import { performance } from 'perf_hooks';
import { messageRepository } from '@db/repositories';
import { cache } from '@services/cache';
import { pool, getPoolMetrics } from '@db/connection';
import { redis } from '@db/redis';
import { generateEmbedding, generateChatCompletion } from '@ai/openai';
import { logger } from '@utils/logger';
import { faker } from '@faker-js/faker';

interface BenchmarkResult {
  name: string;
  operations: number;
  duration: number;
  opsPerSecond: number;
  avgLatency: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
}

interface PerformanceReport {
  timestamp: Date;
  environment: string;
  benchmarks: BenchmarkResult[];
  systemMetrics: {
    memory: NodeJS.MemoryUsage;
    cpu: NodeJS.CpuUsage;
    database: any;
    redis: any;
  };
}

export class PerformanceBenchmark {
  private results: BenchmarkResult[] = [];
  private latencies: Map<string, number[]> = new Map();

  /**
   * Run all benchmarks
   */
  async runAll(): Promise<PerformanceReport> {
    console.log('🚀 Starting performance benchmarks...\n');

    // Warm up connections
    await this.warmUp();

    // Run benchmarks
    await this.benchmarkDatabaseOperations();
    await this.benchmarkCacheOperations();
    await this.benchmarkEmbeddingGeneration();
    await this.benchmarkMessageRetrieval();
    await this.benchmarkConcurrentLoad();
    await this.benchmarkMemorySearch();

    // Generate report
    const report = this.generateReport();
    
    // Clean up
    await this.cleanup();

    return report;
  }

  /**
   * Warm up connections and caches
   */
  private async warmUp(): Promise<void> {
    console.log('Warming up connections...');
    
    // Database warm-up
    await pool.query('SELECT 1');
    
    // Redis warm-up
    const client = await redis.getClient();
    await client.ping();
    
    // Cache warm-up
    await cache.set('benchmark', 'warmup', 'test', { ttl: 60 });
    await cache.get('benchmark', 'warmup');
    
    console.log('✓ Warm-up complete\n');
  }

  /**
   * Benchmark database operations
   */
  private async benchmarkDatabaseOperations(): Promise<void> {
    const name = 'Database Operations';
    console.log(`Running ${name}...`);
    
    const operations = 1000;
    const latencies: number[] = [];
    let errors = 0;

    // Test data
    const messages = Array.from({ length: 100 }, () => ({
      slack_user_id: faker.string.alphanumeric(10),
      channel_id: faker.string.alphanumeric(10),
      message_text: faker.lorem.paragraph(),
      message_ts: faker.number.float({ min: 1000000, max: 9999999 }).toString(),
    }));

    const start = performance.now();

    // Run operations
    for (let i = 0; i < operations; i++) {
      const opStart = performance.now();
      try {
        const message = messages[i % messages.length];
        
        if (i % 3 === 0) {
          // Write operation
          await messageRepository.create(message);
        } else if (i % 3 === 1) {
          // Read operation
          await messageRepository.findByTimestamp(message.message_ts);
        } else {
          // Query operation
          await messageRepository.getRecentMessages(message.channel_id, 1, 10);
        }
        
        latencies.push(performance.now() - opStart);
      } catch (error) {
        errors++;
      }
    }

    const duration = performance.now() - start;
    this.recordBenchmark(name, operations, duration, latencies, errors);
  }

  /**
   * Benchmark cache operations
   */
  private async benchmarkCacheOperations(): Promise<void> {
    const name = 'Cache Operations';
    console.log(`Running ${name}...`);
    
    const operations = 5000;
    const latencies: number[] = [];
    let errors = 0;

    // Test data
    const keys = Array.from({ length: 100 }, (_, i) => `bench:key:${i}`);
    const values = Array.from({ length: 100 }, () => ({
      data: faker.lorem.paragraphs(3),
      timestamp: Date.now(),
    }));

    const start = performance.now();

    for (let i = 0; i < operations; i++) {
      const opStart = performance.now();
      try {
        const key = keys[i % keys.length];
        const value = values[i % values.length];
        
        if (i % 3 === 0) {
          // Set operation
          await cache.set('benchmark', key, value, { ttl: 300 });
        } else if (i % 3 === 1) {
          // Get operation
          await cache.get('benchmark', key);
        } else {
          // Get with factory
          await cache.getOrSet('benchmark', key, async () => value, { ttl: 300 });
        }
        
        latencies.push(performance.now() - opStart);
      } catch (error) {
        errors++;
      }
    }

    const duration = performance.now() - start;
    this.recordBenchmark(name, operations, duration, latencies, errors);
  }

