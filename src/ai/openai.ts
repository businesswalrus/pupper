import OpenAI from 'openai';
import pLimit from 'p-limit';
import { config } from '@utils/config';
import { circuitBreakers } from '@utils/circuitBreaker';
import { ApiError, RateLimitError } from '@utils/errors';
import { logger } from '@utils/logger';
import { costTracker } from '@services/costTracker';

// Initialize OpenAI client
export const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

// Rate limiting: 3 concurrent requests max
const limit = pLimit(3);

// Rate limiting for embeddings: 1500 requests per minute
const embeddingLimit = pLimit(25); // ~25 concurrent = ~1500/min with processing time

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface ChatResponse {
  content: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Generate embedding for text using OpenAI's text-embedding-3-small model
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResponse> {
  return embeddingLimit(async () => {
    return circuitBreakers.openai.execute(async () => {
      const timer = logger.startTimer('OpenAI.generateEmbedding');
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: text.slice(0, 8000), // Limit input to avoid token limits
          });

          timer();
          logger.logApiCall('OpenAI', 'generateEmbedding', true, Date.now());

          // Track cost
          await costTracker.trackAPIUsage(
            'openai',
            response.model,
            'system', // System user for embeddings
            { input: response.usage.prompt_tokens },
            { textLength: text.length }
          );

          return {
            embedding: response.data[0].embedding,
            model: response.model,
            usage: {
              prompt_tokens: response.usage.prompt_tokens,
              total_tokens: response.usage.total_tokens,
            },
          };
        } catch (error: any) {
          lastError = error;
          
          // Handle rate limiting
          if (error?.status === 429) {
            const retryAfter = error?.headers?.['retry-after'] || 60;
            throw new RateLimitError(
              'OpenAI rate limit exceeded',
              retryAfter
            );
          }

          // Don't retry on client errors (except rate limits)
          if (error?.status && error.status >= 400 && error.status < 500) {
            throw new ApiError(
              `OpenAI API error: ${error.message}`,
              'OpenAI',
              error
            );
          }

          // Log retry attempt
          if (attempt < MAX_RETRIES - 1) {
            logger.warn(`OpenAI embedding attempt ${attempt + 1} failed, retrying...`, {
              error,
              metadata: { attempt, textLength: text.length },
            });
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (attempt + 1)));
          }
        }
      }

      logger.logApiCall('OpenAI', 'generateEmbedding', false, Date.now(), lastError);
      throw new ApiError(
        'Failed to generate embedding after retries',
        'OpenAI',
        lastError
      );
    });
  });
}

/**
 * Generate chat completion using OpenAI's GPT-4
 */
export async function generateChatCompletion(
  messages: OpenAI.ChatCompletionMessageParam[],
  options: {
    temperature?: number;
    max_tokens?: number;
    model?: string;
  } = {}
): Promise<ChatResponse> {
  return limit(async () => {
    return circuitBreakers.openai.execute(async () => {
      const timer = logger.startTimer('OpenAI.generateChatCompletion');
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const response = await openai.chat.completions.create({
            model: options.model || 'gpt-4-turbo-preview',
            messages,
            temperature: options.temperature ?? 0.8,
            max_tokens: options.max_tokens ?? 500,
          });

          const choice = response.choices[0];
          if (!choice.message.content) {
            throw new Error('No content in response');
          }

          timer();
          logger.logApiCall('OpenAI', 'generateChatCompletion', true, Date.now());

          // Track cost
          // Extract user ID from messages if available
          const userId = messages.find(m => m.role === 'user' && 'name' in m)?.name || 'system';
          
          await costTracker.trackAPIUsage(
            'openai',
            response.model,
            userId,
            { 
              input: response.usage?.prompt_tokens || 0,
              output: response.usage?.completion_tokens || 0
            },
            { 
              temperature: options.temperature,
              max_tokens: options.max_tokens 
            }
          );

          return {
            content: choice.message.content,
            model: response.model,
            usage: {
              prompt_tokens: response.usage?.prompt_tokens || 0,
              completion_tokens: response.usage?.completion_tokens || 0,
              total_tokens: response.usage?.total_tokens || 0,
            },
          };
        } catch (error: any) {
          lastError = error;
          
          // Handle rate limiting
          if (error?.status === 429) {
            const retryAfter = error?.headers?.['retry-after'] || 60;
            throw new RateLimitError(
              'OpenAI rate limit exceeded',
              retryAfter
            );
          }

          // Don't retry on client errors (except rate limits)
          if (error?.status && error.status >= 400 && error.status < 500) {
            throw new ApiError(
              `OpenAI API error: ${error.message}`,
              'OpenAI',
              error
            );
          }

          // Log retry attempt
          if (attempt < MAX_RETRIES - 1) {
            logger.warn(`OpenAI chat attempt ${attempt + 1} failed, retrying...`, {
              error,
              metadata: { attempt, model: options.model },
            });
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (attempt + 1)));
          }
        }
      }

      logger.logApiCall('OpenAI', 'generateChatCompletion', false, Date.now(), lastError);
      throw new ApiError(
        'Failed to generate chat completion after retries',
        'OpenAI',
        lastError
      );
    });
  });
}

/**
 * Count approximate tokens in a string (rough estimate)
 * More accurate counting would require tiktoken library
 */
export function estimateTokens(text: string): number {
  // Rough approximation: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Batch generate embeddings for multiple texts
 */
export async function batchGenerateEmbeddings(
  texts: string[]
): Promise<EmbeddingResponse[]> {
  const results = await Promise.all(
    texts.map(text => generateEmbedding(text))
  );
  return results;
}

/**
 * Test OpenAI connection
 */
export async function testOpenAIConnection(): Promise<boolean> {
  try {
    await generateEmbedding('test');
    console.log('✅ OpenAI connection successful');
    return true;
  } catch (error) {
    console.error('❌ OpenAI connection failed:', error);
    return false;
  }
}