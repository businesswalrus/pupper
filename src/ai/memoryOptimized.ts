import { HybridSearchEngine, ThreadRetriever, ScoredMessage } from '@ai/retrieval/hybridSearch';
import { messageRepository, Message } from '@db/repositories/messageRepository';
import { summaryRepository, ConversationSummary } from '@db/repositories/summaryRepository';
import { userRepository, User } from '@db/repositories/userRepository';
import { logger } from '@utils/logger';
import LRUCache from 'lru-cache';

export interface OptimizedMemoryContext {
  recentMessages: Message[];
  relevantMessages: ScoredMessage[];
  threadContext?: Message[];
  conversationSummaries?: ConversationSummary[];
  userProfiles?: Map<string, User>;
  contextWindow: {
    tokens: number;
    messages: number;
    quality: number; // 0-1 score
  };
  searchMetadata?: {
    keywordMatches: number;
    semanticMatches: number;
    hybridScore: number;
  };
}

export interface ContextBuildOptions {
  maxTokens?: number;
  recentLimit?: number;
  relevantLimit?: number;
  hours?: number;
  threadTs?: string;
  includeProfiles?: boolean;
  includeSummaries?: boolean;
  semanticWeight?: number;
  diversityWeight?: number;
}

/**
 * Context quality scorer
 */
class ContextQualityScorer {
  /**
   * Score the quality of retrieved context
   */
  score(context: OptimizedMemoryContext): number {
    let score = 0;
    let weights = 0;

    // Recency factor
    if (context.recentMessages.length > 0) {
      const recencyScore = Math.min(context.recentMessages.length / 10, 1);
      score += recencyScore * 0.3;
      weights += 0.3;
    }

    // Relevance factor
    if (context.relevantMessages.length > 0) {
      const avgRelevance = context.relevantMessages.reduce((sum, msg) => sum + msg.score, 0) / context.relevantMessages.length;
      score += avgRelevance * 0.4;
      weights += 0.4;
    }

    // Diversity factor
    if (context.relevantMessages.length > 1) {
      const uniqueUsers = new Set(context.relevantMessages.map(m => m.slack_user_id)).size;
      const diversityScore = uniqueUsers / context.relevantMessages.length;
      score += diversityScore * 0.1;
      weights += 0.1;
    }

    // Thread completeness
    if (context.threadContext && context.threadContext.length > 0) {
      score += 0.1;
      weights += 0.1;
    }

    // Profile availability
    if (context.userProfiles && context.userProfiles.size > 0) {
      score += 0.1;
      weights += 0.1;
    }

    return weights > 0 ? score / weights : 0;
  }
}

/**
 * Optimized memory system with caching and smart context building
 */
export class OptimizedMemorySystem {
  private hybridSearch: HybridSearchEngine;
  private threadRetriever: ThreadRetriever;
  private contextCache: LRUCache<string, OptimizedMemoryContext>;
  private qualityScorer: ContextQualityScorer;

  constructor() {
    this.hybridSearch = new HybridSearchEngine();
    this.threadRetriever = new ThreadRetriever();
    this.qualityScorer = new ContextQualityScorer();
    
    // Cache contexts for 15 minutes
    this.contextCache = new LRUCache<string, OptimizedMemoryContext>({
      max: 100,
      ttl: 15 * 60 * 1000,
    });
  }

