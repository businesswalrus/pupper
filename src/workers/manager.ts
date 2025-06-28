import { Worker, WorkerOptions } from 'bullmq';
import { config } from '@utils/config';
import { logger } from '@utils/logger';
import { createBatchEmbeddingWorker } from './batchEmbeddings';
import { getQueueHealth } from './queues';
import cluster from 'cluster';
import os from 'os';

interface WorkerConfig {
  name: string;
  queueName: string;
  processor: any;
  concurrency: number;
  options?: Partial<WorkerOptions>;
}

interface WorkerPool {
  workers: Worker[];
  config: WorkerConfig;
  metrics: {
    processed: number;
    failed: number;
    avgProcessingTime: number;
    lastError?: Error;
  };
}

export class WorkerManager {
  private pools = new Map<string, WorkerPool>();
  private isShuttingDown = false;
  private healthCheckInterval?: NodeJS.Timeout;
  private autoScaleInterval?: NodeJS.Timeout;

  constructor(private readonly options: {
    enableClustering?: boolean;
    enableAutoScaling?: boolean;
    maxWorkersPerQueue?: number;
    minWorkersPerQueue?: number;
  } = {}) {
    this.setupSignalHandlers();
  }

  /**
   * Initialize worker manager with clustering support
   */
  async initialize(): Promise<void> {
    if (this.options.enableClustering && cluster.isPrimary) {
      await this.initializePrimary();
    } else {
      await this.initializeWorker();
    }
  }

