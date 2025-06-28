import { Redis } from 'ioredis';
import { config } from '@utils/config';
import { logger } from '@utils/logger';
import { compress, decompress } from 'lz4js';

const CACHE_PREFIX = 'emb:';
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const COMPRESSION_THRESHOLD = 1024; // Compress embeddings larger than 1KB

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  sets: number;
  errors: number;
  compressionRatio: number;
}

/**
 * Redis-based embedding cache with compression
 */
export class RedisEmbeddingCache {
  private redis: Redis;
  private stats: EmbeddingCacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    errors: 0,
    compressionRatio: 1,
  };

  constructor() {
    this.redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.redis.on('error', (error) => {
      logger.error('Redis cache error', { error });
      this.stats.errors++;
    });
  }

  /**
   * Get a single embedding from cache
   */
  async get(key: string): Promise<number[] | null> {
    try {
      const data = await this.redis.getBuffer(`${CACHE_PREFIX}${key}`);
      
      if (!data) {
        this.stats.misses++;
        return null;
      }

      this.stats.hits++;
      return this.deserializeEmbedding(data);
    } catch (error) {
      logger.error('Cache get error', { error: error as Error, key });
      this.stats.errors++;
      return null;
    }
  }

  /**
   * Set a single embedding in cache
   */
  async set(key: string, embedding: number[]): Promise<void> {
    try {
      const data = this.serializeEmbedding(embedding);
      await this.redis.setex(
        `${CACHE_PREFIX}${key}`,
        CACHE_TTL,
        data
      );
      this.stats.sets++;
    } catch (error) {
      logger.error('Cache set error', { error: error as Error, key });
      this.stats.errors++;
    }
  }

  /**
   * Get multiple embeddings from cache
   */
  async mget(keys: string[]): Promise<(number[] | null)[]> {
    if (keys.length === 0) return [];

    try {
      const pipeline = this.redis.pipeline();
      keys.forEach(key => {
        pipeline.getBuffer(`${CACHE_PREFIX}${key}`);
      });

      const results = await pipeline.exec();
      if (!results) return keys.map(() => null);

      return results.map((result, index) => {
        if (result[0] || !result[1]) {
          this.stats.misses++;
          return null;
        }
        this.stats.hits++;
        return this.deserializeEmbedding(result[1] as Buffer);
      });
    } catch (error) {
      logger.error('Cache mget error', { error: error as Error });
      this.stats.errors++;
      return keys.map(() => null);
    }
  }

  /**
   * Set multiple embeddings in cache
   */
  async mset(entries: Array<[string, number[]]>): Promise<void> {
    if (entries.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();
      
      entries.forEach(([key, embedding]) => {
        const data = this.serializeEmbedding(embedding);
        pipeline.setex(`${CACHE_PREFIX}${key}`, CACHE_TTL, data);
      });

      await pipeline.exec();
      this.stats.sets += entries.length;
    } catch (error) {
      logger.error('Cache mset error', { error: error as Error });
      this.stats.errors++;
    }
  }

  /**
   * Delete embeddings from cache
   */
  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    try {
      await this.redis.del(...keys.map(key => `${CACHE_PREFIX}${key}`));
    } catch (error) {
      logger.error('Cache delete error', { error: error as Error });
      this.stats.errors++;
    }
  }

  /**
   * Clear all embeddings from cache
   */
  async clear(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${CACHE_PREFIX}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      logger.error('Cache clear error', { error: error as Error });
      this.stats.errors++;
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): EmbeddingCacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? (this.stats.hits / total) * 100 : 0,
    } as EmbeddingCacheStats;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      errors: 0,
      compressionRatio: 1,
    };
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Serialize embedding with optional compression
   */
  private serializeEmbedding(embedding: number[]): Buffer {
    // Convert to Float32Array for efficient storage
    const float32Array = new Float32Array(embedding);
    const buffer = Buffer.from(float32Array.buffer);

    // Compress if larger than threshold
    if (buffer.length > COMPRESSION_THRESHOLD) {
      const compressed = compress(buffer);
      this.updateCompressionRatio(buffer.length, compressed.length);
      // Add compression flag
      return Buffer.concat([Buffer.from([1]), compressed]);
    }

    // No compression flag
    return Buffer.concat([Buffer.from([0]), buffer]);
  }

  /**
   * Deserialize embedding with decompression if needed
   */
  private deserializeEmbedding(data: Buffer): number[] {
    const isCompressed = data[0] === 1;
    const embeddingData = data.slice(1);

    let buffer: Buffer;
    if (isCompressed) {
      buffer = Buffer.from(decompress(embeddingData));
    } else {
      buffer = embeddingData;
    }

    // Convert back to number array
    const float32Array = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 4
    );
    
    return Array.from(float32Array);
  }

  /**
   * Update compression ratio statistics
   */
  private updateCompressionRatio(original: number, compressed: number): void {
    const ratio = compressed / original;
    // Moving average
    this.stats.compressionRatio = 
      (this.stats.compressionRatio * 0.9) + (ratio * 0.1);
  }
}

/**
 * In-memory LRU cache for hot embeddings
 */
export class LRUEmbeddingCache {
  private cache: Map<string, { embedding: number[]; timestamp: number }>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 1000, ttlMs: number = 3600000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  get(key: string): number[] | null {
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry.embedding;
  }

  set(key: string, embedding: number[]): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      embedding,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Two-tier cache combining in-memory LRU and Redis
 */
export class TwoTierEmbeddingCache {
  private lru: LRUEmbeddingCache;
  private redis: RedisEmbeddingCache;

  constructor() {
    this.lru = new LRUEmbeddingCache(500); // Hot cache for 500 embeddings
    this.redis = new RedisEmbeddingCache();
  }

  async get(key: string): Promise<number[] | null> {
    // Check L1 (memory)
    const l1Result = this.lru.get(key);
    if (l1Result) return l1Result;

    // Check L2 (Redis)
    const l2Result = await this.redis.get(key);
    if (l2Result) {
      // Promote to L1
      this.lru.set(key, l2Result);
      return l2Result;
    }

    return null;
  }

  async set(key: string, embedding: number[]): Promise<void> {
    // Set in both tiers
    this.lru.set(key, embedding);
    await this.redis.set(key, embedding);
  }

  async mget(keys: string[]): Promise<(number[] | null)[]> {
    const results: (number[] | null)[] = [];
    const missingIndices: number[] = [];
    const missingKeys: string[] = [];

    // Check L1 first
    keys.forEach((key, index) => {
      const l1Result = this.lru.get(key);
      if (l1Result) {
        results[index] = l1Result;
      } else {
        results[index] = null;
        missingIndices.push(index);
        missingKeys.push(key);
      }
    });

    // Check L2 for missing
    if (missingKeys.length > 0) {
      const l2Results = await this.redis.mget(missingKeys);
      
      l2Results.forEach((embedding, i) => {
        const originalIndex = missingIndices[i];
        if (embedding) {
          results[originalIndex] = embedding;
          // Promote to L1
          this.lru.set(missingKeys[i], embedding);
        }
      });
    }

    return results;
  }

  async mset(entries: Array<[string, number[]]>): Promise<void> {
    // Set in L1
    entries.forEach(([key, embedding]) => {
      this.lru.set(key, embedding);
    });
    
    // Set in L2
    await this.redis.mset(entries);
  }

  getStats() {
    return this.redis.getStats();
  }

  async close() {
    await this.redis.close();
  }
}