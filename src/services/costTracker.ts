import { redis } from '@db/redis';
import { logger } from '@utils/logger';
import { pool } from '@db/connection';

// Cost configuration per service
const COST_CONFIG = {
  openai: {
    'gpt-4-turbo-preview': {
      input: 0.01,    // $0.01 per 1K tokens
      output: 0.03,   // $0.03 per 1K tokens
    },
    'text-embedding-3-small': {
      input: 0.00002, // $0.00002 per 1K tokens
    },
  },
  database: {
    storage: 0.15,    // $0.15 per GB per month
    compute: 0.08,    // $0.08 per vCPU hour
  },
  redis: {
    memory: 0.016,    // $0.016 per GB per hour
  },
  bandwidth: {
    egress: 0.09,     // $0.09 per GB
  },
};

interface UsageMetric {
  service: string;
  operation: string;
  userId?: string;
  quantity: number;
  unit: string;
  cost: number;
  timestamp: Date;
  metadata?: Record<string, any>;
}

interface CostReport {
  period: string;
  totalCost: number;
  byService: Record<string, number>;
  byUser: Record<string, number>;
  byOperation: Record<string, number>;
  trends: {
    dailyAverage: number;
    weeklyGrowth: number;
    projection: number;
  };
}

export class CostTracker {
  private readonly USAGE_KEY_PREFIX = 'usage:';
  private readonly COST_KEY_PREFIX = 'cost:';
  private readonly BUDGET_KEY_PREFIX = 'budget:';
  
  // In-memory buffer for batch writes
  private usageBuffer: UsageMetric[] = [];
  private flushInterval?: NodeJS.Timeout;

  constructor() {
    // Start periodic flush
    this.flushInterval = setInterval(() => {
      this.flushUsageBuffer().catch(err => 
        logger.error('Failed to flush usage buffer', { error: err })
      );
    }, 5000); // Every 5 seconds
  }

  /**
   * Track API usage
   */
  async trackAPIUsage(
    service: 'openai' | 'search',
    operation: string,
    userId: string,
    tokens?: { input?: number; output?: number },
    metadata?: Record<string, any>
  ): Promise<void> {
    try {
      const cost = this.calculateAPICost(service, operation, tokens);
      
      const metric: UsageMetric = {
        service,
        operation,
        userId,
        quantity: tokens ? (tokens.input || 0) + (tokens.output || 0) : 1,
        unit: 'tokens',
        cost,
        timestamp: new Date(),
        metadata,
      };

      this.usageBuffer.push(metric);

      // Check user budget
      await this.checkBudget(userId, cost);

      // Update real-time counters
      await this.updateRealtimeMetrics(metric);

    } catch (error) {
      logger.error('Failed to track API usage', { error: error as Error });
    }
  }

  /**
   * Track database usage
   */
  async trackDatabaseUsage(): Promise<void> {
    try {
      const metrics = await this.collectDatabaseMetrics();
      
      const storageCost = (metrics.storageGB * COST_CONFIG.database.storage) / 30 / 24; // Per hour
      const computeCost = metrics.activeConnections * 0.25 * COST_CONFIG.database.compute; // Estimate

      const metric: UsageMetric = {
        service: 'database',
        operation: 'usage',
        quantity: metrics.storageGB,
        unit: 'GB-hours',
        cost: storageCost + computeCost,
        timestamp: new Date(),
        metadata: metrics,
      };

      this.usageBuffer.push(metric);

    } catch (error) {
      logger.error('Failed to track database usage', { error: error as Error });
    }
  }

  /**
   * Track Redis usage
   */
  async trackRedisUsage(): Promise<void> {
    try {
      const info = await (await redis.getClient()).info('memory');
      const memoryUsedGB = this.parseRedisMemory(info) / (1024 * 1024 * 1024);
      const cost = memoryUsedGB * COST_CONFIG.redis.memory;

      const metric: UsageMetric = {
        service: 'redis',
        operation: 'memory',
        quantity: memoryUsedGB,
        unit: 'GB-hours',
        cost,
        timestamp: new Date(),
        metadata: { memoryUsedGB },
      };

      this.usageBuffer.push(metric);

    } catch (error) {
      logger.error('Failed to track Redis usage', { error: error as Error });
    }
  }

