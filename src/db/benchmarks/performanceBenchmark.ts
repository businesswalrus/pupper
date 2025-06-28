import { performance } from 'perf_hooks';
import { messageRepository } from '@db/repositories/messageRepository';
import { cachedMessageRepository } from '@db/repositories/cachedMessageRepository';
import { pool } from '@db/connection';
import { optimizedPool, getPoolMetrics } from '@db/optimizedConnection';
import { generateEmbedding } from '@ai/openai';
import { buildConversationContext } from '@ai/memory';
import { buildConversationContext as buildOptimizedContext } from '@ai/optimizedMemory';
import { redis } from '@db/redis';

interface BenchmarkResult {
  operation: string;
  originalTime: number;
  optimizedTime: number;
  improvement: string;
  details?: any;
}

export class PerformanceBenchmark {
  private results: BenchmarkResult[] = [];
  private testChannelId = 'test_channel_001';
  private testUserId = 'test_user_001';
  
  async runFullBenchmark(): Promise<void> {
    console.log('🚀 Starting Performance Benchmark Suite...\n');
    
    try {
      // Prepare test data
      await this.prepareTestData();
      
      // Run benchmarks
      await this.benchmarkVectorSearch();
      await this.benchmarkRecentMessages();
      await this.benchmarkContextBuilding();
      await this.benchmarkBatchOperations();
      await this.benchmarkConnectionPool();
      await this.benchmarkCaching();
      
      // Display results
      this.displayResults();
      
      // Cleanup
      await this.cleanup();
    } catch (error) {
      console.error('Benchmark failed:', error);
    }
  }

  private async prepareTestData(): Promise<void> {
    console.log('📦 Preparing test data...');
    
    // Create test messages with embeddings
    const messages = [];
    for (let i = 0; i < 1000; i++) {
      messages.push({
        slack_user_id: `test_user_${i % 10}`,
        channel_id: this.testChannelId,
        message_text: `Test message ${i} with some content about ${['coding', 'design', 'testing', 'deployment'][i % 4]}`,
        message_ts: `${Date.now()}.${i}`,
        embedding: Array(1536).fill(0).map(() => Math.random()),
        embedding_model: 'text-embedding-ada-002',
      });
    }
    
    // Batch insert
    const batchSize = 100;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      await cachedMessageRepository.createBatch(batch);
    }
    
