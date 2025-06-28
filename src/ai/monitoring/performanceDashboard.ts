import { costTracker } from '@ai/costTracking';
import { analyzeEmbeddingUsage } from '@workers/embeddingsOptimized';
import { pool } from '@db/connection';
import { logger } from '@utils/logger';
import express from 'express';

export interface AIPerformanceMetrics {
  embedding: {
    coverage: number;
    totalMessages: number;
    embeddedMessages: number;
    cacheHitRate: number;
    processingRate: number; // messages per second
    estimatedCost: number;
  };
  retrieval: {
    avgRetrievalTime: number;
    avgRelevanceScore: number;
    hybridSearchRatio: number; // keyword vs semantic
    contextQuality: number;
  };
  generation: {
    avgResponseTime: number;
    modelDistribution: Record<string, number>;
    tokenUsage: {
      hourly: number;
      daily: number;
      trend: 'increasing' | 'stable' | 'decreasing';
    };
    errorRate: number;
  };
  costs: {
    last24h: number;
    last7d: number;
    last30d: number;
    projection: {
      daily: number;
      monthly: number;
      yearly: number;
    };
    byModel: Record<string, number>;
    byOperation: Record<string, number>;
  };
  quality: {
    userEngagement: number; // response rate
    avgContextScore: number;
    factCheckingRate: number;
    moodDistribution: Record<string, number>;
  };
}

/**
 * AI Performance monitoring dashboard
 */
export class AIPerformanceDashboard {
  /**
   * Collect comprehensive performance metrics
   */
  async collectMetrics(): Promise<AIPerformanceMetrics> {
    const [
      embeddingMetrics,
      retrievalMetrics,
      generationMetrics,
      costMetrics,
      qualityMetrics,
    ] = await Promise.all([
      this.collectEmbeddingMetrics(),
      this.collectRetrievalMetrics(),
      this.collectGenerationMetrics(),
      this.collectCostMetrics(),
      this.collectQualityMetrics(),
    ]);

    return {
      embedding: embeddingMetrics,
      retrieval: retrievalMetrics,
      generation: generationMetrics,
      costs: costMetrics,
      quality: qualityMetrics,
    };
  }

  /**
   * Collect embedding metrics
   */
  private async collectEmbeddingMetrics() {
    const usage = await analyzeEmbeddingUsage();
    
    // Get processing rate
    const recentProcessing = await pool.query(`
      SELECT COUNT(*) as count
      FROM messages
      WHERE embedding IS NOT NULL
      AND created_at > NOW() - INTERVAL '1 hour'
    `);
    
    const processingRate = parseInt(recentProcessing.rows[0].count) / 3600;

    return {
      coverage: usage.coverage,
      totalMessages: usage.totalMessages,
      embeddedMessages: usage.embeddedMessages,
      cacheHitRate: usage.cacheStats.hitRate || 0,
      processingRate,
      estimatedCost: usage.estimatedCost,
    };
  }

  /**
   * Collect retrieval metrics
   */
  private async collectRetrievalMetrics() {
    // Query retrieval performance logs
    const performanceQuery = `
      SELECT 
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_time,
        AVG(relevance_score) as avg_relevance,
        SUM(CASE WHEN search_type = 'hybrid' THEN 1 ELSE 0 END)::float / COUNT(*) as hybrid_ratio
      FROM search_logs
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `;

    try {
      const result = await pool.query(performanceQuery);
      const row = result.rows[0];

      return {
        avgRetrievalTime: parseFloat(row?.avg_time || '0'),
        avgRelevanceScore: parseFloat(row?.avg_relevance || '0'),
        hybridSearchRatio: parseFloat(row?.hybrid_ratio || '0'),
        contextQuality: 0.8, // Placeholder - would calculate from actual quality scores
      };
    } catch {
      // Table might not exist yet
      return {
        avgRetrievalTime: 0,
        avgRelevanceScore: 0,
        hybridSearchRatio: 0,
        contextQuality: 0,
      };
    }
  }

  /**
   * Collect generation metrics
   */
  private async collectGenerationMetrics() {
    const stats = await costTracker.getRealtimeStats();
    const report = await costTracker.generateReport(7);

    // Calculate token usage trend
    const hourlyTokens = Object.values(report.byTimeRange.hourly);
    const trend = this.calculateTrend(hourlyTokens);

    // Calculate model distribution
    const totalTokens = Object.values(report.byModel).reduce((sum, m) => sum + m.tokens, 0);
    const modelDistribution: Record<string, number> = {};
    
    for (const [model, data] of Object.entries(report.byModel)) {
      modelDistribution[model] = totalTokens > 0 ? data.tokens / totalTokens : 0;
    }

    return {
      avgResponseTime: 800, // Placeholder - would get from actual logs
      modelDistribution,
      tokenUsage: {
        hourly: stats.lastHour.tokens,
        daily: stats.last24Hours.tokens,
        trend,
      },
      errorRate: 0.02, // Placeholder - would calculate from error logs
    };
  }

