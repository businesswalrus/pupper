import { summaryRepository, ConversationSummary } from '../summaryRepository';
import { pool } from '@db/connection';
import { createMockPool, createMockSummary } from '@test-utils';

jest.mock('@db/connection');

describe('SummaryRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = createMockPool();
    (pool as any) = mockPool;
  });

  describe('create', () => {
    it('should create a summary with all fields', async () => {
      const newSummary: ConversationSummary = {
        channel_id: 'C1234567890',
        summary: 'Team discussed the new feature implementation',
        key_topics: ['feature', 'implementation', 'testing'],
        participant_ids: ['U123', 'U456', 'U789'],
        mood: 'productive',
        notable_moments: [
          { timestamp: '1234567890.123', description: 'Alice proposed new architecture' },
          { timestamp: '1234567891.456', description: 'Bob found a critical bug' }
        ],
        start_ts: '1234567890.000',
        end_ts: '1234567899.999',
        message_count: 42
      };

      const createdSummary = { ...newSummary, id: 1, created_at: new Date() };
      mockPool.query.mockResolvedValue({ rows: [createdSummary], rowCount: 1 });

      const result = await summaryRepository.create(newSummary);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO conversation_summaries'),
        [
          'C1234567890',
          'Team discussed the new feature implementation',
          '["feature","implementation","testing"]',
          '["U123","U456","U789"]',
          'productive',
          '[{"timestamp":"1234567890.123","description":"Alice proposed new architecture"},{"timestamp":"1234567891.456","description":"Bob found a critical bug"}]',
          '1234567890.000',
          '1234567899.999',
          42
        ]
      );
      expect(result).toEqual(createdSummary);
    });

    it('should create summary with minimal fields', async () => {
      const minimalSummary: ConversationSummary = {
        channel_id: 'C9876543210',
        summary: 'Quick standup meeting',
        start_ts: '1234567890.000',
        end_ts: '1234567890.999'
      };

      const createdSummary = createMockSummary(minimalSummary);
      mockPool.query.mockResolvedValue({ rows: [createdSummary], rowCount: 1 });

      const result = await summaryRepository.create(minimalSummary);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO conversation_summaries'),
        [
          'C9876543210',
          'Quick standup meeting',
          '[]',
          '[]',
          null,
          '[]',
          '1234567890.000',
          '1234567890.999',
          0
        ]
      );
      expect(result).toEqual(createdSummary);
    });

    it('should handle special characters in summary text', async () => {
      const summary: ConversationSummary = {
        channel_id: 'C123',
        summary: 'Discussion about "quotes" and \'apostrophes\' and\\backslashes',
        key_topics: ['special-chars', 'edge cases'],
        start_ts: '1234567890.000',
        end_ts: '1234567890.999'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockSummary()], rowCount: 1 });

      await summaryRepository.create(summary);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[1]).toBe('Discussion about "quotes" and \'apostrophes\' and\\backslashes');
      expect(callArgs[2]).toBe('["special-chars","edge cases"]');
    });

    it('should handle database errors', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      await expect(summaryRepository.create({
        channel_id: 'C123',
        summary: 'Test',
        start_ts: '123',
        end_ts: '456'
      })).rejects.toThrow('Database error');
    });
  });

  describe('findByChannel', () => {
    it('should find summaries by channel with default limit', async () => {
      const summaries = [
        createMockSummary({ id: 1, summary: 'First summary' }),
        createMockSummary({ id: 2, summary: 'Second summary' }),
        createMockSummary({ id: 3, summary: 'Third summary' })
      ];
      mockPool.query.mockResolvedValue({ rows: summaries, rowCount: 3 });

      const result = await summaryRepository.findByChannel('C1234567890');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE channel_id = $1'),
        ['C1234567890', 10]
      );
      expect(result).toEqual(summaries);
      expect(result).toHaveLength(3);
    });

    it('should respect custom limit', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.findByChannel('C123', 5);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $2'),
        ['C123', 5]
      );
    });

    it('should order by created_at DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.findByChannel('C123');

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at DESC');
    });

    it('should return empty array when no summaries found', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await summaryRepository.findByChannel('C999');

      expect(result).toEqual([]);
    });
  });

  describe('findRecent', () => {
    it('should find recent summaries with default parameters', async () => {
      const recentSummaries = [
        createMockSummary({ id: 1, created_at: new Date() }),
        createMockSummary({ id: 2, created_at: new Date(Date.now() - 3600000) })
      ];
      mockPool.query.mockResolvedValue({ rows: recentSummaries, rowCount: 2 });

      const result = await summaryRepository.findRecent();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE created_at >= NOW() - INTERVAL $1'),
        ['24 hours', 20]
      );
      expect(result).toEqual(recentSummaries);
    });

    it('should accept custom hours and limit', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.findRecent(48, 50);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['48 hours', 50]
      );
    });

    it('should order by created_at DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.findRecent();

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at DESC');
    });

    it('should handle fractional hours', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.findRecent(0.5, 10);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['0.5 hours', 10]
      );
    });
  });

  describe('getLastSummaryTime', () => {
    it('should return last summary timestamp for channel', async () => {
      const lastTime = new Date('2024-01-15T12:00:00Z');
      mockPool.query.mockResolvedValue({ 
        rows: [{ last_summary: lastTime }], 
        rowCount: 1 
      });

      const result = await summaryRepository.getLastSummaryTime('C1234567890');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT MAX(created_at) as last_summary'),
        ['C1234567890']
      );
      expect(result).toEqual(lastTime);
    });

    it('should return null when no summaries exist', async () => {
      mockPool.query.mockResolvedValue({ 
        rows: [{ last_summary: null }], 
        rowCount: 1 
      });

      const result = await summaryRepository.getLastSummaryTime('C999');

      expect(result).toBeNull();
    });

    it('should return null when query returns no rows', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await summaryRepository.getLastSummaryTime('C999');

      expect(result).toBeNull();
    });
  });

  describe('searchByTopics', () => {
    it('should search summaries by topics', async () => {
      const topicSummaries = [
        createMockSummary({ 
          id: 1, 
          key_topics: ['javascript', 'testing'] 
        }),
        createMockSummary({ 
          id: 2, 
          key_topics: ['typescript', 'testing'] 
        })
      ];
      mockPool.query.mockResolvedValue({ rows: topicSummaries, rowCount: 2 });

      const result = await summaryRepository.searchByTopics(['testing', 'javascript']);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE key_topics ?| $1'),
        [['testing', 'javascript']]
      );
      expect(result).toEqual(topicSummaries);
    });

    it('should handle empty topics array', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await summaryRepository.searchByTopics([]);

      expect(result).toEqual([]);
    });

    it('should limit results to 50', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.searchByTopics(['test']);

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('LIMIT 50');
    });

    it('should order by created_at DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.searchByTopics(['test']);

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at DESC');
    });

    it('should handle special characters in topics', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await summaryRepository.searchByTopics([
        'topic-with-dash',
        'topic.with.dots',
        'topic_with_underscore',
        'topic with spaces'
      ]);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        [['topic-with-dash', 'topic.with.dots', 'topic_with_underscore', 'topic with spaces']]
      );
    });
  });

  describe('SQL injection prevention', () => {
    it('should handle malicious channel ID safely', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const maliciousId = "'; DROP TABLE conversation_summaries; --";
      await summaryRepository.findByChannel(maliciousId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ["'; DROP TABLE conversation_summaries; --", 10]
      );
    });

    it('should handle malicious summary content safely', async () => {
      const maliciousSummary: ConversationSummary = {
        channel_id: 'C123',
        summary: "'); DROP TABLE users; --",
        start_ts: '123',
        end_ts: '456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockSummary()], rowCount: 1 });

      await summaryRepository.create(maliciousSummary);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[1]).toBe("'); DROP TABLE users; --");
    });
  });

  describe('Edge cases', () => {
    it('should handle very long summary text', async () => {
      const longSummary: ConversationSummary = {
        channel_id: 'C123',
        summary: 'a'.repeat(10000),
        start_ts: '123',
        end_ts: '456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockSummary()], rowCount: 1 });

      await summaryRepository.create(longSummary);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[1]).toHaveLength(10000);
    });

    it('should handle many topics and participants', async () => {
      const topics = Array.from({ length: 100 }, (_, i) => `topic${i}`);
      const participants = Array.from({ length: 50 }, (_, i) => `U${i}`);

      const summary: ConversationSummary = {
        channel_id: 'C123',
        summary: 'Large meeting',
        key_topics: topics,
        participant_ids: participants,
        start_ts: '123',
        end_ts: '456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockSummary()], rowCount: 1 });

      await summaryRepository.create(summary);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(JSON.parse(callArgs[2])).toHaveLength(100);
      expect(JSON.parse(callArgs[3])).toHaveLength(50);
    });

    it('should handle unicode in notable moments', async () => {
      const summary: ConversationSummary = {
        channel_id: 'C123',
        summary: 'International team meeting',
        notable_moments: [
          { description: '🎉 Celebration time', emoji: '🚀' },
          { description: 'Discussion in 中文', language: 'Chinese' }
        ],
        start_ts: '123',
        end_ts: '456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockSummary()], rowCount: 1 });

      await summaryRepository.create(summary);

      const callArgs = mockPool.query.mock.calls[0][1];
      const notableMoments = JSON.parse(callArgs[5]);
      expect(notableMoments[0].description).toBe('🎉 Celebration time');
      expect(notableMoments[1].description).toBe('Discussion in 中文');
    });
  });
});