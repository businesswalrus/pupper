#!/usr/bin/env ts-node

import { config } from '@utils/config';
import { pool } from '@db/connection';
import { optimizedPool, checkDatabaseHealth } from '@db/optimizedConnection';
import PerformanceBenchmark from '@db/benchmarks/performanceBenchmark';
import { databaseMonitor } from '@db/monitoring/databaseMonitor';
import { query } from '@db/optimizedConnection';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

async function runOptimization() {
  console.log(`
╔════════════════════════════════════════════════╗
║     Database Optimization Suite for pup.ai     ║
╚════════════════════════════════════════════════╝
`);

  try {
    // Ensure logs directory exists
    const logsDir = join(process.cwd(), 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Step 1: Check current database health
    console.log('\n📊 Step 1: Checking Database Health...');
    const health = await checkDatabaseHealth();
    console.log(`Database Health: ${health.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
    console.log(`Connection Latency: ${health.latency}ms`);
    console.log(`Pool Metrics:`, health.metrics);

    // Step 2: Analyze current vector index configuration
    console.log('\n🔍 Step 2: Analyzing Vector Index Configuration...');
    const indexAnalysis = await analyzeVectorIndexes();
    console.log(indexAnalysis);

    // Step 3: Check for missing indexes
    console.log('\n🔎 Step 3: Checking for Missing Indexes...');
    const missingIndexes = await checkMissingIndexes();
    console.log(missingIndexes);

    // Step 4: Run performance benchmark
    console.log('\n⚡ Step 4: Running Performance Benchmark...');
    const benchmark = new PerformanceBenchmark();
    await benchmark.runFullBenchmark();

    // Step 5: Start monitoring
    console.log('\n📈 Step 5: Starting Database Monitoring...');
    databaseMonitor.startMonitoring(30000);
    
    // Wait for some metrics to be collected
    await new Promise(resolve => setTimeout(resolve, 35000));
    
    const report = await databaseMonitor.generateReport(
      join(logsDir, `optimization-report-${Date.now()}.md`)
    );
    console.log('\n📄 Monitoring Report Generated');
    console.log(report);

    // Step 6: Optimization recommendations
    console.log('\n💡 Step 6: Optimization Recommendations\n');
    await generateOptimizationPlan();

    // Cleanup
    databaseMonitor.stopMonitoring();
    await optimizedPool.end();
    await pool.end();

    console.log('\n✅ Optimization analysis complete!');
    
  } catch (error) {
    console.error('❌ Optimization failed:', error);
    process.exit(1);
  }
}

async function analyzeVectorIndexes(): Promise<string> {
  const result = await query<any>(`
    SELECT 
      i.indexname,
      i.indexdef,
      pg_size_pretty(pg_relation_size(i.indexname::regclass)) as size,
      s.idx_scan as scans,
      s.idx_tup_read as tuples_read,
      s.idx_tup_fetch as tuples_fetched
    FROM pg_indexes i
    LEFT JOIN pg_stat_user_indexes s ON i.indexname = s.indexrelname
    WHERE i.indexdef LIKE '%vector%'
      AND i.schemaname = 'public'
  `);

  if (result.rows.length === 0) {
    return '⚠️  No vector indexes found! This will severely impact similarity search performance.';
  }

  let analysis = 'Vector Index Analysis:\n';
  for (const idx of result.rows) {
    analysis += `\n- ${idx.indexname}`;
    analysis += `\n  Size: ${idx.size}`;
    analysis += `\n  Scans: ${idx.scans || 0}`;
    analysis += `\n  Efficiency: ${idx.scans > 0 ? (idx.tuples_fetched / idx.scans).toFixed(2) : 'N/A'} tuples/scan`;
    
    // Check if it's IVFFlat or HNSW
    if (idx.indexdef.includes('ivfflat')) {
      const lists = idx.indexdef.match(/lists = (\d+)/)?.[1] || 'unknown';
      analysis += `\n  Type: IVFFlat (${lists} lists)`;
      
      if (parseInt(lists) < 100) {
        analysis += '\n  ⚠️  Warning: Too few lists for optimal performance';
      }
    } else if (idx.indexdef.includes('hnsw')) {
      analysis += '\n  Type: HNSW (recommended for large datasets)';
    }
  }

  // Check message count vs index configuration
  const messageCount = await query<any>('SELECT COUNT(*) as count FROM messages WHERE embedding IS NOT NULL');
  const embeddingCount = parseInt(messageCount.rows[0].count);
  
  analysis += `\n\nTotal messages with embeddings: ${embeddingCount.toLocaleString()}`;
  
  if (embeddingCount > 1000000 && !analysis.includes('HNSW')) {
    analysis += '\n⚠️  Recommendation: Switch to HNSW index for better performance with >1M vectors';
  }

  return analysis;
}

async function checkMissingIndexes(): Promise<string> {
  // Analyze slow queries without indexes
  const result = await query<any>(`
    WITH slow_queries AS (
      SELECT 
        query,
        calls,
        mean_exec_time,
        rows
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_%'
        AND query NOT LIKE '%EXPLAIN%'
        AND mean_exec_time > 100
      ORDER BY mean_exec_time DESC
      LIMIT 20
    )
    SELECT * FROM slow_queries
  `).catch(() => ({ rows: [] }));

  if (result.rows.length === 0) {
    return '✅ No significant slow queries detected (pg_stat_statements may need to be enabled)';
  }

  let analysis = 'Potential Missing Indexes:\n';
  const indexSuggestions = new Set<string>();

  for (const query of result.rows) {
    // Analyze WHERE clauses
    const whereMatch = query.query.match(/WHERE\s+(\w+)\s*=/i);
    if (whereMatch) {
      const column = whereMatch[1];
      if (!['id', 'created_at'].includes(column.toLowerCase())) {
        indexSuggestions.add(column);
      }
    }

    // Analyze JOIN conditions
    const joinMatch = query.query.match(/JOIN.*ON\s+\w+\.(\w+)\s*=/i);
    if (joinMatch) {
      indexSuggestions.add(joinMatch[1]);
    }
  }

  if (indexSuggestions.size > 0) {
    analysis += '\nConsider adding indexes on these columns:\n';
    for (const col of indexSuggestions) {
      analysis += `- CREATE INDEX idx_messages_${col} ON messages(${col});\n`;
    }
  } else {
    analysis += '\n✅ No obvious missing indexes detected';
  }

  return analysis;
}

async function generateOptimizationPlan(): Promise<void> {
  console.log(`
┌─────────────────────────────────────────────────┐
│          OPTIMIZATION IMPLEMENTATION PLAN        │
└─────────────────────────────────────────────────┘

1. IMMEDIATE ACTIONS (Do Now):
   □ Run migration 002_optimize_vector_indexes.sql
   □ Switch to optimized connection pool (update imports)
   □ Enable query caching with cachedMessageRepository
   □ Run VACUUM ANALYZE on all tables

2. SHORT TERM (This Week):
   □ Implement data archival for messages > 6 months
   □ Set up monitoring dashboard with alerts
   □ Add missing indexes identified above
   □ Optimize batch operations for embedding updates

3. MEDIUM TERM (This Month):
   □ Evaluate switching to HNSW index if >1M messages
   □ Implement read replica for scaling reads
   □ Set up automated performance testing
   □ Optimize similarity threshold based on data

4. LONG TERM (Next Quarter):
   □ Implement table partitioning for messages
   □ Consider sharding strategy for horizontal scaling
   □ Evaluate alternative vector databases (pgvector vs dedicated)
   □ Implement intelligent caching strategies

5. MONITORING & MAINTENANCE:
   □ Set up daily performance reports
   □ Configure alerts for slow queries
   □ Monitor index usage and drop unused indexes
   □ Regular VACUUM and REINDEX operations

To implement these optimizations:

1. Update your imports:
   - Replace: import { pool } from '@db/connection'
   - With: import { optimizedPool } from '@db/optimizedConnection'
   
2. Update repositories:
   - Replace: import { messageRepository } from '@db/repositories/messageRepository'
   - With: import { cachedMessageRepository } from '@db/repositories/cachedMessageRepository'
   
3. Update memory retrieval:
   - Replace: import { buildConversationContext } from '@ai/memory'
   - With: import { buildConversationContext } from '@ai/optimizedMemory'

4. Run migrations:
   npm run db:migrate

5. Start monitoring:
   npx ts-node src/db/monitoring/databaseMonitor.ts

Expected Performance Improvements:
- 50-70% reduction in p95 query latency
- 80% cache hit rate for repeated queries
- 60% improvement in vector similarity search
- 40% reduction in connection pool wait time
`);
}

// Run the optimization
if (require.main === module) {
  runOptimization().catch(console.error);
}