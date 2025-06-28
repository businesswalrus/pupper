import { openai } from '@ai/openai';
import { logger } from '@utils/logger';
import { config } from '@utils/config';
import crypto from 'crypto';
import pLimit from 'p-limit';

// OpenAI batch embedding limits
const MAX_BATCH_SIZE = 2048; // Max inputs per batch
const MAX_INPUT_LENGTH = 8191; // Max tokens per input
const BATCH_CONCURRENCY = 5; // Parallel batch requests

interface BatchEmbeddingInput {
  text: string;
  id: string; // message_ts or other unique identifier
}

interface BatchEmbeddingResult {
  id: string;
  embedding: number[];
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface EmbeddingCache {
  get(key: string): Promise<number[] | null>;
  set(key: string, embedding: number[]): Promise<void>;
  mget(keys: string[]): Promise<(number[] | null)[]>;
  mset(entries: Array<[string, number[]]>): Promise<void>;
}

/**
 * Generate hash for text content to enable caching
 */
function generateTextHash(text: string): string {
  return crypto
    .createHash('sha256')
    .update(text.normalize())
    .digest('hex')
    .substring(0, 16);
}

/**
 * Chunk texts into optimal batch sizes
 */
function chunkTextsForBatching(inputs: BatchEmbeddingInput[]): BatchEmbeddingInput[][] {
  const chunks: BatchEmbeddingInput[][] = [];
  let currentChunk: BatchEmbeddingInput[] = [];
  let currentTokenCount = 0;

  for (const input of inputs) {
    // Rough token estimation (more accurate would use tiktoken)
    const estimatedTokens = Math.ceil(input.text.length / 4);
    
    // If adding this would exceed batch limits, start new chunk
    if (
      currentChunk.length >= MAX_BATCH_SIZE ||
      (currentTokenCount + estimatedTokens > MAX_BATCH_SIZE * 100) // Conservative estimate
    ) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokenCount = 0;
      }
    }

    // Truncate text if too long
    const truncatedText = input.text.length > MAX_INPUT_LENGTH * 4
      ? input.text.substring(0, MAX_INPUT_LENGTH * 4)
      : input.text;

    currentChunk.push({
      ...input,
      text: truncatedText
    });
    currentTokenCount += estimatedTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Batch embedding processor with caching and optimization
 */
export class BatchEmbeddingProcessor {
  private cache: EmbeddingCache;
  private limit = pLimit(BATCH_CONCURRENCY);
  private stats = {
    processed: 0,
    cached: 0,
    errors: 0,
    totalTokens: 0,
  };

  constructor(cache: EmbeddingCache) {
    this.cache = cache;
  }

  /**
   * Process multiple texts with batch API and caching
   */
  async processBatch(inputs: BatchEmbeddingInput[]): Promise<Map<string, BatchEmbeddingResult>> {
    const results = new Map<string, BatchEmbeddingResult>();
    const timer = logger.startTimer('BatchEmbeddingProcessor.processBatch');

    try {
      // Step 1: Check cache for existing embeddings
      const cacheKeys = inputs.map(input => generateTextHash(input.text));
      const cachedEmbeddings = await this.cache.mget(cacheKeys);

      const uncachedInputs: BatchEmbeddingInput[] = [];
      inputs.forEach((input, index) => {
        const cached = cachedEmbeddings[index];
        if (cached) {
          results.set(input.id, {
            id: input.id,
            embedding: cached,
            usage: { prompt_tokens: 0, total_tokens: 0 }, // No tokens used for cached
          });
          this.stats.cached++;
        } else {
          uncachedInputs.push(input);
        }
      });

      logger.info(`Cache hit rate: ${this.stats.cached}/${inputs.length}`);

      // Step 2: Process uncached texts in batches
      if (uncachedInputs.length > 0) {
        const chunks = chunkTextsForBatching(uncachedInputs);
        
        const batchPromises = chunks.map(chunk => 
          this.limit(() => this.processSingleBatch(chunk))
        );

        const batchResults = await Promise.all(batchPromises);
        
        // Merge results and update cache
        const cacheEntries: Array<[string, number[]]> = [];
        
        for (const batchResult of batchResults) {
          for (const [id, result] of batchResult) {
            results.set(id, result);
            const input = uncachedInputs.find(i => i.id === id);
            if (input) {
              cacheEntries.push([generateTextHash(input.text), result.embedding]);
            }
            this.stats.processed++;
            this.stats.totalTokens += result.usage.total_tokens;
          }
        }

        // Batch cache update
        if (cacheEntries.length > 0) {
          await this.cache.mset(cacheEntries);
        }
      }

      timer();
      logger.info('Batch embedding stats', { metadata: this.stats });

      return results;
    } catch (error) {
      timer();
      logger.error('Batch embedding processing failed', { error: error as Error });
      throw error;
    }
  }

