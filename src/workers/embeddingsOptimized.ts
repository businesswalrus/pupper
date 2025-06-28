import { Worker, Job, Queue } from 'bullmq';
import { config } from '@utils/config';
import { messageRepository } from '@db/repositories/messageRepository';
import { BatchEmbeddingProcessor, deduplicateBySemanticSimilarity } from '@ai/embeddings/batchProcessor';
import { TwoTierEmbeddingCache } from '@ai/embeddings/cache';
import { EmbeddingJob } from './queues';
import { logger } from '@utils/logger';

// Redis connection for worker
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port || '6379'),
  password: new URL(config.redis.url).password || undefined,
};

// Initialize cache and batch processor
const embeddingCache = new TwoTierEmbeddingCache();
const batchProcessor = new BatchEmbeddingProcessor(embeddingCache);

// Batch accumulator
interface BatchAccumulator {
  jobs: Job<EmbeddingJob>[];
  texts: Array<{ text: string; id: string }>;
  timeout: NodeJS.Timeout | null;
}

const batch: BatchAccumulator = {
  jobs: [],
  texts: [],
  timeout: null,
};

const BATCH_SIZE = 100; // Process in batches of 100
const BATCH_TIMEOUT = 5000; // 5 seconds max wait

/**
 * Process a batch of embedding jobs
 */
async function processBatch() {
  if (batch.jobs.length === 0) return;

  const currentBatch = [...batch.jobs];
  const currentTexts = [...batch.texts];
  
  // Clear batch
  batch.jobs = [];
  batch.texts = [];
  if (batch.timeout) {
    clearTimeout(batch.timeout);
    batch.timeout = null;
  }

  logger.info(`Processing batch of ${currentBatch.length} embeddings`);

  try {
    // Process embeddings in batch
    const results = await batchProcessor.processBatch(currentTexts);

    // Check for semantic duplicates
    const embeddings = Array.from(results.values()).map(r => ({
      id: r.id,
      embedding: r.embedding,
    }));
    
    const duplicates = await deduplicateBySemanticSimilarity(embeddings, 0.95);
    
    // Update database for each result
    const updatePromises = currentBatch.map(async (job) => {
      const result = results.get(job.data.messageTs);
      
      if (!result) {
        throw new Error(`No embedding result for message ${job.data.messageTs}`);
      }

      // Skip if identified as duplicate
      if (duplicates.has(job.data.messageTs)) {
        logger.info(`Skipping duplicate message ${job.data.messageTs}`);
        return;
      }

      // Update embedding in database
      await messageRepository.updateEmbedding(
        job.data.messageTs,
        result.embedding,
        'text-embedding-3-small'
      );
    });

    await Promise.all(updatePromises);

    // Log statistics
    const stats = batchProcessor.getStats();
    logger.info('Batch processing complete', {
      metadata: {
        processed: currentBatch.length,
        duplicates: duplicates.size,
        cacheHitRate: stats.cacheHitRate.toFixed(2) + '%',
        avgTokens: stats.avgTokensPerEmbedding,
      },
    });
  } catch (error) {
    logger.error('Batch processing failed', { error: error as Error });
    
    // Re-queue failed jobs individually
    for (const job of currentBatch) {
      await job.moveToFailed(error as Error, 'Batch processing failed');
    }
  }
}

/**
 * Add job to batch
 */
async function addToBatch(job: Job<EmbeddingJob>) {
  batch.jobs.push(job);
  batch.texts.push({
    text: job.data.messageText,
    id: job.data.messageTs,
  });

  // Process batch if it's full
  if (batch.jobs.length >= BATCH_SIZE) {
    await processBatch();
  } else if (!batch.timeout) {
    // Set timeout to process partial batch
    batch.timeout = setTimeout(() => {
      processBatch().catch(error => {
        logger.error('Batch timeout processing failed', { error });
      });
    }, BATCH_TIMEOUT);
  }
}

/**
 * Create optimized embedding worker
 */
