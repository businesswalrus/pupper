import { createClient, RedisClientType } from 'redis';
import { config } from '@utils/config';
import { logger } from '@utils/logger';

// Redis client pool for better performance
class RedisPool {
  private clients: RedisClientType[] = [];
  private activeClients: Set<RedisClientType> = new Set();
  private readonly maxPoolSize = 10;
  private readonly minPoolSize = 2;
  private primaryClient: RedisClientType | null = null;

  constructor(
    private readonly connectionConfig: {
      url: string;
      maxRetriesPerRequest?: number;
      enableReadyCheck?: boolean;
      lazyConnect?: boolean;
    }
  ) {}

  async initialize(): Promise<void> {
    // Create primary client for pub/sub and blocking operations
    this.primaryClient = createClient({
      ...this.connectionConfig,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('Redis connection failed after 10 retries');
            return new Error('Max retries reached');
          }
          return Math.min(retries * 100, 3000);
        },
        connectTimeout: 5000,
        keepAlive: 5000,
      },
    });

    this.setupEventHandlers(this.primaryClient, 'primary');
    await this.primaryClient.connect();

    // Pre-create minimum pool connections
    for (let i = 0; i < this.minPoolSize; i++) {
      await this.createPoolClient();
    }

    logger.info(`Redis pool initialized with ${this.clients.length} connections`);
  }

  private async createPoolClient(): Promise<RedisClientType> {
    const client = createClient({
      ...this.connectionConfig,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
        connectTimeout: 5000,
        keepAlive: 5000,
      },
    });

    this.setupEventHandlers(client, `pool-${this.clients.length}`);
    await client.connect();
    this.clients.push(client);
    return client;
  }

  private setupEventHandlers(client: RedisClientType, name: string): void {
    client.on('error', (err) => {
      logger.error(`Redis Client Error (${name}):`, { error: err });
    });

    client.on('connect', () => {
      logger.debug(`Redis connected (${name})`);
    });

    client.on('ready', () => {
      logger.debug(`Redis ready (${name})`);
    });

    client.on('end', () => {
      logger.warn(`Redis disconnected (${name})`);
    });
  }

  async getClient(): Promise<RedisClientType> {
    // Find available client from pool
    for (const client of this.clients) {
      if (!this.activeClients.has(client) && client.isReady) {
        this.activeClients.add(client);
        
        // Return client with automatic release
        return new Proxy(client, {
          get: (target, prop) => {
            // Auto-release client after command execution
            if (typeof target[prop] === 'function') {
              return async (...args: any[]) => {
                try {
                  return await target[prop](...args);
                } finally {
                  // Release client back to pool
                  setImmediate(() => {
                    this.activeClients.delete(client);
                  });
                }
              };
            }
            return target[prop];
          },
        }) as RedisClientType;
      }
    }

    // Create new client if pool not at max capacity
    if (this.clients.length < this.maxPoolSize) {
      const newClient = await this.createPoolClient();
      this.activeClients.add(newClient);
      return newClient;
    }

    // Wait for available client
    return new Promise((resolve) => {
      const checkAvailable = setInterval(() => {
        const availableClient = this.clients.find(
          c => !this.activeClients.has(c) && c.isReady
        );
        if (availableClient) {
          clearInterval(checkAvailable);
          this.activeClients.add(availableClient);
          resolve(availableClient);
        }
      }, 10);
    });
  }

  async getPrimaryClient(): Promise<RedisClientType> {
    if (!this.primaryClient?.isReady) {
      await this.initialize();
    }
    return this.primaryClient!;
  }

  async disconnect(): Promise<void> {
    const disconnectPromises = [...this.clients, this.primaryClient]
      .filter(Boolean)
      .map(client => client?.quit());
    
    await Promise.all(disconnectPromises);
    this.clients = [];
    this.activeClients.clear();
    this.primaryClient = null;
  }

  getPoolStats() {
    return {
      totalClients: this.clients.length,
      activeClients: this.activeClients.size,
      availableClients: this.clients.length - this.activeClients.size,
      primaryClientReady: this.primaryClient?.isReady || false,
    };
  }
}

// Create pool instance
const redisPool = new RedisPool({
  url: config.redis.url,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

// Legacy client for backward compatibility
export const redisClient = createClient({
  url: config.redis.url,
});

redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Redis connected');
});

export async function connectRedis(): Promise<void> {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  await redisPool.initialize();
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient.isOpen) {
    await redisClient.disconnect();
  }
  await redisPool.disconnect();
}

// Enhanced wrapper with connection pooling
export const redis = {
  getClient: async () => {
    // Use pooled connection for better performance
    return await redisPool.getClient();
  },
  
  // Get primary client for pub/sub operations
  getPrimaryClient: async () => {
    return await redisPool.getPrimaryClient();
  },
  
  // Get pool statistics
  getPoolStats: () => {
    return redisPool.getPoolStats();
  },
  
  // Execute with automatic client management
  execute: async <T>(fn: (client: RedisClientType) => Promise<T>): Promise<T> => {
    const client = await redisPool.getClient();
    return await fn(client);
  },
  
  // Pipeline operations for batch commands
  pipeline: async <T>(commands: Array<[string, ...any[]]>): Promise<T[]> => {
    const client = await redisPool.getClient();
    const pipeline = client.multi();
    
    for (const [command, ...args] of commands) {
      (pipeline as any)[command](...args);
    }
    
    return await pipeline.exec() as T[];
  },
};