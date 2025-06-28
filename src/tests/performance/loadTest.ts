import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import { logger } from '@utils/logger';
import * as os from 'os';

interface LoadTestConfig {
  duration: number;          // Test duration in seconds
  rampUp: number;           // Ramp up time in seconds
  users: number;            // Number of concurrent users
  scenario: 'mixed' | 'read' | 'write' | 'embedding';
  targetRPS?: number;       // Target requests per second (optional)
}

interface LoadTestResult {
  config: LoadTestConfig;
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    requestsPerSecond: number;
    errors: Record<string, number>;
  };
  timeline: Array<{
    timestamp: number;
    activeUsers: number;
    requestsPerSecond: number;
    avgResponseTime: number;
    errorRate: number;
  }>;
}

export class LoadTester {
  private workers: Worker[] = [];
  private results: any[] = [];
  private timeline: LoadTestResult['timeline'] = [];
  private isRunning = false;

  constructor(private config: LoadTestConfig) {}

  /**
   * Run load test
   */
  async run(): Promise<LoadTestResult> {
    console.log('🚀 Starting load test...');
    console.log(`Configuration:`);
    console.log(`  Duration: ${this.config.duration}s`);
    console.log(`  Ramp-up: ${this.config.rampUp}s`);
    console.log(`  Users: ${this.config.users}`);
    console.log(`  Scenario: ${this.config.scenario}`);
    if (this.config.targetRPS) {
      console.log(`  Target RPS: ${this.config.targetRPS}`);
    }
    console.log('');

    this.isRunning = true;
    const startTime = Date.now();

    // Start monitoring
    this.startMonitoring();

    // Ramp up users gradually
    await this.rampUpUsers();

    // Run for specified duration
    await this.waitForDuration();

    // Stop test
    await this.stop();

    // Aggregate results
    const result = this.aggregateResults();
    
    // Print summary
    this.printSummary(result);

    return result;
  }

