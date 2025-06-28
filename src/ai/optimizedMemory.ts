import { cachedMessageRepository } from '@db/repositories/cachedMessageRepository';
import { summaryRepository } from '@db/repositories/summaryRepository';
import { userRepository } from '@db/repositories/userRepository';
import { generateEmbedding } from '@ai/openai';
import { Message } from '@db/repositories/messageRepository';
import { ConversationSummary } from '@db/repositories/summaryRepository';
import { User } from '@db/repositories/userRepository';
import { redis } from '@db/redis';
import { query } from '@db/optimizedConnection';

export interface OptimizedMemoryContext {
  recentMessages: Message[];
  relevantMessages: Array<Message & { relevance_score: number }>;
  threadContext?: Message[];
  conversationSummaries?: ConversationSummary[];
  userProfiles?: Map<string, User>;
  userRelationships?: any[];
  totalMessages: number;
  contextScore: number; // Quality score of the context
  performanceMetrics: {
    queryTime: number;
    cacheHits: number;
    totalQueries: number;
  };
}

export interface OptimizedSearchOptions {
  limit?: number;
  threshold?: number;
  includeRecent?: boolean;
  channelId?: string;
  hours?: number;
  timeWeight?: number;
  channelWeight?: number;
  userWeight?: number;
  useAdaptiveThreshold?: boolean;
}

export class OptimizedMemoryRetrieval {
  private readonly CONTEXT_CACHE_PREFIX = 'context:';
  private readonly CONTEXT_CACHE_TTL = 300; // 5 minutes
  private performanceMetrics = {
    queryTime: 0,
    cacheHits: 0,
    totalQueries: 0,
  };

  /**
   * Adaptive similarity threshold based on result distribution
   */
  private async getAdaptiveThreshold(
    embedding: number[],
    targetResults: number = 10
  ): Promise<number> {
    // Sample similarity distribution
    const sampleQuery = `
      SELECT 
        1 - (embedding <=> $1::vector) as similarity
      FROM messages 
      WHERE embedding IS NOT NULL
      ORDER BY RANDOM()
      LIMIT 1000
    `;
    
    const embeddingStr = `{${embedding.join(',')}}`;
    const result = await query<{ similarity: number }>(sampleQuery, [embeddingStr]);
    
    if (result.rows.length < targetResults) {
      return 0.5; // Fallback threshold
    }
    
    // Calculate percentile for target results
    const similarities = result.rows.map(r => r.similarity).sort((a, b) => b - a);
    const percentileIndex = Math.min(targetResults * 2, similarities.length - 1);
    
    return Math.max(0.5, similarities[percentileIndex]);
  }

  /**
   * Search for semantically similar messages with performance optimization
   */
  async searchSimilarMessages(
    queryText: string,
    options: OptimizedSearchOptions = {}
  ): Promise<Array<Message & { relevance_score: number }>> {
    const {
      limit = 10,
      threshold = 0.7,
      channelId,
      timeWeight = 0.2,
      channelWeight = 0.1,
      useAdaptiveThreshold = true,
    } = options;

    const start = Date.now();
    this.performanceMetrics.totalQueries++;

    try {
      // Generate embedding for the query
      const { embedding } = await generateEmbedding(queryText);
      
      // Use adaptive threshold if enabled
      const effectiveThreshold = useAdaptiveThreshold
        ? await this.getAdaptiveThreshold(embedding, limit)
        : threshold;
      
      // Search with relevance scoring
      const messages = await cachedMessageRepository.getRelevantMessages(
        embedding,
        channelId || '',
        {
          limit: limit * 2, // Get more for post-filtering
          threshold: effectiveThreshold,
          timeWeight,
          channelWeight,
        }
      );
      
      // Post-process and filter
      let filteredMessages = messages;
      if (channelId) {
        filteredMessages = messages.filter(msg => msg.channel_id === channelId);
      }
      
      this.performanceMetrics.queryTime = Date.now() - start;
      
      return filteredMessages.slice(0, limit);
    } catch (error) {
      console.error('Error searching similar messages:', error);
      return [];
    }
  }

