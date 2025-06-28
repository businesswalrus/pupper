import { userRepository, User } from '../userRepository';
import { pool } from '@db/connection';
import { createMockPool, createMockUser, mockDatabaseErrors } from '@test-utils';

jest.mock('@db/connection');

describe('UserRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = createMockPool();
    (pool as any) = mockPool;
  });

  describe('findBySlackId', () => {
    it('should find user by slack ID', async () => {
      const mockUser = createMockUser();
      mockPool.query.mockResolvedValue({ rows: [mockUser], rowCount: 1 });

      const result = await userRepository.findBySlackId('U1234567890');

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE slack_user_id = $1',
        ['U1234567890']
      );
      expect(result).toEqual(mockUser);
    });

    it('should return null when user not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.findBySlackId('U999999999');

      expect(result).toBeNull();
    });

    it('should handle database errors', async () => {
      mockPool.query.mockRejectedValue(new Error('Connection failed'));

      await expect(userRepository.findBySlackId('U123')).rejects.toThrow('Connection failed');
    });
  });

  describe('create', () => {
    it('should create a new user with all fields', async () => {
      const newUser: User = {
        slack_user_id: 'U9876543210',
        username: 'newuser',
        real_name: 'New User',
        display_name: 'New',
        personality_summary: 'Enthusiastic newcomer',
        interests: ['coding', 'music'],
        communication_style: 'friendly',
        memorable_quotes: ['Hello world!'],
        metadata: { joined_date: '2024-01-01' }
      };

      const createdUser = { ...newUser, id: 1, created_at: new Date(), updated_at: new Date() };
      mockPool.query.mockResolvedValue({ rows: [createdUser], rowCount: 1 });

      const result = await userRepository.create(newUser);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        [
          'U9876543210',
          'newuser',
          'New User',
          'New',
          'Enthusiastic newcomer',
          '["coding","music"]',
          'friendly',
          '["Hello world!"]',
          '{"joined_date":"2024-01-01"}'
        ]
      );
      expect(result).toEqual(createdUser);
    });

    it('should create user with minimal fields', async () => {
      const minimalUser: User = {
        slack_user_id: 'U1111111111'
      };

      const createdUser = createMockUser({ slack_user_id: 'U1111111111' });
      mockPool.query.mockResolvedValue({ rows: [createdUser], rowCount: 1 });

      const result = await userRepository.create(minimalUser);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        [
          'U1111111111',
          null,
          null,
          null,
          null,
          '[]',
          null,
          '[]',
          '{}'
        ]
      );
      expect(result).toEqual(createdUser);
    });

    it('should handle unique constraint violations', async () => {
      mockPool.query.mockRejectedValue(mockDatabaseErrors.uniqueConstraint);

      await expect(userRepository.create({
        slack_user_id: 'U1234567890'
      })).rejects.toThrow('duplicate key value violates unique constraint');
    });

    it('should properly stringify JSON fields', async () => {
      const userWithComplexData: User = {
        slack_user_id: 'U2222222222',
        interests: ['coding', 'with spaces', 'and-dashes'],
        memorable_quotes: ['Quote with "quotes"', "Quote with 'apostrophes'"],
        metadata: {
          nested: {
            data: true,
            count: 42
          }
        }
      };

      mockPool.query.mockResolvedValue({ rows: [createMockUser()], rowCount: 1 });

      await userRepository.create(userWithComplexData);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[5]).toBe('["coding","with spaces","and-dashes"]');
      expect(callArgs[7]).toBe('["Quote with \\"quotes\\"","Quote with \'apostrophes\'"]');
      expect(callArgs[8]).toBe('{"nested":{"data":true,"count":42}}');
    });
  });

  describe('update', () => {
    it('should update allowed fields', async () => {
      const updates = {
        username: 'updated_user',
        personality_summary: 'Now more experienced',
        interests: ['typescript', 'testing']
      };

      const updatedUser = createMockUser({ ...updates });
      mockPool.query.mockResolvedValue({ rows: [updatedUser], rowCount: 1 });

      const result = await userRepository.update('U1234567890', updates);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users'),
        ['updated_user', 'Now more experienced', '["typescript","testing"]', 'U1234567890']
      );
      expect(result).toEqual(updatedUser);
    });

    it('should ignore non-allowed fields', async () => {
      const updates = {
        id: 999, // Should be ignored
        slack_user_id: 'U999', // Should be ignored
        username: 'valid_update',
        created_at: new Date(), // Should be ignored
      };

      mockPool.query.mockResolvedValue({ rows: [createMockUser()], rowCount: 1 });

      await userRepository.update('U1234567890', updates);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('username = $1'),
        ['valid_update', 'U1234567890']
      );
      // Should not contain id, slack_user_id, or created_at
      const query = mockPool.query.mock.calls[0][0];
      expect(query).not.toContain('id =');
      expect(query).not.toContain('slack_user_id =');
      expect(query).not.toContain('created_at =');
    });

    it('should return existing user when no valid updates provided', async () => {
      const existingUser = createMockUser();
      mockPool.query.mockResolvedValue({ rows: [existingUser], rowCount: 1 });

      const result = await userRepository.update('U1234567890', {
        id: 999, // Invalid field
        created_at: new Date() // Invalid field
      });

      // Should call findBySlackId instead of update
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE slack_user_id = $1',
        ['U1234567890']
      );
      expect(result).toEqual(existingUser);
    });

    it('should return null when user not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.update('U999999999', { username: 'new_name' });

      expect(result).toBeNull();
    });

    it('should handle empty updates object', async () => {
      const existingUser = createMockUser();
      mockPool.query.mockResolvedValue({ rows: [existingUser], rowCount: 1 });

      const result = await userRepository.update('U1234567890', {});

      expect(result).toEqual(existingUser);
    });

    it('should properly update metadata field', async () => {
      const updates = {
        metadata: {
          preferences: {
            theme: 'dark',
            notifications: true
          },
          lastSeen: '2024-01-01T12:00:00Z'
        }
      };

      mockPool.query.mockResolvedValue({ rows: [createMockUser()], rowCount: 1 });

      await userRepository.update('U1234567890', updates);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('metadata = $1'),
        [
          '{"preferences":{"theme":"dark","notifications":true},"lastSeen":"2024-01-01T12:00:00Z"}',
          'U1234567890'
        ]
      );
    });
  });

  describe('upsert', () => {
    it('should update existing user', async () => {
      const existingUser = createMockUser();
      const updates: User = {
        slack_user_id: 'U1234567890',
        username: 'updated_username',
        interests: ['new', 'interests']
      };

      // First call: findBySlackId returns existing user
      mockPool.query.mockResolvedValueOnce({ rows: [existingUser], rowCount: 1 });
      // Second call: update returns updated user
      const updatedUser = { ...existingUser, ...updates };
      mockPool.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 });

      const result = await userRepository.upsert(updates);

      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(result).toEqual(updatedUser);
    });

    it('should create new user when not exists', async () => {
      const newUser: User = {
        slack_user_id: 'U9999999999',
        username: 'brandnew'
      };

      // First call: findBySlackId returns null
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Second call: create returns new user
      const createdUser = createMockUser(newUser);
      mockPool.query.mockResolvedValueOnce({ rows: [createdUser], rowCount: 1 });

      const result = await userRepository.upsert(newUser);

      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(mockPool.query).toHaveBeenNthCalledWith(1,
        'SELECT * FROM users WHERE slack_user_id = $1',
        ['U9999999999']
      );
      expect(mockPool.query).toHaveBeenNthCalledWith(2,
        expect.stringContaining('INSERT INTO users'),
        expect.any(Array)
      );
      expect(result).toEqual(createdUser);
    });
  });

  describe('findAll', () => {
    it('should return all users ordered by created_at', async () => {
      const users = [
        createMockUser({ username: 'user1' }),
        createMockUser({ username: 'user2' }),
        createMockUser({ username: 'user3' })
      ];
      mockPool.query.mockResolvedValue({ rows: users, rowCount: 3 });

      const result = await userRepository.findAll();

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users ORDER BY created_at DESC'
      );
      expect(result).toEqual(users);
      expect(result).toHaveLength(3);
    });

    it('should return empty array when no users', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await userRepository.findAll();

      expect(result).toEqual([]);
    });

    it('should handle database errors', async () => {
      mockPool.query.mockRejectedValue(mockDatabaseErrors.connectionError);

      await expect(userRepository.findAll()).rejects.toThrow('connection refused');
    });
  });

  describe('SQL injection prevention', () => {
    it('should safely handle malicious input in findBySlackId', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const maliciousId = "U123'; DROP TABLE users; --";
      await userRepository.findBySlackId(maliciousId);

      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE slack_user_id = $1',
        ["U123'; DROP TABLE users; --"]
      );
      // The malicious code should be treated as a literal string, not executed
    });

    it('should safely handle malicious input in create', async () => {
      mockPool.query.mockResolvedValue({ rows: [createMockUser()], rowCount: 1 });

      const maliciousUser: User = {
        slack_user_id: 'U123',
        username: "admin'; DROP TABLE users; --",
        personality_summary: "', 'malicious'), ('U999', 'hacked'); --"
      };

      await userRepository.create(maliciousUser);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(callArgs[1]).toBe("admin'; DROP TABLE users; --");
      expect(callArgs[4]).toBe("', 'malicious'), ('U999', 'hacked'); --");
    });
  });

  describe('Edge cases', () => {
    it('should handle very long strings', async () => {
      const longString = 'a'.repeat(10000);
      const user: User = {
        slack_user_id: 'U123',
        personality_summary: longString
      };

      mockPool.query.mockResolvedValue({ rows: [createMockUser()], rowCount: 1 });

      await userRepository.create(user);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([longString])
      );
    });

    it('should handle special characters in JSON fields', async () => {
      const user: User = {
        slack_user_id: 'U123',
        interests: ['tab\there', 'new\nline', 'quote"inside'],
        metadata: {
          special: '\\backslash',
          unicode: '😀🎉'
        }
      };

      mockPool.query.mockResolvedValue({ rows: [createMockUser()], rowCount: 1 });

      await userRepository.create(user);

      const callArgs = mockPool.query.mock.calls[0][1];
      expect(JSON.parse(callArgs[5])).toEqual(['tab\there', 'new\nline', 'quote"inside']);
      expect(JSON.parse(callArgs[8])).toEqual({
        special: '\\backslash',
        unicode: '😀🎉'
      });
    });
  });
});