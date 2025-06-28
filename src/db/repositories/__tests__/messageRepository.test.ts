import { messageRepository, Message, MessageSearchOptions } from '../messageRepository';
import { pool } from '@db/connection';
import { createMockPool, createMockMessage, mockDatabaseErrors, createMockEmbedding } from '@test-utils';

jest.mock('@db/connection');

describe('MessageRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = createMockPool();
    (pool as any) = mockPool;
  });

  describe('create', () => {
    it('should insert message with all fields', async () => {
      const messageData: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'Test message',
        message_ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
        parent_user_ts: '1234567890.000000',
        context: { team: 'T123', reactions: [] },
        embedding: createMockEmbedding(0.5),
        embedding_model: 'text-embedding-ada-002'
      };

      const createdMessage = createMockMessage(messageData);
      mockPool.query.mockResolvedValue({ rows: [createdMessage], rowCount: 1 });

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
          messageData.embedding,
          messageData.embedding_model
        ]
      );
      expect(result).toEqual(createdMessage);
    });

    it('should handle minimal message data', async () => {
      const minimalMessage: Message = {
        slack_user_id: 'U456',
        channel_id: 'C456',
        message_text: 'Minimal message',
        message_ts: '9876543210.123456'
      };

      const createdMessage = createMockMessage(minimalMessage);
      mockPool.query.mockResolvedValue({ rows: [createdMessage], rowCount: 1 });

      const result = await messageRepository.create(minimalMessage);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages'),
        [
          'U456',
          'C456',
          'Minimal message',
          '9876543210.123456',
          null,
          null,
          '{}',
          null,
          null
        ]
      );
      expect(result).toEqual(createdMessage);
    });

    it('should handle ON CONFLICT UPDATE for duplicate message_ts', async () => {
      const messageData: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'Updated message',
        message_ts: '1234567890.123456'
      };

      const updatedMessage = createMockMessage({
        ...messageData,
        message_text: 'Updated message'
      });
      mockPool.query.mockResolvedValue({ rows: [updatedMessage], rowCount: 1 });

      const result = await messageRepository.create(messageData);

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ON CONFLICT (message_ts) DO UPDATE SET');
      expect(query).toContain('message_text = EXCLUDED.message_text');
      expect(query).toContain('context = EXCLUDED.context');
      expect(result).toEqual(updatedMessage);
    });

    it('should handle special characters in message text', async () => {
      const messageWithSpecialChars: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'Message with "quotes", \'apostrophes\', and\nnewlines\ttabs',
        message_ts: '1234567890.123456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockMessage()], rowCount: 1 });

      await messageRepository.create(messageWithSpecialChars);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[2]).toBe('Message with "quotes", \'apostrophes\', and\nnewlines\ttabs');
    });

    it('should properly serialize context object', async () => {
      const complexContext = {
        team: 'T123',
        reactions: [
          { name: 'thumbsup', users: ['U1', 'U2'], count: 2 },
          { name: 'heart', users: ['U3'], count: 1 }
        ],
        attachments: [{ id: 'A1', title: 'File.pdf' }],
        custom_data: { nested: { value: true } }
      };

      const message: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'Message with complex context',
        message_ts: '1234567890.123456',
        context: complexContext
      };

      mockPool.query.mockResolvedValue({ rows: [createMockMessage()], rowCount: 1 });

      await messageRepository.create(message);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(JSON.parse(callArgs[6])).toEqual(complexContext);
    });
  });

  describe('findByTimestamp', () => {
    it('should find message by timestamp', async () => {
      const mockMessage = createMockMessage({ message_ts: '1234567890.123456' });
      mockPool.query.mockResolvedValue({ rows: [mockMessage], rowCount: 1 });

      const result = await messageRepository.findByTimestamp('1234567890.123456');

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM messages WHERE message_ts = $1',
        ['1234567890.123456']
      );
      expect(result).toEqual(mockMessage);
    });

    it('should return null when message not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await messageRepository.findByTimestamp('9999999999.999999');

      expect(result).toBeNull();
    });
  });

  describe('findByChannel', () => {
    it('should find messages by channel with default options', async () => {
      const messages = [
        createMockMessage({ id: 1 }),
        createMockMessage({ id: 2 })
      ];
      mockPool.query.mockResolvedValue({ rows: messages, rowCount: 2 });

      const result = await messageRepository.findByChannel('C123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE channel_id = $1'),
        ['C123']
      );
      expect(result).toEqual(messages);
    });

    it('should filter by thread_ts when provided', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findByChannel('C123', {
        thread_ts: '1234567890.000000'
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AND thread_ts = $2'),
        ['C123', '1234567890.000000']
      );
    });

    it('should filter by date range', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findByChannel('C123', {
        start_date: startDate,
        end_date: endDate
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AND created_at >= $2'),
        expect.arrayContaining([startDate, endDate])
      );
    });

    it('should apply limit and offset', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findByChannel('C123', {
        limit: 50,
        offset: 100
      });

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('LIMIT $2');
      expect(query).toContain('OFFSET $3');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['C123', 50, 100]
      );
    });

    it('should order by created_at DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findByChannel('C123');

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at DESC');
    });

    it('should handle all options together', async () => {
      const options: MessageSearchOptions = {
        thread_ts: '1234567890.000000',
        start_date: new Date('2024-01-01'),
        end_date: new Date('2024-01-31'),
        limit: 25,
        offset: 50
      };

      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findByChannel('C123', options);

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('channel_id = $1');
      expect(query).toContain('thread_ts = $2');
      expect(query).toContain('created_at >= $3');
      expect(query).toContain('created_at <= $4');
      expect(query).toContain('LIMIT $5');
      expect(query).toContain('OFFSET $6');
    });
  });

  describe('updateEmbedding', () => {
    it('should update message embedding', async () => {
      const embedding = createMockEmbedding(0.8);
      const updatedMessage = createMockMessage({
        embedding,
        embedding_model: 'text-embedding-ada-002'
      });
      mockPool.query.mockResolvedValue({ rows: [updatedMessage], rowCount: 1 });

      const result = await messageRepository.updateEmbedding(
        '1234567890.123456',
        embedding,
        'text-embedding-ada-002'
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE messages'),
        [
          `[${embedding.join(',')}]`,
          'text-embedding-ada-002',
          '1234567890.123456'
        ]
      );
      expect(result).toEqual(updatedMessage);
    });

    it('should return null when message not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await messageRepository.updateEmbedding(
        '9999999999.999999',
        createMockEmbedding(),
        'model'
      );

      expect(result).toBeNull();
    });

    it('should handle large embeddings', async () => {
      const largeEmbedding = new Array(1536).fill(0).map((_, i) => Math.sin(i));
      mockPool.query.mockResolvedValue({ rows: [createMockMessage()], rowCount: 1 });

      await messageRepository.updateEmbedding(
        '1234567890.123456',
        largeEmbedding,
        'text-embedding-ada-002'
      );

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[0]).toMatch(/^\[[\d\.\-,]+\]$/);
      expect(callArgs[0].split(',').length).toBe(1536);
    });
  });

  describe('findSimilar', () => {
    it('should find similar messages using vector search', async () => {
      const embedding = createMockEmbedding(0.5);
      const similarMessages = [
        createMockMessage({ id: 1, similarity: 0.95 }),
        createMockMessage({ id: 2, similarity: 0.85 }),
        createMockMessage({ id: 3, similarity: 0.75 })
      ];
      mockPool.query.mockResolvedValue({ rows: similarMessages, rowCount: 3 });

      const result = await messageRepository.findSimilar(embedding);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('1 - (embedding <=> $1::vector) as similarity'),
        [`[${embedding.join(',')}]`, 0.7, 10]
      );
      expect(result).toEqual(similarMessages);
    });

    it('should respect custom limit and threshold', async () => {
      const embedding = createMockEmbedding();
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findSimilar(embedding, 20, 0.85);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        [`[${embedding.join(',')}]`, 0.85, 20]
      );
    });

    it('should order by similarity (ascending distance)', async () => {
      const embedding = createMockEmbedding();
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findSimilar(embedding);

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY embedding <=> $1::vector');
    });

    it('should filter out messages without embeddings', async () => {
      const embedding = createMockEmbedding();
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.findSimilar(embedding);

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('WHERE embedding IS NOT NULL');
    });
  });

  describe('getMessagesWithoutEmbeddings', () => {
    it('should get messages without embeddings', async () => {
      const messages = [
        createMockMessage({ id: 1, embedding: null }),
        createMockMessage({ id: 2, embedding: null })
      ];
      mockPool.query.mockResolvedValue({ rows: messages, rowCount: 2 });

      const result = await messageRepository.getMessagesWithoutEmbeddings();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE embedding IS NULL'),
        [100]
      );
      expect(result).toEqual(messages);
    });

    it('should respect custom limit', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.getMessagesWithoutEmbeddings(50);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1'),
        [50]
      );
    });

    it('should order by created_at ASC to process oldest first', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.getMessagesWithoutEmbeddings();

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at ASC');
    });
  });

  describe('countByChannel', () => {
    it('should count messages in channel', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ count: '42' }], rowCount: 1 });

      const result = await messageRepository.countByChannel('C123');

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT COUNT(*) FROM messages WHERE channel_id = $1',
        ['C123']
      );
      expect(result).toBe(42);
    });

    it('should handle zero count', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ count: '0' }], rowCount: 1 });

      const result = await messageRepository.countByChannel('C999');

      expect(result).toBe(0);
    });

    it('should parse large counts correctly', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ count: '1234567' }], rowCount: 1 });

      const result = await messageRepository.countByChannel('C123');

      expect(result).toBe(1234567);
    });
  });

  describe('getRecentMessages', () => {
    it('should get recent messages with default parameters', async () => {
      const recentMessages = [
        createMockMessage({ id: 1 }),
        createMockMessage({ id: 2 })
      ];
      mockPool.query.mockResolvedValue({ rows: recentMessages, rowCount: 2 });

      const result = await messageRepository.getRecentMessages('C123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('created_at >= NOW() - INTERVAL $2'),
        ['C123', '24 hours', 100]
      );
      expect(result).toEqual(recentMessages);
    });

    it('should use custom hours and limit', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.getRecentMessages('C123', 48, 200);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['C123', '48 hours', 200]
      );
    });

    it('should order by created_at DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.getRecentMessages('C123');

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY created_at DESC');
    });

    it('should handle fractional hours', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await messageRepository.getRecentMessages('C123', 0.5, 10);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['C123', '0.5 hours', 10]
      );
    });
  });

  describe('SQL injection prevention', () => {
    it('should safely handle malicious channel ID', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const maliciousId = "'; DROP TABLE messages; --";
      await messageRepository.getRecentMessages(maliciousId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ["'; DROP TABLE messages; --", '24 hours', 100]
      );
    });

    it('should safely handle malicious message text', async () => {
      const maliciousMessage: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: "'); DROP TABLE users; --",
        message_ts: '1234567890.123456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockMessage()], rowCount: 1 });

      await messageRepository.create(maliciousMessage);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[2]).toBe("'); DROP TABLE users; --");
    });

    it('should safely handle malicious timestamp', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const maliciousTs = "1234567890.123456'; DELETE FROM messages; --";
      await messageRepository.findByTimestamp(maliciousTs);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ["1234567890.123456'; DELETE FROM messages; --"]
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle very long message text', async () => {
      const longMessage: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: 'a'.repeat(10000),
        message_ts: '1234567890.123456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockMessage()], rowCount: 1 });

      await messageRepository.create(longMessage);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[2]).toHaveLength(10000);
    });

    it('should handle database errors', async () => {
      mockPool.query.mockRejectedValue(mockDatabaseErrors.connectionError);

      await expect(messageRepository.findByChannel('C123'))
        .rejects.toThrow('connection refused');
    });

    it('should handle unicode in message text', async () => {
      const unicodeMessage: Message = {
        slack_user_id: 'U123',
        channel_id: 'C123',
        message_text: '🎉 Unicode test 中文 עברית',
        message_ts: '1234567890.123456'
      };

      mockPool.query.mockResolvedValue({ rows: [createMockMessage()], rowCount: 1 });

      await messageRepository.create(unicodeMessage);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[2]).toBe('🎉 Unicode test 中文 עברית');
    });
  });
});