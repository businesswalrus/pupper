import { Redis } from 'ioredis';
import { config } from '@utils/config';
import { logger } from '@utils/logger';

export interface ModelCosts {
  'gpt-4-turbo-preview': { prompt: number; completion: number };
  'gpt-4': { prompt: number; completion: number };
  'gpt-3.5-turbo': { prompt: number; completion: number };
  'text-embedding-3-small': { prompt: number; completion: number };
  'text-embedding-3-large': { prompt: number; completion: number };
}

// Cost per 1K tokens in USD
const MODEL_COSTS: ModelCosts = {
  'gpt-4-turbo-preview': { prompt: 0.01, completion: 0.03 },
  'gpt-4': { prompt: 0.03, completion: 0.06 },
  'gpt-3.5-turbo': { prompt: 0.0005, completion: 0.0015 },
  'text-embedding-3-small': { prompt: 0.00002, completion: 0 },
  'text-embedding-3-large': { prompt: 0.00013, completion: 0 },
};

export interface UsageMetrics {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  timestamp: Date;
  operation: string;
  userId?: string;
  channelId?: string;
}

export interface CostReport {
  totalCost: number;
  byModel: Record<string, { tokens: number; cost: number }>;
  byOperation: Record<string, { tokens: number; cost: number }>;
  byTimeRange: {
    hourly: Record<string, number>;
    daily: Record<string, number>;
  };
  projections: {
    dailyAverage: number;
    monthlyProjection: number;
    yearlyProjection: number;
  };
}

/**
 * AI cost tracking and optimization system
 */
export class CostTracker {
  private redis: Redis;
  private readonly KEY_PREFIX = 'ai:cost:';
  private readonly RETENTION_DAYS = 90;

  constructor() {
    this.redis = new Redis(config.redis.url);
  }

  /**
   * Track AI API usage
   */
  async trackUsage(metrics: UsageMetrics): Promise<void> {
    try {
      const cost = this.calculateCost(
        metrics.model,
        metrics.promptTokens,
        metrics.completionTokens
      );

      const enrichedMetrics = {
        ...metrics,
        cost,
        timestamp: metrics.timestamp || new Date(),
      };

      // Store in time-series format
      const dateKey = new Date().toISOString().split('T')[0];
      const hourKey = new Date().getHours().toString().padStart(2, '0');

      // Store detailed metrics
      await this.redis.zadd(
        `${this.KEY_PREFIX}usage:${dateKey}`,
        Date.now(),
        JSON.stringify(enrichedMetrics)
      );

      // Update aggregates
      await Promise.all([
        this.redis.hincrby(`${this.KEY_PREFIX}daily:${dateKey}`, 'totalTokens', metrics.totalTokens),
        this.redis.hincrbyfloat(`${this.KEY_PREFIX}daily:${dateKey}`, 'totalCost', cost),
        this.redis.hincrby(`${this.KEY_PREFIX}hourly:${dateKey}:${hourKey}`, 'totalTokens', metrics.totalTokens),
        this.redis.hincrbyfloat(`${this.KEY_PREFIX}hourly:${dateKey}:${hourKey}`, 'totalCost', cost),
        this.redis.hincrby(`${this.KEY_PREFIX}model:${metrics.model}`, 'totalTokens', metrics.totalTokens),
        this.redis.hincrbyfloat(`${this.KEY_PREFIX}model:${metrics.model}`, 'totalCost', cost),
        this.redis.hincrby(`${this.KEY_PREFIX}operation:${metrics.operation}`, 'totalTokens', metrics.totalTokens),
        this.redis.hincrbyfloat(`${this.KEY_PREFIX}operation:${metrics.operation}`, 'totalCost', cost),
      ]);

      // Set expiration
      await this.redis.expire(
        `${this.KEY_PREFIX}usage:${dateKey}`,
        this.RETENTION_DAYS * 24 * 60 * 60
      );

      // Check budget alerts
      await this.checkBudgetAlerts(dateKey, cost);
    } catch (error) {
      logger.error('Failed to track AI usage', { error: error as Error });
    }
  }

