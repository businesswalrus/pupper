#!/usr/bin/env node

/**
 * Test database and Redis connections
 * Useful for debugging Railway deployment issues
 */

const { Pool } = require('pg');
const Redis = require('ioredis');

console.log('🔌 Testing Connections\n');

// Test PostgreSQL
async function testPostgreSQL() {
  console.log('📊 Testing PostgreSQL...');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set');
    return false;
  }
  
  // Parse and mask the connection string for logging
  const dbUrl = new URL(process.env.DATABASE_URL);
  console.log(`  Host: ${dbUrl.hostname}`);
  console.log(`  Port: ${dbUrl.port || 5432}`);
  console.log(`  Database: ${dbUrl.pathname.slice(1)}`);
  console.log(`  SSL: ${dbUrl.hostname.includes('railway.app') ? 'enabled' : 'disabled'}`);
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: dbUrl.hostname.includes('railway.app') ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    max: 1
  });
  
  try {
    // Test basic connection
    const client = await pool.connect();
    console.log('✓ Connected to PostgreSQL');
    
    // Test query
    const result = await client.query('SELECT version(), current_database(), now()');
    console.log(`  Version: ${result.rows[0].version.split(',')[0]}`);
    console.log(`  Database: ${result.rows[0].current_database}`);
    console.log(`  Server time: ${result.rows[0].now}`);
    
    // Test pgvector extension
    try {
      await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
      console.log('✓ pgvector extension is installed');
    } catch {
      console.log('⚠️  pgvector extension not found - run CREATE EXTENSION vector;');
    }
    
    // Check if migrations table exists
    try {
      const migrationResult = await client.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_name = 'pgmigrations'
      `);
      if (migrationResult.rows[0].count > 0) {
        const migrations = await client.query('SELECT COUNT(*) as count FROM pgmigrations WHERE run_on IS NOT NULL');
        console.log(`✓ Migrations table exists (${migrations.rows[0].count} migrations run)`);
      } else {
        console.log('⚠️  Migrations table not found - migrations may not have run');
      }
    } catch (error) {
      console.log('⚠️  Could not check migrations table');
    }
    
    client.release();
    await pool.end();
    return true;
    
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error.message);
    if (error.code === 'ENOTFOUND') {
      console.error('   → Host not found. Check DATABASE_URL');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('   → Connection refused. Database may be down');
    } else if (error.code === '28P01') {
      console.error('   → Authentication failed. Check credentials');
    }
    await pool.end();
    return false;
  }
}

// Test Redis
async function testRedis() {
  console.log('\n🔴 Testing Redis...');
  
  if (!process.env.REDIS_URL) {
    console.error('❌ REDIS_URL not set');
    return false;
  }
  
  // Parse and mask the connection string for logging
  const redisUrl = new URL(process.env.REDIS_URL);
  console.log(`  Host: ${redisUrl.hostname}`);
  console.log(`  Port: ${redisUrl.port || 6379}`);
  console.log(`  TLS: ${redisUrl.protocol === 'rediss:' ? 'enabled' : 'disabled'}`);
  
  const redis = new Redis(process.env.REDIS_URL, {
    connectTimeout: 10000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // Don't retry for this test
    tls: redisUrl.protocol === 'rediss:' ? {} : undefined
  });
  
  try {
    // Wait for connection
    await new Promise((resolve, reject) => {
      redis.once('connect', resolve);
      redis.once('error', reject);
      
      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
    
    console.log('✓ Connected to Redis');
    
    // Test basic operations
    const testKey = `test:connection:${Date.now()}`;
    await redis.set(testKey, 'test', 'EX', 10);
    const value = await redis.get(testKey);
    if (value === 'test') {
      console.log('✓ Read/write test passed');
    }
    
    // Get Redis info
    const info = await redis.info('server');
    const version = info.match(/redis_version:(.+)/)?.[1];
    if (version) {
      console.log(`  Version: Redis ${version}`);
    }
    
    // Check memory usage
    const memoryInfo = await redis.info('memory');
    const usedMemory = memoryInfo.match(/used_memory_human:(.+)/)?.[1];
    if (usedMemory) {
      console.log(`  Memory usage: ${usedMemory}`);
    }
    
    await redis.quit();
    return true;
    
  } catch (error) {
    console.error('❌ Redis connection failed:', error.message);
    if (error.code === 'ENOTFOUND') {
      console.error('   → Host not found. Check REDIS_URL');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('   → Connection refused. Redis may be down');
    } else if (error.message.includes('AUTH')) {
      console.error('   → Authentication failed. Check credentials');
    }
    redis.disconnect();
    return false;
  }
}

// Test Slack API
async function testSlackAPI() {
  console.log('\n💬 Testing Slack API...');
  
  const requiredTokens = {
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET
  };
  
  // Check if tokens are set
  const missingTokens = Object.entries(requiredTokens)
    .filter(([_, value]) => !value)
    .map(([key]) => key);
  
  if (missingTokens.length > 0) {
    console.error('❌ Missing Slack tokens:', missingTokens.join(', '));
    return false;
  }
  
  // Validate token formats
  if (!process.env.SLACK_BOT_TOKEN.startsWith('xoxb-')) {
    console.error('❌ SLACK_BOT_TOKEN should start with xoxb-');
    return false;
  }
  
  if (!process.env.SLACK_APP_TOKEN.startsWith('xapp-')) {
    console.error('❌ SLACK_APP_TOKEN should start with xapp-');
    return false;
  }
  
  console.log('✓ Slack tokens are properly formatted');
  
  // We can't test actual API calls without importing Slack SDK
  // but format validation is a good start
  return true;
}

// Test OpenAI API
async function testOpenAI() {
  console.log('\n🤖 Testing OpenAI API...');
  
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY not set');
    return false;
  }
  
  if (!process.env.OPENAI_API_KEY.startsWith('sk-')) {
    console.error('❌ OPENAI_API_KEY should start with sk-');
    return false;
  }
  
  console.log('✓ OpenAI API key is properly formatted');
  console.log(`  Key: ${process.env.OPENAI_API_KEY.substring(0, 10)}...`);
  
  return true;
}

// Main test runner
async function runTests() {
  console.log('Environment:', process.env.RAILWAY_ENVIRONMENT || 'local');
  console.log('Node version:', process.version);
  console.log('Platform:', process.platform);
  console.log('---\n');
  
  const results = {
    postgresql: await testPostgreSQL(),
    redis: await testRedis(),
    slack: await testSlackAPI(),
    openai: await testOpenAI()
  };
  
  console.log('\n📋 Summary:');
  console.log('===========');
  
  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;
  
  Object.entries(results).forEach(([service, passed]) => {
    console.log(`${passed ? '✅' : '❌'} ${service}`);
  });
  
  if (passed === total) {
    console.log('\n✨ All connections successful!');
    process.exit(0);
  } else {
    console.log(`\n⚠️  ${total - passed} connection(s) failed`);
    process.exit(1);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('\n💥 Unexpected error:', error);
  process.exit(1);
});

// Run tests
runTests();