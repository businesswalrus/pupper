import { query } from '@db/optimizedConnection';
import { redis } from '@db/redis';
import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { join } from 'path';

interface DatabaseMetrics {
  timestamp: Date;
  connections: {
    active: number;
    idle: number;
    waiting: number;
    max: number;
  };
  performance: {
    slowQueries: QueryInfo[];
    avgQueryTime: number;
    cacheHitRate: number;
    indexUsage: IndexUsage[];
  };
  storage: {
    databaseSize: string;
    tableSize: TableSize[];
    indexSize: string;
    archiveSize: string;
  };
  vectorSearch: {
    avgSimilaritySearchTime: number;
    indexEfficiency: number;
    embeddingCoverage: number;
  };
  replication?: {
    lag: number;
    status: string;
  };
}

interface QueryInfo {
  query: string;
  duration: number;
  calls: number;
}

interface IndexUsage {
  indexName: string;
  tableName: string;
  indexScans: number;
  indexSize: string;
  efficiency: number;
}

interface TableSize {
  tableName: string;
  rowCount: number;
  totalSize: string;
  indexSize: string;
  toastSize: string;
}

export class DatabaseMonitor extends EventEmitter {
  private metricsHistory: DatabaseMetrics[] = [];
  private readonly MAX_HISTORY = 1000;
  private monitoringInterval?: NodeJS.Timeout;
  