  /**
   * Benchmark embedding generation
   */
  private async benchmarkEmbeddingGeneration(): Promise<void> {
    const name = 'Embedding Generation';
    console.log(`Running ${name}...`);
    
    const operations = 50; // Limited due to API costs
    const latencies: number[] = [];
    let errors = 0;

    // Test texts
    const texts = Array.from({ length: 10 }, () => 
      faker.lorem.paragraphs(2).slice(0, 1000)
    );

    const start = performance.now();

    for (let i = 0; i < operations; i++) {
      const opStart = performance.now();
      try {
        const text = texts[i % texts.length];
        
        // Check cache first
        const cached = await cache.get('embeddings', text);
        
        if (!cached) {
          const result = await generateEmbedding(text);
          await cache.set('embeddings', text, result.embedding, { ttl: 3600 });
        }
        
        latencies.push(performance.now() - opStart);
      } catch (error) {
        errors++;
      }
    }

    const duration = performance.now() - start;
    this.recordBenchmark(name, operations, duration, latencies, errors);
  }

  /**
   * Benchmark message retrieval with caching
   */
  private async benchmarkMessageRetrieval(): Promise<void> {
    const name = 'Message Retrieval (Cached)';
    console.log(`Running ${name}...`);
    
    const operations = 2000;
    const latencies: number[] = [];
    let errors = 0;
    let cacheHits = 0;

    // Test channel IDs
    const channelIds = Array.from({ length: 20 }, () => 
      faker.string.alphanumeric(10)
    );

    const start = performance.now();

    for (let i = 0; i < operations; i++) {
      const opStart = performance.now();
      try {
        const channelId = channelIds[i % channelIds.length];
        
        // This should use the cached repository
        const messages = await messageRepository.getRecentMessages(channelId, 24, 50);
        
        if (i > channelIds.length) {
          // After first round, most should be cache hits
          cacheHits++;
        }
        
        latencies.push(performance.now() - opStart);
      } catch (error) {
        errors++;
      }
    }

    const duration = performance.now() - start;
    const result = this.recordBenchmark(name, operations, duration, latencies, errors);
    
    console.log(`  Cache hit rate: ${((cacheHits / operations) * 100).toFixed(2)}%`);
  }

  /**
   * Benchmark concurrent load
   */
  private async benchmarkConcurrentLoad(): Promise<void> {
    const name = 'Concurrent Load Test';
    console.log(`Running ${name}...`);
    
    const concurrency = 50;
    const operationsPerWorker = 20;
    const totalOperations = concurrency * operationsPerWorker;
    const latencies: number[] = [];
    let errors = 0;

    const start = performance.now();

    // Create concurrent workers
    const workers = Array.from({ length: concurrency }, async (_, workerId) => {
      const workerLatencies: number[] = [];
      
      for (let i = 0; i < operationsPerWorker; i++) {
        const opStart = performance.now();
        try {
          // Mix of operations
          const op = i % 4;
          
          switch (op) {
            case 0:
              // Database read
              await messageRepository.findByTimestamp(`${Date.now()}.${workerId}.${i}`);
              break;
            case 1:
              // Cache operation
              await cache.get('benchmark', `concurrent:${workerId}:${i}`);
              break;
            case 2:
              // Database write
              await messageRepository.create({
                slack_user_id: `user_${workerId}`,
                channel_id: `channel_${workerId}`,
                message_text: faker.lorem.sentence(),
                message_ts: `${Date.now()}.${workerId}.${i}`,
              });
              break;
            case 3:
              // Complex query
              await pool.query(
                'SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL \'1 hour\''
              );
              break;
          }
          
          workerLatencies.push(performance.now() - opStart);
        } catch (error) {
          errors++;
        }
      }
      
      return workerLatencies;
    });

    // Wait for all workers
    const results = await Promise.all(workers);
    results.forEach(workerLatencies => latencies.push(...workerLatencies));

    const duration = performance.now() - start;
    this.recordBenchmark(name, totalOperations, duration, latencies, errors);
  }

  /**
   * Benchmark vector similarity search
   */
  private async benchmarkMemorySearch(): Promise<void> {
    const name = 'Vector Similarity Search';
    console.log(`Running ${name}...`);
    
    const operations = 100;
    const latencies: number[] = [];
    let errors = 0;

    // Generate random embeddings for testing
    const testEmbeddings = Array.from({ length: 10 }, () => 
      Array.from({ length: 1536 }, () => Math.random() - 0.5)
    );

    const start = performance.now();

    for (let i = 0; i < operations; i++) {
      const opStart = performance.now();
      try {
        const embedding = testEmbeddings[i % testEmbeddings.length];
        
        // Search for similar messages
        await messageRepository.findSimilar(embedding, 20, 0.7);
        
        latencies.push(performance.now() - opStart);
      } catch (error) {
        errors++;
      }
    }

    const duration = performance.now() - start;
    this.recordBenchmark(name, operations, duration, latencies, errors);
  }