  /**
   * Build optimized conversation context with parallel queries
   */
  async buildConversationContext(
    channelId: string,
    query?: string,
    options: {
      recentLimit?: number;
      relevantLimit?: number;
      hours?: number;
      threadTs?: string;
      includeProfiles?: boolean;
      includeSummaries?: boolean;
      useCache?: boolean;
    } = {}
  ): Promise<OptimizedMemoryContext> {
    const {
      recentLimit = 20,
      relevantLimit = 10,
      hours = 24,
      threadTs,
      includeProfiles = true,
      includeSummaries = true,
      useCache = true,
    } = options;

    const start = Date.now();
    const cacheKey = this.generateContextCacheKey(channelId, query, options);
    
    // Check cache
    if (useCache) {
      const cached = await this.getContextCache(cacheKey);
      if (cached) {
        this.performanceMetrics.cacheHits++;
        return {
          ...cached,
          performanceMetrics: {
            ...this.performanceMetrics,
            queryTime: Date.now() - start,
          },
        };
      }
    }

    try {
      // Execute parallel queries for better performance
      const [
        recentMessages,
        relevantMessages,
        threadContext,
        conversationSummaries,
        totalMessages,
      ] = await Promise.all([
        // Recent messages
        cachedMessageRepository.getRecentMessages(channelId, hours, recentLimit),
        
        // Relevant messages (if query provided)
        query
          ? this.searchSimilarMessages(query, {
              limit: relevantLimit,
              channelId,
              includeRecent: false,
            })
          : Promise.resolve([]),
        
        // Thread context
        threadTs
          ? cachedMessageRepository.findByChannel(channelId, {
              thread_ts: threadTs,
              limit: 50,
            })
          : Promise.resolve(undefined),
        
        // Conversation summaries
        includeSummaries
          ? summaryRepository.findByChannel(channelId, 5)
          : Promise.resolve(undefined),
        
        // Total message count
        cachedMessageRepository.countByChannel(channelId),
      ]);

      // Remove duplicates between recent and relevant
      const recentIds = new Set(recentMessages.map(m => m.id));
      const dedupedRelevant = relevantMessages.filter(m => !recentIds.has(m.id));

      // Get user profiles in batch
      let userProfiles: Map<string, User> | undefined;
      if (includeProfiles) {
        const allMessages = [
          ...recentMessages,
          ...dedupedRelevant,
          ...(threadContext || []),
        ];
        userProfiles = await this.batchLoadUserProfiles(
          allMessages.map(m => m.slack_user_id)
        );
      }

      // Calculate context quality score
      const contextScore = this.calculateContextScore({
        recentMessages,
        relevantMessages: dedupedRelevant,
        threadContext,
        conversationSummaries,
      });

      const context: OptimizedMemoryContext = {
        recentMessages,
        relevantMessages: dedupedRelevant,
        threadContext,
        conversationSummaries,
        userProfiles,
        totalMessages,
        contextScore,
        performanceMetrics: {
          ...this.performanceMetrics,
          queryTime: Date.now() - start,
        },
      };

      // Cache the context
      if (useCache) {
        await this.setContextCache(cacheKey, context);
      }

      return context;
    } catch (error) {
      console.error('Error building conversation context:', error);
      return {
        recentMessages: [],
        relevantMessages: [],
        totalMessages: 0,
        contextScore: 0,
        performanceMetrics: {
          ...this.performanceMetrics,
          queryTime: Date.now() - start,
        },
      };
    }
  }

