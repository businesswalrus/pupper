#!/usr/bin/env tsx

import { costTracker } from '@services/costTracker';
import { logger } from '@utils/logger';

async function generateCostReport() {
  const period = process.argv[2] || 'daily';
  const format = process.argv[3] || 'console';

  logger.info(`Generating ${period} cost report...`);

  try {
    // Generate report
    const report = await costTracker.generateCostReport(period as any);
    
    if (format === 'console') {
      console.log('\n📊 Cost Report');
      console.log('==============');
      console.log(`Period: ${report.period}`);
      console.log(`Total Cost: $${report.totalCost.toFixed(4)}`);
      
      console.log('\nBy Service:');
      Object.entries(report.byService)
        .sort(([, a], [, b]) => b - a)
        .forEach(([service, cost]) => {
          console.log(`  ${service}: $${cost.toFixed(4)}`);
        });
      
      console.log('\nTop Users:');
      Object.entries(report.byUser)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .forEach(([user, cost]) => {
          console.log(`  ${user}: $${cost.toFixed(4)}`);
        });
      
      console.log('\nTrends:');
      console.log(`  Daily Average: $${report.trends.dailyAverage.toFixed(4)}`);
      console.log(`  Weekly Growth: ${report.trends.weeklyGrowth.toFixed(2)}%`);
      console.log(`  30-Day Projection: $${report.trends.projection.toFixed(2)}`);
      
    } else if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    }
    
    // Check for anomalies
    await costTracker.checkCostAnomalies();
    
    process.exit(0);
  } catch (error) {
    logger.error('Failed to generate cost report', { error: error as Error });
    process.exit(1);
  }
}

generateCostReport();