import { redis } from '@db/redis';
import { logger } from '@utils/logger';
import { createHash } from 'crypto';

export enum CacheTier {
  HOT = 'hot',      // L1: Frequently accessed, short TTL (5 mins)
  WARM = 'warm',    // L2: Moderately accessed, medium TTL (1 hour)
  COLD = 'cold',    // L3: Infrequently accessed, long TTL (24 hours)
}

export interface CacheOptions {
  tier?: CacheTier;
  ttl?: number; // Override default TTL
  tags?: string[]; // For invalidation groups
  compress?: boolean; // Compress large values
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

// Default TTLs by tier (in seconds)
const TIER_TTLS = {
  [CacheTier.HOT]: 300,      // 5 minutes
  [CacheTier.WARM]: 3600,    // 1 hour
  [CacheTier.COLD]: 86400,   // 24 hours
};

// Cache key prefixes
const KEY_PREFIXES = {
  data: 'cache:data:',
  tags: 'cache:tags:',
  stats: 'cache:stats:',
  locks: 'cache:locks:',
};

export class CacheService {
  private readonly stats: Map<string, CacheStats> = new Map();
  private readonly localCache: Map<string, { value: any; expires: number }> = new Map();
  private readonly maxLocalCacheSize = 1000; // Max items in local cache

  constructor() {
    // Periodically clean up expired local cache entries
    setInterval(() => this.cleanupLocalCache(), 60000); // Every minute
  }

  /**
   * Generate cache key with namespace
   */
  private generateKey(namespace: string, identifier: string): string {
    const hash = createHash('sha256').update(identifier).digest('hex').substring(0, 16);
    return `${KEY_PREFIXES.data}${namespace}:${hash}`;
  }