  /**
   * Ramp up users gradually
   */
  private async rampUpUsers(): Promise<void> {
    const usersPerSecond = this.config.users / this.config.rampUp;
    const delayBetweenUsers = 1000 / usersPerSecond;

    for (let i = 0; i < this.config.users; i++) {
      if (!this.isRunning) break;

      this.startWorker(i);
      
      if (i < this.config.users - 1) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenUsers));
      }
    }

    console.log(`✓ All ${this.workers.length} users ramped up`);
  }

  /**
   * Start a worker thread
   */
  private startWorker(workerId: number): void {
    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const axios = require('axios');
      
      const { workerId, scenario, targetRPS, baseUrl } = workerData;
      const results = [];
      let requestCount = 0;
      
      // Calculate delay between requests if targetRPS is set
      const delayBetweenRequests = targetRPS 
        ? Math.floor(1000 / (targetRPS / workerData.totalWorkers))
        : 0;
      
      async function makeRequest() {
        const start = Date.now();
        let success = false;
        let error = null;
        
        try {
          switch (scenario) {
            case 'read':
              await axios.get(\`\${baseUrl}/api/messages/recent\`, {
                params: { channelId: \`channel_\${workerId}\`, limit: 50 }
              });
              break;
              
            case 'write':
              await axios.post(\`\${baseUrl}/api/messages\`, {
                userId: \`user_\${workerId}\`,
                channelId: \`channel_\${workerId}\`,
                text: \`Test message \${requestCount} from worker \${workerId}\`,
                timestamp: Date.now().toString()
              });
              break;
              
            case 'embedding':
              await axios.post(\`\${baseUrl}/api/embeddings/generate\`, {
                text: \`Test text for embedding generation \${requestCount}\`
              });
              break;
              
            case 'mixed':
              const op = requestCount % 3;
              if (op === 0) {
                // Read operation
                await axios.get(\`\${baseUrl}/api/messages/recent\`, {
                  params: { channelId: \`channel_\${workerId}\`, limit: 20 }
                });
              } else if (op === 1) {
                // Search operation
                await axios.post(\`\${baseUrl}/api/messages/search\`, {
                  query: 'test query',
                  channelId: \`channel_\${workerId}\`
                });
              } else {
                // Write operation
                await axios.post(\`\${baseUrl}/api/messages\`, {
                  userId: \`user_\${workerId}\`,
                  channelId: \`channel_\${workerId}\`,
                  text: \`Mixed scenario message \${requestCount}\`,
                  timestamp: Date.now().toString()
                });
              }
              break;
          }
          
          success = true;
        } catch (err) {
          error = err.response?.status || err.code || 'unknown';
        }
        
        const duration = Date.now() - start;
        results.push({
          timestamp: Date.now(),
          duration,
          success,
          error,
          operation: scenario
        });
        
        requestCount++;
        
        // Send periodic updates
        if (requestCount % 10 === 0) {
          parentPort.postMessage({
            type: 'update',
            workerId,
            results: results.splice(0)
          });
        }
        
        // Apply rate limiting if needed
        if (delayBetweenRequests > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
        }
      }
      
      // Main loop
      async function run() {
        while (true) {
          const message = await new Promise(resolve => {
            parentPort.once('message', resolve);
          });
          
          if (message === 'stop') {
            // Send final results
            parentPort.postMessage({
              type: 'final',
              workerId,
              results
            });
            break;
          }
          
          await makeRequest();
        }
      }
      
      run();
    `;

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: {
        workerId,
        scenario: this.config.scenario,
        targetRPS: this.config.targetRPS,
        totalWorkers: this.config.users,
        baseUrl: process.env.API_BASE_URL || 'http://localhost:3000'
      }
    });

    worker.on('message', (message) => {
      if (message.type === 'update') {
        this.results.push(...message.results);
      } else if (message.type === 'final') {
        this.results.push(...message.results);
      }
    });

    worker.on('error', (error) => {
      logger.error(`Worker ${workerId} error:`, { error });
    });

    this.workers.push(worker);
  }

  /**
   * Wait for test duration
   */
  private async waitForDuration(): Promise<void> {
    const endTime = Date.now() + (this.config.duration * 1000);
    
    while (Date.now() < endTime && this.isRunning) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Progress update
      const remaining = Math.ceil((endTime - Date.now()) / 1000);
      process.stdout.write(`\rTest running... ${remaining}s remaining  `);
    }
    
    console.log('\n');
  }

  /**
   * Start monitoring timeline
   */
  private startMonitoring(): void {
    const interval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(interval);
        return;
      }

      // Calculate metrics for last second
      const now = Date.now();
      const recentResults = this.results.filter(r => 
        r.timestamp > now - 1000
      );

      if (recentResults.length > 0) {
        const successful = recentResults.filter(r => r.success).length;
        const avgResponseTime = recentResults.reduce((sum, r) => sum + r.duration, 0) / recentResults.length;
        
        this.timeline.push({
          timestamp: now,
          activeUsers: this.workers.length,
          requestsPerSecond: recentResults.length,
          avgResponseTime,
          errorRate: (recentResults.length - successful) / recentResults.length
        });
      }
    }, 1000);
  }

  /**
   * Stop load test
   */
  private async stop(): Promise<void> {
    console.log('Stopping load test...');
    this.isRunning = false;

    // Stop all workers
    await Promise.all(this.workers.map(worker => 
      worker.postMessage('stop')
    ));

    // Wait for workers to finish
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Terminate workers
    await Promise.all(this.workers.map(worker =>
      worker.terminate()
    ));

    console.log('✓ All workers stopped');
  }

  /**
   * Aggregate results
   */
  private aggregateResults(): LoadTestResult {
    const allResults = [...this.results];
    const successfulResults = allResults.filter(r => r.success);
    const failedResults = allResults.filter(r => !r.success);
    
    // Calculate response times
    const responseTimes = successfulResults.map(r => r.duration).sort((a, b) => a - b);
    
    // Count errors by type
    const errors: Record<string, number> = {};
    failedResults.forEach(r => {
      errors[r.error] = (errors[r.error] || 0) + 1;
    });

    // Calculate metrics
    const metrics = {
      totalRequests: allResults.length,
      successfulRequests: successfulResults.length,
      failedRequests: failedResults.length,
      avgResponseTime: responseTimes.length > 0 
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
        : 0,
      minResponseTime: responseTimes[0] || 0,
      maxResponseTime: responseTimes[responseTimes.length - 1] || 0,
      p50ResponseTime: this.percentile(responseTimes, 50),
      p95ResponseTime: this.percentile(responseTimes, 95),
      p99ResponseTime: this.percentile(responseTimes, 99),
      requestsPerSecond: allResults.length / this.config.duration,
      errors
    };

    return {
      config: this.config,
      metrics,
      timeline: this.timeline
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Print test summary
   */
  private printSummary(result: LoadTestResult): void {
    console.log('\n📊 Load Test Summary:');
    console.log('====================');
    console.log(`Total Requests: ${result.metrics.totalRequests}`);
    console.log(`Successful: ${result.metrics.successfulRequests} (${((result.metrics.successfulRequests / result.metrics.totalRequests) * 100).toFixed(2)}%)`);
    console.log(`Failed: ${result.metrics.failedRequests} (${((result.metrics.failedRequests / result.metrics.totalRequests) * 100).toFixed(2)}%)`);
    console.log(`\nThroughput: ${result.metrics.requestsPerSecond.toFixed(2)} req/s`);
    
    console.log('\nResponse Times:');
    console.log(`  Min: ${result.metrics.minResponseTime}ms`);
    console.log(`  Avg: ${result.metrics.avgResponseTime.toFixed(2)}ms`);
    console.log(`  Max: ${result.metrics.maxResponseTime}ms`);
    console.log(`  P50: ${result.metrics.p50ResponseTime}ms`);
    console.log(`  P95: ${result.metrics.p95ResponseTime}ms`);
    console.log(`  P99: ${result.metrics.p99ResponseTime}ms`);
    
    if (Object.keys(result.metrics.errors).length > 0) {
      console.log('\nErrors:');
      Object.entries(result.metrics.errors).forEach(([error, count]) => {
        console.log(`  ${error}: ${count}`);
      });
    }

    // Check SLA compliance
    console.log('\n🎯 SLA Compliance:');
    const slaViolations = [];
    
    if (result.metrics.p95ResponseTime > 500) {
      slaViolations.push(`P95 response time (${result.metrics.p95ResponseTime}ms) exceeds 500ms target`);
    }
    
    if (result.metrics.failedRequests / result.metrics.totalRequests > 0.01) {
      slaViolations.push(`Error rate (${((result.metrics.failedRequests / result.metrics.totalRequests) * 100).toFixed(2)}%) exceeds 1% target`);
    }
    
    if (slaViolations.length === 0) {
      console.log('  ✅ All SLAs met!');
    } else {
      slaViolations.forEach(violation => {
        console.log(`  ❌ ${violation}`);
      });
    }
  }

  /**
   * Generate HTML report
   */
  async generateHTMLReport(result: LoadTestResult, filename?: string): Promise<void> {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Load Test Report - ${new Date().toISOString()}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .metric { display: inline-block; margin: 10px 20px 10px 0; }
        .metric-value { font-size: 24px; font-weight: bold; }
        .metric-label { color: #666; }
        .chart-container { width: 100%; height: 400px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>Load Test Report</h1>
    <p>Generated: ${new Date().toISOString()}</p>
    
    <h2>Configuration</h2>
    <ul>
        <li>Duration: ${result.config.duration}s</li>
        <li>Users: ${result.config.users}</li>
        <li>Scenario: ${result.config.scenario}</li>
        ${result.config.targetRPS ? `<li>Target RPS: ${result.config.targetRPS}</li>` : ''}
    </ul>
    
    <h2>Summary</h2>
    <div>
        <div class="metric">
            <div class="metric-value">${result.metrics.totalRequests}</div>
            <div class="metric-label">Total Requests</div>
        </div>
        <div class="metric">
            <div class="metric-value">${((result.metrics.successfulRequests / result.metrics.totalRequests) * 100).toFixed(1)}%</div>
            <div class="metric-label">Success Rate</div>
        </div>
        <div class="metric">
            <div class="metric-value">${result.metrics.requestsPerSecond.toFixed(2)}</div>
            <div class="metric-label">Requests/sec</div>
        </div>
        <div class="metric">
            <div class="metric-value">${result.metrics.avgResponseTime.toFixed(0)}ms</div>
            <div class="metric-label">Avg Response Time</div>
        </div>
    </div>
    
    <h2>Response Time Distribution</h2>
    <table>
        <tr><th>Percentile</th><th>Response Time</th></tr>
        <tr><td>Min</td><td>${result.metrics.minResponseTime}ms</td></tr>
        <tr><td>P50</td><td>${result.metrics.p50ResponseTime}ms</td></tr>
        <tr><td>P95</td><td>${result.metrics.p95ResponseTime}ms</td></tr>
        <tr><td>P99</td><td>${result.metrics.p99ResponseTime}ms</td></tr>
        <tr><td>Max</td><td>${result.metrics.maxResponseTime}ms</td></tr>
    </table>
    
    <h2>Timeline</h2>
    <div class="chart-container">
        <canvas id="timelineChart"></canvas>
    </div>
    
    <script>
        const timelineData = ${JSON.stringify(result.timeline)};
        const ctx = document.getElementById('timelineChart').getContext('2d');
        
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: timelineData.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [{
                    label: 'Requests/sec',
                    data: timelineData.map(d => d.requestsPerSecond),
                    borderColor: 'blue',
                    yAxisID: 'y-rps'
                }, {
                    label: 'Avg Response Time (ms)',
                    data: timelineData.map(d => d.avgResponseTime),
                    borderColor: 'green',
                    yAxisID: 'y-rt'
                }, {
                    label: 'Error Rate (%)',
                    data: timelineData.map(d => d.errorRate * 100),
                    borderColor: 'red',
                    yAxisID: 'y-error'
                }]
            },
            options: {
                scales: {
                    'y-rps': {
                        type: 'linear',
                        position: 'left',
                        title: { display: true, text: 'Requests/sec' }
                    },
                    'y-rt': {
                        type: 'linear',
                        position: 'right',
                        title: { display: true, text: 'Response Time (ms)' }
                    },
                    'y-error': {
                        type: 'linear',
                        position: 'right',
                        title: { display: true, text: 'Error Rate (%)' },
                        max: 100
                    }
                }
            }
        });
    </script>
</body>
</html>
    `;

    const fs = await import('fs/promises');
    const path = await import('path');
    
    const reportDir = path.join(process.cwd(), 'performance-reports');
    await fs.mkdir(reportDir, { recursive: true });
    
    const reportFile = filename || `load-test-${Date.now()}.html`;
    const reportPath = path.join(reportDir, reportFile);
    
    await fs.writeFile(reportPath, html);
    console.log(`\nHTML report saved to: ${reportPath}`);
  }
}

// CLI runner
if (require.main === module) {
  const args = process.argv.slice(2);
  
  const config: LoadTestConfig = {
    duration: parseInt(args[0]) || 60,
    rampUp: parseInt(args[1]) || 10,
    users: parseInt(args[2]) || 50,
    scenario: (args[3] as any) || 'mixed',
    targetRPS: args[4] ? parseInt(args[4]) : undefined
  };
  
  const tester = new LoadTester(config);
  
  tester.run()
    .then(result => tester.generateHTMLReport(result))
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Load test failed:', error);
      process.exit(1);
    });
}