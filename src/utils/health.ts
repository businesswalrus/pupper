import { pool } from '@db/connection';
import { redisClient } from '@db/redis';
import { testOpenAIConnection } from '@ai/openai';
import { circuitBreakers } from '@utils/circuitBreaker';
import { logger } from '@utils/logger';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
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
  memory: MemoryHealth;
  circuitBreakers: Record<string, any>;
}

interface ServiceHealth {
  status: 'up' | 'down';
  latency?: number;
  error?: string;
}

interface QueueHealth {
  status: 'active' | 'inactive';
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

interface MemoryHealth {
  used: number;
  total: number;
  percentage: number;
  warning: boolean;
}

class HealthChecker {
  private startTime: Date;

  constructor() {
    this.startTime = new Date();
  }

  async checkHealth(): Promise<HealthStatus> {
    const [database, redis, openai, slack] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkOpenAI(),
      this.checkSlack(),
    ]);

    const workers = await this.checkWorkers();
    const memory = this.checkMemory();
    const circuitBreakerStates = this.getCircuitBreakerStates();

    const allServicesUp = 
      database.status === 'up' && 
      redis.status === 'up' && 
      openai.status === 'up';

    const status = allServicesUp ? 'healthy' : 
      (database.status === 'up' && redis.status === 'up') ? 'degraded' : 'unhealthy';

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime.getTime(),
      services: {
        database,
        redis,
        openai,
        slack,
      },
      workers,
      memory,
      circuitBreakers: circuitBreakerStates,
    };
  }

  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await pool.query('SELECT 1');
      return {
        status: 'up',
        latency: Date.now() - start,
      };
    } catch (error) {
      logger.error('Database health check failed', { error: error as Error });
      return {
        status: 'down',
        error: (error as Error).message,
      };
    }
  }

  private async checkRedis(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await redisClient.ping();
      return {
        status: 'up',
        latency: Date.now() - start,
      };
    } catch (error) {
      logger.error('Redis health check failed', { error: error as Error });
      return {
        status: 'down',
        error: (error as Error).message,
      };
    }
  }

  private async checkOpenAI(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const success = await testOpenAIConnection();
      return {
        status: success ? 'up' : 'down',
        latency: Date.now() - start,
      };
    } catch (error) {
      logger.error('OpenAI health check failed', { error: error as Error });
      return {
        status: 'down',
        error: (error as Error).message,
      };
    }
  }

  private async checkSlack(): Promise<ServiceHealth> {
    // For now, we'll assume Slack is up if we're connected
    // In production, you might want to check the Slack API
    return {
      status: 'up',
      latency: 0,
    };
  }

  private async checkWorkers(): Promise<HealthStatus['workers']> {
    try {
      const { embeddingQueue, messageSummaryQueue, userProfileQueue } = await import('@workers/queues');
      
      const [embeddingCounts, summaryCounts, profileCounts] = await Promise.all([
        embeddingQueue.getJobCounts(),
        messageSummaryQueue.getJobCounts(),
        userProfileQueue.getJobCounts(),
      ]);

      return {
        embeddings: {
          status: 'active',
          waiting: embeddingCounts.waiting || 0,
          active: embeddingCounts.active || 0,
          completed: embeddingCounts.completed || 0,
          failed: embeddingCounts.failed || 0,
        },
        summaries: {
          status: 'active',
          waiting: summaryCounts.waiting || 0,
          active: summaryCounts.active || 0,
          completed: summaryCounts.completed || 0,
          failed: summaryCounts.failed || 0,
        },
        profiles: {
          status: 'active',
          waiting: profileCounts.waiting || 0,
          active: profileCounts.active || 0,
          completed: profileCounts.completed || 0,
          failed: profileCounts.failed || 0,
        },
      };
    } catch (error) {
      logger.error('Worker health check failed', { error: error as Error });
      return {
        embeddings: { status: 'inactive', waiting: 0, active: 0, completed: 0, failed: 0 },
        summaries: { status: 'inactive', waiting: 0, active: 0, completed: 0, failed: 0 },
        profiles: { status: 'inactive', waiting: 0, active: 0, completed: 0, failed: 0 },
      };
    }
  }

  private checkMemory(): MemoryHealth {
    const usage = process.memoryUsage();
    const total = usage.heapTotal;
    const used = usage.heapUsed;
    const percentage = (used / total) * 100;

    return {
      used: Math.round(used / 1024 / 1024), // MB
      total: Math.round(total / 1024 / 1024), // MB
      percentage: Math.round(percentage),
      warning: percentage > 80,
    };
  }

  private getCircuitBreakerStates(): Record<string, any> {
    const states: Record<string, any> = {};
    
    for (const [name, breaker] of Object.entries(circuitBreakers)) {
      states[name] = breaker.getStats();
    }

    return states;
  }
}

export const healthChecker = new HealthChecker();

// Express route handler for health checks
export async function healthCheckHandler(_req: any, res: any) {
  try {
    const health = await healthChecker.checkHealth();
    const statusCode = health.status === 'healthy' ? 200 : 
                       health.status === 'degraded' ? 503 : 500;
    
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
  } catch (error) {
    logger.error('Health check error', { error: error as Error });
    res.writeHead(500);
    res.end(JSON.stringify({ status: 'error', message: 'Health check failed' }));
  }
}