  /**
   * Build optimized conversation context
   */
  async buildContext(
    channelId: string,
    query?: string,
    options: ContextBuildOptions = {}
  ): Promise<OptimizedMemoryContext> {
    const {
      maxTokens = 4000,
      recentLimit = 20,
      relevantLimit = 15,
      hours = 48,
      threadTs,
      includeProfiles = true,
      includeSummaries = true,
      semanticWeight = 0.7,
      diversityWeight = 0.2,
    } = options;

    // Check cache first
    const cacheKey = `${channelId}:${query || 'recent'}:${threadTs || 'main'}`;
    const cached = this.contextCache.get(cacheKey);
    if (cached) {
      logger.debug('Using cached context', { cacheKey });
      return cached;
    }

    const timer = logger.startTimer('OptimizedMemory.buildContext');

    try {
      // Parallel data fetching
      const [
        recentMessages,
        relevantMessages,
        threadContext,
        conversationSummaries,
      ] = await Promise.all([
        // Recent messages
        messageRepository.getRecentMessages(channelId, hours, recentLimit),
        
        // Relevant messages using hybrid search
        query ? this.hybridSearch.search(query, {
          channelId,
          limit: relevantLimit * 2, // Get extra for filtering
          semanticWeight,
          recentHours: hours * 2,
        }) : Promise.resolve([]),
        
        // Thread context
        threadTs ? this.threadRetriever.getThreadContext(channelId, threadTs, {
          includeRelated: true,
          maxMessages: 50,
        }) : Promise.resolve(undefined),
        
        // Conversation summaries
        includeSummaries ? summaryRepository.findByChannel(channelId, 3) : Promise.resolve(undefined),
      ]);

      // Deduplicate and rerank relevant messages
      let processedRelevant = relevantMessages;
      if (relevantMessages.length > 0) {
        // Remove messages already in recent
        const recentIds = new Set(recentMessages.map(m => m.message_ts));
        processedRelevant = relevantMessages.filter(m => !recentIds.has(m.message_ts));

        // Apply diversity reranking
        if (diversityWeight > 0) {
          processedRelevant = await this.hybridSearch.rerank(processedRelevant, query!, {
            diversityWeight,
          });
        }

        // Limit to requested amount
        processedRelevant = processedRelevant.slice(0, relevantLimit);
      }

      // Get user profiles
      let userProfiles: Map<string, User> | undefined;
      if (includeProfiles) {
        userProfiles = await this.loadUserProfiles([
          ...recentMessages,
          ...processedRelevant,
          ...(threadContext || []),
        ]);
      }

      // Calculate token usage
      const contextWindow = this.calculateContextWindow(
        recentMessages,
        processedRelevant,
        threadContext,
        conversationSummaries,
        maxTokens
      );

      // Build context
      const context: OptimizedMemoryContext = {
        recentMessages,
        relevantMessages: processedRelevant,
        threadContext,
        conversationSummaries,
        userProfiles,
        contextWindow,
        searchMetadata: query ? {
          keywordMatches: processedRelevant.filter(m => m.keywordScore && m.keywordScore > 0).length,
          semanticMatches: processedRelevant.filter(m => m.semanticScore && m.semanticScore > 0).length,
          hybridScore: processedRelevant.reduce((sum, m) => sum + m.score, 0) / processedRelevant.length,
        } : undefined,
      };

      // Score context quality
      context.contextWindow.quality = this.qualityScorer.score(context);

      // Cache the context
      this.contextCache.set(cacheKey, context);

      timer();
      logger.info('Context built successfully', {
        metadata: {
          channelId,
          hasQuery: !!query,
          recentCount: recentMessages.length,
          relevantCount: processedRelevant.length,
          quality: context.contextWindow.quality.toFixed(2),
          tokens: context.contextWindow.tokens,
        },
      });

      return context;
    } catch (error) {
      timer();
      logger.error('Failed to build context', { error: error as Error });
      
      // Return minimal context on error
      return {
        recentMessages: [],
        relevantMessages: [],
        contextWindow: { tokens: 0, messages: 0, quality: 0 },
      };
    }
  }

  /**
   * Load user profiles efficiently
   */
  private async loadUserProfiles(messages: Message[]): Promise<Map<string, User>> {
    const userIds = new Set(messages.map(m => m.slack_user_id));
    const profiles = new Map<string, User>();

    // Batch load users
    const users = await Promise.all(
      Array.from(userIds).map(id => userRepository.findBySlackId(id))
    );

    users.forEach(user => {
      if (user) {
        profiles.set(user.slack_user_id, user);
      }
    });

    return profiles;
  }

  /**
   * Calculate context window usage
   */
  private calculateContextWindow(
    recentMessages: Message[],
    relevantMessages: ScoredMessage[],
    threadContext?: Message[],
    summaries?: ConversationSummary[],
    maxTokens: number = 4000
  ): OptimizedMemoryContext['contextWindow'] {
    let totalTokens = 0;
    let messageCount = 0;

    // Estimate tokens (rough approximation)
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    // Recent messages
    recentMessages.forEach(msg => {
      totalTokens += estimateTokens(msg.message_text);
      messageCount++;
    });

    // Relevant messages
    relevantMessages.forEach(msg => {
      totalTokens += estimateTokens(msg.message_text);
      messageCount++;
    });

    // Thread context
    if (threadContext) {
      threadContext.forEach(msg => {
        totalTokens += estimateTokens(msg.message_text);
        messageCount++;
      });
    }

    // Summaries
    if (summaries) {
      summaries.forEach(summary => {
        totalTokens += estimateTokens(summary.summary);
      });
    }

    // Add overhead for formatting
    totalTokens *= 1.2;

    return {
      tokens: Math.min(totalTokens, maxTokens),
      messages: messageCount,
      quality: 0, // Will be set by quality scorer
    };
  }

