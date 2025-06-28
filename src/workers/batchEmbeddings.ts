import { Worker, Job, Queue } from 'bullmq';
import { config } from '@utils/config';
import { messageRepository } from '@db/repositories';
import { generateEmbedding, batchGenerateEmbeddings } from '@ai/openai';
import { EmbeddingJob } from './queues';
import { logger } from '@utils/logger';
import { RateLimiter } from '@utils/rateLimiter';
import { cache, CacheTier } from '@services/cache';

// Batch configuration
const BATCH_SIZE = 10;                // Process 10 embeddings per batch
const BATCH_TIMEOUT = 5000;           // Wait max 5s for batch to fill
const MAX_TEXT_LENGTH = 8000;         // Max text length per embedding
const MAX_BATCH_TOKENS = 20000;       // Max total tokens per batch

// Redis connection for worker
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port || '6379'),
  password: new URL(config.redis.url).password || undefined,
};

// Batch accumulator
interface BatchItem {
  job: Job<EmbeddingJob>;
  text: string;
  messageTs: string;
}

class BatchProcessor {
  private batch: BatchItem[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private processing = false;
  
  // Performance metrics
  private metrics = {
    totalBatches: 0,
    totalItems: 0,
    totalTokens: 0,
    apiCalls: 0,
    cacheHits: 0,
    errors: 0,
    avgBatchSize: 0,
    avgProcessingTime: 0,
  };

  constructor(private readonly onBatchReady: (batch: BatchItem[]) => Promise<void>) {}

  async add(item: BatchItem): Promise<void> {
    // Check cache first
    const cached = await this.getCachedEmbedding(item.text);
    if (cached) {
      await this.processCachedItem(item, cached);
      return;
    }

    this.batch.push(item);

    // Process if batch is full
    if (this.batch.length >= BATCH_SIZE || this.estimateBatchTokens() >= MAX_BATCH_TOKENS) {
      await this.processBatch();
    } else if (!this.batchTimer) {
      // Start timer for partial batch
      this.batchTimer = setTimeout(() => this.processBatch(), BATCH_TIMEOUT);
    }
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.batch.length === 0) return;

    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Take current batch
    const currentBatch = [...this.batch];
    this.batch = [];
    this.processing = true;

    try {
      await this.onBatchReady(currentBatch);
      
      // Update metrics
      this.metrics.totalBatches++;
      this.metrics.totalItems += currentBatch.length;
      this.metrics.avgBatchSize = this.metrics.totalItems / this.metrics.totalBatches;
    } finally {
      this.processing = false;

      // Process any items added during processing
      if (this.batch.length > 0) {
        setImmediate(() => this.processBatch());
      }
    }
  }

  private estimateBatchTokens(): number {
    // Rough estimate: 4 chars = 1 token
    return this.batch.reduce((sum, item) => sum + Math.ceil(item.text.length / 4), 0);
  }

  private async getCachedEmbedding(text: string): Promise<number[] | null> {
    const key = this.generateTextHash(text);
    const cached = await cache.get<number[]>('embeddings', key);
    
    if (cached) {
      this.metrics.cacheHits++;
    }
    
    return cached;
  }

  private async processCachedItem(item: BatchItem, embedding: number[]): Promise<void> {
    try {
      await messageRepository.updateEmbedding(
        item.messageTs,
        embedding,
        'text-embedding-3-small'
      );
      
      await item.job.moveToCompleted({
        cached: true,
        messageTs: item.messageTs,
      });
      
      logger.debug(`Used cached embedding for message ${item.messageTs}`);
    } catch (error) {
      await item.job.moveToFailed(error as Error, 'Failed to process cached embedding');
    }
  }

  private generateTextHash(text: string): string {
    const { createHash } = require('crypto');
    return createHash('sha256').update(text).digest('hex');
  }

  getMetrics() {
    return { ...this.metrics };
  }