  /**
   * Batch load user profiles with caching
   */
  private async batchLoadUserProfiles(
    userIds: string[]
  ): Promise<Map<string, User>> {
    const uniqueIds = [...new Set(userIds)];
    const profiles = new Map<string, User>();
    
    // Check cache for each user
    const uncachedIds: string[] = [];
    const cachePromises = uniqueIds.map(async (id) => {
      const cached = await this.getUserCache(id);
      if (cached) {
        profiles.set(id, cached);
      } else {
        uncachedIds.push(id);
      }
    });
    
    await Promise.all(cachePromises);
    
    // Batch load uncached users
    if (uncachedIds.length > 0) {
      const batchQuery = `
        SELECT * FROM users 
        WHERE slack_user_id = ANY($1::text[])
      `;
      
      const result = await query<User>(batchQuery, [uncachedIds]);
      
      // Cache and add to map
      await Promise.all(
        result.rows.map(async (user) => {
          profiles.set(user.slack_user_id, user);
          await this.setUserCache(user.slack_user_id, user);
        })
      );
    }
    
    return profiles;
  }

  /**
   * Calculate context quality score
   */
  private calculateContextScore(context: {
    recentMessages: Message[];
    relevantMessages: any[];
    threadContext?: Message[];
    conversationSummaries?: ConversationSummary[];
  }): number {
    let score = 0;
    
    // Recent messages contribute to temporal relevance
    score += Math.min(context.recentMessages.length / 20, 1) * 0.3;
    
    // Relevant messages contribute to semantic relevance
    if (context.relevantMessages.length > 0) {
      const avgRelevance = context.relevantMessages.reduce(
        (sum, msg) => sum + (msg.relevance_score || 0),
        0
      ) / context.relevantMessages.length;
      score += avgRelevance * 0.4;
    }
    
    // Thread context adds continuity
    if (context.threadContext && context.threadContext.length > 0) {
      score += 0.2;
    }
    
    // Summaries add historical context
    if (context.conversationSummaries && context.conversationSummaries.length > 0) {
      score += 0.1;
    }
    
    return Math.min(score, 1);
  }

  /**
   * Advanced pattern analysis with caching
   */
  async analyzeConversationPatterns(
    channelId: string,
    userId?: string,
    days: number = 30
  ): Promise<{
    patterns: {
      peakHours: number[];
      commonTopics: Array<{ topic: string; frequency: number }>;
      sentimentTrend: Array<{ date: string; sentiment: number }>;
      userInteractionGraph: Array<{ user1: string; user2: string; strength: number }>;
    };
    statistics: {
      messageCount: number;
      uniqueUsers: number;
      avgMessageLength: number;
      avgResponseTime: number;
    };
  }> {
    const cacheKey = `patterns:${channelId}:${userId || 'all'}:${days}`;
    const cached = await this.getCache(cacheKey);
    if (cached) return cached;

    // Complex analysis query using window functions
    const analysisQuery = `
      WITH message_analysis AS (
        SELECT 
          m.*,
          EXTRACT(HOUR FROM m.created_at) as hour,
          LENGTH(m.message_text) as msg_length,
          LAG(m.created_at) OVER (PARTITION BY m.channel_id ORDER BY m.created_at) as prev_msg_time,
          LAG(m.slack_user_id) OVER (PARTITION BY m.channel_id ORDER BY m.created_at) as prev_user
        FROM messages m
        WHERE m.channel_id = $1
          AND m.created_at >= CURRENT_TIMESTAMP - INTERVAL '1 day' * $2
          ${userId ? 'AND m.slack_user_id = $3' : ''}
      ),
      hourly_distribution AS (
        SELECT hour, COUNT(*) as msg_count
        FROM message_analysis
        GROUP BY hour
      ),
      user_interactions AS (
        SELECT 
          slack_user_id as user1,
          prev_user as user2,
          COUNT(*) as interaction_count
        FROM message_analysis
        WHERE prev_user IS NOT NULL
          AND slack_user_id != prev_user
        GROUP BY slack_user_id, prev_user
        HAVING COUNT(*) > 5
      )
      SELECT 
        (SELECT json_agg(json_build_object('hour', hour, 'count', msg_count) ORDER BY msg_count DESC) FROM hourly_distribution) as peak_hours,
        (SELECT json_agg(json_build_object('user1', user1, 'user2', user2, 'strength', interaction_count) ORDER BY interaction_count DESC) FROM user_interactions LIMIT 20) as interactions,
        COUNT(DISTINCT slack_user_id) as unique_users,
        COUNT(*) as total_messages,
        AVG(msg_length) as avg_length,
        AVG(EXTRACT(EPOCH FROM (created_at - prev_msg_time))) as avg_response_time
      FROM message_analysis
    `;

    const values = userId ? [channelId, days, userId] : [channelId, days];
    const result = await query<any>(analysisQuery, values);
    
    if (result.rows.length === 0) {
      return {
        patterns: {
          peakHours: [],
          commonTopics: [],
          sentimentTrend: [],
          userInteractionGraph: [],
        },
        statistics: {
          messageCount: 0,
          uniqueUsers: 0,
          avgMessageLength: 0,
          avgResponseTime: 0,
        },
      };
    }

    const row = result.rows[0];
    const patterns = {
      patterns: {
        peakHours: (row.peak_hours || []).slice(0, 3).map((h: any) => h.hour),
        commonTopics: [], // Would require NLP processing
        sentimentTrend: [], // Would require sentiment analysis
        userInteractionGraph: row.interactions || [],
      },
      statistics: {
        messageCount: parseInt(row.total_messages) || 0,
        uniqueUsers: parseInt(row.unique_users) || 0,
        avgMessageLength: parseFloat(row.avg_length) || 0,
        avgResponseTime: parseFloat(row.avg_response_time) || 0,
      },
    };

    // Cache for 1 hour
    await this.setCache(cacheKey, patterns, 3600);
    
    return patterns;
  }