  /**
   * Format context for prompts with smart truncation
   */
  formatContext(
    context: OptimizedMemoryContext,
    options: {
      maxTokens?: number;
      includeScores?: boolean;
      prioritizeRecent?: boolean;
    } = {}
  ): string {
    const {
      maxTokens = 3000,
      includeScores = false,
      prioritizeRecent = true,
    } = options;

    const sections: string[] = [];
    let currentTokens = 0;
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);

    // Add summaries first (most compact)
    if (context.conversationSummaries && context.conversationSummaries.length > 0) {
      sections.push('=== Conversation History ===');
      context.conversationSummaries.slice(0, 2).forEach(summary => {
        const text = `[${new Date(summary.created_at!).toLocaleDateString()}] ${summary.summary}`;
        if (currentTokens + estimateTokens(text) < maxTokens) {
          sections.push(text);
          currentTokens += estimateTokens(text);
        }
      });
      sections.push('');
    }

    // Add user profiles
    if (context.userProfiles && context.userProfiles.size > 0) {
      sections.push('=== Active Users ===');
      context.userProfiles.forEach((user, userId) => {
        if (user.personality_summary) {
          const text = `${user.username}: ${user.personality_summary}`;
          if (currentTokens + estimateTokens(text) < maxTokens) {
            sections.push(text);
            currentTokens += estimateTokens(text);
          }
        }
      });
      sections.push('');
    }

    // Add thread context if available
    if (context.threadContext && context.threadContext.length > 0) {
      sections.push('=== Thread Context ===');
      const threadMessages = prioritizeRecent 
        ? context.threadContext.slice(-10)
        : context.threadContext.slice(0, 10);

      threadMessages.forEach(msg => {
        const userName = context.userProfiles?.get(msg.slack_user_id)?.username || 'unknown';
        const text = `[${userName}]: ${msg.message_text}`;
        if (currentTokens + estimateTokens(text) < maxTokens * 0.8) {
          sections.push(text);
          currentTokens += estimateTokens(text);
        }
      });
      sections.push('');
    }

    // Add relevant messages with scores
    if (context.relevantMessages.length > 0) {
      sections.push('=== Relevant Context ===');
      context.relevantMessages.forEach(msg => {
        const userName = context.userProfiles?.get(msg.slack_user_id)?.username || 'unknown';
        const scoreInfo = includeScores ? ` [relevance: ${msg.score.toFixed(2)}]` : '';
        const text = `[${userName}]${scoreInfo}: ${msg.message_text}`;
        
        if (currentTokens + estimateTokens(text) < maxTokens * 0.9) {
          sections.push(text);
          currentTokens += estimateTokens(text);
        }
      });
      sections.push('');
    }

    // Add recent messages (most important, so last to ensure inclusion)
    if (context.recentMessages.length > 0) {
      sections.push('=== Recent Conversation ===');
      const recentToInclude = prioritizeRecent
        ? context.recentMessages
        : context.recentMessages.slice(-15);

      recentToInclude.forEach(msg => {
        const userName = context.userProfiles?.get(msg.slack_user_id)?.username || 'unknown';
        const text = `[${userName}]: ${msg.message_text}`;
        
        if (currentTokens + estimateTokens(text) < maxTokens) {
          sections.push(text);
          currentTokens += estimateTokens(text);
        }
      });
    }

    // Add metadata if included
    if (context.searchMetadata && includeScores) {
      sections.push('');
      sections.push(`=== Search Quality ===`);
      sections.push(`Keyword matches: ${context.searchMetadata.keywordMatches}`);
      sections.push(`Semantic matches: ${context.searchMetadata.semanticMatches}`);
      sections.push(`Average relevance: ${context.searchMetadata.hybridScore.toFixed(2)}`);
      sections.push(`Context quality: ${context.contextWindow.quality.toFixed(2)}`);
    }

    return sections.join('\n');
  }

  /**
   * Clear context cache
   */
  clearCache(): void {
    this.contextCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.contextCache.size,
      hits: 0, // Would need to track this
      misses: 0, // Would need to track this
    };
  }
}