  async flush(): Promise<void> {
    if (this.batch.length > 0) {
      await this.processBatch();
    }
  }
}

/**
 * Process batch of embedding jobs
 */
async function processBatchEmbeddings(batch: BatchItem[]): Promise<void> {
  const start = Date.now();
  
  logger.info(`Processing batch of ${batch.length} embeddings`);

  try {
    // Check rate limits for all users
    const userIds = [...new Set(batch.map(item => item.job.data.userId))];
    for (const userId of userIds) {
      const limit = await RateLimiter.checkLimit(userId, 'embedding');
      if (!limit.allowed) {
        throw new Error(`Rate limit exceeded for user ${userId}`);
      }
    }

    // Prepare texts for batch processing
    const texts = batch.map(item => item.text.slice(0, MAX_TEXT_LENGTH));
    
    // Generate embeddings in batch
    const embeddings = await batchGenerateEmbeddings(texts);
    
    // Process results
    const updatePromises = batch.map(async (item, index) => {
      try {
        const embedding = embeddings[index];
        
        // Update database
        await messageRepository.updateEmbedding(
          item.messageTs,
          embedding.embedding,
          embedding.model
        );
        
        // Cache the embedding
        const key = generateTextHash(item.text);
        await cache.set(
          'embeddings',
          key,
          embedding.embedding,
          {
            tier: CacheTier.COLD,
            ttl: 86400 * 7, // Cache for 7 days
            compress: true,
          }
        );
        
        // Complete job
        await item.job.moveToCompleted({
          messageTs: item.messageTs,
          model: embedding.model,
          tokens: embedding.usage.total_tokens,
        });
        
      } catch (error) {
        logger.error(`Failed to process embedding for ${item.messageTs}`, { error: error as Error });
        await item.job.moveToFailed(error as Error, 'Failed to update embedding');
      }
    });

    await Promise.all(updatePromises);
    
    const duration = Date.now() - start;
    logger.info(`Batch processed in ${duration}ms`, {
      batchSize: batch.length,
      avgTimePerItem: duration / batch.length,
    });

  } catch (error) {
    logger.error('Batch processing failed', { error: error as Error });
    
    // Fall back to individual processing
    for (const item of batch) {
      try {
        const { embedding, model, usage } = await generateEmbedding(item.text);
        
        await messageRepository.updateEmbedding(
          item.messageTs,
          embedding,
          model
        );
        
        await item.job.moveToCompleted({
          messageTs: item.messageTs,
          model,
          tokens: usage.total_tokens,
          fallback: true,
        });
        
      } catch (itemError) {
        await item.job.moveToFailed(itemError as Error, 'Failed in fallback processing');
      }
    }
  }
}