  /**
   * Get value from cache with multi-tier lookup
   */
  async get<T>(
    namespace: string,
    identifier: string,
    factory?: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T | null> {
    const key = this.generateKey(namespace, identifier);
    const tier = options.tier || CacheTier.WARM;

    try {
      // Check local cache first (L0)
      const localValue = this.getFromLocalCache(key);
      if (localValue !== null) {
        this.recordHit(namespace);
        return localValue;
      }

      // Check Redis cache
      const client = await redis.getClient();
      const cached = await client.get(key);

      if (cached) {
        this.recordHit(namespace);
        const value = options.compress ? 
          JSON.parse(await this.decompress(cached)) : 
          JSON.parse(cached);
        
        // Store in local cache for hot data
        if (tier === CacheTier.HOT) {
          this.setLocalCache(key, value, 60); // 1 minute local cache
        }
        
        return value;
      }

      this.recordMiss(namespace);

      // If factory provided, compute and cache the value
      if (factory) {
        const value = await factory();
        await this.set(namespace, identifier, value, options);
        return value;
      }

      return null;
    } catch (error) {
      logger.error('Cache get error', { error: error as Error, namespace, key });
      // Fail open - if cache fails, try factory if provided
      return factory ? await factory() : null;
    }
  }

  /**
   * Set value in cache with tier-based TTL
   */
  async set<T>(
    namespace: string,
    identifier: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<void> {
    const key = this.generateKey(namespace, identifier);
    const tier = options.tier || CacheTier.WARM;
    const ttl = options.ttl || TIER_TTLS[tier];

    try {
      const client = await redis.getClient();
      const serialized = JSON.stringify(value);
      const data = options.compress ? await this.compress(serialized) : serialized;

      // Set in Redis with TTL
      await client.setEx(key, ttl, data);

      // Handle tags for group invalidation
      if (options.tags && options.tags.length > 0) {
        await this.addToTags(key, options.tags, ttl);
      }

      // Store in local cache for hot data
      if (tier === CacheTier.HOT) {
        this.setLocalCache(key, value, Math.min(ttl, 60));
      }

      this.recordSize(namespace, data.length);
    } catch (error) {
      logger.error('Cache set error', { error: error as Error, namespace, key });
    }
  }

  /**
   * Delete value from cache
   */
  async delete(namespace: string, identifier: string): Promise<void> {
    const key = this.generateKey(namespace, identifier);
    
    try {
      const client = await redis.getClient();
      await client.del(key);
      this.localCache.delete(key);
      this.recordEviction(namespace);
    } catch (error) {
      logger.error('Cache delete error', { error: error as Error, namespace, key });
    }
  }

  /**
   * Invalidate all cache entries with a specific tag
   */
  async invalidateTag(tag: string): Promise<void> {
    try {
      const client = await redis.getClient();
      const tagKey = `${KEY_PREFIXES.tags}${tag}`;
      const keys = await client.sMembers(tagKey);

      if (keys.length > 0) {
        // Delete all keys with this tag
        await client.del(...keys);
        
        // Clean up local cache
        keys.forEach(key => this.localCache.delete(key));
        
        // Delete the tag set
        await client.del(tagKey);
        
        logger.info(`Invalidated ${keys.length} cache entries for tag: ${tag}`);
      }
    } catch (error) {
      logger.error('Cache tag invalidation error', { error: error as Error, tag });
    }
  }

  /**
   * Batch get multiple values
   */
  async mget<T>(
    namespace: string,
    identifiers: string[],
    factory?: (missing: string[]) => Promise<Map<string, T>>,
    options: CacheOptions = {}
  ): Promise<Map<string, T | null>> {
    const results = new Map<string, T | null>();
    const keys = identifiers.map(id => this.generateKey(namespace, id));
    const keyToId = new Map(identifiers.map((id, i) => [keys[i], id]));

    try {
      const client = await redis.getClient();
      const cached = await client.mGet(keys);
      const missing: string[] = [];

      cached.forEach((value, index) => {
        const identifier = identifiers[index];
        if (value) {
          this.recordHit(namespace);
          const parsed = options.compress ? 
            JSON.parse(this.decompress(value)) : 
            JSON.parse(value);
          results.set(identifier, parsed);
        } else {
          this.recordMiss(namespace);
          missing.push(identifier);
        }
      });

      // Fetch missing values if factory provided
      if (factory && missing.length > 0) {
        const computed = await factory(missing);
        
        // Cache the computed values
        for (const [id, value] of computed) {
          await this.set(namespace, id, value, options);
          results.set(id, value);
        }
      }

      return results;
    } catch (error) {
      logger.error('Cache mget error', { error: error as Error, namespace });
      // Fail open - compute all if cache fails
      if (factory) {
        return await factory(identifiers);
      }
      return new Map(identifiers.map(id => [id, null]));
    }
  }

  /**
   * Implement cache-aside pattern with locking to prevent stampede
   */
  async getOrSet<T>(
    namespace: string,
    identifier: string,
    factory: () => Promise<T>,
    options: CacheOptions & { lockTimeout?: number } = {}
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(namespace, identifier);
    if (cached !== null) {
      return cached;
    }

    // Acquire lock to prevent cache stampede
    const lockKey = `${KEY_PREFIXES.locks}${namespace}:${identifier}`;
    const lockTimeout = options.lockTimeout || 5000; // 5 seconds default
    
    try {
      const client = await redis.getClient();
      const lockId = Math.random().toString(36).substring(7);
      
      // Try to acquire lock
      const acquired = await client.set(lockKey, lockId, {
        NX: true,
        PX: lockTimeout,
      });

      if (!acquired) {
        // Another process is computing, wait and retry
        await new Promise(resolve => setTimeout(resolve, 100));
        return await this.get(namespace, identifier, factory, options) as T;
      }

      // Compute the value
      const value = await factory();
      
      // Cache the result
      await this.set(namespace, identifier, value, options);
      
      // Release lock
      const currentLock = await client.get(lockKey);
      if (currentLock === lockId) {
        await client.del(lockKey);
      }
      
      return value;
    } catch (error) {
      logger.error('Cache getOrSet error', { error: error as Error, namespace, identifier });
      // Fail open - return computed value even if caching fails
      return await factory();
    }
  }

  /**
   * Warm up cache with precomputed values
   */
  async warmUp(
    namespace: string,
    items: Array<{ identifier: string; value: any }>,
    options: CacheOptions = {}
  ): Promise<void> {
    const promises = items.map(({ identifier, value }) =>
      this.set(namespace, identifier, value, { ...options, tier: CacheTier.WARM })
    );
    
    await Promise.all(promises);
    logger.info(`Warmed up ${items.length} cache entries for namespace: ${namespace}`);
  }

  /**
   * Get cache statistics
   */
  getStats(namespace?: string): CacheStats | Map<string, CacheStats> {
    if (namespace) {
      return this.stats.get(namespace) || { hits: 0, misses: 0, evictions: 0, size: 0 };
    }
    return new Map(this.stats);
  }

  /**
   * Clear all cache entries for a namespace
   */
  async clearNamespace(namespace: string): Promise<void> {
    try {
      const client = await redis.getClient();
      const pattern = `${KEY_PREFIXES.data}${namespace}:*`;
      
      // Use SCAN to find all keys in namespace
      const keys: string[] = [];
      for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keys.push(key);
      }
      
      if (keys.length > 0) {
        await client.del(...keys);
        // Clear from local cache
        keys.forEach(key => this.localCache.delete(key));
        logger.info(`Cleared ${keys.length} cache entries for namespace: ${namespace}`);
      }
    } catch (error) {
      logger.error('Cache clear namespace error', { error: error as Error, namespace });
    }
  }

  // Private helper methods

  private getFromLocalCache(key: string): any | null {
    const entry = this.localCache.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.value;
    }
    this.localCache.delete(key);
    return null;
  }

