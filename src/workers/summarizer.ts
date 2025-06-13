import { Worker, Job } from 'bullmq';
import { config } from '@utils/config';
import { messageRepository } from '@db/repositories/messageRepository';
import { summaryRepository } from '@db/repositories/summaryRepository';
import { generateChatCompletion } from '@ai/openai';
import { CONVERSATION_SUMMARY_PROMPT } from '@ai/prompts';
import { MessageSummaryJob } from './queues';

// Redis connection for worker
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port || '6379'),
  password: new URL(config.redis.url).password || undefined,
};

/**
 * Process conversation summary job
 */
async function processSummaryJob(job: Job<MessageSummaryJob>) {
  const { channelId, startTs, endTs } = job.data;
  
  console.log(`Generating summary for channel ${channelId} from ${startTs} to ${endTs}`);

  try {
    // Fetch messages in the time range
    const messages = await messageRepository.findByChannel(channelId, {
      start_date: new Date(parseFloat(startTs) * 1000),
      end_date: new Date(parseFloat(endTs) * 1000),
      limit: 500, // Reasonable limit for summarization
    });

    if (messages.length < 10) {
      console.log(`Not enough messages to summarize (${messages.length} found)`);
      return;
    }

    // Format messages for summarization
    const conversationText = messages
      .reverse() // Chronological order
      .map(m => `${m.slack_user_id}: ${m.message_text}`)
      .join('\n');

    // Extract participants
    const participants = Array.from(new Set(messages.map(m => m.slack_user_id)));

    // Generate summary using GPT-4
    const summaryPrompt = `${CONVERSATION_SUMMARY_PROMPT}\n\nConversation:\n${conversationText}`;
    
    const response = await generateChatCompletion([
      { role: 'system', content: 'You are an expert at summarizing conversations. Be concise but capture all important details.' },
      { role: 'user', content: summaryPrompt },
    ], {
      temperature: 0.7,
      max_tokens: 500,
      model: 'gpt-4-turbo-preview',
    });

    // Parse the summary (in production, you'd want structured output)
    const summaryText = response.content;
    
    // Extract topics using simple keyword extraction (could be enhanced)
    const topics = extractTopics(conversationText);
    
    // Determine mood
    const mood = determineMood(conversationText);

    // Store summary
    await summaryRepository.create({
      channel_id: channelId,
      summary: summaryText,
      key_topics: topics,
      participant_ids: participants,
      mood: mood,
      notable_moments: [], // Could extract quotes or key moments
      start_ts: startTs,
      end_ts: endTs,
      message_count: messages.length,
    });

    console.log(`✅ Summary generated for channel ${channelId}: ${messages.length} messages processed`);
  } catch (error) {
    console.error(`❌ Error generating summary for channel ${channelId}:`, error);
    throw error;
  }
}

/**
 * Extract topics from conversation (simple implementation)
 */
function extractTopics(text: string): string[] {
  // Common technical topics
  const topicPatterns = [
    /\b(bug|error|issue|problem)\b/gi,
    /\b(deploy|deployment|release|ship)\b/gi,
    /\b(meeting|standup|sync)\b/gi,
    /\b(feature|implement|build)\b/gi,
    /\b(review|pr|pull request)\b/gi,
    /\b(test|testing|qa)\b/gi,
    /\b(database|api|server)\b/gi,
    /\b(frontend|backend|fullstack)\b/gi,
  ];

  const topics = new Set<string>();
  
  for (const pattern of topicPatterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 2) { // Topic appears more than twice
      topics.add(pattern.source.replace(/\\b|[()]/g, '').split('|')[0]);
    }
  }

  return Array.from(topics);
}

/**
 * Determine conversation mood
 */
function determineMood(text: string): string {
  const lowercaseText = text.toLowerCase();
  
  // Simple mood detection based on keywords
  if (lowercaseText.includes('emergency') || lowercaseText.includes('urgent') || lowercaseText.includes('critical')) {
    return 'urgent';
  }
  if (lowercaseText.includes('celebrate') || lowercaseText.includes('congrats') || lowercaseText.includes('awesome')) {
    return 'celebratory';
  }
  if (lowercaseText.includes('frustrated') || lowercaseText.includes('annoying') || lowercaseText.includes('broken')) {
    return 'frustrated';
  }
  if (lowercaseText.includes('help') || lowercaseText.includes('question') || lowercaseText.includes('how')) {
    return 'collaborative';
  }
  
  return 'neutral';
}

/**
 * Create and start the summarizer worker
 */
export function createSummarizerWorker(): Worker<MessageSummaryJob> {
  const worker = new Worker<MessageSummaryJob>(
    'message-summaries',
    processSummaryJob,
    {
      connection,
      concurrency: 2, // Process 2 summaries at a time
      limiter: {
        max: 10, // Max 10 summaries per hour
        duration: 3600000, // 1 hour
      },
    }
  );

  worker.on('completed', (job) => {
    console.log(`Summary job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Summary job ${job?.id} failed:`, err);
  });

  console.log('📝 Summarizer worker started');
  return worker;
}

/**
 * Schedule periodic summarization for active channels
 */
export async function scheduleChannelSummarization(channelId: string) {
  try {
    // Check when last summary was created
    const lastSummaryTime = await summaryRepository.getLastSummaryTime(channelId);
    const now = new Date();
    const hoursSinceLastSummary = lastSummaryTime 
      ? (now.getTime() - lastSummaryTime.getTime()) / (1000 * 60 * 60)
      : 24; // If no summary exists, assume it's been 24 hours

    // Summarize if it's been more than 6 hours or 100 messages
    const messageCount = await messageRepository.countByChannel(channelId);
    const shouldSummarize = hoursSinceLastSummary >= 6 || messageCount >= 100;

    if (shouldSummarize) {
      const startTs = lastSummaryTime 
        ? (lastSummaryTime.getTime() / 1000).toString()
        : ((now.getTime() - 24 * 60 * 60 * 1000) / 1000).toString();
      const endTs = (now.getTime() / 1000).toString();

      const { addMessageSummaryJob } = await import('./queues');
      await addMessageSummaryJob({
        channelId,
        startTs,
        endTs,
      });

      console.log(`Scheduled summarization for channel ${channelId}`);
    }
  } catch (error) {
    console.error(`Error scheduling summarization for channel ${channelId}:`, error);
  }
}