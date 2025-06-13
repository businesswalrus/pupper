import { Worker, Job } from 'bullmq';
import { config } from '@utils/config';
import { messageRepository } from '@db/repositories/messageRepository';
import { userRepository } from '@db/repositories/userRepository';
import { interactionRepository } from '@db/repositories/interactionRepository';
import { generateChatCompletion } from '@ai/openai';
import { buildUserAnalysisPrompt } from '@ai/prompts';
import { UserProfileJob } from './queues';

// Redis connection for worker
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port || '6379'),
  password: new URL(config.redis.url).password || undefined,
};

/**
 * Process user profile job
 */
async function processProfileJob(job: Job<UserProfileJob>) {
  const { userId, forceUpdate } = job.data;
  
  console.log(`Building profile for user ${userId}`);

  try {
    // Get user from database
    const user = await userRepository.findBySlackId(userId);
    if (!user) {
      console.log(`User ${userId} not found in database`);
      return;
    }

    // Check if update is needed
    if (!forceUpdate && user.personality_summary && user.updated_at) {
      const hoursSinceUpdate = (Date.now() - new Date(user.updated_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceUpdate < 24) {
        console.log(`Profile for ${userId} is recent, skipping update`);
        return;
      }
    }

    // Fetch recent messages from user
    const recentMessages = await messageRepository.findByChannel('', {
      user_id: userId,
      limit: 100,
      offset: 0,
    });

    if (recentMessages.length < 10) {
      console.log(`Not enough messages from user ${userId} to build profile`);
      return;
    }

    // Get interaction statistics
    const interactionStats = await interactionRepository.getInteractionStats(userId);

    // Extract message texts
    const messageTexts = recentMessages.map(m => m.message_text);

    // Analyze communication patterns
    const patterns = analyzePatterns(messageTexts);

    // Generate personality summary using AI
    const analysisPrompt = buildUserAnalysisPrompt(
      messageTexts.slice(0, 50), // Limit to avoid token limits
      user.username || userId
    );

    const personalityResponse = await generateChatCompletion([
      { role: 'system', content: 'You are an expert at analyzing communication patterns and personalities.' },
      { role: 'user', content: analysisPrompt },
    ], {
      temperature: 0.7,
      max_tokens: 200,
    });

    // Extract interests from topics
    const interests = [
      ...patterns.commonTopics,
      ...interactionStats.topTopics,
    ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 10); // Unique, top 10

    // Extract memorable quotes
    const memorableQuotes = extractMemorableQuotes(recentMessages);

    // Update user profile
    await userRepository.update(userId, {
      personality_summary: personalityResponse.content,
      interests: interests,
      communication_style: patterns.style,
      memorable_quotes: memorableQuotes,
      metadata: {
        ...user.metadata,
        message_count: recentMessages.length,
        avg_message_length: patterns.avgLength,
        active_hours: patterns.activeHours,
        emoji_usage: patterns.emojiUsage,
        interaction_stats: interactionStats,
        last_analysis: new Date().toISOString(),
      },
    });

    console.log(`✅ Profile updated for user ${user.username || userId}`);
  } catch (error) {
    console.error(`❌ Error building profile for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Analyze communication patterns
 */
function analyzePatterns(messages: string[]) {
  const patterns = {
    avgLength: 0,
    style: 'casual',
    commonTopics: [] as string[],
    activeHours: [] as number[],
    emojiUsage: 0,
  };

  if (messages.length === 0) return patterns;

  // Average message length
  patterns.avgLength = messages.reduce((sum, m) => sum + m.length, 0) / messages.length;

  // Communication style based on indicators
  const formalIndicators = messages.filter(m => 
    /\b(please|thank you|regards|sincerely)\b/i.test(m)
  ).length;
  const casualIndicators = messages.filter(m => 
    /\b(lol|lmao|gonna|wanna|yep|nope)\b/i.test(m)
  ).length;
  
  if (formalIndicators > casualIndicators * 2) {
    patterns.style = 'formal';
  } else if (casualIndicators > messages.length * 0.3) {
    patterns.style = 'very casual';
  }

  // Emoji usage
  const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
  patterns.emojiUsage = messages.filter(m => emojiPattern.test(m)).length / messages.length;

  // Extract common topics (simple keyword extraction)
  const topicCounts = new Map<string, number>();
  const topicKeywords = [
    'work', 'project', 'code', 'bug', 'feature', 'meeting',
    'lunch', 'coffee', 'weekend', 'vacation', 'game', 'movie',
    'deploy', 'review', 'test', 'design', 'api', 'database'
  ];

  for (const message of messages) {
    const lower = message.toLowerCase();
    for (const keyword of topicKeywords) {
      if (lower.includes(keyword)) {
        topicCounts.set(keyword, (topicCounts.get(keyword) || 0) + 1);
      }
    }
  }

  // Get top topics
  patterns.commonTopics = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);

  return patterns;
}

/**
 * Extract memorable quotes from messages
 */
function extractMemorableQuotes(messages: any[]): string[] {
  const quotes: string[] = [];

  for (const message of messages) {
    const text = message.message_text;
    
    // Look for interesting patterns
    if (
      text.length > 50 && text.length < 200 && // Good length
      (text.includes('!') || text.includes('?')) && // Has punctuation
      !text.startsWith('http') && // Not just a link
      /[A-Z]/.test(text) // Has proper capitalization
    ) {
      // Simple heuristics for memorable quotes
      if (
        /\b(always|never|everyone|nobody|best|worst)\b/i.test(text) || // Absolutes
        /\b(remember|forget|think|believe|feel)\b/i.test(text) || // Personal statements
        text.split(' ').length > 10 // Substantial statement
      ) {
        quotes.push(text);
      }
    }
  }

  // Return top 5 most recent memorable quotes
  return quotes.slice(-5);
}

/**
 * Create and start the profiler worker
 */
export function createProfilerWorker(): Worker<UserProfileJob> {
  const worker = new Worker<UserProfileJob>(
    'user-profiles',
    processProfileJob,
    {
      connection,
      concurrency: 3, // Process 3 profiles at a time
      limiter: {
        max: 30, // Max 30 profiles per hour
        duration: 3600000, // 1 hour
      },
    }
  );

  worker.on('completed', (job) => {
    console.log(`Profile job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Profile job ${job?.id} failed:`, err);
  });

  console.log('👤 Profiler worker started');
  return worker;
}

/**
 * Schedule profile updates for active users
 */
export async function scheduleActiveUserProfiling() {
  try {
    // Get recently active users
    const recentUsers = await messageRepository.getRecentMessages('', 24, 1000)
      .then(messages => {
        const userIds = new Set(messages.map(m => m.slack_user_id));
        return Array.from(userIds);
      });

    console.log(`Scheduling profile updates for ${recentUsers.length} active users`);

    const { addUserProfileJob } = await import('./queues');
    
    for (const userId of recentUsers) {
      await addUserProfileJob({ userId, forceUpdate: false });
    }
  } catch (error) {
    console.error('Error scheduling user profiling:', error);
  }
}