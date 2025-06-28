#!/usr/bin/env node

/**
 * Railway-specific health check script
 * Provides detailed health status for Railway's monitoring
 */

const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function checkHealth() {
  const checks = {
    server: false,
    database: false,
    redis: false,
    environment: true
  };
  
  // Check if server is responding
  try {
    await new Promise((resolve, reject) => {
      const req = http.get('http://localhost:3000/health', (res) => {
        if (res.statusCode === 200) {
          checks.server = true;
          resolve();
        } else {
          reject(new Error(`Server returned ${res.statusCode}`));
        }
      });
      
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Health check timeout'));
      });
    });
  } catch (error) {
    console.error('Server health check failed:', error.message);
  }
  
  // Check critical environment variables
  const requiredEnvVars = [
    'DATABASE_URL',
    'REDIS_URL',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'OPENAI_API_KEY'
  ];
  
  const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
  if (missingEnvVars.length > 0) {
    console.error('Missing critical environment variables:', missingEnvVars.join(', '));
    checks.environment = false;
  }
  
  // Railway-specific: Log health status for debugging
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log('Railway health check status:', JSON.stringify(checks, null, 2));
    console.log('Railway environment:', process.env.RAILWAY_ENVIRONMENT);
    console.log('Railway deployment ID:', process.env.RAILWAY_DEPLOYMENT_ID);
  }
  
  // Determine overall health
  const isHealthy = checks.server && checks.environment;
  
  if (!isHealthy) {
    console.error('Health check failed:', checks);
    process.exit(1);
  }
  
  console.log('Health check passed');
  process.exit(0);
}

// Add timeout to prevent hanging
setTimeout(() => {
  console.error('Health check timed out after 8 seconds');
  process.exit(1);
}, 8000);

checkHealth().catch(error => {
  console.error('Health check error:', error);
  process.exit(1);
});