  async startMonitoring(intervalMs: number = 60000): Promise<void> {
    console.log('🔍 Starting database monitoring...');
    
    // Initial collection
    await this.collectMetrics();
    
    // Set up interval
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.collectMetrics();
      } catch (error) {
        console.error('Error collecting metrics:', error);
      }
    }, intervalMs);
  }
  
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      console.log('🛑 Database monitoring stopped');
    }
  }
  
  private async collectMetrics(): Promise<void> {
    const metrics: DatabaseMetrics = {
      timestamp: new Date(),
      connections: await this.getConnectionMetrics(),
      performance: await this.getPerformanceMetrics(),
      storage: await this.getStorageMetrics(),
      vectorSearch: await this.getVectorSearchMetrics(),
    };
    
    // Check for replication
    const replicationStatus = await this.getReplicationStatus();
    if (replicationStatus) {
      metrics.replication = replicationStatus;
    }
    
    // Store metrics
    this.metricsHistory.push(metrics);
    if (this.metricsHistory.length > this.MAX_HISTORY) {
      this.metricsHistory.shift();
    }
    
    // Emit metrics event
    this.emit('metrics', metrics);
    
    // Check for alerts
    await this.checkAlerts(metrics);
  }
  
  private async getConnectionMetrics(): Promise<DatabaseMetrics['connections']> {
    const result = await query<any>(`
      SELECT 
        count(*) FILTER (WHERE state = 'active') as active,
        count(*) FILTER (WHERE state = 'idle') as idle,
        count(*) FILTER (WHERE state = 'idle in transaction') as idle_in_transaction,
        count(*) FILTER (WHERE wait_event_type = 'Client') as waiting,
        setting::int as max_connections
      FROM pg_stat_activity, pg_settings
      WHERE pg_settings.name = 'max_connections'
      GROUP BY setting
    `);
    
    const row = result.rows[0] || {};
    return {
      active: parseInt(row.active) || 0,
      idle: parseInt(row.idle) || 0,
      waiting: parseInt(row.waiting) || 0,
      max: parseInt(row.max_connections) || 100,
    };
  }
  
  private async getPerformanceMetrics(): Promise<DatabaseMetrics['performance']> {
    // Get slow queries
    const slowQueriesResult = await query<any>(`
      SELECT 
        query,
        mean_exec_time as duration,
        calls
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
        AND mean_exec_time > 1000
      ORDER BY mean_exec_time DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));
    
    // Get cache hit rate
    const cacheResult = await query<any>(`
      SELECT 
        sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0) as cache_hit_rate
      FROM pg_statio_user_tables
    `);
    
    // Get index usage
    const indexUsageResult = await query<any>(`
      SELECT 
        schemaname || '.' || tablename as table_name,
        indexrelname as index_name,
        idx_scan as index_scans,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        CASE 
          WHEN idx_scan = 0 THEN 0
          ELSE round(100.0 * idx_scan / (seq_scan + idx_scan), 2)
        END as efficiency
      FROM pg_stat_user_indexes
      JOIN pg_stat_user_tables USING (schemaname, tablename)
      WHERE schemaname = 'public'
      ORDER BY idx_scan DESC
      LIMIT 10
    `);
    
    // Calculate average query time from our monitoring
    const client = await redis.getClient();
    const avgQueryTime = parseFloat(await client.get('avg_query_time') || '0');
    
    return {
      slowQueries: slowQueriesResult.rows.map((row: any) => ({
        query: row.query.substring(0, 100),
        duration: parseFloat(row.duration),
        calls: parseInt(row.calls),
      })),
      avgQueryTime,
      cacheHitRate: parseFloat(cacheResult.rows[0]?.cache_hit_rate || '0'),
      indexUsage: indexUsageResult.rows.map((row: any) => ({
        indexName: row.index_name,
        tableName: row.table_name,
        indexScans: parseInt(row.index_scans),
        indexSize: row.index_size,
        efficiency: parseFloat(row.efficiency),
      })),
    };
  }
  
  private async getStorageMetrics(): Promise<DatabaseMetrics['storage']> {
    // Database size
    const dbSizeResult = await query<any>(`
      SELECT pg_size_pretty(pg_database_size(current_database())) as db_size
    `);
    
    // Table sizes
    const tableSizeResult = await query<any>(`
      SELECT 
        schemaname || '.' || tablename as table_name,
        n_live_tup as row_count,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as total_size,
        pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) as index_size,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename) - pg_indexes_size(schemaname || '.' || tablename)) as toast_size
      FROM pg_stat_user_tables
      WHERE schemaname IN ('public', 'archive')
      ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
      LIMIT 10
    `);
    
    // Archive size
    const archiveSizeResult = await query<any>(`
      SELECT pg_size_pretty(pg_total_relation_size('archive.messages')) as archive_size
    `).catch(() => ({ rows: [{ archive_size: '0 bytes' }] }));
    
    // Total index size
    const indexSizeResult = await query<any>(`
      SELECT pg_size_pretty(sum(pg_relation_size(indexrelid))) as total_index_size
      FROM pg_index
    `);
    
    return {
      databaseSize: dbSizeResult.rows[0].db_size,
      tableSize: tableSizeResult.rows.map((row: any) => ({
        tableName: row.table_name,
        rowCount: parseInt(row.row_count),
        totalSize: row.total_size,
        indexSize: row.index_size,
        toastSize: row.toast_size,
      })),
      indexSize: indexSizeResult.rows[0].total_index_size,
      archiveSize: archiveSizeResult.rows[0].archive_size,
    };
  }
  
  private async getVectorSearchMetrics(): Promise<DatabaseMetrics['vectorSearch']> {
    // Average similarity search time
    const client = await redis.getClient();
    const avgSearchTime = parseFloat(await client.get('avg_vector_search_time') || '0');
    
    // Index efficiency (using EXPLAIN on a sample query)
    const efficiencyResult = await query<any>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM messages
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> (SELECT embedding FROM messages WHERE embedding IS NOT NULL LIMIT 1)
      LIMIT 10
    `).catch(() => ({ rows: [] }));
    
    // Embedding coverage
    const coverageResult = await query<any>(`
      SELECT 
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::float / COUNT(*)::float as coverage
      FROM messages
    `);
    
    // Parse efficiency from EXPLAIN
    let indexEfficiency = 0;
    if (efficiencyResult.rows.length > 0) {
      const plan = efficiencyResult.rows[0]['QUERY PLAN'][0]['Plan'];
      if (plan['Node Type'].includes('Index')) {
        indexEfficiency = 1.0;
      }
    }
    
    return {
      avgSimilaritySearchTime: avgSearchTime,
      indexEfficiency,
      embeddingCoverage: parseFloat(coverageResult.rows[0].coverage),
    };
  }
  
  private async getReplicationStatus(): Promise<DatabaseMetrics['replication'] | null> {
    try {
      const result = await query<any>(`
        SELECT 
          pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as lag_bytes,
          state
        FROM pg_stat_replication
        WHERE application_name IS NOT NULL
        LIMIT 1
      `);
      
      if (result.rows.length > 0) {
        return {
          lag: parseInt(result.rows[0].lag_bytes) || 0,
          status: result.rows[0].state,
        };
      }
    } catch (error) {
      // No replication configured
    }
    
    return null;
  }
  
  private async checkAlerts(metrics: DatabaseMetrics): Promise<void> {
    const alerts: string[] = [];
    
    // Connection pool alerts
    const connectionUsage = (metrics.connections.active + metrics.connections.idle) / metrics.connections.max;
    if (connectionUsage > 0.8) {
      alerts.push(`High connection usage: ${(connectionUsage * 100).toFixed(1)}%`);
    }
    
    // Cache hit rate alert
    if (metrics.performance.cacheHitRate < 0.9) {
      alerts.push(`Low cache hit rate: ${(metrics.performance.cacheHitRate * 100).toFixed(1)}%`);
    }
    
    // Slow query alert
    if (metrics.performance.slowQueries.length > 5) {
      alerts.push(`${metrics.performance.slowQueries.length} slow queries detected`);
    }
    
    // Vector search coverage alert
    if (metrics.vectorSearch.embeddingCoverage < 0.8) {
      alerts.push(`Low embedding coverage: ${(metrics.vectorSearch.embeddingCoverage * 100).toFixed(1)}%`);
    }
    
    // Replication lag alert
    if (metrics.replication && metrics.replication.lag > 1000000) {
      alerts.push(`High replication lag: ${(metrics.replication.lag / 1000000).toFixed(1)}MB`);
    }
    
    // Emit alerts
    if (alerts.length > 0) {
      this.emit('alerts', alerts);
      console.warn('⚠️ Database Alerts:', alerts);
    }
  }
  
  getLatestMetrics(): DatabaseMetrics | null {
    return this.metricsHistory[this.metricsHistory.length - 1] || null;
  }
  
  getMetricsHistory(): DatabaseMetrics[] {
    return [...this.metricsHistory];
  }
  
  async generateReport(outputPath?: string): Promise<string> {
    const metrics = this.getLatestMetrics();
    if (!metrics) {
      return 'No metrics available';
    }
    
    const report = `
# Database Performance Report
Generated: ${new Date().toISOString()}

## Connection Pool Status
- Active: ${metrics.connections.active}/${metrics.connections.max} (${((metrics.connections.active / metrics.connections.max) * 100).toFixed(1)}%)
- Idle: ${metrics.connections.idle}
- Waiting: ${metrics.connections.waiting}

## Performance Metrics
- Average Query Time: ${metrics.performance.avgQueryTime.toFixed(2)}ms
- Cache Hit Rate: ${(metrics.performance.cacheHitRate * 100).toFixed(1)}%
- Slow Queries: ${metrics.performance.slowQueries.length}

### Top Slow Queries
${metrics.performance.slowQueries.slice(0, 5).map(q => 
  `- ${q.query} (${q.duration.toFixed(2)}ms, ${q.calls} calls)`
).join('\n')}

## Storage Usage
- Database Size: ${metrics.storage.databaseSize}
- Index Size: ${metrics.storage.indexSize}
- Archive Size: ${metrics.storage.archiveSize}

### Largest Tables
${metrics.storage.tableSize.slice(0, 5).map(t =>
  `- ${t.tableName}: ${t.totalSize} (${t.rowCount.toLocaleString()} rows)`
).join('\n')}

## Vector Search Performance
- Average Search Time: ${metrics.vectorSearch.avgSimilaritySearchTime.toFixed(2)}ms
- Index Efficiency: ${(metrics.vectorSearch.indexEfficiency * 100).toFixed(1)}%
- Embedding Coverage: ${(metrics.vectorSearch.embeddingCoverage * 100).toFixed(1)}%

${metrics.replication ? `
## Replication Status
- Status: ${metrics.replication.status}
- Lag: ${(metrics.replication.lag / 1000).toFixed(1)}KB
` : ''}

## Recommendations
${this.generateRecommendations(metrics).map(r => `- ${r}`).join('\n')}
`;
    
    if (outputPath) {
      writeFileSync(outputPath, report);
      console.log(`✅ Report saved to ${outputPath}`);
    }
    
    return report;
  }
  
  private generateRecommendations(metrics: DatabaseMetrics): string[] {
    const recommendations: string[] = [];
    
    if (metrics.performance.cacheHitRate < 0.9) {
      recommendations.push('Consider increasing shared_buffers to improve cache hit rate');
    }
    
    if (metrics.connections.active > metrics.connections.max * 0.8) {
      recommendations.push('Connection pool is near capacity - consider increasing max_connections');
    }
    
    if (metrics.vectorSearch.embeddingCoverage < 0.9) {
      recommendations.push('Run embedding generation job to improve vector search coverage');
    }
    
    const unusedIndexes = metrics.performance.indexUsage.filter(i => i.indexScans === 0);
    if (unusedIndexes.length > 0) {
      recommendations.push(`Consider dropping unused indexes: ${unusedIndexes.map(i => i.indexName).join(', ')}`);
    }
    
    if (metrics.storage.archiveSize === '0 bytes') {
      recommendations.push('Enable data archival for messages older than 6 months');
    }
    
    return recommendations;
  }
}

// Export singleton instance
export const databaseMonitor = new DatabaseMonitor();

// CLI interface
if (require.main === module) {
  const monitor = new DatabaseMonitor();
  
  // Start monitoring
  monitor.startMonitoring(30000); // Every 30 seconds
  
  // Log metrics
  monitor.on('metrics', (metrics) => {
    console.log('📊 Metrics collected:', new Date().toISOString());
  });
  
  // Handle alerts
  monitor.on('alerts', (alerts) => {
    console.error('🚨 Alerts:', alerts);
  });
  
  // Generate report every 5 minutes
  setInterval(async () => {
    const report = await monitor.generateReport(
      join(process.cwd(), 'logs', `db-report-${Date.now()}.md`)
    );
    console.log('📄 Report generated');
  }, 300000);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    monitor.stopMonitoring();
    process.exit(0);
  });
}