import { Worker, Job } from 'bullmq';
import { config } from '@utils/config';
import { messageRepository } from '@db/repositories/messageRepository';
import { generateEmbedding } from '@ai/openai';
import { EmbeddingJob } from './queues';

// Redis connection for worker
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port || '6379'),
  password: new URL(config.redis.url).password || undefined,
};

// Statistics tracking
let processedCount = 0;
let errorCount = 0;
const startTime = Date.now();

/**
 * Process embedding generation job
 */
async function processEmbeddingJob(job: Job<EmbeddingJob>) {
  const { messageTs, messageText } = job.data;
  
  console.log(`Processing embedding for message ${messageTs}`);

  try {
    // Skip empty messages
    if (!messageText || messageText.trim().length === 0) {
      console.log(`Skipping empty message ${messageTs}`);
      return;
    }

    // Check if embedding already exists
    const existingMessage = await messageRepository.findByTimestamp(messageTs);
    if (existingMessage?.embedding) {
      console.log(`Embedding already exists for message ${messageTs}`);
      return;
    }

    // Generate embedding
    const { embedding, model, usage } = await generateEmbedding(messageText);
    
    // Store embedding in database
    await messageRepository.updateEmbedding(messageTs, embedding, model);
    
    processedCount++;
    console.log(`✅ Embedding generated for message ${messageTs} (${usage.total_tokens} tokens)`);
    
    // Log progress every 10 messages
    if (processedCount % 10 === 0) {
      const runtime = Math.floor((Date.now() - startTime) / 1000);
      console.log(`📊 Embedding progress: ${processedCount} processed, ${errorCount} errors, ${runtime}s runtime`);
    }
  } catch (error) {
    errorCount++;
    console.error(`❌ Error processing embedding for message ${messageTs}:`, error);
    throw error; // Re-throw to trigger retry
  }
}

/**
 * Create and start the embedding worker
 */
export function createEmbeddingWorker(): Worker<EmbeddingJob> {
  const worker = new Worker<EmbeddingJob>(
    'embeddings',
    processEmbeddingJob,
    {
      connection,
      concurrency: 5, // Process 5 embeddings at a time
      limiter: {
        max: 25, // Max 25 jobs per minute
        duration: 60000, // 1 minute
      },
    }
  );

  worker.on('completed', (job) => {
    console.log(`Embedding job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Embedding job ${job?.id} failed:`, err);
  });

  worker.on('error', (err) => {
    console.error('Embedding worker error:', err);
  });

  console.log('🚀 Embedding worker started');
  return worker;
}

/**
 * Process messages that don't have embeddings yet
 */
export async function processUnembeddedMessages(limit: number = 100) {
  try {
    const messages = await messageRepository.getMessagesWithoutEmbeddings(limit);
    console.log(`Found ${messages.length} messages without embeddings`);
    
    for (const message of messages) {
      // Add to queue
      const { addEmbeddingJob } = await import('./queues');
      await addEmbeddingJob({
        messageTs: message.message_ts,
        messageText: message.message_text,
        userId: message.slack_user_id,
        channelId: message.channel_id,
      });
    }
    
    console.log(`Queued ${messages.length} messages for embedding generation`);
  } catch (error) {
    console.error('Error processing unembedded messages:', error);
  }
}