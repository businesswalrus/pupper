import { pool } from '@db/connection';
import { redisClient } from '@db/redis';
import { testOpenAIConnection } from '@ai/openai';
import { circuitBreakers } from '@utils/circuitBreaker';
import { logger } from '@utils/logger';
import { metrics } from '@utils/observability';
import * as os from 'os';
import * as fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  correlationId: string;
  environment: {
    nodeVersion: string;
    platform: string;
    hostname: string;
    pid: number;
    ppid: number;
  };
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
    openai: ServiceHealth;
    slack: ServiceHealth;
  };
  workers: {
    embeddings: QueueHealth;
    summaries: QueueHealth;
    profiles: QueueHealth;
  };
  system: {
    memory: MemoryHealth;
    cpu: CpuHealth;
    disk: DiskHealth;
    network: NetworkHealth;
  };
  circuitBreakers: Record<string, CircuitBreakerHealth>;
  dependencies: DependencyHealth[];
  checks: HealthCheck[];
}

interface ServiceHealth {
  status: 'up' | 'down' | 'degraded';
  latency?: number;
  error?: string;
  lastCheck: string;
  metadata?: Record<string, any>;
}

interface QueueHealth {
  status: 'active' | 'inactive' | 'error';
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
  processingRate: number;
  errorRate: number;
}

interface MemoryHealth {
  used: number;
  total: number;
  percentage: number;
  warning: boolean;
  critical: boolean;
  details: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
}

interface CpuHealth {
  usage: number;
  loadAverage: number[];
  cores: number;
  warning: boolean;
  critical: boolean;
}

interface DiskHealth {
  available: number;
  total: number;
  percentage: number;
  warning: boolean;
  critical: boolean;
}

interface NetworkHealth {
  latency: number;
  status: 'ok' | 'slow' | 'error';
}

interface CircuitBreakerHealth {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  nextAttempt?: string;
  lastFailure?: string;
}

interface DependencyHealth {
  name: string;
  status: 'healthy' | 'unhealthy';
  version?: string;
  lastCheck: string;
}

interface HealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  duration: number;
  timestamp: string;
}

class EnhancedHealthChecker {
  private startTime: Date;
  private healthCheckHistory: HealthCheck[] = [];
  private readonly maxHistorySize = 100;

  constructor() {
    this.startTime = new Date();
  }