    console.log('✅ Test data prepared\n');
  }

  private async benchmarkVectorSearch(): Promise<void> {
    console.log('🔍 Benchmarking Vector Search...');
    
    // Generate test embedding
    const { embedding } = await generateEmbedding('test query about coding');
    
    // Original implementation
    const originalStart = performance.now();
    let originalResults;
    for (let i = 0; i < 10; i++) {
      originalResults = await messageRepository.findSimilar(embedding, 20, 0.7);
    }
    const originalTime = (performance.now() - originalStart) / 10;
    
    // Clear cache for fair comparison
    const client = await redis.getClient();
    await client.flushDb();
    
    // Optimized implementation
    const optimizedStart = performance.now();
    let optimizedResults;
    for (let i = 0; i < 10; i++) {
      optimizedResults = await cachedMessageRepository.findSimilar(embedding, 20, 0.7);
    }
    const optimizedTime = (performance.now() - optimizedStart) / 10;
    
    this.results.push({
      operation: 'Vector Similarity Search',
      originalTime,
      optimizedTime,
      improvement: `${((originalTime - optimizedTime) / originalTime * 100).toFixed(1)}%`,
      details: {
        originalResultCount: originalResults?.length || 0,
        optimizedResultCount: optimizedResults?.length || 0,
      },
    });
    
    console.log(`✅ Vector search benchmark complete\n`);
  }

  private async benchmarkRecentMessages(): Promise<void> {
    console.log('📅 Benchmarking Recent Messages Query...');
    
    // Original implementation
    const originalStart = performance.now();
    for (let i = 0; i < 20; i++) {
      await messageRepository.getRecentMessages(this.testChannelId, 24, 50);
    }
    const originalTime = (performance.now() - originalStart) / 20;
    
    // Optimized implementation (with caching)
    const optimizedStart = performance.now();
    for (let i = 0; i < 20; i++) {
      await cachedMessageRepository.getRecentMessages(this.testChannelId, 24, 50);
    }
    const optimizedTime = (performance.now() - optimizedStart) / 20;
    
    this.results.push({
      operation: 'Recent Messages Query',
      originalTime,
      optimizedTime,
      improvement: `${((originalTime - optimizedTime) / originalTime * 100).toFixed(1)}%`,
    });
    
    console.log(`✅ Recent messages benchmark complete\n`);
  }

  private async benchmarkContextBuilding(): Promise<void> {
    console.log('🧠 Benchmarking Context Building...');
    
    // Original implementation
    const originalStart = performance.now();
    const originalContext = await buildConversationContext(
      this.testChannelId,
      'test query',
      {
        recentLimit: 20,
        relevantLimit: 10,
        includeProfiles: true,
        includeSummaries: true,
      }
    );
    const originalTime = performance.now() - originalStart;
    
    // Clear cache
    const client = await redis.getClient();
    await client.flushDb();
    
    // Optimized implementation
    const optimizedStart = performance.now();
    const optimizedContext = await buildOptimizedContext(
      this.testChannelId,
      'test query',
      {
        recentLimit: 20,
        relevantLimit: 10,
        includeProfiles: true,
        includeSummaries: true,
        useCache: false, // First run without cache
      }
    );
    const optimizedTime = performance.now() - optimizedStart;
    
    // Test with cache
    const cachedStart = performance.now();
    await buildOptimizedContext(
      this.testChannelId,
      'test query',
      {
        recentLimit: 20,
        relevantLimit: 10,
        includeProfiles: true,
        includeSummaries: true,
        useCache: true,
      }
    );
    const cachedTime = performance.now() - cachedStart;
    
    this.results.push({
      operation: 'Context Building',
      originalTime,
      optimizedTime,
      improvement: `${((originalTime - optimizedTime) / originalTime * 100).toFixed(1)}%`,
      details: {
        cachedTime,
        cacheImprovement: `${((originalTime - cachedTime) / originalTime * 100).toFixed(1)}%`,
        contextScore: optimizedContext.contextScore,
      },
    });
    
    console.log(`✅ Context building benchmark complete\n`);
  }

  private async benchmarkBatchOperations(): Promise<void> {
    console.log('📦 Benchmarking Batch Operations...');
    
    // Prepare test embeddings
    const updates = [];
    for (let i = 0; i < 100; i++) {
      updates.push({
        messageTs: `${Date.now()}.${i}`,
        embedding: Array(1536).fill(0).map(() => Math.random()),
        model: 'text-embedding-ada-002',
      });
    }
    
    // Original implementation (one by one)
    const originalStart = performance.now();
    for (const update of updates.slice(0, 20)) {
      await messageRepository.updateEmbedding(
        update.messageTs,
        update.embedding,
        update.model
      );
    }
    const originalTime = performance.now() - originalStart;
    
    // Optimized batch implementation
    const optimizedStart = performance.now();
    await cachedMessageRepository.updateEmbeddingsBatch(updates.slice(20, 40));
    const optimizedTime = performance.now() - optimizedStart;
    
    this.results.push({
      operation: 'Batch Embedding Updates (20 items)',
      originalTime,
      optimizedTime,
      improvement: `${((originalTime - optimizedTime) / originalTime * 100).toFixed(1)}%`,
    });
    
    console.log(`✅ Batch operations benchmark complete\n`);
  }

  private async benchmarkConnectionPool(): Promise<void> {
    console.log('🔌 Benchmarking Connection Pool...');
    
    // Original pool
    const originalStart = performance.now();
    const originalPromises = [];
    for (let i = 0; i < 50; i++) {
      originalPromises.push(
        pool.query('SELECT COUNT(*) FROM messages WHERE channel_id = $1', [this.testChannelId])
      );
    }
    await Promise.all(originalPromises);
    const originalTime = performance.now() - originalStart;
    
    // Optimized pool
    const optimizedStart = performance.now();
    const optimizedPromises = [];
    for (let i = 0; i < 50; i++) {
      optimizedPromises.push(
        optimizedPool.query('SELECT COUNT(*) FROM messages WHERE channel_id = $1', [this.testChannelId])
      );
    }
    await Promise.all(optimizedPromises);
    const optimizedTime = performance.now() - optimizedStart;
    
    const metrics = getPoolMetrics();
    
    this.results.push({
      operation: 'Connection Pool (50 concurrent queries)',
      originalTime,
      optimizedTime,
      improvement: `${((originalTime - optimizedTime) / originalTime * 100).toFixed(1)}%`,
      details: {
        poolMetrics: metrics,
      },
    });
    
    console.log(`✅ Connection pool benchmark complete\n`);
  }

  private async benchmarkCaching(): Promise<void> {
    console.log('💾 Benchmarking Cache Performance...');
    
    // Test cache hit rate
    const queries = ['coding', 'design', 'testing', 'deployment', 'architecture'];
    
    // First pass - cache miss
    const cacheMissStart = performance.now();
    for (const query of queries) {
      await buildOptimizedContext(this.testChannelId, query, {
        recentLimit: 10,
        relevantLimit: 5,
      });
    }
    const cacheMissTime = (performance.now() - cacheMissStart) / queries.length;
    
    // Second pass - cache hit
    const cacheHitStart = performance.now();
    for (const query of queries) {
      await buildOptimizedContext(this.testChannelId, query, {
        recentLimit: 10,
        relevantLimit: 5,
      });
    }
    const cacheHitTime = (performance.now() - cacheHitStart) / queries.length;
    
    this.results.push({
      operation: 'Cache Performance',
      originalTime: cacheMissTime,
      optimizedTime: cacheHitTime,
      improvement: `${((cacheMissTime - cacheHitTime) / cacheMissTime * 100).toFixed(1)}%`,
      details: {
        cacheHitRate: `${((cacheMissTime - cacheHitTime) / cacheMissTime * 100).toFixed(1)}%`,
      },
    });
    
    console.log(`✅ Cache benchmark complete\n`);
  }

  private displayResults(): void {
    console.log('\n📊 BENCHMARK RESULTS\n');
    console.log('='.repeat(80));
    console.log(
      'Operation'.padEnd(40) +
      'Original'.padEnd(12) +
      'Optimized'.padEnd(12) +
      'Improvement'
    );
    console.log('='.repeat(80));
    
    let totalOriginal = 0;
    let totalOptimized = 0;
    
    for (const result of this.results) {
      console.log(
        result.operation.padEnd(40) +
        `${result.originalTime.toFixed(2)}ms`.padEnd(12) +
        `${result.optimizedTime.toFixed(2)}ms`.padEnd(12) +
        result.improvement
      );
      
      if (result.details) {
        console.log(`  Details: ${JSON.stringify(result.details, null, 2).replace(/\n/g, '\n  ')}`);
      }
      
      totalOriginal += result.originalTime;
      totalOptimized += result.optimizedTime;
    }
    
    console.log('='.repeat(80));
    console.log(
      'TOTAL'.padEnd(40) +
      `${totalOriginal.toFixed(2)}ms`.padEnd(12) +
      `${totalOptimized.toFixed(2)}ms`.padEnd(12) +
      `${((totalOriginal - totalOptimized) / totalOriginal * 100).toFixed(1)}%`
    );
    console.log('='.repeat(80));
    
    // Performance recommendations
    console.log('\n📈 PERFORMANCE RECOMMENDATIONS\n');
    console.log('1. Enable query result caching for frequently accessed data');
    console.log('2. Use HNSW indexes for vector search with >1M messages');
    console.log('3. Implement connection pooling with dynamic sizing');
    console.log('4. Use batch operations for bulk updates');
    console.log('5. Monitor slow queries and add appropriate indexes');
    console.log('6. Consider read replicas for scaling read operations');
    console.log('7. Implement data archival for messages older than 6 months');
  }

  private async cleanup(): Promise<void> {
    console.log('\n🧹 Cleaning up test data...');
    
    // Clean up test data
    await pool.query('DELETE FROM messages WHERE channel_id = $1', [this.testChannelId]);
    await pool.query('DELETE FROM users WHERE slack_user_id LIKE $1', ['test_user_%']);
    
    // Clear cache
    const client = await redis.getClient();
    await client.flushDb();
    
    console.log('✅ Cleanup complete');
  }
}

// Run benchmark if executed directly
if (require.main === module) {
  const benchmark = new PerformanceBenchmark();
  benchmark.runFullBenchmark().catch(console.error);
}

export default PerformanceBenchmark;