import { Pool, PoolClient, PoolConfig } from 'pg';
import { config } from '@utils/config';
import { EventEmitter } from 'events';

interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeQueries: number;
  totalConnections: number;
  errors: number;
  avgQueryTime: number;
  slowQueries: number;
}

interface QueryMetadata {
  query: string;
  duration: number;
  timestamp: Date;
  error?: Error;
}

class MonitoredPool extends EventEmitter {
  private pool: Pool;
  private metrics: PoolMetrics = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    activeQueries: 0,
    totalConnections: 0,
    errors: 0,
    avgQueryTime: 0,
    slowQueries: 0,
  };
  private queryTimes: number[] = [];
  private readonly SLOW_QUERY_THRESHOLD = 1000; // 1 second
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly INITIAL_RECONNECT_DELAY = 1000;

  constructor(config: PoolConfig) {
    super();
    
    // Optimized pool configuration
    this.pool = new Pool({
      ...config,
      // Connection pool optimization
      max: process.env.NODE_ENV === 'production' ? 50 : 20,
      min: process.env.NODE_ENV === 'production' ? 10 : 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      
      // Statement timeout to prevent long-running queries
      statement_timeout: 30000,
      
      // Enable prepared statements for better performance
      query_timeout: 30000,
      
      // Connection string includes additional parameters
      connectionString: `${config.connectionString}?sslmode=require&connect_timeout=10&application_name=pupper_bot`,
    });

    this.setupEventHandlers();
    this.startMetricsCollection();
  }

  private setupEventHandlers(): void {
    this.pool.on('connect', (client) => {
      this.metrics.totalConnections++;
      this.emit('connect', client);
    });

    this.pool.on('acquire', (client) => {
      this.metrics.activeQueries++;
      this.emit('acquire', client);
    });

    this.pool.on('release', (client) => {
      this.metrics.activeQueries--;
      this.emit('release', client);
    });

    this.pool.on('remove', (client) => {
      this.emit('remove', client);
    });

    this.pool.on('error', (err, client) => {
      this.metrics.errors++;
      console.error('Pool error:', err);
      this.emit('error', err, client);
      this.handleReconnection();
    });
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('Max reconnection attempts reached');
      return;
    }

    const delay = this.INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(`Attempting to reconnect (attempt ${this.reconnectAttempts}) in ${delay}ms`);
    
    setTimeout(async () => {
      try {
        await this.testConnection();
        this.reconnectAttempts = 0;
        console.log('Successfully reconnected to database');
      } catch (error) {
        console.error('Reconnection failed:', error);
        await this.handleReconnection();
      }
    }, delay);
  }

  private startMetricsCollection(): void {
    setInterval(() => {
      this.metrics.totalCount = this.pool.totalCount;
      this.metrics.idleCount = this.pool.idleCount;
      this.metrics.waitingCount = this.pool.waitingCount;
      
      if (this.queryTimes.length > 0) {
        this.metrics.avgQueryTime = 
          this.queryTimes.reduce((a, b) => a + b, 0) / this.queryTimes.length;
      }
      
      // Keep only last 1000 query times
      if (this.queryTimes.length > 1000) {
        this.queryTimes = this.queryTimes.slice(-1000);
      }
    }, 5000);
  }

  async query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
    const start = Date.now();
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(text, params);
      const duration = Date.now() - start;
      
      this.trackQuery({ query: text, duration, timestamp: new Date() });
      
      if (duration > this.SLOW_QUERY_THRESHOLD) {
        this.metrics.slowQueries++;
        console.warn(`Slow query detected (${duration}ms):`, text.substring(0, 100));
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.trackQuery({ 
        query: text, 
        duration, 
        timestamp: new Date(), 
        error: error as Error 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  private trackQuery(metadata: QueryMetadata): void {
    this.queryTimes.push(metadata.duration);
    this.emit('query', metadata);
  }

  async getClient(): Promise<PoolClient> {
    const client = await this.pool.connect();
    
    // Wrap the client to track query metrics
    const originalQuery = client.query.bind(client);
    client.query = async (...args: any[]) => {
      const start = Date.now();
      try {
        const result = await originalQuery(...args);
        const duration = Date.now() - start;
        this.trackQuery({ 
          query: args[0], 
          duration, 
          timestamp: new Date() 
        });
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        this.trackQuery({ 
          query: args[0], 
          duration, 
          timestamp: new Date(), 
          error: error as Error 
        });
        throw error;
      }
    };
    
    return client;
  }

  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
    isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      if (isolationLevel) {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      }
      
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async testConnection(): Promise<void> {
    const client = await this.getClient();
    try {
      await client.query('SELECT NOW()');
      console.log('✅ Database connection successful');
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  getMetrics(): PoolMetrics {
    return { ...this.metrics };
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    metrics: PoolMetrics;
    latency: number;
  }> {
    const start = Date.now();
    try {
      await this.query('SELECT 1');
      return {
        healthy: true,
        metrics: this.getMetrics(),
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        metrics: this.getMetrics(),
        latency: Date.now() - start,
      };
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

// Create optimized pool instance
export const optimizedPool = new MonitoredPool({
  connectionString: config.database.url,
});

// Export helper functions
export async function getClient(): Promise<PoolClient> {
  return optimizedPool.getClient();
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
): Promise<T> {
  return optimizedPool.transaction(callback, isolationLevel);
}

export async function query<T = any>(
  text: string, 
  params?: any[]
): Promise<{ rows: T[] }> {
  return optimizedPool.query<T>(text, params);
}

// Monitoring endpoint data
export function getPoolMetrics(): PoolMetrics {
  return optimizedPool.getMetrics();
}

// Health check for monitoring
export async function checkDatabaseHealth() {
  return optimizedPool.healthCheck();
}

// Setup query logging in development
if (config.app.nodeEnv === 'development') {
  optimizedPool.on('query', (metadata: QueryMetadata) => {
    if (metadata.duration > 100) {
      console.log(`[DB] ${metadata.duration}ms - ${metadata.query.substring(0, 100)}`);
    }
  });
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await optimizedPool.end();
}