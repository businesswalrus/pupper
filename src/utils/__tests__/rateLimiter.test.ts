import { RateLimiter } from '../rateLimiter';
import { redis } from '@db/redis';

jest.mock('@db/redis');
jest.mock('../logger');

describe('RateLimiter', () => {
  let mockRedisClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient = {
      zRemRangeByScore: jest.fn().mockResolvedValue(0),
      zCard: jest.fn().mockResolvedValue(0),
      zAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      zRange: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(1),
    };
    
    (redis.getClient as jest.Mock).mockResolvedValue(mockRedisClient);
  });

  describe('checkLimit', () => {
    it('should allow requests within limit', async () => {
      mockRedisClient.zCard.mockResolvedValue(3);
      
      const result = await RateLimiter.checkLimit('user123', 'message');
      
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(26); // 30 max - 3 existing - 1 current
      expect(mockRedisClient.zAdd).toHaveBeenCalled();
    });

    it('should block requests exceeding limit', async () => {
      mockRedisClient.zCard.mockResolvedValue(30); // At limit
      mockRedisClient.zRange.mockResolvedValue(['1234567890000']);
      
      const result = await RateLimiter.checkLimit('user123', 'message');
      
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(mockRedisClient.zAdd).not.toHaveBeenCalled();
    });

    it('should use different limits for different operations', async () => {
      // Test AI response limit (5 per minute)
      mockRedisClient.zCard.mockResolvedValue(4);
      
      const aiResult = await RateLimiter.checkLimit('user123', 'aiResponse');
      expect(aiResult.allowed).toBe(true);
      expect(aiResult.remaining).toBe(0); // 5 max - 4 existing - 1 current
      
      // Test search limit (10 per 5 minutes)
      mockRedisClient.zCard.mockResolvedValue(9);
      
      const searchResult = await RateLimiter.checkLimit('user123', 'search');
      expect(searchResult.allowed).toBe(true);
      expect(searchResult.remaining).toBe(0); // 10 max - 9 existing - 1 current
    });

    it('should fail open on Redis errors', async () => {
      (redis.getClient as jest.Mock).mockRejectedValue(new Error('Redis error'));
      
      const result = await RateLimiter.checkLimit('user123', 'message');
      
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should clean up old entries', async () => {
      await RateLimiter.checkLimit('user123', 'message');
      
      expect(mockRedisClient.zRemRangeByScore).toHaveBeenCalledWith(
        'rl:msg:user123',
        '-inf',
        expect.any(String)
      );
    });
  });

  describe('reset', () => {
    it('should delete rate limit key', async () => {
      await RateLimiter.reset('user123', 'message');
      
      expect(mockRedisClient.del).toHaveBeenCalledWith('rl:msg:user123');
    });

    it('should handle errors gracefully', async () => {
      mockRedisClient.del.mockRejectedValue(new Error('Redis error'));
      
      // Should not throw
      await expect(RateLimiter.reset('user123', 'message')).resolves.toBeUndefined();
    });
  });

  describe('getUsageStats', () => {
    it('should return usage statistics for all limit types', async () => {
      mockRedisClient.zCard
        .mockResolvedValueOnce(15) // message
        .mockResolvedValueOnce(3)  // aiResponse
        .mockResolvedValueOnce(5)  // search
        .mockResolvedValueOnce(50); // embedding
      
      const stats = await RateLimiter.getUsageStats('user123');
      
      expect(stats).toEqual({
        message: { used: 15, limit: 30 },
        aiResponse: { used: 3, limit: 5 },
        search: { used: 5, limit: 10 },
        embedding: { used: 50, limit: 100 },
      });
    });

    it('should handle errors and return empty stats', async () => {
      (redis.getClient as jest.Mock).mockRejectedValue(new Error('Redis error'));
      
      const stats = await RateLimiter.getUsageStats('user123');
      
      expect(stats).toEqual({});
    });
  });
});