import Redis from 'ioredis';
import { config } from '../utils/config.simple';

let redis: Redis | null = null;

export async function connectRedis() {
  try {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
    });
    
    await redis.ping();
    console.log('Redis connection successful');
  } catch (error) {
    console.error('Redis connection failed:', error);
    throw error;
  }
}

export async function disconnectRedis() {
  if (redis) {
    await redis.quit();
  }
}

export function getRedis() {
  if (!redis) {
    throw new Error('Redis not connected');
  }
  return redis;
}