  // Cache management helpers
  private generateContextCacheKey(
    channelId: string,
    query?: string,
    options?: any
  ): string {
    const key = `${this.CONTEXT_CACHE_PREFIX}${channelId}:${query || 'no-query'}:${JSON.stringify(options)}`;
    return key.substring(0, 200); // Limit key length
  }

  private async getContextCache(key: string): Promise<any> {
    try {
      const client = await redis.getClient();
      const data = await client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Context cache get error:', error);
      return null;
    }
  }

  private async setContextCache(key: string, data: any): Promise<void> {
    try {
      const client = await redis.getClient();
      // Don't cache performance metrics
      const { performanceMetrics, ...cacheData } = data;
      await client.setEx(key, this.CONTEXT_CACHE_TTL, JSON.stringify(cacheData));
    } catch (error) {
      console.error('Context cache set error:', error);
    }
  }

  private async getUserCache(userId: string): Promise<User | null> {
    try {
      const client = await redis.getClient();
      const data = await client.get(`user:${userId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      return null;
    }
  }

  private async setUserCache(userId: string, user: User): Promise<void> {
    try {
      const client = await redis.getClient();
      await client.setEx(`user:${userId}`, 3600, JSON.stringify(user));
    } catch (error) {
      console.error('User cache set error:', error);
    }
  }

  private async getCache(key: string): Promise<any> {
    try {
      const client = await redis.getClient();
      const data = await client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      return null;
    }
  }

  private async setCache(key: string, data: any, ttl: number): Promise<void> {
    try {
      const client = await redis.getClient();
      await client.setEx(key, ttl, JSON.stringify(data));
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  // Get performance metrics
  getPerformanceMetrics() {
    return { ...this.performanceMetrics };
  }

  // Reset performance metrics
  resetPerformanceMetrics() {
    this.performanceMetrics = {
      queryTime: 0,
      cacheHits: 0,
      totalQueries: 0,
    };
  }
}

// Export singleton instance
export const optimizedMemory = new OptimizedMemoryRetrieval();

// Export convenience functions
export const searchSimilarMessages = optimizedMemory.searchSimilarMessages.bind(optimizedMemory);
export const buildConversationContext = optimizedMemory.buildConversationContext.bind(optimizedMemory);
export const analyzeConversationPatterns = optimizedMemory.analyzeConversationPatterns.bind(optimizedMemory);