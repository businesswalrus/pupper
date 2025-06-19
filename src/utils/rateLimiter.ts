import { redis } from '@db/redis';
import { logger } from './logger';

export class RateLimiter {
  
  // Different rate limits for different operations
  static readonly LIMITS = {
    message: {
      windowMs: 60000, // 1 minute
      maxRequests: 30,
      keyPrefix: 'rl:msg:',
    },
    aiResponse: {
      windowMs: 60000, // 1 minute
      maxRequests: 5,
      keyPrefix: 'rl:ai:',
    },
    search: {
      windowMs: 300000, // 5 minutes
      maxRequests: 10,
      keyPrefix: 'rl:search:',
    },
    embedding: {
      windowMs: 3600000, // 1 hour
      maxRequests: 100,
      keyPrefix: 'rl:embed:',
    },
  };
  
  static async checkLimit(
    userId: string,
    limitType: keyof typeof RateLimiter.LIMITS
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const config = this.LIMITS[limitType];
    const key = `${config.keyPrefix}${userId}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;
    
    try {
      const client = await redis.getClient();
      
      // Remove old entries
      await client.zRemRangeByScore(key, '-inf', windowStart.toString());
      
      // Count current requests in window
      const currentCount = await client.zCard(key);
      
      if (currentCount >= config.maxRequests) {
        // Get the oldest entry to determine when the limit resets
        const oldestEntries = await client.zRange(key, 0, 0);
        const resetAt = oldestEntries.length > 0 
          ? new Date(parseInt(oldestEntries[0]) + config.windowMs)
          : new Date(now + config.windowMs);
          
        logger.warn('Rate limit exceeded', {
          userId,
          limitType,
          currentCount,
          maxRequests: config.maxRequests,
          resetAt,
        });
        
        return {
          allowed: false,
          remaining: 0,
          resetAt,
        };
      }
      
      // Add current request
      await client.zAdd(key, { score: now, value: now.toString() });
      await client.expire(key, Math.ceil(config.windowMs / 1000));
      
      return {
        allowed: true,
        remaining: config.maxRequests - currentCount - 1,
        resetAt: new Date(now + config.windowMs),
      };
    } catch (error) {
      logger.error('Rate limiter error', { error: error as Error });
      // Fail open in case of Redis issues
      return {
        allowed: true,
        remaining: 0,
        resetAt: new Date(now + config.windowMs),
      };
    }
  }
  
  static async reset(userId: string, limitType: keyof typeof RateLimiter.LIMITS): Promise<void> {
    const config = this.LIMITS[limitType];
    const key = `${config.keyPrefix}${userId}`;
    
    try {
      const client = await redis.getClient();
      await client.del(key);
    } catch (error) {
      logger.error('Failed to reset rate limit', { error: error as Error, userId, limitType });
    }
  }
  
  // Get current usage stats
  static async getUsageStats(userId: string): Promise<Record<string, { used: number; limit: number }>> {
    const stats: Record<string, { used: number; limit: number }> = {};
    
    try {
      const client = await redis.getClient();
      
      for (const [limitType, config] of Object.entries(this.LIMITS)) {
        const key = `${config.keyPrefix}${userId}`;
        const windowStart = Date.now() - config.windowMs;
        
        await client.zRemRangeByScore(key, '-inf', windowStart.toString());
        const used = await client.zCard(key);
        
        stats[limitType] = {
          used,
          limit: config.maxRequests,
        };
      }
    } catch (error) {
      logger.error('Failed to get usage stats', { error: error as Error, userId });
    }
    
    return stats;
  }
}

// Express middleware for rate limiting
export function createRateLimitMiddleware(limitType: keyof typeof RateLimiter.LIMITS) {
  return async (req: any, res: any, next: any) => {
    const userId = req.user?.id || req.ip || 'anonymous';
    
    const result = await RateLimiter.checkLimit(userId, limitType);
    
    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', RateLimiter.LIMITS[limitType].maxRequests);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt.toISOString());
    
    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded for ${limitType} operations`,
        retryAfter: result.resetAt.toISOString(),
      });
    }
    
    next();
  };
}