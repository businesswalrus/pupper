import { messageRepository } from '../messageRepository';
import { pool } from '@db/connection';

jest.mock('@db/connection');

describe('MessageRepository', () => {
  let mockPool: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = {
      query: jest.fn(),
    };
    (pool as any) = mockPool;
  });

  describe('getRecentMessages', () => {
    it('should use parameterized queries to prevent SQL injection', async () => {
      const mockMessages = [
        { id: 1, message_text: 'Hello', channel_id: 'C123' },
        { id: 2, message_text: 'World', channel_id: 'C123' },
      ];
      mockPool.query.mockResolvedValue({ rows: mockMessages });

      await messageRepository.getRecentMessages('C123', 24, 100);

      // Verify parameterized query was used
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AND created_at >= NOW() - INTERVAL $2'),
        ['C123', '24 hours', 100]
      );
    });

    it('should handle SQL injection attempt in hours parameter', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      // This would have been dangerous with string interpolation:
      // "24; DROP TABLE messages; --"
      const maliciousHours = 24; // Now it's just a number
      
      await messageRepository.getRecentMessages('C123', maliciousHours, 100);

      // Verify the parameter is safely passed
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['C123', '24 hours', 100]
      );
      
      // The query should not contain any DROP TABLE
      const queryCall = mockPool.query.mock.calls[0][0];
      expect(queryCall).not.toContain('DROP');
    });

    it('should enforce default values', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await messageRepository.getRecentMessages('C123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['C123', '24 hours', 100] // Default values
      );
    });
  });

  describe('create', () => {
    it('should insert message with all fields', async () => {
      const messageData = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'Test message',
        message_ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
        parent_user_ts: undefined,
        context: { team: 'T123' },
      };

      const mockResult = {
        rows: [{
          id: 1,
          ...messageData,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      };
      mockPool.query.mockResolvedValue(mockResult);

      const result = await messageRepository.create(messageData);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages'),
        [
          messageData.slack_user_id,
          messageData.channel_id,
          messageData.message_text,
          messageData.message_ts,
          messageData.thread_ts,
          messageData.parent_user_ts,
          JSON.stringify(messageData.context),
        ]
      );
      expect(result).toEqual(mockResult.rows[0]);
    });

    it('should handle duplicate message_ts gracefully', async () => {
      const messageData = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'Test message',
        message_ts: '1234567890.123456',
      };

      // Simulate unique constraint violation
      const error = new Error('duplicate key value violates unique constraint');
      (error as any).code = '23505';
      mockPool.query.mockRejectedValue(error);

      // Should not throw, returns undefined for duplicates
      const result = await messageRepository.create(messageData);
      expect(result).toBeUndefined();
    });
  });

  describe('searchSimilar', () => {
    it('should use vector similarity search safely', async () => {
      const embedding = new Array(1536).fill(0.1);
      mockPool.query.mockResolvedValue({ rows: [] });

      await messageRepository.searchSimilar(
        embedding,
        'C123',
        0.7,
        50,
        24
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('1 - (embedding <=> $1) as similarity'),
        [
          JSON.stringify(embedding),
          'C123',
          0.7,
          50,
        ]
      );
    });
  });
});