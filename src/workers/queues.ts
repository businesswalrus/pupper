import { Queue, QueueEvents, QueueOptions } from 'bullmq';
import { config } from '@utils/config';
import { redis } from '@db/redis';

// Connection configuration for BullMQ with pooling
const getConnection = async () => {
  const client = await redis.getPrimaryClient();
  return client;
};

// Optimized queue options
const defaultQueueOptions: QueueOptions = {
  connection: {
    host: new URL(config.redis.url).hostname,
    port: parseInt(new URL(config.redis.url).port || '6379'),
    password: new URL(config.redis.url).password || undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    keepAlive: 5000,
  },
  defaultJobOptions: {
    removeOnComplete: {
      age: 3600,      // Keep completed jobs for 1 hour
      count: 1000,    // Keep last 1000 completed jobs
    },
    removeOnFail: {
      age: 86400,     // Keep failed jobs for 24 hours
      count: 5000,    // Keep last 5000 failed jobs
    },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
};

// Specialized queue configurations
const queueConfigs = {
  embeddings: {
    ...defaultQueueOptions,
    defaultJobOptions: {
      ...defaultQueueOptions.defaultJobOptions,
      priority: 1,    // Lower priority for batch processing
    },
  },
  'message-summaries': {
    ...defaultQueueOptions,
    defaultJobOptions: {
      ...defaultQueueOptions.defaultJobOptions,
      priority: 2,    // Medium priority
      attempts: 2,    // Fewer retries for summaries
    },
  },
  'user-profiles': {
    ...defaultQueueOptions,
    defaultJobOptions: {
      ...defaultQueueOptions.defaultJobOptions,
      priority: 3,    // Higher priority for user updates
      delay: 5000,    // 5s delay to batch updates
    },
  },
};

// Queue definitions with optimized settings
export const embeddingQueue = new Queue('embeddings', queueConfigs.embeddings);
export const messageSummaryQueue = new Queue('message-summaries', queueConfigs['message-summaries']);
export const userProfileQueue = new Queue('user-profiles', queueConfigs['user-profiles']);

// Queue event listeners with connection reuse
export const embeddingQueueEvents = new QueueEvents('embeddings', {
  connection: queueConfigs.embeddings.connection,
});
export const messageSummaryQueueEvents = new QueueEvents('message-summaries', {
  connection: queueConfigs['message-summaries'].connection,
});
export const userProfileQueueEvents = new QueueEvents('user-profiles', {
  connection: queueConfigs['user-profiles'].connection,
});

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

// Optimized helper functions with deduplication and batching
const activeJobs = new Map<string, Promise<any>>();

export async function addEmbeddingJob(data: EmbeddingJob) {
  // Deduplicate by message timestamp
  const jobKey = `embed:${data.messageTs}`;
  
  // Check if job already exists
  const existingJob = await embeddingQueue.getJob(jobKey);
  if (existingJob && ['waiting', 'active', 'delayed'].includes(await existingJob.getState())) {
    return existingJob;
  }
  
  return embeddingQueue.add('generate-embedding', data, {
    jobId: jobKey,
    // Remove individual job options - use queue defaults
  });
}

export async function addMessageSummaryJob(data: MessageSummaryJob) {
  // Deduplicate by channel and time range
  const jobKey = `summary:${data.channelId}:${data.startTs}:${data.endTs}`;
  
  const existingJob = await messageSummaryQueue.getJob(jobKey);
  if (existingJob && ['waiting', 'active', 'delayed'].includes(await existingJob.getState())) {
    return existingJob;
  }
  
  return messageSummaryQueue.add('generate-summary', data, {
    jobId: jobKey,
    delay: 10000, // 10s delay to allow message accumulation
  });
}

export async function addUserProfileJob(data: UserProfileJob) {
  // Deduplicate and batch user profile updates
  const jobKey = `profile:${data.userId}`;
  
  // Cancel existing job if not started
  const existingJob = await userProfileQueue.getJob(jobKey);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === 'waiting' || state === 'delayed') {
      await existingJob.remove();
    }
  }
  
  return userProfileQueue.add('update-profile', data, {
    jobId: jobKey,
    delay: data.forceUpdate ? 0 : 30000, // 30s delay for batching unless forced
  });
}

// Bulk job operations
export async function bulkAddEmbeddingJobs(jobs: EmbeddingJob[]) {
  const uniqueJobs = new Map<string, EmbeddingJob>();
  
  // Deduplicate
  for (const job of jobs) {
    uniqueJobs.set(job.messageTs, job);
  }
  
  // Check existing jobs
  const newJobs: EmbeddingJob[] = [];
  for (const [messageTs, jobData] of uniqueJobs) {
    const jobKey = `embed:${messageTs}`;
    const existingJob = await embeddingQueue.getJob(jobKey);
    
    if (!existingJob || !['waiting', 'active', 'delayed'].includes(await existingJob.getState())) {
      newJobs.push(jobData);
    }
  }
  
  // Add new jobs in bulk
  if (newJobs.length > 0) {
    const bulkJobs = newJobs.map(data => ({
      name: 'generate-embedding',
      data,
      opts: { jobId: `embed:${data.messageTs}` },
    }));
    
    return embeddingQueue.addBulk(bulkJobs);
  }
  
  return [];
}

// Queue monitoring and health checks
export async function getQueueHealth() {
  const [embeddingHealth, summaryHealth, profileHealth] = await Promise.all([
    getQueueStats(embeddingQueue),
    getQueueStats(messageSummaryQueue),
    getQueueStats(userProfileQueue),
  ]);
  
  return {
    embeddings: embeddingHealth,
    summaries: summaryHealth,
    profiles: profileHealth,
  };
}

async function getQueueStats(queue: Queue) {
  const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
    queue.isPaused(),
  ]);
  
  const metrics = await queue.getMetrics('completed', 5);
  const throughput = metrics.data.length > 0 
    ? metrics.data.reduce((sum, m) => sum + m.count, 0) / metrics.data.length 
    : 0;
  
  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    paused,
    throughput: Math.round(throughput * 12), // Per minute
    health: failed < 100 && waiting < 1000 ? 'healthy' : 'degraded',
  };
}

// Clean up old jobs
export async function cleanupQueues() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const oneDayAgo = now - 86400000;
  
  await Promise.all([
    embeddingQueue.clean(oneHourAgo, 1000, 'completed'),
    embeddingQueue.clean(oneDayAgo, 1000, 'failed'),
    messageSummaryQueue.clean(oneHourAgo * 2, 500, 'completed'),
    messageSummaryQueue.clean(oneDayAgo, 500, 'failed'),
    userProfileQueue.clean(oneHourAgo, 500, 'completed'),
    userProfileQueue.clean(oneDayAgo, 500, 'failed'),
  ]);
}

// Start periodic cleanup
setInterval(cleanupQueues, 3600000); // Every hour