  /**
   * Record benchmark results
   */
  private recordBenchmark(
    name: string,
    operations: number,
    duration: number,
    latencies: number[],
    errors: number
  ): BenchmarkResult {
    // Sort latencies for percentile calculation
    latencies.sort((a, b) => a - b);

    const result: BenchmarkResult = {
      name,
      operations,
      duration,
      opsPerSecond: operations / (duration / 1000),
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50: this.percentile(latencies, 50),
      p95: this.percentile(latencies, 95),
      p99: this.percentile(latencies, 99),
      errors,
    };

    this.results.push(result);
    this.latencies.set(name, latencies);

    // Print results
    console.log(`✓ ${name} complete:`);
    console.log(`  Operations: ${operations}`);
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`  Throughput: ${result.opsPerSecond.toFixed(2)} ops/sec`);
    console.log(`  Avg Latency: ${result.avgLatency.toFixed(2)}ms`);
    console.log(`  P50: ${result.p50.toFixed(2)}ms`);
    console.log(`  P95: ${result.p95.toFixed(2)}ms`);
    console.log(`  P99: ${result.p99.toFixed(2)}ms`);
    console.log(`  Errors: ${errors}`);
    console.log('');

    return result;
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Generate performance report
   */
  private generateReport(): PerformanceReport {
    // Collect system metrics
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const dbMetrics = getPoolMetrics();
    const redisStats = redis.getPoolStats();

    const report: PerformanceReport = {
      timestamp: new Date(),
      environment: process.env.NODE_ENV || 'development',
      benchmarks: this.results,
      systemMetrics: {
        memory: memoryUsage,
        cpu: cpuUsage,
        database: dbMetrics,
        redis: redisStats,
      },
    };

    // Print summary
    console.log('\n📊 Performance Report Summary:');
    console.log('================================');
    console.log(`Total benchmarks: ${this.results.length}`);
    console.log(`Total operations: ${this.results.reduce((sum, r) => sum + r.operations, 0)}`);
    console.log(`Total errors: ${this.results.reduce((sum, r) => sum + r.errors, 0)}`);
    console.log('\nTop performers by throughput:');
    
    const sorted = [...this.results].sort((a, b) => b.opsPerSecond - a.opsPerSecond);
    sorted.slice(0, 3).forEach((result, i) => {
      console.log(`${i + 1}. ${result.name}: ${result.opsPerSecond.toFixed(2)} ops/sec`);
    });

    console.log('\nMemory usage:');
    console.log(`  RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Heap: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);

    return report;
  }

  /**
   * Clean up test data
   */
  private async cleanup(): Promise<void> {
    console.log('\nCleaning up test data...');
    
    // Clear benchmark cache namespace
    await cache.clearNamespace('benchmark');
    
    // Clean up test messages
    await pool.query(
      'DELETE FROM messages WHERE message_ts LIKE \'%.%.%\' AND created_at > NOW() - INTERVAL \'1 hour\''
    );
    
    console.log('✓ Cleanup complete\n');
  }

  /**
   * Save report to file
   */
  async saveReport(report: PerformanceReport, filename?: string): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const reportDir = path.join(process.cwd(), 'performance-reports');
    await fs.mkdir(reportDir, { recursive: true });
    
    const reportFile = filename || `benchmark-${Date.now()}.json`;
    const reportPath = path.join(reportDir, reportFile);
    
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report saved to: ${reportPath}`);
  }

  /**
   * Compare two reports
   */
  static compareReports(baseline: PerformanceReport, current: PerformanceReport): void {
    console.log('\n📈 Performance Comparison:');
    console.log('===========================');
    
    // Compare each benchmark
    baseline.benchmarks.forEach(baseResult => {
      const currentResult = current.benchmarks.find(r => r.name === baseResult.name);
      if (!currentResult) return;
      
      const throughputChange = ((currentResult.opsPerSecond - baseResult.opsPerSecond) / baseResult.opsPerSecond) * 100;
      const latencyChange = ((currentResult.avgLatency - baseResult.avgLatency) / baseResult.avgLatency) * 100;
      
      console.log(`\n${baseResult.name}:`);
      console.log(`  Throughput: ${baseResult.opsPerSecond.toFixed(2)} → ${currentResult.opsPerSecond.toFixed(2)} ops/sec (${throughputChange >= 0 ? '+' : ''}${throughputChange.toFixed(2)}%)`);
      console.log(`  Avg Latency: ${baseResult.avgLatency.toFixed(2)} → ${currentResult.avgLatency.toFixed(2)} ms (${latencyChange >= 0 ? '+' : ''}${latencyChange.toFixed(2)}%)`);
      
      if (Math.abs(throughputChange) > 10) {
        console.log(`  ⚠️  Significant ${throughputChange > 0 ? 'improvement' : 'regression'} detected!`);
      }
    });
  }
}

// CLI runner
if (require.main === module) {
  const benchmark = new PerformanceBenchmark();
  
  benchmark.runAll()
    .then(report => benchmark.saveReport(report))
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Benchmark failed:', error);
      process.exit(1);
    });
}