  /**
   * Calculate API cost
   */
  private calculateAPICost(
    service: string,
    model: string,
    tokens?: { input?: number; output?: number }
  ): number {
    if (service !== 'openai' || !tokens) return 0;

    const pricing = COST_CONFIG.openai[model as keyof typeof COST_CONFIG.openai];
    if (!pricing) return 0;

    let cost = 0;
    if (tokens.input && 'input' in pricing) {
      cost += (tokens.input / 1000) * pricing.input;
    }
    if (tokens.output && 'output' in pricing) {
      cost += (tokens.output / 1000) * pricing.output;
    }

    return cost;
  }

  /**
   * Flush usage buffer to storage
   */
  private async flushUsageBuffer(): Promise<void> {
    if (this.usageBuffer.length === 0) return;

    const metrics = [...this.usageBuffer];
    this.usageBuffer = [];

    try {
      // Store in PostgreSQL for long-term analysis
      const query = `
        INSERT INTO usage_metrics (
          service, operation, user_id, quantity, unit, cost, 
          timestamp, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        for (const metric of metrics) {
          await client.query(query, [
            metric.service,
            metric.operation,
            metric.userId || null,
            metric.quantity,
            metric.unit,
            metric.cost,
            metric.timestamp,
            JSON.stringify(metric.metadata || {}),
          ]);
        }
        
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      logger.debug(`Flushed ${metrics.length} usage metrics to database`);

    } catch (error) {
      logger.error('Failed to flush usage metrics', { error: error as Error });
      // Re-add to buffer
      this.usageBuffer.unshift(...metrics);
    }
  }

  /**
   * Update real-time metrics in Redis
   */
  private async updateRealtimeMetrics(metric: UsageMetric): Promise<void> {
    const client = await redis.getClient();
    const hour = new Date().toISOString().substring(0, 13);
    const day = new Date().toISOString().substring(0, 10);

    // Update hourly counters
    await client.hIncrByFloat(
      `${this.COST_KEY_PREFIX}hourly:${hour}`,
      metric.service,
      metric.cost
    );
    await client.expire(`${this.COST_KEY_PREFIX}hourly:${hour}`, 86400); // 24 hours

    // Update daily counters
    await client.hIncrByFloat(
      `${this.COST_KEY_PREFIX}daily:${day}`,
      metric.service,
      metric.cost
    );
    await client.expire(`${this.COST_KEY_PREFIX}daily:${day}`, 2592000); // 30 days

    // Update user counters
    if (metric.userId) {
      await client.hIncrByFloat(
        `${this.COST_KEY_PREFIX}user:${metric.userId}:${day}`,
        metric.service,
        metric.cost
      );
      await client.expire(`${this.COST_KEY_PREFIX}user:${metric.userId}:${day}`, 2592000);
    }
  }

  /**
   * Check user budget
   */
  private async checkBudget(userId: string, cost: number): Promise<void> {
    const client = await redis.getClient();
    const budgetKey = `${this.BUDGET_KEY_PREFIX}${userId}`;
    
    const budget = await client.hGetAll(budgetKey);
    if (!budget.limit) return;

    const spent = parseFloat(budget.spent || '0') + cost;
    const limit = parseFloat(budget.limit);

    await client.hSet(budgetKey, 'spent', spent.toString());

    // Check thresholds
    const percentage = (spent / limit) * 100;
    
    if (percentage >= 100) {
      logger.warn(`User ${userId} exceeded budget`, { spent, limit });
      // Could implement budget enforcement here
    } else if (percentage >= 90) {
      logger.warn(`User ${userId} at 90% of budget`, { spent, limit, percentage });
    } else if (percentage >= 75) {
      logger.info(`User ${userId} at 75% of budget`, { spent, limit, percentage });
    }
  }

  /**
   * Set user budget
   */
  async setUserBudget(userId: string, limit: number, period: 'daily' | 'monthly'): Promise<void> {
    const client = await redis.getClient();
    const budgetKey = `${this.BUDGET_KEY_PREFIX}${userId}`;
    
    await client.hSet(budgetKey, {
      limit: limit.toString(),
      period,
      spent: '0',
      resetAt: this.getNextResetTime(period).toISOString(),
    });
    
    // Set expiry
    const ttl = period === 'daily' ? 86400 : 2592000;
    await client.expire(budgetKey, ttl);
  }

  /**
   * Generate cost report
   */
  async generateCostReport(
    period: 'hourly' | 'daily' | 'weekly' | 'monthly',
    date?: Date
  ): Promise<CostReport> {
    const endDate = date || new Date();
    const startDate = this.getStartDate(period, endDate);

    // Query aggregated data
    const query = `
      SELECT 
        service,
        operation,
        user_id,
        SUM(cost) as total_cost,
        COUNT(*) as request_count,
        SUM(quantity) as total_quantity
      FROM usage_metrics
      WHERE timestamp >= $1 AND timestamp < $2
      GROUP BY service, operation, user_id
    `;

    const result = await pool.query(query, [startDate, endDate]);

    // Aggregate results
    const byService: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    const byOperation: Record<string, number> = {};
    let totalCost = 0;

    for (const row of result.rows) {
      const cost = parseFloat(row.total_cost);
      totalCost += cost;

      byService[row.service] = (byService[row.service] || 0) + cost;
      byOperation[`${row.service}:${row.operation}`] = 
        (byOperation[`${row.service}:${row.operation}`] || 0) + cost;
      
      if (row.user_id) {
        byUser[row.user_id] = (byUser[row.user_id] || 0) + cost;
      }
    }

    // Calculate trends
    const trends = await this.calculateTrends(period, totalCost);

    return {
      period: `${period} ending ${endDate.toISOString()}`,
      totalCost,
      byService,
      byUser,
      byOperation,
      trends,
    };
  }

  /**
   * Calculate cost trends
   */
  private async calculateTrends(
    period: string,
    currentCost: number
  ): Promise<CostReport['trends']> {
    // Query historical data for trend analysis
    const query = `
      SELECT 
        DATE_TRUNC('day', timestamp) as day,
        SUM(cost) as daily_cost
      FROM usage_metrics
      WHERE timestamp >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY day
      ORDER BY day
    `;

    const result = await pool.query(query);
    const dailyCosts = result.rows.map(r => parseFloat(r.daily_cost));

    // Calculate metrics
    const dailyAverage = dailyCosts.length > 0
      ? dailyCosts.reduce((a, b) => a + b, 0) / dailyCosts.length
      : 0;

    // Weekly growth rate
    const lastWeek = dailyCosts.slice(-14, -7);
    const thisWeek = dailyCosts.slice(-7);
    const lastWeekAvg = lastWeek.length > 0
      ? lastWeek.reduce((a, b) => a + b, 0) / lastWeek.length
      : 0;
    const thisWeekAvg = thisWeek.length > 0
      ? thisWeek.reduce((a, b) => a + b, 0) / thisWeek.length
      : 0;
    const weeklyGrowth = lastWeekAvg > 0
      ? ((thisWeekAvg - lastWeekAvg) / lastWeekAvg) * 100
      : 0;

    // 30-day projection based on trend
    const projection = dailyAverage * 30 * (1 + weeklyGrowth / 100);

    return {
      dailyAverage,
      weeklyGrowth,
      projection,
    };
  }

  /**
   * Get real-time cost metrics
   */
  async getRealtimeCosts(): Promise<{
    hourly: Record<string, number>;
    daily: Record<string, number>;
    topUsers: Array<{ userId: string; cost: number }>;
  }> {
    const client = await redis.getClient();
    const hour = new Date().toISOString().substring(0, 13);
    const day = new Date().toISOString().substring(0, 10);

    // Get hourly costs
    const hourly = await client.hGetAll(`${this.COST_KEY_PREFIX}hourly:${hour}`);
    const hourlyCosts = Object.fromEntries(
      Object.entries(hourly).map(([k, v]) => [k, parseFloat(v)])
    );

    // Get daily costs
    const daily = await client.hGetAll(`${this.COST_KEY_PREFIX}daily:${day}`);
    const dailyCosts = Object.fromEntries(
      Object.entries(daily).map(([k, v]) => [k, parseFloat(v)])
    );

    // Get top users by cost
    const userPattern = `${this.COST_KEY_PREFIX}user:*:${day}`;
    const userKeys: string[] = [];
    for await (const key of client.scanIterator({ MATCH: userPattern })) {
      userKeys.push(key);
    }

    const topUsers: Array<{ userId: string; cost: number }> = [];
    for (const key of userKeys) {
      const userId = key.split(':')[2];
      const costs = await client.hGetAll(key);
      const totalCost = Object.values(costs).reduce(
        (sum, cost) => sum + parseFloat(cost),
        0
      );
      topUsers.push({ userId, cost: totalCost });
    }

    topUsers.sort((a, b) => b.cost - a.cost);

    return {
      hourly: hourlyCosts,
      daily: dailyCosts,
      topUsers: topUsers.slice(0, 10),
    };
  }

  /**
   * Alert on cost anomalies
   */
  async checkCostAnomalies(): Promise<void> {
    const current = await this.getRealtimeCosts();
    const totalHourlyCost = Object.values(current.hourly).reduce((a, b) => a + b, 0);

    // Get average hourly cost from last 7 days
    const avgQuery = `
      SELECT AVG(hourly_cost) as avg_cost
      FROM (
        SELECT 
          DATE_TRUNC('hour', timestamp) as hour,
          SUM(cost) as hourly_cost
        FROM usage_metrics
        WHERE timestamp >= CURRENT_TIMESTAMP - INTERVAL '7 days'
        GROUP BY hour
      ) hourly_costs
    `;

    const result = await pool.query(avgQuery);
    const avgHourlyCost = parseFloat(result.rows[0]?.avg_cost || '0');

    // Check for anomalies (2x average)
    if (totalHourlyCost > avgHourlyCost * 2) {
      logger.warn('Cost anomaly detected', {
        currentHourly: totalHourlyCost,
        averageHourly: avgHourlyCost,
        ratio: totalHourlyCost / avgHourlyCost,
      });
    }
  }

  // Helper methods

  private parseRedisMemory(info: string): number {
    const match = info.match(/used_memory:(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  private async collectDatabaseMetrics() {
    const sizeQuery = `
      SELECT pg_database_size(current_database()) as size,
             (SELECT count(*) FROM pg_stat_activity) as connections
    `;
    const result = await pool.query(sizeQuery);
    
    return {
      storageGB: parseInt(result.rows[0].size) / (1024 * 1024 * 1024),
      activeConnections: parseInt(result.rows[0].connections),
    };
  }

  private getStartDate(period: string, endDate: Date): Date {
    const start = new Date(endDate);
    switch (period) {
      case 'hourly':
        start.setHours(start.getHours() - 1);
        break;
      case 'daily':
        start.setDate(start.getDate() - 1);
        break;
      case 'weekly':
        start.setDate(start.getDate() - 7);
        break;
      case 'monthly':
        start.setMonth(start.getMonth() - 1);
        break;
    }
    return start;
  }

  private getNextResetTime(period: 'daily' | 'monthly'): Date {
    const now = new Date();
    if (period === 'daily') {
      now.setDate(now.getDate() + 1);
      now.setHours(0, 0, 0, 0);
    } else {
      now.setMonth(now.getMonth() + 1);
      now.setDate(1);
      now.setHours(0, 0, 0, 0);
    }
    return now;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flushUsageBuffer().catch(err => 
      logger.error('Failed to flush usage buffer on destroy', { error: err })
    );
  }
}

// Export singleton instance
export const costTracker = new CostTracker();

// Start periodic anomaly checks
setInterval(() => {
  costTracker.checkCostAnomalies().catch(err =>
    logger.error('Cost anomaly check failed', { error: err })
  );
}, 3600000); // Every hour

// Track infrastructure usage periodically
setInterval(() => {
  Promise.all([
    costTracker.trackDatabaseUsage(),
    costTracker.trackRedisUsage(),
  ]).catch(err => logger.error('Infrastructure tracking failed', { error: err }));
}, 300000); // Every 5 minutes