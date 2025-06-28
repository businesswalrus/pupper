import { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
import { config } from '@utils/config';
import { logger } from '@utils/logger';
import { performance } from 'perf_hooks';

// Parse connection string to extract components
const dbUrl = new URL(config.database.url);
const isProduction = process.env.NODE_ENV === 'production';

// Optimized pool configuration
const poolConfig: PoolConfig = {
  connectionString: config.database.url,
  
  // Connection pool sizing
  max: isProduction ? 50 : 20,                    // More connections in production
  min: isProduction ? 10 : 2,                    // Maintain minimum connections
  
  // Timeouts
  idleTimeoutMillis: 10000,                      // Close idle connections after 10s
  connectionTimeoutMillis: 3000,                 // Connection timeout 3s
  query_timeout: 30000,                          // Query timeout 30s
  statement_timeout: 30000,                      // Statement timeout 30s
  idle_in_transaction_session_timeout: 60000,    // Idle transaction timeout 1min
  
  // Connection behavior
  allowExitOnIdle: false,                        // Keep pool alive
  keepAlive: true,                               // Enable TCP keepalive
  keepAliveInitialDelayMillis: 10000,           // Start keepalive after 10s
  
  // SSL configuration for production
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  
  // Application name for monitoring
  application_name: 'pup-ai-v2',
};

// Create optimized connection pool
export const pool = new Pool(poolConfig);

// Connection pool metrics
const poolMetrics = {
  totalConnections: 0,
  activeConnections: 0,
  idleConnections: 0,
  waitingRequests: 0,
  totalQueries: 0,
  queryErrors: 0,
  slowQueries: 0,
};

// Monitor pool events
pool.on('connect', (client) => {
  poolMetrics.totalConnections++;
  logger.debug('New database connection established');
  
  // Set runtime parameters for each connection
  client.query(`
    SET statement_timeout = '30s';
    SET lock_timeout = '10s';
    SET idle_in_transaction_session_timeout = '60s';
    SET client_encoding = 'UTF8';
  `).catch(err => logger.error('Failed to set connection parameters', { error: err }));
});

pool.on('acquire', (client) => {
  poolMetrics.activeConnections++;
  poolMetrics.idleConnections = pool.idleCount;
});

pool.on('release', (client) => {
  poolMetrics.activeConnections--;
  poolMetrics.idleConnections = pool.idleCount;
});

pool.on('remove', (client) => {
  poolMetrics.totalConnections--;
  logger.debug('Database connection removed from pool');
});

pool.on('error', (err, client) => {
  logger.error('Unexpected database pool error', { error: err });
});

// Enhanced client with automatic instrumentation
export async function getClient(): Promise<PoolClient> {
  const start = performance.now();
  poolMetrics.waitingRequests++;
  
  try {
    const client = await pool.connect();
    const duration = performance.now() - start;
    
    if (duration > 1000) {
      logger.warn('Slow connection acquisition', { duration });
    }
    
    // Wrap query method for instrumentation
    const originalQuery = client.query.bind(client);
    client.query = async (...args: any[]) => {
      const queryStart = performance.now();
      poolMetrics.totalQueries++;
      
      try {
        const result = await originalQuery(...args);
        const queryDuration = performance.now() - queryStart;
        
        if (queryDuration > 1000) {
          poolMetrics.slowQueries++;
          logger.warn('Slow query detected', {
            duration: queryDuration,
            query: args[0]?.text || args[0],
          });
        }
        
        return result;
      } catch (error) {
        poolMetrics.queryErrors++;
        throw error;
      }
    };
    
    return client;
  } finally {
    poolMetrics.waitingRequests--;
  }
}

// Enhanced transaction helper with savepoints
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  options?: {
    isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
    readOnly?: boolean;
    deferrable?: boolean;
  }
): Promise<T> {
  const client = await getClient();
  const txStart = performance.now();
  
  try {
    // Start transaction with options
    let beginQuery = 'BEGIN';
    if (options?.isolationLevel) {
      beginQuery += ` ISOLATION LEVEL ${options.isolationLevel}`;
    }
    if (options?.readOnly) {
      beginQuery += ' READ ONLY';
    }
    if (options?.deferrable) {
      beginQuery += ' DEFERRABLE';
    }
    
    await client.query(beginQuery);
    
    // Execute callback with savepoint support
    const result = await callback(client);
    
    await client.query('COMMIT');
    
    const duration = performance.now() - txStart;
    if (duration > 5000) {
      logger.warn('Long-running transaction', { duration });
    }
    
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Prepared statement cache
const preparedStatements = new Map<string, { name: string; text: string; created: number }>();

/**
 * Execute query with automatic prepared statement caching
 */
export async function query<T = any>(
  text: string,
  values?: any[],
  options?: {
    cache?: boolean;
    name?: string;
  }
): Promise<QueryResult<T>> {
  const client = await getClient();
  
  try {
    // Use prepared statements for parameterized queries
    if (values && values.length > 0 && options?.cache !== false) {
      const stmtName = options?.name || `stmt_${Buffer.from(text).toString('base64').substring(0, 63)}`;
      
      if (!preparedStatements.has(stmtName)) {
        preparedStatements.set(stmtName, {
          name: stmtName,
          text,
          created: Date.now(),
        });
      }
      
      return await client.query({
        name: stmtName,
        text,
        values,
      });
    }
    
    // Regular query
    return await client.query(text, values);
  } finally {
    client.release();
  }
}

/**
 * Batch query execution for better performance
 */
export async function batchQuery<T = any>(
  queries: Array<{ text: string; values?: any[] }>
): Promise<QueryResult<T>[]> {
  const client = await getClient();
  
  try {
    await client.query('BEGIN');
    
    const results = await Promise.all(
      queries.map(q => client.query(q.text, q.values))
    );
    
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Connection pool health check
 */
export async function checkPoolHealth(): Promise<{
  healthy: boolean;
  metrics: typeof poolMetrics;
  pool: {
    total: number;
    idle: number;
    waiting: number;
  };
}> {
  try {
    const client = await getClient();
    await client.query('SELECT 1');
    client.release();
    
    return {
      healthy: true,
      metrics: { ...poolMetrics },
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (error) {
    return {
      healthy: false,
      metrics: { ...poolMetrics },
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  }
}

// Test database connection with detailed diagnostics
export async function testConnection(): Promise<void> {
  const start = performance.now();
  
  try {
    const client = await getClient();
    
    // Test basic connectivity
    const result = await client.query('SELECT version(), current_database(), pg_is_in_recovery()');
    const dbVersion = result.rows[0].version;
    const dbName = result.rows[0].current_database;
    const isReplica = result.rows[0].pg_is_in_recovery;
    
    // Test pgvector extension
    const vectorResult = await client.query(`
      SELECT extversion 
      FROM pg_extension 
      WHERE extname = 'vector'
    `);
    const hasVector = vectorResult.rows.length > 0;
    
    client.release();
    
    const duration = performance.now() - start;
    
    console.log('✅ Database connection successful');
    console.log(`   Version: ${dbVersion}`);
    console.log(`   Database: ${dbName}`);
    console.log(`   Is Replica: ${isReplica}`);
    console.log(`   PGVector: ${hasVector ? vectorResult.rows[0].extversion : 'Not installed'}`);
    console.log(`   Connection time: ${duration.toFixed(2)}ms`);
    
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
}

// Graceful shutdown with connection draining
export async function closePool(): Promise<void> {
  logger.info('Closing database pool...');
  
  // Clear prepared statement cache
  preparedStatements.clear();
  
  // Wait for active queries to complete (max 30s)
  const timeout = setTimeout(() => {
    logger.warn('Force closing database pool after timeout');
  }, 30000);
  
  try {
    await pool.end();
    clearTimeout(timeout);
    logger.info('Database pool closed successfully');
  } catch (error) {
    clearTimeout(timeout);
    logger.error('Error closing database pool', { error: error as Error });
    throw error;
  }
}

// Export pool metrics for monitoring
export function getPoolMetrics() {
  return {
    ...poolMetrics,
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
  };
}