  /**
   * Calculate cost for a model usage
   */
  private calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number
  ): number {
    const costs = MODEL_COSTS[model as keyof ModelCosts];
    if (!costs) {
      logger.warn(`Unknown model for cost calculation: ${model}`);
      return 0;
    }

    const promptCost = (promptTokens / 1000) * costs.prompt;
    const completionCost = (completionTokens / 1000) * costs.completion;
    
    return promptCost + completionCost;
  }

  /**
   * Generate cost report for a time range
   */
  async generateReport(days: number = 30): Promise<CostReport> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const report: CostReport = {
      totalCost: 0,
      byModel: {},
      byOperation: {},
      byTimeRange: {
        hourly: {},
        daily: {},
      },
      projections: {
        dailyAverage: 0,
        monthlyProjection: 0,
        yearlyProjection: 0,
      },
    };

    // Collect daily data
    for (let d = 0; d < days; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dateKey = date.toISOString().split('T')[0];

      const dailyData = await this.redis.hgetall(`${this.KEY_PREFIX}daily:${dateKey}`);
      if (dailyData.totalCost) {
        const cost = parseFloat(dailyData.totalCost);
        report.totalCost += cost;
        report.byTimeRange.daily[dateKey] = cost;
      }

      // Collect hourly data for recent days
      if (d >= days - 7) {
        for (let h = 0; h < 24; h++) {
          const hourKey = h.toString().padStart(2, '0');
          const hourlyData = await this.redis.hgetall(
            `${this.KEY_PREFIX}hourly:${dateKey}:${hourKey}`
          );
          if (hourlyData.totalCost) {
            report.byTimeRange.hourly[`${dateKey}T${hourKey}`] = parseFloat(hourlyData.totalCost);
          }
        }
      }
    }

    // Collect model data
    const models = Object.keys(MODEL_COSTS);
    for (const model of models) {
      const modelData = await this.redis.hgetall(`${this.KEY_PREFIX}model:${model}`);
      if (modelData.totalTokens) {
        report.byModel[model] = {
          tokens: parseInt(modelData.totalTokens),
          cost: parseFloat(modelData.totalCost || '0'),
        };
      }
    }

    // Collect operation data
    const operations = ['generateResponse', 'generateEmbedding', 'searchIntegration', 'interjection'];
    for (const operation of operations) {
      const opData = await this.redis.hgetall(`${this.KEY_PREFIX}operation:${operation}`);
      if (opData.totalTokens) {
        report.byOperation[operation] = {
          tokens: parseInt(opData.totalTokens),
          cost: parseFloat(opData.totalCost || '0'),
        };
      }
    }

    // Calculate projections
    const activeDays = Object.keys(report.byTimeRange.daily).length;
    if (activeDays > 0) {
      report.projections.dailyAverage = report.totalCost / activeDays;
      report.projections.monthlyProjection = report.projections.dailyAverage * 30;
      report.projections.yearlyProjection = report.projections.dailyAverage * 365;
    }

    return report;
  }

  /**
   * Get real-time usage statistics
   */
  async getRealtimeStats(): Promise<{
    last24Hours: { cost: number; tokens: number };
    lastHour: { cost: number; tokens: number };
    currentRate: number; // tokens per minute
  }> {
    const now = new Date();
    const dateKey = now.toISOString().split('T')[0];
    const hourKey = now.getHours().toString().padStart(2, '0');

    // Get last 24 hours
    let last24HoursCost = 0;
    let last24HoursTokens = 0;

    for (let h = 0; h < 24; h++) {
      const checkDate = new Date(now);
      checkDate.setHours(checkDate.getHours() - h);
      const checkDateKey = checkDate.toISOString().split('T')[0];
      const checkHourKey = checkDate.getHours().toString().padStart(2, '0');

      const hourlyData = await this.redis.hgetall(
        `${this.KEY_PREFIX}hourly:${checkDateKey}:${checkHourKey}`
      );

      if (hourlyData.totalCost) {
        last24HoursCost += parseFloat(hourlyData.totalCost);
        last24HoursTokens += parseInt(hourlyData.totalTokens || '0');
      }
    }

    // Get last hour
    const lastHourData = await this.redis.hgetall(
      `${this.KEY_PREFIX}hourly:${dateKey}:${hourKey}`
    );

    // Calculate current rate (tokens per minute)
    const recentUsage = await this.redis.zrangebyscore(
      `${this.KEY_PREFIX}usage:${dateKey}`,
      Date.now() - 5 * 60 * 1000, // Last 5 minutes
      Date.now()
    );

    let recentTokens = 0;
    recentUsage.forEach(entry => {
      try {
        const metrics = JSON.parse(entry);
        recentTokens += metrics.totalTokens || 0;
      } catch {}
    });

    const currentRate = recentTokens / 5; // Average per minute

    return {
      last24Hours: { cost: last24HoursCost, tokens: last24HoursTokens },
      lastHour: {
        cost: parseFloat(lastHourData.totalCost || '0'),
        tokens: parseInt(lastHourData.totalTokens || '0'),
      },
      currentRate,
    };
  }

  /**
   * Model selection based on query complexity
   */
  async selectOptimalModel(
    query: string,
    context: {
      requiresSearch?: boolean;
      conversationLength?: number;
      responseComplexity?: 'simple' | 'moderate' | 'complex';
    } = {}
  ): Promise<{
    model: string;
    reasoning: string;
    estimatedCost: number;
  }> {
    const { requiresSearch, conversationLength = 0, responseComplexity = 'moderate' } = context;

    // Estimate token usage
    const estimatedPromptTokens = 
      query.length / 4 + // Query tokens
      conversationLength * 50 + // Context tokens
      200; // System prompt tokens

    const estimatedCompletionTokens = 
      responseComplexity === 'simple' ? 50 :
      responseComplexity === 'moderate' ? 150 :
      300;

    // Model selection logic
    let selectedModel = 'gpt-3.5-turbo';
    let reasoning = 'Default economical choice';

    if (requiresSearch || responseComplexity === 'complex') {
      selectedModel = 'gpt-4-turbo-preview';
      reasoning = 'Complex query requiring advanced reasoning';
    } else if (conversationLength > 20) {
      selectedModel = 'gpt-4-turbo-preview';
      reasoning = 'Long conversation requiring better context understanding';
    } else if (query.includes('code') || query.includes('debug')) {
      selectedModel = 'gpt-4';
      reasoning = 'Technical query requiring code understanding';
    }

    // Check current spending rate
    const stats = await this.getRealtimeStats();
    if (stats.lastHour.cost > 1.0) { // $1/hour threshold
      selectedModel = 'gpt-3.5-turbo';
      reasoning += ' (Cost optimization due to high usage)';
    }

    const estimatedCost = this.calculateCost(
      selectedModel,
      estimatedPromptTokens,
      estimatedCompletionTokens
    );

    return {
      model: selectedModel,
      reasoning,
      estimatedCost,
    };
  }

  /**
   * Check budget alerts
   */
  private async checkBudgetAlerts(dateKey: string, additionalCost: number): Promise<void> {
    const dailyData = await this.redis.hgetall(`${this.KEY_PREFIX}daily:${dateKey}`);
    const dailyCost = parseFloat(dailyData.totalCost || '0');

    const budgets = {
      daily: parseFloat(process.env.AI_DAILY_BUDGET || '10'),
      hourly: parseFloat(process.env.AI_HOURLY_BUDGET || '1'),
    };

    if (dailyCost > budgets.daily) {
      logger.warn('Daily AI budget exceeded', {
        metadata: {
          dailyCost,
          budget: budgets.daily,
          date: dateKey,
        },
      });
      // Could trigger alerts, throttling, etc.
    }

    if (dailyCost > budgets.daily * 0.8) {
      logger.warn('Approaching daily AI budget limit', {
        metadata: {
          dailyCost,
          budget: budgets.daily,
          percentage: (dailyCost / budgets.daily) * 100,
        },
      });
    }
  }

  /**
   * Export usage data for analysis
   */
  async exportUsageData(startDate: Date, endDate: Date): Promise<UsageMetrics[]> {
    const data: UsageMetrics[] = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      const dateKey = current.toISOString().split('T')[0];
      const usage = await this.redis.zrangebyscore(
        `${this.KEY_PREFIX}usage:${dateKey}`,
        '-inf',
        '+inf'
      );

      usage.forEach(entry => {
        try {
          const metrics = JSON.parse(entry);
          data.push(metrics);
        } catch (error) {
          logger.error('Failed to parse usage entry', { error: error as Error });
        }
      });

      current.setDate(current.getDate() + 1);
    }

    return data;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Singleton instance
export const costTracker = new CostTracker();