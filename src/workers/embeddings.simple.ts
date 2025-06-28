import { Worker, Queue } from 'bullmq';
import { getRedis } from '../db/redis.simple';
import { pool } from '../db/connection.simple';
import { config } from '../utils/config.simple';
import { logger } from '../utils/logger.simple';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

// Create queue lazily
let embeddingQueue: Queue | null = null;

function getQueue() {
  if (!embeddingQueue) {
    embeddingQueue = new Queue('embeddings', {
      connection: getRedis(),
    });
  }
  return embeddingQueue;
}

// Add job to queue
export async function addEmbeddingJob(data: {
  messageTs: string;
  messageText: string;
  userId: string;
  channelId: string;
}) {
  await getQueue().add('generate', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  });
}

// Create worker
export function createEmbeddingWorker() {
  const worker = new Worker(
    'embeddings',
    async (job) => {
      const { messageTs, messageText, userId, channelId } = job.data;
      
      try {
        // Generate embedding
        const response = await openai.embeddings.create({
          model: 'text-embedding-ada-002',
          input: messageText,
        });
        
        const embedding = response.data[0].embedding;
        
        // Store embedding
        await pool.query(`
          UPDATE messages 
          SET embedding = $1
          WHERE message_ts = $2
        `, [JSON.stringify(embedding), messageTs]);
        
        logger.info(`Generated embedding for message ${messageTs}`);
      } catch (error) {
        logger.error('Error generating embedding:', error);
        throw error;
      }
    },
    {
      connection: getRedis(),
      concurrency: 5,
    }
  );
  
  worker.on('failed', (job, error) => {
    logger.error(`Embedding job ${job?.id} failed:`, error);
  });
  
  return worker;
}