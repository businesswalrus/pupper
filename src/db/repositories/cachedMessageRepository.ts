import { Message, MessageSearchOptions, MessageRepository } from './messageRepository';
import { cache, CacheTier } from '../../services/cache';
import { logger } from '@utils/logger';
import { pool } from '@db/connection';

/**
 * Cached version of MessageRepository with multi-tier caching
 */
export class CachedMessageRepository extends MessageRepository {
  private readonly NAMESPACE = 'messages';
  
  async findByTimestamp(messageTs: string): Promise<Message | null> {
    return cache.getOrSet(
      this.NAMESPACE,
      `byTs:${messageTs}`,
      () => super.findByTimestamp(messageTs),
      { tier: CacheTier.WARM }
    );
  }

  async findByChannel(
    channelId: string,
    options: MessageSearchOptions = {}
  ): Promise<Message[]> {
    // Don't cache if using pagination or specific filters
    if (options.offset || options.start_date || options.end_date) {
      return super.findByChannel(channelId, options);
    }

    const cacheKey = `byChannel:${channelId}:${JSON.stringify(options)}`;
    
    return cache.getOrSet(
      this.NAMESPACE,
      cacheKey,
      () => super.findByChannel(channelId, options),
      { 
        tier: CacheTier.HOT,
        ttl: 300, // 5 minutes for channel messages
        tags: [`channel:${channelId}`]
      }
    );
  }

  async create(message: Message): Promise<Message> {
    const result = await super.create(message);
    
    // Invalidate channel cache
    await cache.invalidateTag(`channel:${message.channel_id}`);
    
    // Pre-cache the created message
    await cache.set(
      this.NAMESPACE,
      `byTs:${result.message_ts}`,
      result,
      { tier: CacheTier.WARM }
    );
    
    return result;
  }

  async updateEmbedding(
    messageTs: string,
    embedding: number[],
    model: string
  ): Promise<Message | null> {
    const result = await super.updateEmbedding(messageTs, embedding, model);
    
    if (result) {
      // Update cache
      await cache.set(
        this.NAMESPACE,
        `byTs:${messageTs}`,
        result,
        { tier: CacheTier.WARM }
      );
      
      // Invalidate channel cache
      await cache.invalidateTag(`channel:${result.channel_id}`);
    }
    
    return result;
  }

  async findSimilar(
    embedding: number[],
    limit: number = 10,
    threshold: number = 0.7
  ): Promise<Message[]> {
    // Cache similar message queries for 10 minutes
    const embeddingHash = this.hashEmbedding(embedding);
    
    return cache.getOrSet(
      this.NAMESPACE,
      `similar:${embeddingHash}:${limit}:${threshold}`,
      () => super.findSimilar(embedding, limit, threshold),
      { 
        tier: CacheTier.WARM,
        ttl: 600 // 10 minutes
      }
    );
  }

  async getRecentMessages(
    channelId: string,
    hours: number = 24,
    limit: number = 100
  ): Promise<Message[]> {
    // Cache recent messages for 1 minute (they change frequently)
    return cache.getOrSet(
      this.NAMESPACE,
      `recent:${channelId}:${hours}:${limit}`,
      () => super.getRecentMessages(channelId, hours, limit),
      { 
        tier: CacheTier.HOT,
        ttl: 60, // 1 minute
        tags: [`channel:${channelId}`]
      }
    );
  }

  async countByChannel(channelId: string): Promise<number> {
    return cache.getOrSet(
      this.NAMESPACE,
      `count:${channelId}`,
      () => super.countByChannel(channelId),
      { 
        tier: CacheTier.WARM,
        ttl: 300, // 5 minutes
        tags: [`channel:${channelId}`]
      }
    );
  }

  async getMessagesWithoutEmbeddings(limit: number = 100): Promise<Message[]> {
    // Don't cache this query as it changes frequently
    return super.getMessagesWithoutEmbeddings(limit);
  }

  /**
   * Batch get messages by timestamps with caching
   */
  async batchGetByTimestamps(timestamps: string[]): Promise<Map<string, Message | null>> {
    return cache.mget(
      this.NAMESPACE,
      timestamps.map(ts => `byTs:${ts}`),
      async (missing) => {
        const results = new Map<string, Message | null>();
        
        // Batch query missing messages
        if (missing.length > 0) {
          const query = `
            SELECT * FROM messages 
            WHERE message_ts = ANY($1::text[])
          `;
          const queryResult = await pool.query(query, [missing]);
          
          queryResult.rows.forEach(row => {
            results.set(`byTs:${row.message_ts}`, row);
          });
          
          // Add nulls for not found
          missing.forEach(ts => {
            if (!results.has(`byTs:${ts}`)) {
              results.set(`byTs:${ts}`, null);
            }
          });
        }
        
        return results;
      },
      { tier: CacheTier.WARM }
    );
  }

  /**
   * Pre-warm cache with recent messages
   */
  async warmCache(channelIds: string[]): Promise<void> {
    logger.info(`Warming cache for ${channelIds.length} channels`);
    
    const promises = channelIds.map(async (channelId) => {
      try {
        // Pre-fetch recent messages
        const messages = await super.getRecentMessages(channelId, 24, 100);
        
        // Cache individual messages
        const items = messages.map(msg => ({
          identifier: `byTs:${msg.message_ts}`,
          value: msg
        }));
        
        await cache.warmUp(this.NAMESPACE, items);
        
        // Cache the collection
        await cache.set(
          this.NAMESPACE,
          `recent:${channelId}:24:100`,
          messages,
          { tier: CacheTier.HOT, ttl: 60 }
        );
        
      } catch (error) {
        logger.error(`Failed to warm cache for channel ${channelId}`, { error: error as Error });
      }
    });
    
    await Promise.all(promises);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return cache.getStats(this.NAMESPACE);
  }

  /**
   * Clear all message caches
   */
  async clearCache(): Promise<void> {
    await cache.clearNamespace(this.NAMESPACE);
  }

  /**
   * Hash embedding for cache key
   */
  private hashEmbedding(embedding: number[]): string {
    // Use first 10 and last 10 values as hash
    const sample = [
      ...embedding.slice(0, 10),
      ...embedding.slice(-10)
    ].join(',');
    
    const { createHash } = require('crypto');
    return createHash('sha256').update(sample).digest('hex').substring(0, 16);
  }
}

// Export cached version as default
export const messageRepository = new CachedMessageRepository();