function generateTextHash(text: string): string {
  const { createHash } = require('crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Create batch embedding worker
 */
export function createBatchEmbeddingWorker(): Worker<EmbeddingJob> {
  const batchProcessor = new BatchProcessor(processBatchEmbeddings);

  const worker = new Worker<EmbeddingJob>(
    'embeddings',
    async (job: Job<EmbeddingJob>) => {
      const { messageTs, messageText } = job.data;
      
      // Skip empty messages
      if (!messageText || messageText.trim().length === 0) {
        logger.debug(`Skipping empty message ${messageTs}`);
        return { skipped: true, reason: 'empty' };
      }

      // Check if embedding already exists
      const existingMessage = await messageRepository.findByTimestamp(messageTs);
      if (existingMessage?.embedding) {
        logger.debug(`Embedding already exists for message ${messageTs}`);
        return { skipped: true, reason: 'exists' };
      }

      // Add to batch processor
      await batchProcessor.add({
        job,
        text: messageText,
        messageTs,
      });

      // Return pending status (job will be completed by batch processor)
      return { status: 'batched' };
    },
    {
      connection,
      concurrency: 20,  // Higher concurrency for batching
      limiter: {
        max: 100,       // Process up to 100 jobs per minute
        duration: 60000,
      },
      // Don't auto-complete jobs (batch processor handles completion)
      autorun: false,
    }
  );

  // Start the worker
  worker.run();

  // Periodic flush for partial batches
  setInterval(() => {
    batchProcessor.flush().catch(err => 
      logger.error('Failed to flush batch', { error: err })
    );
  }, BATCH_TIMEOUT * 2);

  // Log metrics periodically
  setInterval(() => {
    const metrics = batchProcessor.getMetrics();
    logger.info('Batch embedding metrics', { metrics });
  }, 60000); // Every minute

  worker.on('completed', (job) => {
    logger.debug(`Embedding job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Embedding job ${job?.id} failed:`, { error: err });
  });

  worker.on('error', (err) => {
    logger.error('Embedding worker error:', { error: err });
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Shutting down batch embedding worker...');
    await batchProcessor.flush();
    await worker.close();
  });

  logger.info('🚀 Batch embedding worker started');
  return worker;
}

/**
 * Optimized bulk embedding generation for initial load
 */
export async function bulkGenerateEmbeddings(limit: number = 1000): Promise<void> {
  const startTime = Date.now();
  let processed = 0;
  let errors = 0;

  try {
    logger.info(`Starting bulk embedding generation for up to ${limit} messages`);

    // Get messages without embeddings
    const messages = await messageRepository.getMessagesWithoutEmbeddings(limit);
    
    if (messages.length === 0) {
      logger.info('No messages without embeddings found');
      return;
    }

    logger.info(`Found ${messages.length} messages without embeddings`);

    // Process in batches
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, Math.min(i + BATCH_SIZE, messages.length));
      
      try {
        // Check cache first
        const uncachedBatch: typeof batch = [];
        const cachedEmbeddings = new Map<string, number[]>();

        for (const msg of batch) {
          const cached = await cache.get<number[]>(
            'embeddings',
            generateTextHash(msg.message_text)
          );
          
          if (cached) {
            cachedEmbeddings.set(msg.message_ts, cached);
          } else {
            uncachedBatch.push(msg);
          }
        }

        // Update cached embeddings
        for (const [messageTs, embedding] of cachedEmbeddings) {
          await messageRepository.updateEmbedding(
            messageTs,
            embedding,
            'text-embedding-3-small'
          );
          processed++;
        }

        // Generate embeddings for uncached messages
        if (uncachedBatch.length > 0) {
          const texts = uncachedBatch.map(msg => 
            msg.message_text.slice(0, MAX_TEXT_LENGTH)
          );
          
          const embeddings = await batchGenerateEmbeddings(texts);
          
          // Update database and cache
          await Promise.all(uncachedBatch.map(async (msg, index) => {
            const embedding = embeddings[index];
            
            await messageRepository.updateEmbedding(
              msg.message_ts,
              embedding.embedding,
              embedding.model
            );
            
            await cache.set(
              'embeddings',
              generateTextHash(msg.message_text),
              embedding.embedding,
              {
                tier: CacheTier.COLD,
                ttl: 86400 * 7,
                compress: true,
              }
            );
            
            processed++;
          }));
        }

        // Progress update
        if (processed % 100 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = processed / elapsed;
          logger.info(`Progress: ${processed}/${messages.length} (${rate.toFixed(1)} msgs/sec)`);
        }

        // Small delay to avoid overwhelming the API
        if (i + BATCH_SIZE < messages.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (error) {
        logger.error(`Batch processing error at index ${i}:`, { error: error as Error });
        errors += batch.length;
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    logger.info('Bulk embedding generation completed', {
      processed,
      errors,
      totalTime,
      avgTimePerMessage: totalTime / processed,
      messagesPerSecond: processed / totalTime,
    });

  } catch (error) {
    logger.error('Bulk embedding generation failed:', { error: error as Error });
    throw error;
  }
}