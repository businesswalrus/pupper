import { messageRepository } from '@db/repositories/messageRepository';
import { summaryRepository } from '@db/repositories/summaryRepository';
import { userRepository } from '@db/repositories/userRepository';
import { generateEmbedding } from '@ai/openai';
import { Message } from '@db/repositories/messageRepository';
import { ConversationSummary } from '@db/repositories/summaryRepository';
import { User } from '@db/repositories/userRepository';

export interface MemoryContext {
  recentMessages: Message[];
  relevantMessages: Message[];
  threadContext?: Message[];
  conversationSummaries?: ConversationSummary[];
  userProfiles?: Map<string, User>;
  userRelationships?: any[];
  totalMessages: number;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  includeRecent?: boolean;
  channelId?: string;
  hours?: number;
}

/**
 * Search for semantically similar messages
 */
export async function searchSimilarMessages(
  query: string,
  options: SearchOptions = {}
): Promise<Message[]> {
  const {
    limit = 10,
    threshold = 0.7,
    channelId,
  } = options;

  try {
    // Generate embedding for the query
    const { embedding } = await generateEmbedding(query);
    
    // Search for similar messages
    let similarMessages = await messageRepository.findSimilar(
      embedding,
      limit * 2, // Get more to filter by channel if needed
      threshold
    );

    // Filter by channel if specified
    if (channelId) {
      similarMessages = similarMessages.filter(msg => msg.channel_id === channelId);
    }

    // Return top matches
    return similarMessages.slice(0, limit);
  } catch (error) {
    console.error('Error searching similar messages:', error);
    return [];
  }
}

/**
 * Build context for a conversation
 */
export async function buildConversationContext(
  channelId: string,
  query?: string,
  options: {
    recentLimit?: number;
    relevantLimit?: number;
    hours?: number;
    threadTs?: string;
    includeProfiles?: boolean;
    includeSummaries?: boolean;
  } = {}
): Promise<MemoryContext> {
  const {
    recentLimit = 20,
    relevantLimit = 10,
    hours = 24,
    threadTs,
    includeProfiles = true,
    includeSummaries = true,
  } = options;

  try {
    // Get recent messages from the channel
    const recentMessages = await messageRepository.getRecentMessages(
      channelId,
      hours,
      recentLimit
    );

    // Get relevant messages if query provided
    let relevantMessages: Message[] = [];
    if (query) {
      relevantMessages = await searchSimilarMessages(query, {
        limit: relevantLimit,
        channelId,
        includeRecent: false,
      });

      // Remove duplicates between recent and relevant
      const recentIds = new Set(recentMessages.map(m => m.id));
      relevantMessages = relevantMessages.filter(m => !recentIds.has(m.id));
    }

    // Get thread context if in a thread
    let threadContext: Message[] | undefined;
    if (threadTs) {
      threadContext = await messageRepository.findByChannel(channelId, {
        thread_ts: threadTs,
        limit: 50,
      });
    }

    // Get conversation summaries
    let conversationSummaries: ConversationSummary[] | undefined;
    if (includeSummaries) {
      conversationSummaries = await summaryRepository.findByChannel(channelId, 5);
    }

    // Get user profiles for participants
    let userProfiles: Map<string, User> | undefined;
    if (includeProfiles) {
      const allMessages = [...recentMessages, ...relevantMessages, ...(threadContext || [])];
      const userIds = new Set(allMessages.map(m => m.slack_user_id));
      
      userProfiles = new Map();
      for (const userId of userIds) {
        const user = await userRepository.findBySlackId(userId);
        if (user) {
          userProfiles.set(userId, user);
        }
      }
    }

    // Get total message count for context
    const totalMessages = await messageRepository.countByChannel(channelId);

    return {
      recentMessages,
      relevantMessages,
      threadContext,
      conversationSummaries,
      userProfiles,
      totalMessages,
    };
  } catch (error) {
    console.error('Error building conversation context:', error);
    return {
      recentMessages: [],
      relevantMessages: [],
      totalMessages: 0,
    };
  }
}

/**
 * Format memory context for prompt
 */
export function formatMemoryContext(context: MemoryContext): string {
  const sections: string[] = [];

  // Add conversation summaries if available
  if (context.conversationSummaries && context.conversationSummaries.length > 0) {
    sections.push('=== Recent Conversation History ===');
    context.conversationSummaries.slice(0, 3).forEach(summary => {
      const date = new Date(summary.created_at!).toLocaleDateString();
      sections.push(`[${date}] ${summary.summary}`);
      if (summary.key_topics && summary.key_topics.length > 0) {
        sections.push(`Topics: ${summary.key_topics.join(', ')}`);
      }
    });
    sections.push('');
  }

  // Add user profiles if available
  if (context.userProfiles && context.userProfiles.size > 0) {
    sections.push('=== User Profiles ===');
    context.userProfiles.forEach((user, userId) => {
      if (user.personality_summary) {
        sections.push(`${user.username || userId}: ${user.personality_summary}`);
      }
    });
    sections.push('');
  }

  // Add thread context if available
  if (context.threadContext && context.threadContext.length > 0) {
    sections.push('=== Thread Context ===');
    context.threadContext.forEach(msg => {
      const userName = context.userProfiles?.get(msg.slack_user_id)?.username || msg.slack_user_id;
      sections.push(`[${userName}]: ${msg.message_text}`);
    });
    sections.push('');
  }

  // Add relevant past messages
  if (context.relevantMessages.length > 0) {
    sections.push('=== Relevant Past Conversations ===');
    context.relevantMessages.forEach(msg => {
      const date = new Date(msg.created_at!).toLocaleDateString();
      const userName = context.userProfiles?.get(msg.slack_user_id)?.username || msg.slack_user_id;
      sections.push(`[${date} - ${userName}]: ${msg.message_text}`);
    });
    sections.push('');
  }

  // Add recent messages
  if (context.recentMessages.length > 0) {
    sections.push('=== Recent Conversation ===');
    context.recentMessages.forEach(msg => {
      const userName = context.userProfiles?.get(msg.slack_user_id)?.username || msg.slack_user_id;
      sections.push(`[${userName}]: ${msg.message_text}`);
    });
  }

  return sections.join('\n');
}

/**
 * Find messages that might trigger a response
 */
export async function findTriggerMessages(
  channelId: string,
  keywords: string[]
): Promise<Message[]> {
  const results: Message[] = [];
  
  for (const keyword of keywords) {
    const messages = await searchSimilarMessages(keyword, {
      channelId,
      limit: 5,
      threshold: 0.8,
    });
    results.push(...messages);
  }

  // Remove duplicates
  const uniqueMessages = Array.from(
    new Map(results.map(m => [m.id, m])).values()
  );

  return uniqueMessages;
}

/**
 * Analyze conversation patterns
 */
export async function analyzeConversationPatterns(
  channelId: string,
  userId: string
): Promise<{
  messageCount: number;
  averageLength: number;
  commonTopics: string[];
  activeHours: number[];
}> {
  // This is a placeholder for more sophisticated analysis
  // In a real implementation, this would analyze message patterns,
  // extract topics, and identify user behavior patterns
  
  const messages = await messageRepository.findByChannel(channelId, {
    limit: 100,
  });

  const userMessages = messages.filter(m => m.slack_user_id === userId);
  
  return {
    messageCount: userMessages.length,
    averageLength: userMessages.reduce((sum, m) => sum + m.message_text.length, 0) / userMessages.length,
    commonTopics: [], // TODO: Implement topic extraction
    activeHours: [], // TODO: Implement time analysis
  };
}