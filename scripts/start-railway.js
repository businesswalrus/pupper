#!/usr/bin/env node

/**
 * Railway-specific production startup script
 * Handles Railway's unique environment and deployment constraints
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

console.log('=== Railway Deployment Starting ===');
console.log('Railway Environment:', process.env.RAILWAY_ENVIRONMENT || 'unknown');
console.log('Railway Static URL:', process.env.RAILWAY_STATIC_URL || 'not set');
console.log('Node Environment:', process.env.NODE_ENV);
console.log('Port:', process.env.PORT || 3000);

// Railway-specific environment validation
async function validateEnvironment() {
  console.log('\n--- Validating Railway Environment ---');
  
  const required = {
    'DATABASE_URL': process.env.DATABASE_URL,
    'REDIS_URL': process.env.REDIS_URL,
    'SLACK_BOT_TOKEN': process.env.SLACK_BOT_TOKEN,
    'SLACK_APP_TOKEN': process.env.SLACK_APP_TOKEN,
    'OPENAI_API_KEY': process.env.OPENAI_API_KEY
  };
  
  const missing = [];
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      missing.push(key);
    } else {
      // Log masked values for debugging
      const masked = key.includes('TOKEN') || key.includes('KEY') 
        ? value.substring(0, 10) + '...' 
        : value.split('@')[0] + '@...';
      console.log(`✓ ${key}: ${masked}`);
    }
  }
  
  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:', missing.join(', '));
    console.error('Please set these in Railway dashboard under Variables tab');
    
    // On Railway, we should fail fast for missing env vars
    if (process.env.RAILWAY_ENVIRONMENT) {
      process.exit(1);
    }
  }
  
  return missing.length === 0;
}

// Test database connection with retry logic
async function testDatabaseConnection() {
  console.log('\n--- Testing Database Connection ---');
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('railway.app') ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 10000
      });
      
      const result = await pool.query('SELECT NOW()');
      await pool.end();
      
      console.log('✓ Database connected successfully');
      console.log('  Current time from DB:', result.rows[0].now);
      return true;
    } catch (error) {
      console.error(`  Attempt ${attempt}/3 failed:`, error.message);
      if (attempt < 3) {
        console.log('  Retrying in 5 seconds...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  
  return false;
}

// Run migrations with Railway-specific handling
async function runMigrations() {
  console.log('\n--- Running Database Migrations ---');
  
  // Skip migrations if explicitly disabled
  if (process.env.SKIP_MIGRATIONS === 'true') {
    console.log('⚠️  Migrations skipped (SKIP_MIGRATIONS=true)');
    return true;
  }
  
  try {
    // Set migration-specific environment variables
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = process.env.DATABASE_URL;
    
    // Use node-pg-migrate directly
    const { stdout, stderr } = await execAsync('npx node-pg-migrate up', {
      env: process.env,
      timeout: 60000 // 60 second timeout for migrations
    });
    
    if (stdout) console.log('Migration output:', stdout);
    if (stderr && !stderr.includes('No migrations to run')) {
      console.error('Migration warnings:', stderr);
    }
    
    console.log('✓ Migrations completed successfully');
    return true;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (error.stdout) console.log('stdout:', error.stdout);
    if (error.stderr) console.error('stderr:', error.stderr);
    
    // On Railway, migrations failing is critical
    if (process.env.RAILWAY_ENVIRONMENT === 'production') {
      console.error('CRITICAL: Migrations failed in production. Exiting...');
      process.exit(1);
    }
    
    return false;
  }
}

// Start the application
async function startApp() {
  console.log('\n--- Starting Application ---');
  
  try {
    // Register TypeScript paths for production
    require('tsconfig-paths/register');
    
    // Set production-specific Node options
    if (!process.env.NODE_OPTIONS) {
      process.env.NODE_OPTIONS = '--max-old-space-size=512 --enable-source-maps';
    }
    
    console.log('Starting pup.ai v2...');
    console.log('Memory limit:', process.env.NODE_OPTIONS);
    
    // Start the application
    require('../dist/bootstrap.js');
    
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    console.error(error.stack);
    
    // Log additional debugging info for Railway
    if (process.env.RAILWAY_ENVIRONMENT) {
      console.error('\nRailway debugging info:');
      console.error('- Working directory:', process.cwd());
      console.error('- Files in dist:', require('fs').readdirSync('./dist').slice(0, 10));
      console.error('- Node version:', process.version);
    }
    
    process.exit(1);
  }
}

// Main startup sequence
async function main() {
  try {
    // 1. Validate environment
    const envValid = await validateEnvironment();
    if (!envValid && process.env.RAILWAY_ENVIRONMENT === 'production') {
      console.error('\n❌ Cannot start in production with missing environment variables');
      process.exit(1);
    }
    
    // 2. Test database connection
    const dbConnected = await testDatabaseConnection();
    if (!dbConnected) {
      console.error('\n❌ Cannot connect to database');
      if (process.env.RAILWAY_ENVIRONMENT === 'production') {
        process.exit(1);
      }
    }
    
    // 3. Run migrations (if database is connected)
    if (dbConnected) {
      await runMigrations();
    }
    
    // 4. Start the application
    await startApp();
    
  } catch (error) {
    console.error('\n❌ Startup failed:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start the application
main();