export function createOptimizedEmbeddingWorker(): Worker<EmbeddingJob> {
  const worker = new Worker<EmbeddingJob>(
    'embeddings',
    async (job: Job<EmbeddingJob>) => {
      const { messageTs, messageText } = job.data;
      
      // Skip empty messages
      if (!messageText || messageText.trim().length === 0) {
        logger.debug(`Skipping empty message ${messageTs}`);
        return;
      }

      // Check if embedding already exists
      const existingMessage = await messageRepository.findByTimestamp(messageTs);
      if (existingMessage?.embedding) {
        logger.debug(`Embedding already exists for message ${messageTs}`);
        return;
      }

      // Add to batch for processing
      await addToBatch(job);
    },
    {
      connection,
      concurrency: 1, // Process one at a time, batching happens internally
      limiter: {
        max: 1000, // Process up to 1000 jobs per minute
        duration: 60000,
      },
    }
  );

  // Process any remaining batch on shutdown
  worker.on('closing', async () => {
    if (batch.jobs.length > 0) {
      logger.info('Processing remaining batch before shutdown');
      await processBatch();
    }
    await embeddingCache.close();
  });

  worker.on('completed', (job) => {
    logger.debug(`Embedding job ${job.id} added to batch`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Embedding job ${job?.id} failed:`, err);
  });

  logger.info('🚀 Optimized embedding worker started');
  return worker;
}

/**
 * Bulk process unembedded messages
 */
export async function bulkProcessUnembeddedMessages(
  limit: number = 1000,
  batchSize: number = 100
): Promise<void> {
  const startTime = Date.now();
  let totalProcessed = 0;

  try {
    // Get the embeddings queue
    const embeddingsQueue = new Queue('embeddings', { connection });

    while (totalProcessed < limit) {
      // Get batch of unembedded messages
      const messages = await messageRepository.getMessagesWithoutEmbeddings(
        Math.min(batchSize, limit - totalProcessed)
      );

      if (messages.length === 0) {
        logger.info('No more unembedded messages found');
        break;
      }

      // Process directly in batches
      const inputs = messages.map(msg => ({
        text: msg.message_text,
        id: msg.message_ts,
      }));

      const results = await batchProcessor.processBatch(inputs);

      // Update database
      const updatePromises = messages.map(async (message) => {
        const result = results.get(message.message_ts);
        if (result) {
          await messageRepository.updateEmbedding(
            message.message_ts,
            result.embedding,
            'text-embedding-3-small'
          );
        }
      });

      await Promise.all(updatePromises);
      
      totalProcessed += messages.length;
      
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = totalProcessed / elapsed;
      
      logger.info(`Bulk processing progress: ${totalProcessed}/${limit} messages (${rate.toFixed(1)} msg/s)`);
    }

    const totalTime = (Date.now() - startTime) / 1000;
    const stats = batchProcessor.getStats();
    
    logger.info('Bulk processing complete', {
      metadata: {
        totalProcessed,
        totalTimeSeconds: totalTime.toFixed(1),
        avgRate: (totalProcessed / totalTime).toFixed(1) + ' msg/s',
        cacheHitRate: stats.cacheHitRate.toFixed(2) + '%',
        totalTokens: stats.totalTokens,
        estimatedCost: (stats.totalTokens / 1000000 * 0.02).toFixed(2) + ' USD',
      },
    });
  } catch (error) {
    logger.error('Bulk processing failed', { error: error as Error });
    throw error;
  } finally {
    // Reset batch processor stats for next run
    batchProcessor.resetStats();
  }
}

/**
 * Analyze embedding usage and costs
 */
export async function analyzeEmbeddingUsage(): Promise<{
  totalMessages: number;
  embeddedMessages: number;
  coverage: number;
  estimatedTokens: number;
  estimatedCost: number;
  cacheStats: any;
}> {
  const totalQuery = 'SELECT COUNT(*) as total FROM messages';
  const embeddedQuery = 'SELECT COUNT(*) as embedded FROM messages WHERE embedding IS NOT NULL';
  const tokenQuery = `
    SELECT 
      COUNT(*) as count,
      AVG(LENGTH(message_text)) as avg_length,
      SUM(LENGTH(message_text)) as total_chars
    FROM messages 
    WHERE embedding IS NOT NULL
  `;

  const [totalResult, embeddedResult, tokenResult] = await Promise.all([
    pool.query(totalQuery),
    pool.query(embeddedQuery),
    pool.query(tokenQuery),
  ]);

  const total = parseInt(totalResult.rows[0].total);
  const embedded = parseInt(embeddedResult.rows[0].embedded);
  const avgLength = parseFloat(tokenResult.rows[0].avg_length || 0);
  const totalChars = parseInt(tokenResult.rows[0].total_chars || 0);

  // Estimate tokens (roughly 4 chars per token)
  const estimatedTokens = Math.ceil(totalChars / 4);
  
  // OpenAI embedding cost: $0.02 per 1M tokens
  const estimatedCost = (estimatedTokens / 1000000) * 0.02;

  return {
    totalMessages: total,
    embeddedMessages: embedded,
    coverage: total > 0 ? (embedded / total) * 100 : 0,
    estimatedTokens,
    estimatedCost,
    cacheStats: embeddingCache.getStats(),
  };
}