  /**
   * Process a single batch with OpenAI API
   */
  private async processSingleBatch(
    inputs: BatchEmbeddingInput[]
  ): Promise<Map<string, BatchEmbeddingResult>> {
    const results = new Map<string, BatchEmbeddingResult>();
    const timer = logger.startTimer('OpenAI.batchEmbeddings');

    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: inputs.map(i => i.text),
        dimensions: 1536, // Standard dimension for compatibility
      });

      response.data.forEach((embedding, index) => {
        const input = inputs[index];
        results.set(input.id, {
          id: input.id,
          embedding: embedding.embedding,
          usage: {
            prompt_tokens: Math.ceil(input.text.length / 4), // Estimate
            total_tokens: Math.ceil(input.text.length / 4),
          },
        });
      });

      timer();
      logger.logApiCall('OpenAI', 'batchEmbeddings', true, Date.now());

      return results;
    } catch (error: any) {
      timer();
      this.stats.errors++;
      
      // Handle rate limiting with exponential backoff
      if (error?.status === 429) {
        const retryAfter = parseInt(error?.headers?.['retry-after'] || '60');
        logger.warn(`Rate limited, retrying after ${retryAfter}s`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return this.processSingleBatch(inputs); // Retry
      }

      logger.error('Batch embedding request failed', { 
        error: error as Error,
        metadata: { batchSize: inputs.length }
      });
      throw error;
    }
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      ...this.stats,
      avgTokensPerEmbedding: this.stats.processed > 0 
        ? Math.round(this.stats.totalTokens / this.stats.processed)
        : 0,
      cacheHitRate: this.stats.processed + this.stats.cached > 0
        ? (this.stats.cached / (this.stats.processed + this.stats.cached)) * 100
        : 0,
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      processed: 0,
      cached: 0,
      errors: 0,
      totalTokens: 0,
    };
  }
}

/**
 * Semantic deduplication using embeddings
 */
export async function deduplicateBySemanticSimilarity(
  embeddings: Array<{ id: string; embedding: number[] }>,
  threshold: number = 0.95
): Promise<Set<string>> {
  const duplicates = new Set<string>();
  
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const similarity = cosineSimilarity(
        embeddings[i].embedding,
        embeddings[j].embedding
      );
      
      if (similarity > threshold) {
        // Keep the earlier message, mark later as duplicate
        duplicates.add(embeddings[j].id);
      }
    }
  }

  return duplicates;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Dimension reduction for storage optimization (PCA-based)
 */
export function reduceDimensions(
  embedding: number[],
  targetDim: number = 512
): number[] {
  if (embedding.length <= targetDim) {
    return embedding;
  }

  // Simple averaging approach for dimension reduction
  // In production, use proper PCA or other dimensionality reduction
  const ratio = embedding.length / targetDim;
  const reduced: number[] = [];

  for (let i = 0; i < targetDim; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    
    for (let j = start; j < end; j++) {
      sum += embedding[j];
    }
    
    reduced.push(sum / (end - start));
  }

  return reduced;
}