  private setLocalCache(key: string, value: any, ttlSeconds: number): void {
    // Implement LRU eviction if cache is full
    if (this.localCache.size >= this.maxLocalCacheSize) {
      const firstKey = this.localCache.keys().next().value;
      if (firstKey) {
        this.localCache.delete(firstKey);
      }
    }
    
    this.localCache.set(key, {
      value,
      expires: Date.now() + (ttlSeconds * 1000),
    });
  }

  private cleanupLocalCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.localCache) {
      if (entry.expires <= now) {
        this.localCache.delete(key);
      }
    }
  }

  private async addToTags(key: string, tags: string[], ttl: number): Promise<void> {
    const client = await redis.getClient();
    const promises = tags.map(tag => {
      const tagKey = `${KEY_PREFIXES.tags}${tag}`;
      return client.sAdd(tagKey, key).then(() => client.expire(tagKey, ttl));
    });
    await Promise.all(promises);
  }

  private async compress(data: string): Promise<string> {
    // Use built-in zlib compression
    const { gzip } = await import('zlib');
    const { promisify } = await import('util');
    const gzipAsync = promisify(gzip);
    const compressed = await gzipAsync(Buffer.from(data));
    return compressed.toString('base64');
  }

  private async decompress(data: string): Promise<string> {
    const { gunzip } = await import('zlib');
    const { promisify } = await import('util');
    const gunzipAsync = promisify(gunzip);
    const decompressed = await gunzipAsync(Buffer.from(data, 'base64'));
    return decompressed.toString();
  }

  private recordHit(namespace: string): void {
    const stats = this.stats.get(namespace) || { hits: 0, misses: 0, evictions: 0, size: 0 };
    stats.hits++;
    this.stats.set(namespace, stats);
  }

  private recordMiss(namespace: string): void {
    const stats = this.stats.get(namespace) || { hits: 0, misses: 0, evictions: 0, size: 0 };
    stats.misses++;
    this.stats.set(namespace, stats);
  }

  private recordEviction(namespace: string): void {
    const stats = this.stats.get(namespace) || { hits: 0, misses: 0, evictions: 0, size: 0 };
    stats.evictions++;
    this.stats.set(namespace, stats);
  }

  private recordSize(namespace: string, bytes: number): void {
    const stats = this.stats.get(namespace) || { hits: 0, misses: 0, evictions: 0, size: 0 };
    stats.size = bytes;
    this.stats.set(namespace, stats);
  }
}

// Export singleton instance
export const cache = new CacheService();

// Export cache decorators for easy method caching
export function Cacheable(namespace: string, options: CacheOptions = {}) {
  return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const identifier = `${propertyName}:${JSON.stringify(args)}`;
      
      return await cache.getOrSet(
        namespace,
        identifier,
        async () => method.apply(this, args),
        options
      );
    };

    return descriptor;
  };
}