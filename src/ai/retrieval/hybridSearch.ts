import { messageRepository, Message } from '@db/repositories/messageRepository';
import { generateEmbedding } from '@ai/openai';
import { pool } from '@db/connection';
import { logger } from '@utils/logger';

export interface HybridSearchOptions {
  channelId?: string;
  limit?: number;
  semanticWeight?: number; // 0-1, where 1 is fully semantic
  temporalDecay?: number; // How much to decay scores based on age
  minScore?: number; // Minimum score threshold
  recentHours?: number; // Boost recent messages
}

export interface ScoredMessage extends Message {
  score: number;
  semanticScore?: number;
  keywordScore?: number;
  temporalScore?: number;
  explanation?: string;
}

/**
 * Hybrid search combining keyword (BM25) and semantic (vector) search
 */
export class HybridSearchEngine {
  /**
   * Perform hybrid search combining multiple retrieval methods
   */
  async search(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<ScoredMessage[]> {
    const {
      channelId,
      limit = 20,
      semanticWeight = 0.7,
      temporalDecay = 0.1,
      minScore = 0.3,
      recentHours = 168, // 1 week
    } = options;

    const timer = logger.startTimer('HybridSearch.search');

    try {
      // Run searches in parallel
      const [keywordResults, semanticResults, recentMessages] = await Promise.all([
        this.keywordSearch(query, channelId, limit * 2),
        this.semanticSearch(query, channelId, limit * 2),
        this.getRecentMessages(channelId, recentHours, limit),
      ]);

      // Combine and score results
      const combinedResults = this.fuseResults(
        keywordResults,
        semanticResults,
        recentMessages,
        {
          semanticWeight,
          temporalDecay,
          query,
        }
      );

      // Filter by minimum score and limit
      const filtered = combinedResults
        .filter(msg => msg.score >= minScore)
        .slice(0, limit);

      timer();
      logger.info('Hybrid search completed', {
        metadata: {
          query,
          keywordCount: keywordResults.length,
          semanticCount: semanticResults.length,
          finalCount: filtered.length,
        },
      });

      return filtered;
    } catch (error) {
      timer();
      logger.error('Hybrid search failed', { error: error as Error });
      throw error;
    }
  }

  /**
   * Keyword-based search using PostgreSQL full-text search
   */
  private async keywordSearch(
    query: string,
    channelId?: string,
    limit: number = 50
  ): Promise<ScoredMessage[]> {
    const searchQuery = `
      WITH ranked_messages AS (
        SELECT 
          m.*,
          ts_rank_cd(
            to_tsvector('english', message_text),
            plainto_tsquery('english', $1)
          ) as rank,
          ts_headline(
            'english',
            message_text,
            plainto_tsquery('english', $1),
            'MaxWords=20, MinWords=10'
          ) as headline
        FROM messages m
        WHERE 
          to_tsvector('english', message_text) @@ plainto_tsquery('english', $1)
          ${channelId ? 'AND channel_id = $2' : ''}
        ORDER BY rank DESC
        LIMIT ${channelId ? '$3' : '$2'}
      )
      SELECT * FROM ranked_messages WHERE rank > 0
    `;

    const values = channelId ? [query, channelId, limit] : [query, limit];
    const result = await pool.query(searchQuery, values);

    return result.rows.map(row => ({
      ...row,
      score: row.rank,
      keywordScore: row.rank,
      explanation: row.headline,
    }));
  }

  /**
   * Semantic search using vector embeddings
   */
  private async semanticSearch(
    query: string,
    channelId?: string,
    limit: number = 50
  ): Promise<ScoredMessage[]> {
    // Generate query embedding
    const { embedding } = await generateEmbedding(query);

    const searchQuery = `
      SELECT 
        m.*,
        1 - (m.embedding <=> $1::vector) as similarity,
        CASE 
          WHEN 1 - (m.embedding <=> $1::vector) > 0.9 THEN 'Very similar'
          WHEN 1 - (m.embedding <=> $1::vector) > 0.8 THEN 'Similar'
          WHEN 1 - (m.embedding <=> $1::vector) > 0.7 THEN 'Somewhat similar'
          ELSE 'Related'
        END as match_type
      FROM messages m
      WHERE 
        m.embedding IS NOT NULL
        ${channelId ? 'AND m.channel_id = $2' : ''}
        AND 1 - (m.embedding <=> $1::vector) > 0.5
      ORDER BY m.embedding <=> $1::vector
      LIMIT ${channelId ? '$3' : '$2'}
    `;

    const embeddingStr = `[${embedding.join(',')}]`;
    const values = channelId 
      ? [embeddingStr, channelId, limit]
      : [embeddingStr, limit];

    const result = await pool.query(searchQuery, values);

    return result.rows.map(row => ({
      ...row,
      score: row.similarity,
      semanticScore: row.similarity,
      explanation: row.match_type,
    }));
  }

  /**
   * Get recent messages with temporal scoring
   */
  private async getRecentMessages(
    channelId?: string,
    hours: number = 168,
    limit: number = 50
  ): Promise<Message[]> {
    if (!channelId) return [];

    return messageRepository.getRecentMessages(channelId, hours, limit);
  }

  /**
   * Fuse results from different search methods
   */
  private fuseResults(
    keywordResults: ScoredMessage[],
    semanticResults: ScoredMessage[],
    recentMessages: Message[],
    options: {
      semanticWeight: number;
      temporalDecay: number;
      query: string;
    }
  ): ScoredMessage[] {
    const { semanticWeight, temporalDecay } = options;
    const keywordWeight = 1 - semanticWeight;

    // Create a map to track all unique messages
    const messageMap = new Map<string, ScoredMessage>();

    // Add keyword results
    keywordResults.forEach(msg => {
      messageMap.set(msg.message_ts, {
        ...msg,
        score: msg.keywordScore! * keywordWeight,
        keywordScore: msg.keywordScore,
        semanticScore: 0,
        temporalScore: 0,
      });
    });

    // Add/update with semantic results
    semanticResults.forEach(msg => {
      const existing = messageMap.get(msg.message_ts);
      if (existing) {
        existing.semanticScore = msg.semanticScore;
        existing.score += msg.semanticScore! * semanticWeight;
      } else {
        messageMap.set(msg.message_ts, {
          ...msg,
          score: msg.semanticScore! * semanticWeight,
          semanticScore: msg.semanticScore,
          keywordScore: 0,
          temporalScore: 0,
        });
      }
    });

    // Calculate temporal scores
    const now = Date.now();
    messageMap.forEach(msg => {
      const age = now - new Date(msg.created_at!).getTime();
      const ageInHours = age / (1000 * 60 * 60);
      
      // Exponential decay based on age
      const temporalScore = Math.exp(-temporalDecay * ageInHours / 24);
      msg.temporalScore = temporalScore;
      
      // Boost score based on recency
      msg.score *= (1 + temporalScore * 0.2);
    });

    // Check if any recent messages should be boosted
    recentMessages.forEach(recentMsg => {
      const existing = messageMap.get(recentMsg.message_ts);
      if (existing) {
        // Boost recent messages that appear in search results
        existing.score *= 1.1;
      }
    });

    // Sort by combined score
    const results = Array.from(messageMap.values())
      .sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Re-rank results using advanced features
   */
  async rerank(
    messages: ScoredMessage[],
    query: string,
    options: {
      diversityWeight?: number;
      userPreferences?: Map<string, number>;
    } = {}
  ): Promise<ScoredMessage[]> {
    const { diversityWeight = 0.2, userPreferences = new Map() } = options;

    // Calculate diversity scores to avoid redundant results
    const reranked = [...messages];
    
    for (let i = 1; i < reranked.length; i++) {
      let diversityPenalty = 0;
      
      // Check similarity with previous results
      for (let j = 0; j < i; j++) {
        const similarity = this.calculateTextSimilarity(
          reranked[i].message_text,
          reranked[j].message_text
        );
        
        if (similarity > 0.8) {
          diversityPenalty += (1 - diversityWeight) * similarity;
        }
      }
      
      // Apply diversity penalty
      reranked[i].score *= (1 - diversityPenalty);
      
      // Apply user preference boost
      const userBoost = userPreferences.get(reranked[i].slack_user_id) || 1;
      reranked[i].score *= userBoost;
    }

    // Re-sort after reranking
    return reranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate text similarity using Jaccard coefficient
   */
  private calculateTextSimilarity(text1: string, text2: string): number {
    const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
    const tokens2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);
    
    return intersection.size / union.size;
  }
}

/**
 * Thread-aware retrieval for conversation context
 */
export class ThreadRetriever {
  /**
   * Get all messages in a thread with smart ordering
   */
  async getThreadContext(
    channelId: string,
    threadTs: string,
    options: {
      includeRelated?: boolean;
      maxMessages?: number;
    } = {}
  ): Promise<Message[]> {
    const { includeRelated = true, maxMessages = 100 } = options;

    // Get direct thread messages
    const threadMessages = await messageRepository.findByChannel(channelId, {
      thread_ts: threadTs,
      limit: maxMessages,
    });

    if (!includeRelated || threadMessages.length === 0) {
      return threadMessages;
    }

    // Find related threads or conversations
    const originalMessage = threadMessages.find(m => m.message_ts === threadTs);
    if (!originalMessage) return threadMessages;

    // Search for related content
    const hybridSearch = new HybridSearchEngine();
    const related = await hybridSearch.search(
      originalMessage.message_text.slice(0, 200),
      {
        channelId,
        limit: 10,
        semanticWeight: 0.8,
      }
    );

    // Merge and deduplicate
    const allMessages = [...threadMessages];
    const existingTs = new Set(threadMessages.map(m => m.message_ts));

    related.forEach(msg => {
      if (!existingTs.has(msg.message_ts)) {
        allMessages.push(msg);
      }
    });

    // Sort by timestamp
    return allMessages.sort((a, b) => 
      new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime()
    );
  }
}

/**
 * Create necessary database indexes for hybrid search
 */
export async function createSearchIndexes(): Promise<void> {
  const queries = [
    // Full-text search index
    `CREATE INDEX IF NOT EXISTS idx_messages_fts 
     ON messages USING gin(to_tsvector('english', message_text))`,
    
    // Composite index for channel-based searches
    `CREATE INDEX IF NOT EXISTS idx_messages_channel_created 
     ON messages(channel_id, created_at DESC)`,
    
    // Index for thread searches
    `CREATE INDEX IF NOT EXISTS idx_messages_thread 
     ON messages(thread_ts, created_at) WHERE thread_ts IS NOT NULL`,
  ];

  for (const query of queries) {
    try {
      await pool.query(query);
      logger.info(`Created search index: ${query.split(' ')[5]}`);
    } catch (error) {
      logger.error('Failed to create search index', { error: error as Error });
    }
  }
}