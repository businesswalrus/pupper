import { Queue, QueueEvents } from 'bullmq';
import { config } from '@utils/config';

// Connection configuration for BullMQ
const connection = {
  host: new URL(config.redis.url).hostname,
  port: parseInt(new URL(config.redis.url).port || '6379'),
  password: new URL(config.redis.url).password || undefined,
};

// Queue definitions
export const embeddingQueue = new Queue('embeddings', { connection });
export const messageSummaryQueue = new Queue('message-summaries', { connection });
export const userProfileQueue = new Queue('user-profiles', { connection });

// Queue event listeners for monitoring
export const embeddingQueueEvents = new QueueEvents('embeddings', { connection });
export const messageSummaryQueueEvents = new QueueEvents('message-summaries', { connection });
export const userProfileQueueEvents = new QueueEvents('user-profiles', { connection });

// Job interfaces
export interface EmbeddingJob {
  messageTs: string;
  messageText: string;
  userId: string;
  channelId: string;
}

export interface MessageSummaryJob {
  channelId: string;
  startTs: string;
  endTs: string;
}

export interface UserProfileJob {
  userId: string;
  forceUpdate?: boolean;
}

// Helper function to add jobs with default options
export async function addEmbeddingJob(data: EmbeddingJob) {
  return embeddingQueue.add('generate-embedding', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 100, // Keep last 100 completed jobs
    },
    removeOnFail: {
      age: 24 * 3600, // Keep failed jobs for 24 hours
    },
  });
}

export async function addMessageSummaryJob(data: MessageSummaryJob) {
  return messageSummaryQueue.add('generate-summary', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: {
      age: 7200,
      count: 50,
    },
  });
}

export async function addUserProfileJob(data: UserProfileJob) {
  return userProfileQueue.add('update-profile', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
    removeOnComplete: {
      age: 3600,
      count: 50,
    },
  });
}