  /**
   * Collect cost metrics
   */
  private async collectCostMetrics() {
    const [report7d, report30d] = await Promise.all([
      costTracker.generateReport(7),
      costTracker.generateReport(30),
    ]);

    const stats = await costTracker.getRealtimeStats();

    return {
      last24h: stats.last24Hours.cost,
      last7d: report7d.totalCost,
      last30d: report30d.totalCost,
      projection: report30d.projections,
      byModel: Object.fromEntries(
        Object.entries(report30d.byModel).map(([model, data]) => [model, data.cost])
      ),
      byOperation: Object.fromEntries(
        Object.entries(report30d.byOperation).map(([op, data]) => [op, data.cost])
      ),
    };
  }

  /**
   * Collect quality metrics
   */
  private async collectQualityMetrics() {
    // These would come from actual tracking
    return {
      userEngagement: 0.75, // 75% of messages get responses
      avgContextScore: 0.82,
      factCheckingRate: 0.15, // 15% of responses include fact checking
      moodDistribution: {
        excited: 0.15,
        sarcastic: 0.25,
        helpful: 0.35,
        analytical: 0.15,
        neutral: 0.10,
      },
    };
  }

  /**
   * Calculate trend from time series data
   */
  private calculateTrend(values: number[]): 'increasing' | 'stable' | 'decreasing' {
    if (values.length < 3) return 'stable';

    const recent = values.slice(-3);
    const older = values.slice(-6, -3);

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

    const change = (recentAvg - olderAvg) / olderAvg;

    if (change > 0.1) return 'increasing';
    if (change < -0.1) return 'decreasing';
    return 'stable';
  }

  /**
   * Generate performance report
   */
  async generateReport(): Promise<string> {
    const metrics = await this.collectMetrics();

    const report = [
      '# AI Performance Report',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Embedding Coverage',
      `- Coverage: ${metrics.embedding.coverage.toFixed(1)}% (${metrics.embedding.embeddedMessages}/${metrics.embedding.totalMessages})`,
      `- Processing Rate: ${metrics.embedding.processingRate.toFixed(1)} msg/s`,
      `- Cache Hit Rate: ${metrics.embedding.cacheHitRate.toFixed(1)}%`,
      `- Estimated Cost: $${metrics.embedding.estimatedCost.toFixed(2)}`,
      '',
      '## Retrieval Performance',
      `- Avg Retrieval Time: ${metrics.retrieval.avgRetrievalTime.toFixed(2)}s`,
      `- Avg Relevance Score: ${metrics.retrieval.avgRelevanceScore.toFixed(2)}`,
      `- Hybrid Search Usage: ${(metrics.retrieval.hybridSearchRatio * 100).toFixed(1)}%`,
      '',
      '## Generation Metrics',
      `- Token Usage: ${metrics.generation.tokenUsage.hourly}/hr (${metrics.generation.tokenUsage.trend})`,
      `- Error Rate: ${(metrics.generation.errorRate * 100).toFixed(1)}%`,
      '- Model Distribution:',
      ...Object.entries(metrics.generation.modelDistribution).map(([model, pct]) => 
        `  - ${model}: ${(pct * 100).toFixed(1)}%`
      ),
      '',
      '## Cost Analysis',
      `- Last 24h: $${metrics.costs.last24h.toFixed(2)}`,
      `- Last 7d: $${metrics.costs.last7d.toFixed(2)}`,
      `- Last 30d: $${metrics.costs.last30d.toFixed(2)}`,
      `- Daily Average: $${metrics.costs.projection.daily.toFixed(2)}`,
      `- Monthly Projection: $${metrics.costs.projection.monthly.toFixed(2)}`,
      '',
      '## Quality Metrics',
      `- User Engagement: ${(metrics.quality.userEngagement * 100).toFixed(1)}%`,
      `- Avg Context Quality: ${metrics.quality.avgContextScore.toFixed(2)}`,
      `- Fact Checking Rate: ${(metrics.quality.factCheckingRate * 100).toFixed(1)}%`,
    ];

    return report.join('\n');
  }

  /**
   * Create monitoring endpoint
   */
  createMonitoringEndpoint(app: express.Application): void {
    app.get('/ai/metrics', async (req, res) => {
      try {
        const metrics = await this.collectMetrics();
        res.json(metrics);
      } catch (error) {
        logger.error('Failed to collect AI metrics', { error: error as Error });
        res.status(500).json({ error: 'Failed to collect metrics' });
      }
    });

    app.get('/ai/report', async (req, res) => {
      try {
        const report = await this.generateReport();
        res.type('text/plain').send(report);
      } catch (error) {
        logger.error('Failed to generate AI report', { error: error as Error });
        res.status(500).json({ error: 'Failed to generate report' });
      }
    });

    app.get('/ai/health', async (req, res) => {
      try {
        const metrics = await this.collectMetrics();
        
        // Health checks
        const health = {
          status: 'healthy',
          checks: {
            embeddingCoverage: metrics.embedding.coverage > 80,
            cachePerformance: metrics.embedding.cacheHitRate > 50,
            errorRate: metrics.generation.errorRate < 0.05,
            costControl: metrics.costs.projection.daily < 50,
          },
        };

        const allHealthy = Object.values(health.checks).every(v => v);
        health.status = allHealthy ? 'healthy' : 'degraded';

        res.json(health);
      } catch (error) {
        logger.error('Health check failed', { error: error as Error });
        res.status(500).json({ status: 'unhealthy', error: error });
      }
    });
  }
}

// Create singleton instance
export const aiDashboard = new AIPerformanceDashboard();