import { Queue, Worker } from 'bullmq';
import Redis from 'redis';
import { generateEmbedding } from './ai';
import { updateEmbedding } from './db';

// Create Redis connection
const connection = new Redis({
  url: process.env.REDIS_URL,
  maxRetriesPerRequest: null,
});

// Create queue
const embeddingQueue = new Queue('embeddings', { connection });

// Add job to queue
export async function addEmbeddingJob(messageId: number): Promise<void> {
  await embeddingQueue.add('generate', { messageId }, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  });
}

// Start worker
export function startWorker(): void {
  const worker = new Worker(
    'embeddings',
    async (job) => {
      const { messageId } = job.data;
      console.log(`Generating embedding for message ${messageId}`);
      
      try {
        // Get message from database
        const { Pool } = require('pg');
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        });
        
        const result = await pool.query(
          'SELECT message_text FROM messages WHERE id = $1',
          [messageId]
        );
        
        if (result.rows.length === 0) {
          throw new Error(`Message ${messageId} not found`);
        }
        
        const messageText = result.rows[0].message_text;
        
        // Generate embedding
        const embedding = await generateEmbedding(messageText);
        
        // Update database
        await updateEmbedding(messageId, embedding);
        
        console.log(`Embedding generated for message ${messageId}`);
      } catch (error) {
        console.error(`Failed to generate embedding for message ${messageId}:`, error);
        throw error;
      }
    },
    {
      connection,
      concurrency: 2, // Process 2 embeddings at a time
      limiter: {
        max: 10,
        duration: 60000, // 10 embeddings per minute
      },
    }
  );
  
  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });
  
  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
  });
  
  console.log('Worker started');
}