  async checkHealth(detailed: boolean = false): Promise<HealthStatus> {
    const correlationId = `health-${Date.now()}`;
    const startTime = Date.now();
    
    try {
      // Run all health checks in parallel
      const [
        services,
        workers,
        system,
        circuitBreakerStates,
        dependencies,
      ] = await Promise.all([
        this.checkServices(),
        this.checkWorkers(),
        this.checkSystem(),
        this.getCircuitBreakerStates(),
        detailed ? this.checkDependencies() : Promise.resolve([]),
      ]);

      // Determine overall status
      const status = this.calculateOverallStatus(services, workers, system);

      // Record metrics
      metrics.recordApiCall('health', 'check', true, Date.now() - startTime);

      // Build response
      const healthStatus: HealthStatus = {
        status,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || 'unknown',
        uptime: Date.now() - this.startTime.getTime(),
        correlationId,
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          hostname: os.hostname(),
          pid: process.pid,
          ppid: process.ppid,
        },
        services,
        workers,
        system,
        circuitBreakers: circuitBreakerStates,
        dependencies,
        checks: detailed ? this.healthCheckHistory.slice(-10) : [],
      };

      // Store in history
      this.addToHistory({
        name: 'overall',
        status: status === 'healthy' ? 'pass' : status === 'degraded' ? 'warn' : 'fail',
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });

      return healthStatus;
    } catch (error) {
      logger.error('Health check failed', { error: error as Error, correlationId });
      metrics.recordError('health_check', 'overall');
      
      throw error;
    }
  }

  private async checkServices(): Promise<HealthStatus['services']> {
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkOpenAI(),
      this.checkSlack(),
    ]);

    return {
      database: checks[0].status === 'fulfilled' ? checks[0].value : this.createErrorService(checks[0].reason),
      redis: checks[1].status === 'fulfilled' ? checks[1].value : this.createErrorService(checks[1].reason),
      openai: checks[2].status === 'fulfilled' ? checks[2].value : this.createErrorService(checks[2].reason),
      slack: checks[3].status === 'fulfilled' ? checks[3].value : this.createErrorService(checks[3].reason),
    };
  }

  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    const checkName = 'database';
    
    try {
      const result = await pool.query('SELECT version(), current_database(), pg_size_pretty(pg_database_size(current_database()))');
      const latency = Date.now() - start;
      
      const metadata = {
        version: result.rows[0].version,
        database: result.rows[0].current_database,
        size: result.rows[0].pg_size_pretty,
      };

      this.addToHistory({
        name: checkName,
        status: 'pass',
        duration: latency,
        timestamp: new Date().toISOString(),
      });

      return {
        status: 'up',
        latency,
        lastCheck: new Date().toISOString(),
        metadata,
      };
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('Database health check failed', { error: error as Error });
      
      this.addToHistory({
        name: checkName,
        status: 'fail',
        message: (error as Error).message,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        status: 'down',
        error: (error as Error).message,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkRedis(): Promise<ServiceHealth> {
    const start = Date.now();
    const checkName = 'redis';
    
    try {
      const info = await redisClient.info();
      const latency = Date.now() - start;
      
      // Parse Redis info
      const metadata: Record<string, any> = {};
      info.split('\n').forEach(line => {
        if (line.includes(':')) {
          const [key, value] = line.split(':');
          if (['redis_version', 'used_memory_human', 'connected_clients'].includes(key)) {
            metadata[key] = value.trim();
          }
        }
      });

      this.addToHistory({
        name: checkName,
        status: 'pass',
        duration: latency,
        timestamp: new Date().toISOString(),
      });

      return {
        status: 'up',
        latency,
        lastCheck: new Date().toISOString(),
        metadata,
      };
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('Redis health check failed', { error: error as Error });
      
      this.addToHistory({
        name: checkName,
        status: 'fail',
        message: (error as Error).message,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        status: 'down',
        error: (error as Error).message,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkOpenAI(): Promise<ServiceHealth> {
    const start = Date.now();
    const checkName = 'openai';
    
    try {
      const success = await testOpenAIConnection();
      const latency = Date.now() - start;
      
      this.addToHistory({
        name: checkName,
        status: success ? 'pass' : 'fail',
        duration: latency,
        timestamp: new Date().toISOString(),
      });

      return {
        status: success ? 'up' : 'down',
        latency,
        lastCheck: new Date().toISOString(),
      };
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('OpenAI health check failed', { error: error as Error });
      
      this.addToHistory({
        name: checkName,
        status: 'fail',
        message: (error as Error).message,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        status: 'down',
        error: (error as Error).message,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  private async checkSlack(): Promise<ServiceHealth> {
    // Implementation depends on your Slack setup
    // For now, assume it's always up if we're running
    return {
      status: 'up',
      latency: 0,
      lastCheck: new Date().toISOString(),
      metadata: {
        socketMode: true,
        connected: true,
      },
    };
  }

  private async checkWorkers(): Promise<HealthStatus['workers']> {
    try {
      const { embeddingQueue, messageSummaryQueue, userProfileQueue } = await import('@workers/queues');
      
      const [embeddingStats, summaryStats, profileStats] = await Promise.all([
        this.getQueueStats(embeddingQueue, 'embeddings'),
        this.getQueueStats(messageSummaryQueue, 'summaries'),
        this.getQueueStats(userProfileQueue, 'profiles'),
      ]);

      return {
        embeddings: embeddingStats,
        summaries: summaryStats,
        profiles: profileStats,
      };
    } catch (error) {
      logger.error('Worker health check failed', { error: error as Error });
      
      const errorQueue: QueueHealth = {
        status: 'error',
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
        processingRate: 0,
        errorRate: 0,
      };

      return {
        embeddings: errorQueue,
        summaries: errorQueue,
        profiles: errorQueue,
      };
    }
  }

  private async getQueueStats(queue: any, name: string): Promise<QueueHealth> {
    try {
      const [counts, isPaused, completedCount, failedCount] = await Promise.all([
        queue.getJobCounts(),
        queue.isPaused(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]);

      // Calculate rates (simplified - in production, use time windows)
      const total = completedCount + failedCount;
      const errorRate = total > 0 ? (failedCount / total) * 100 : 0;
      const processingRate = completedCount / (Date.now() - this.startTime.getTime()) * 1000 * 60; // per minute

      return {
        status: isPaused ? 'inactive' : 'active',
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
        paused: isPaused,
        processingRate: Math.round(processingRate),
        errorRate: Math.round(errorRate * 100) / 100,
      };
    } catch (error) {
      logger.error(`Failed to get queue stats for ${name}`, { error: error as Error });
      
      return {
        status: 'error',
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
        processingRate: 0,
        errorRate: 0,
      };
    }
  }

  private async checkSystem(): Promise<HealthStatus['system']> {
    const [memory, cpu, disk, network] = await Promise.all([
      this.checkMemory(),
      this.checkCpu(),
      this.checkDisk(),
      this.checkNetwork(),
    ]);

    return { memory, cpu, disk, network };
  }

  private checkMemory(): MemoryHealth {
    const usage = process.memoryUsage();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const percentage = (usedMemory / totalMemory) * 100;

    return {
      used: Math.round(usedMemory / 1024 / 1024),
      total: Math.round(totalMemory / 1024 / 1024),
      percentage: Math.round(percentage),
      warning: percentage > 80,
      critical: percentage > 95,
      details: {
        rss: Math.round(usage.rss / 1024 / 1024),
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
        external: Math.round(usage.external / 1024 / 1024),
        arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024),
      },
    };
  }

  private checkCpu(): CpuHealth {
    const cpus = os.cpus();
    const loadAverage = os.loadavg();
    const usage = loadAverage[0] / cpus.length * 100;

    return {
      usage: Math.round(usage),
      loadAverage: loadAverage.map(load => Math.round(load * 100) / 100),
      cores: cpus.length,
      warning: usage > 70,
      critical: usage > 90,
    };
  }

  private async checkDisk(): Promise<DiskHealth> {
    // Simplified disk check - in production, use proper disk usage library
    try {
      const stats = await fs.promises.statfs('/');
      const total = stats.blocks * stats.bsize;
      const available = stats.bavail * stats.bsize;
      const used = total - available;
      const percentage = (used / total) * 100;

      return {
        available: Math.round(available / 1024 / 1024 / 1024), // GB
        total: Math.round(total / 1024 / 1024 / 1024), // GB
        percentage: Math.round(percentage),
        warning: percentage > 80,
        critical: percentage > 95,
      };
    } catch (error) {
      logger.error('Disk check failed', { error: error as Error });
      
      return {
        available: 0,
        total: 0,
        percentage: 0,
        warning: false,
        critical: false,
      };
    }
  }

  private async checkNetwork(): Promise<NetworkHealth> {
    // Simple network check - ping a known service
    const start = Date.now();
    
    try {
      await fetch('https://1.1.1.1/dns-query', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      
      const latency = Date.now() - start;
      
      return {
        latency,
        status: latency < 100 ? 'ok' : latency < 500 ? 'slow' : 'error',
      };
    } catch (error) {
      return {
        latency: Date.now() - start,
        status: 'error',
      };
    }
  }

  private getCircuitBreakerStates(): Record<string, CircuitBreakerHealth> {
    const states: Record<string, CircuitBreakerHealth> = {};
    
    for (const [name, breaker] of Object.entries(circuitBreakers)) {
      const stats = breaker.getStats();
      states[name] = {
        state: stats.state,
        failures: stats.failures,
        successes: stats.successes,
        nextAttempt: stats.nextAttempt,
        lastFailure: stats.lastFailure,
      };
    }

    return states;
  }

  private async checkDependencies(): Promise<DependencyHealth[]> {
    const dependencies: DependencyHealth[] = [];
    
    // Check npm dependencies
    try {
      const packageJson = JSON.parse(
        await readFile('package.json', 'utf-8')
      );
      
      const criticalDeps = [
        '@slack/bolt',
        'openai',
        'pg',
        'redis',
        'bullmq',
      ];
      
      for (const dep of criticalDeps) {
        if (packageJson.dependencies[dep]) {
          dependencies.push({
            name: dep,
            status: 'healthy',
            version: packageJson.dependencies[dep],
            lastCheck: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      logger.error('Dependency check failed', { error: error as Error });
    }

    return dependencies;
  }

  private calculateOverallStatus(
    services: HealthStatus['services'],
    workers: HealthStatus['workers'],
    system: HealthStatus['system']
  ): 'healthy' | 'degraded' | 'unhealthy' {
    // Critical services must be up
    const criticalServicesUp = 
      services.database.status === 'up' && 
      services.redis.status === 'up';

    if (!criticalServicesUp) {
      return 'unhealthy';
    }

    // Check for degraded conditions
    const degradedConditions = [
      services.openai.status !== 'up',
      services.slack.status !== 'up',
      workers.embeddings.status === 'error',
      workers.summaries.status === 'error',
      system.memory.critical,
      system.cpu.critical,
      system.disk.critical,
    ];

    if (degradedConditions.some(condition => condition)) {
      return 'degraded';
    }

    // Check for warning conditions
    const warningConditions = [
      system.memory.warning,
      system.cpu.warning,
      system.disk.warning,
      workers.embeddings.errorRate > 10,
      workers.summaries.errorRate > 10,
      workers.profiles.errorRate > 10,
    ];

    if (warningConditions.some(condition => condition)) {
      return 'degraded';
    }

    return 'healthy';
  }

  private createErrorService(error: any): ServiceHealth {
    return {
      status: 'down',
      error: error?.message || 'Unknown error',
      lastCheck: new Date().toISOString(),
    };
  }

  private addToHistory(check: HealthCheck): void {
    this.healthCheckHistory.push(check);
    
    // Keep history size under control
    if (this.healthCheckHistory.length > this.maxHistorySize) {
      this.healthCheckHistory = this.healthCheckHistory.slice(-this.maxHistorySize);
    }
  }

  // Liveness probe - basic check that the process is alive
  async checkLiveness(): Promise<boolean> {
    return true;
  }

  // Readiness probe - check if the app is ready to serve traffic
  async checkReadiness(): Promise<boolean> {
    try {
      const health = await this.checkHealth(false);
      return health.status !== 'unhealthy';
    } catch {
      return false;
    }
  }

  // Startup probe - check if the app has started successfully
  async checkStartup(): Promise<boolean> {
    try {
      // Check critical services only
      const [db, redis] = await Promise.all([
        this.checkDatabase(),
        this.checkRedis(),
      ]);
      
      return db.status === 'up' && redis.status === 'up';
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const healthChecker = new EnhancedHealthChecker();

// Express route handlers
export async function healthCheckHandler(req: any, res: any) {
  const probeType = req.headers['x-probe-type'] || 'full';
  const detailed = req.query.detailed === 'true';
  
  try {
    let result;
    let statusCode = 200;
    
    switch (probeType) {
      case 'startup':
        result = await healthChecker.checkStartup();
        statusCode = result ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: result }));
        break;
        
      case 'liveness':
        result = await healthChecker.checkLiveness();
        statusCode = result ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ alive: result }));
        break;
        
      case 'readiness':
        result = await healthChecker.checkReadiness();
        statusCode = result ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: result }));
        break;
        
      default:
        const health = await healthChecker.checkHealth(detailed);
        statusCode = health.status === 'healthy' ? 200 : 
                     health.status === 'degraded' ? 200 : 503;
        
        res.writeHead(statusCode, { 
          'Content-Type': 'application/json',
          'X-Health-Status': health.status,
          'X-Correlation-Id': health.correlationId,
        });
        res.end(JSON.stringify(health, null, 2));
    }
  } catch (error) {
    logger.error('Health check error', { error: error as Error });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'error', 
      message: 'Health check failed',
      timestamp: new Date().toISOString(),
    }));
  }
}