import { Worker, Queue, QueueEvents, Job, WorkerOptions, JobsOptions } from 'bullmq';
import { logger } from '@utils/logger-enhanced';
import { metrics, observability, withSpan, SpanAttributes } from '@utils/observability';
import { circuitBreakers } from '@utils/circuitBreaker';
import { config } from '@utils/config';
import * as cluster from 'cluster';
import * as os from 'os';

export interface ScalableWorkerConfig {
  name: string;
  queueName: string;
  concurrency?: number;
  maxWorkers?: number;
  autoScale?: boolean;
  scaleThresholds?: {
    scaleUp: number;
    scaleDown: number;
  };
  workerOptions?: Partial<WorkerOptions>;
  jobOptions?: JobsOptions;
}

export abstract class ScalableWorker<T = any, R = any> {
  protected queue: Queue<T, R>;
  protected worker?: Worker<T, R>;
  protected queueEvents: QueueEvents;
  protected config: Required<ScalableWorkerConfig>;
  private scalingInterval?: NodeJS.Timeout;
  private tracer: any;

  constructor(config: ScalableWorkerConfig) {
    this.config = {
      concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),
      maxWorkers: parseInt(process.env.MAX_WORKERS || String(os.cpus().length)),
      autoScale: process.env.AUTO_SCALE === 'true',
      scaleThresholds: {
        scaleUp: 100,
        scaleDown: 10,
      },
      workerOptions: {},
      jobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
          count: 100,
        },
        removeOnFail: {
          age: 24 * 3600,
        },
      },
      ...config,
    };

    const connection = {
      host: new URL(config.redis.url).hostname,
      port: parseInt(new URL(config.redis.url).port || '6379'),
      password: new URL(config.redis.url).password || undefined,
    };

    this.queue = new Queue(this.config.queueName, { connection });
    this.queueEvents = new QueueEvents(this.config.queueName, { connection });
    this.tracer = observability.getTracer(`worker-${this.config.name}`);

    this.setupEventHandlers();
  }

  // Abstract method to be implemented by subclasses
  protected abstract process(job: Job<T, R>): Promise<R>;

  // Start the worker
  async start(): Promise<void> {
    if (cluster.isPrimary && this.config.autoScale) {
      await this.startPrimary();
    } else {
      await this.startWorker();
    }
  }

  // Primary process manages worker scaling
  private async startPrimary(): Promise<void> {
    logger.info(`Starting primary process for ${this.config.name}`, {
      metadata: {
        pid: process.pid,
        workers: this.config.maxWorkers,
      },
    });

    // Fork initial workers
    const initialWorkers = Math.min(2, this.config.maxWorkers);
    for (let i = 0; i < initialWorkers; i++) {
      this.forkWorker();
    }

    // Set up auto-scaling
    this.scalingInterval = setInterval(() => {
      this.checkScaling();
    }, 30000); // Check every 30 seconds

    // Handle worker exits
    cluster.on('exit', (worker, code, signal) => {
      logger.warn(`Worker ${worker.process.pid} died`, {
        metadata: { code, signal },
      });
      
      // Restart worker if not shutting down
      if (!this.isShuttingDown) {
        this.forkWorker();
      }
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  // Worker process handles actual job processing
  private async startWorker(): Promise<void> {
    logger.info(`Starting worker for ${this.config.name}`, {
      metadata: {
        pid: process.pid,
        concurrency: this.config.concurrency,
      },
    });

    this.worker = new Worker<T, R>(
      this.config.queueName,
      async (job) => {
        return withSpan(
          this.tracer,
          `process-${this.config.name}`,
          async (span) => {
            span.setAttributes({
              [SpanAttributes.WORKER_TYPE]: this.config.name,
              [SpanAttributes.QUEUE_NAME]: this.config.queueName,
              [SpanAttributes.JOB_ID]: job.id,
            });

            const timer = logger.startTimer(`${this.config.name}-job`, {
              metadata: {
                jobId: job.id,
                attemptNumber: job.attemptsMade,
              },
            });

            try {
              const result = await this.processWithCircuitBreaker(job);
              
              timer();
              metrics.recordQueueProcessing(
                this.config.queueName,
                true,
                Date.now() - job.timestamp
              );

              return result;
            } catch (error) {
              timer();
              metrics.recordQueueProcessing(
                this.config.queueName,
                false,
                Date.now() - job.timestamp
              );
              
              throw error;
            }
          }
        );
      },
      {
        connection: {
          host: new URL(config.redis.url).hostname,
          port: parseInt(new URL(config.redis.url).port || '6379'),
          password: new URL(config.redis.url).password || undefined,
        },
        concurrency: this.config.concurrency,
        ...this.config.workerOptions,
      }
    );

    // Worker event handlers
    this.worker.on('completed', (job) => {
      logger.info(`Job completed`, {
        metadata: {
          queue: this.config.queueName,
          jobId: job.id,
          returnValue: job.returnvalue,
        },
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error(`Job failed`, {
        error,
        metadata: {
          queue: this.config.queueName,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
        },
      });
      
      metrics.recordError('job_processing', this.config.name);
    });

    this.worker.on('error', (error) => {
      logger.error(`Worker error`, {
        error,
        metadata: {
          queue: this.config.queueName,
        },
      });
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdownWorker());
    process.on('SIGINT', () => this.shutdownWorker());
  }

  // Process job with circuit breaker protection
  private async processWithCircuitBreaker(job: Job<T, R>): Promise<R> {
    const circuitBreaker = circuitBreakers[this.config.name] || circuitBreakers.default;
    
    return circuitBreaker.execute(async () => {
      return this.process(job);
    });
  }

  // Fork a new worker process
  private forkWorker(): void {
    const worker = cluster.fork({
      WORKER_TYPE: this.config.name,
      WORKER_CONCURRENCY: String(this.config.concurrency),
    });
    
    logger.info(`Forked new worker`, {
      metadata: {
        workerId: worker.id,
        pid: worker.process.pid,
      },
    });
  }

  // Check if scaling is needed
  private async checkScaling(): Promise<void> {
    try {
      const counts = await this.queue.getJobCounts();
      const waiting = counts.waiting || 0;
      const active = counts.active || 0;
      const workers = Object.keys(cluster.workers || {}).length;

      logger.debug(`Scaling check for ${this.config.name}`, {
        metadata: {
          waiting,
          active,
          workers,
        },
      });

      // Scale up if needed
      if (waiting > this.config.scaleThresholds.scaleUp && workers < this.config.maxWorkers) {
        const newWorkers = Math.min(
          Math.ceil(waiting / this.config.scaleThresholds.scaleUp),
          this.config.maxWorkers - workers
        );
        
        for (let i = 0; i < newWorkers; i++) {
          this.forkWorker();
        }
        
        logger.info(`Scaled up ${this.config.name}`, {
          metadata: {
            newWorkers,
            totalWorkers: workers + newWorkers,
          },
        });
      }
      
      // Scale down if needed
      else if (waiting < this.config.scaleThresholds.scaleDown && workers > 1) {
        const workersToRemove = Math.min(
          Math.floor(workers / 2),
          workers - 1
        );
        
        const workerIds = Object.keys(cluster.workers || {});
        for (let i = 0; i < workersToRemove; i++) {
          const workerId = workerIds[i];
          if (cluster.workers && cluster.workers[workerId]) {
            cluster.workers[workerId].disconnect();
          }
        }
        
        logger.info(`Scaled down ${this.config.name}`, {
          metadata: {
            removedWorkers: workersToRemove,
            totalWorkers: workers - workersToRemove,
          },
        });
      }
    } catch (error) {
      logger.error(`Scaling check failed for ${this.config.name}`, {
        error: error as Error,
      });
    }
  }

  // Set up queue event handlers
  private setupEventHandlers(): void {
    this.queueEvents.on('waiting', ({ jobId }) => {
      logger.debug(`Job waiting`, {
        metadata: {
          queue: this.config.queueName,
          jobId,
        },
      });
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      logger.debug(`Job progress`, {
        metadata: {
          queue: this.config.queueName,
          jobId,
          progress: data,
        },
      });
    });

    this.queueEvents.on('stalled', ({ jobId }) => {
      logger.warn(`Job stalled`, {
        metadata: {
          queue: this.config.queueName,
          jobId,
        },
      });
      
      metrics.recordError('job_stalled', this.config.name);
    });
  }

  // Add job to queue
  async addJob(data: T, options?: JobsOptions): Promise<Job<T, R>> {
    const jobOptions = {
      ...this.config.jobOptions,
      ...options,
    };

    const job = await this.queue.add(
      `${this.config.name}-job`,
      data,
      jobOptions
    );

    logger.debug(`Job added to queue`, {
      metadata: {
        queue: this.config.queueName,
        jobId: job.id,
      },
    });

    return job;
  }

  // Batch add jobs
  async addBulkJobs(jobs: Array<{ data: T; options?: JobsOptions }>): Promise<Job<T, R>[]> {
    const bulkJobs = jobs.map((job) => ({
      name: `${this.config.name}-job`,
      data: job.data,
      opts: {
        ...this.config.jobOptions,
        ...job.options,
      },
    }));

    const addedJobs = await this.queue.addBulk(bulkJobs);
    
    logger.info(`Bulk jobs added to queue`, {
      metadata: {
        queue: this.config.queueName,
        count: addedJobs.length,
      },
    });

    return addedJobs;
  }

  // Get queue statistics
  async getStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: boolean;
    workers: number;
  }> {
    const [counts, isPaused] = await Promise.all([
      this.queue.getJobCounts(),
      this.queue.isPaused(),
    ]);

    const workers = cluster.isPrimary
      ? Object.keys(cluster.workers || {}).length
      : 1;

    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      paused: isPaused,
      workers,
    };
  }

  // Pause/resume queue
  async pause(): Promise<void> {
    await this.queue.pause();
    logger.info(`Queue paused: ${this.config.queueName}`);
  }

  async resume(): Promise<void> {
    await this.queue.resume();
    logger.info(`Queue resumed: ${this.config.queueName}`);
  }

  // Clean old jobs
  async clean(grace: number = 3600000): Promise<void> {
    const [completed, failed] = await Promise.all([
      this.queue.clean(grace, 100, 'completed'),
      this.queue.clean(grace, 100, 'failed'),
    ]);

    logger.info(`Cleaned old jobs from ${this.config.queueName}`, {
      metadata: {
        completed: completed.length,
        failed: failed.length,
      },
    });
  }

  // Graceful shutdown
  private isShuttingDown = false;

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info(`Shutting down ${this.config.name} primary process`);

    if (this.scalingInterval) {
      clearInterval(this.scalingInterval);
    }

    // Signal all workers to shut down
    for (const id in cluster.workers) {
      cluster.workers[id]?.disconnect();
    }

    // Wait for workers to exit
    await new Promise<void>((resolve) => {
      const checkWorkers = setInterval(() => {
        if (Object.keys(cluster.workers || {}).length === 0) {
          clearInterval(checkWorkers);
          resolve();
        }
      }, 100);
    });

    await this.cleanup();
  }

  async shutdownWorker(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info(`Shutting down ${this.config.name} worker process`);

    if (this.worker) {
      await this.worker.close();
    }

    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    await Promise.all([
      this.queue.close(),
      this.queueEvents.close(),
    ]);

    logger.info(`${this.config.name} cleanup complete`);
  }
}

// Example implementation for embedding worker
export class EmbeddingWorker extends ScalableWorker<EmbeddingJobData, void> {
  constructor() {
    super({
      name: 'embeddings',
      queueName: 'embeddings',
      concurrency: parseInt(process.env.EMBEDDING_QUEUE_CONCURRENCY || '3'),
      maxWorkers: 5,
      autoScale: true,
      scaleThresholds: {
        scaleUp: 50,
        scaleDown: 5,
      },
    });
  }

  protected async process(job: Job<EmbeddingJobData>): Promise<void> {
    const { messageTs, messageText, userId, channelId } = job.data;
    
    logger.info(`Processing embedding job`, {
      metadata: {
        messageTs,
        userId,
        channelId,
        textLength: messageText.length,
      },
    });

    // Your embedding processing logic here
    // This is just a placeholder
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

interface EmbeddingJobData {
  messageTs: string;
  messageText: string;
  userId: string;
  channelId: string;
}