  private async initializePrimary(): Promise<void> {
    const numCPUs = os.cpus().length;
    const workersPerCPU = Math.max(1, Math.floor(numCPUs / 2)); // Use half of CPUs

    logger.info(`Starting ${workersPerCPU} worker processes on ${numCPUs} CPUs`);

    // Fork workers
    for (let i = 0; i < workersPerCPU; i++) {
      cluster.fork();
    }

    // Handle worker lifecycle
    cluster.on('exit', (worker, code, signal) => {
      if (!this.isShuttingDown) {
        logger.error(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
        cluster.fork();
      }
    });

    // Start monitoring
    this.startHealthMonitoring();
    if (this.options.enableAutoScaling) {
      this.startAutoScaling();
    }
  }

  private async initializeWorker(): Promise<void> {
    // Register workers
    await this.registerWorkers();

    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Register all workers with optimized configurations
   */
  private async registerWorkers(): Promise<void> {
    const workerConfigs: WorkerConfig[] = [
      {
        name: 'batch-embeddings',
        queueName: 'embeddings',
        processor: createBatchEmbeddingWorker,
        concurrency: 20, // High concurrency for batch processing
        options: {
          limiter: {
            max: 100,
            duration: 60000,
          },
          metrics: {
            maxDataPoints: 3600, // Keep 1 hour of metrics
          },
        },
      },
      {
        name: 'message-summaries',
        queueName: 'message-summaries',
        processor: async () => {
          const { createSummaryWorker } = await import('./summarizer');
          return createSummaryWorker();
        },
        concurrency: 5,
        options: {
          limiter: {
            max: 20,
            duration: 60000,
          },
        },
      },
      {
        name: 'user-profiles',
        queueName: 'user-profiles',
        processor: async () => {
          const { createProfileWorker } = await import('./profiler');
          return createProfileWorker();
        },
        concurrency: 10,
        options: {
          limiter: {
            max: 50,
            duration: 60000,
          },
        },
      },
    ];

    for (const config of workerConfigs) {
      await this.createWorkerPool(config);
    }
  }

  /**
   * Create a pool of workers for a specific queue
   */
  private async createWorkerPool(config: WorkerConfig): Promise<void> {
    const minWorkers = this.options.minWorkersPerQueue || 1;
    const workers: Worker[] = [];

    for (let i = 0; i < minWorkers; i++) {
      const worker = await this.createWorker(config, i);
      workers.push(worker);
    }

    this.pools.set(config.name, {
      workers,
      config,
      metrics: {
        processed: 0,
        failed: 0,
        avgProcessingTime: 0,
      },
    });

    logger.info(`Created worker pool for ${config.name} with ${workers.length} workers`);
  }

  /**
   * Create individual worker with instrumentation
   */
  private async createWorker(
    config: WorkerConfig,
    index: number
  ): Promise<Worker> {
    const workerName = `${config.name}-${index}`;
    let worker: Worker;

    // Get the actual worker instance
    if (typeof config.processor === 'function') {
      worker = await config.processor();
    } else {
      worker = config.processor;
    }

    // Add instrumentation
    const pool = this.pools.get(config.name);
    if (pool) {
      worker.on('completed', (job) => {
        pool.metrics.processed++;
        this.updateProcessingTime(pool, job.finishedOn! - job.processedOn!);
      });

      worker.on('failed', (job, err) => {
        pool.metrics.failed++;
        pool.metrics.lastError = err;
        logger.error(`Worker ${workerName} job failed`, {
          jobId: job?.id,
          error: err,
        });
      });

      worker.on('error', (err) => {
        logger.error(`Worker ${workerName} error`, { error: err });
      });
    }

    logger.info(`Started worker ${workerName}`);
    return worker;
  }

  /**
   * Update average processing time
   */
  private updateProcessingTime(pool: WorkerPool, duration: number): void {
    const { processed, avgProcessingTime } = pool.metrics;
    pool.metrics.avgProcessingTime = 
      (avgProcessingTime * (processed - 1) + duration) / processed;
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await getQueueHealth();
        const poolHealth = this.getPoolHealth();

        logger.info('Worker health check', {
          queues: health,
          pools: poolHealth,
        });

        // Alert on degraded health
        for (const [queue, stats] of Object.entries(health)) {
          if (stats.health === 'degraded') {
            logger.warn(`Queue ${queue} is degraded`, stats);
          }
        }
      } catch (error) {
        logger.error('Health check failed', { error: error as Error });
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Start auto-scaling based on queue depth
   */
  private startAutoScaling(): void {
    this.autoScaleInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      try {
        const health = await getQueueHealth();

        for (const [poolName, pool] of this.pools) {
          const queueStats = health[pool.config.queueName as keyof typeof health];
          if (!queueStats) continue;

          const currentWorkers = pool.workers.length;
          const maxWorkers = this.options.maxWorkersPerQueue || 10;
          const minWorkers = this.options.minWorkersPerQueue || 1;

          // Scale up if queue is backing up
          if (queueStats.waiting > 100 && currentWorkers < maxWorkers) {
            const newWorker = await this.createWorker(pool.config, currentWorkers);
            pool.workers.push(newWorker);
            logger.info(`Scaled up ${poolName} to ${pool.workers.length} workers`);
          }

          // Scale down if queue is empty and we have extra workers
          else if (
            queueStats.waiting === 0 && 
            queueStats.active === 0 && 
            currentWorkers > minWorkers
          ) {
            const worker = pool.workers.pop();
            if (worker) {
              await worker.close();
              logger.info(`Scaled down ${poolName} to ${pool.workers.length} workers`);
            }
          }
        }
      } catch (error) {
        logger.error('Auto-scaling failed', { error: error as Error });
      }
    }, 60000); // Every minute
  }

  /**
   * Get pool health metrics
   */
  private getPoolHealth() {
    const health: Record<string, any> = {};

    for (const [name, pool] of this.pools) {
      health[name] = {
        workers: pool.workers.length,
        metrics: pool.metrics,
        active: pool.workers.filter(w => !w.closing).length,
      };
    }

    return health;
  }

  /**
   * Pause all workers
   */
  async pauseAll(reason?: string): Promise<void> {
    logger.info(`Pausing all workers${reason ? `: ${reason}` : ''}`);

    const promises: Promise<void>[] = [];
    for (const pool of this.pools.values()) {
      for (const worker of pool.workers) {
        promises.push(worker.pause());
      }
    }

    await Promise.all(promises);
  }

  /**
   * Resume all workers
   */
  async resumeAll(): Promise<void> {
    logger.info('Resuming all workers');

    const promises: Promise<void>[] = [];
    for (const pool of this.pools.values()) {
      for (const worker of pool.workers) {
        promises.push(worker.resume());
      }
    }

    await Promise.all(promises);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down worker manager...');

    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.autoScaleInterval) {
      clearInterval(this.autoScaleInterval);
    }

    // Close all workers gracefully
    const promises: Promise<void>[] = [];
    for (const pool of this.pools.values()) {
      for (const worker of pool.workers) {
        promises.push(worker.close());
      }
    }

    await Promise.all(promises);
    logger.info('Worker manager shutdown complete');
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGUSR2'];

    signals.forEach((signal) => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, starting graceful shutdown...`);
        await this.shutdown();
        process.exit(0);
      });
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception in worker', { error });
      this.shutdown().then(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection in worker', { reason, promise });
    });
  }
}

// Export singleton instance
export const workerManager = new WorkerManager({
  enableClustering: process.env.NODE_ENV === 'production',
  enableAutoScaling: true,
  maxWorkersPerQueue: 10,
  minWorkersPerQueue: 2,
});

// Convenience function to start all workers
export async function startWorkers(): Promise<void> {
  await workerManager.initialize();
}