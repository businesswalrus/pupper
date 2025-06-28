import { Pool, Client } from 'pg';
import { Message, User, ConversationSummary, UserInteraction } from '@db/types';

// Mock PostgreSQL pool
export const createMockPool = (overrides: any = {}) => {
  const mockPool = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue(createMockClient()),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    ...overrides,
  };

  return mockPool as unknown as Pool;
};

// Mock PostgreSQL client
export const createMockClient = (overrides: any = {}) => {
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    ...overrides,
  };

  return mockClient as unknown as Client;
};

// Mock user data
export const createMockUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  slack_user_id: 'U1234567890',
  username: 'test-user',
  real_name: 'Test User',
  display_name: 'Test User',
  email: 'test@example.com',
  avatar_url: 'https://example.com/avatar.png',
  personality_profile: {
    traits: ['helpful', 'curious'],
    interests: ['coding', 'ai'],
    communication_style: 'casual',
    last_updated: new Date().toISOString(),
  },
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

// Mock message data
export const createMockMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 1,
  slack_user_id: 'U1234567890',
  channel_id: 'C1234567890',
  message_text: 'Test message',
  message_ts: '1234567890.123456',
  thread_ts: null,
  parent_user_ts: null,
  embedding: null,
  context: {
    team_id: 'T1234567890',
    user_context: {},
  },
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

// Mock conversation summary
export const createMockSummary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 1,
  channel_id: 'C1234567890',
  summary_text: 'Today the team discussed the new feature implementation.',
  summary_date: new Date(),
  participant_ids: ['U1234567890', 'U0987654321'],
  key_topics: ['feature', 'implementation', 'testing'],
  metadata: {
    message_count: 42,
    active_users: 5,
  },
  created_at: new Date(),
  ...overrides,
});

// Mock user interaction
export const createMockInteraction = (overrides: Partial<UserInteraction> = {}): UserInteraction => ({
  id: 1,
  user_id: 'U1234567890',
  target_user_id: 'U0987654321',
  interaction_type: 'mention',
  interaction_count: 5,
  sentiment_score: 0.8,
  last_interaction: new Date(),
  context: {
    common_channels: ['C1234567890'],
    interaction_patterns: ['collaborative', 'supportive'],
  },
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

// Mock pgvector operations
export const mockVectorOperations = {
  // Mock similarity search result
  createSimilarityResult: (message: Partial<Message>, similarity: number) => ({
    ...createMockMessage(message),
    similarity,
  }),
  
  // Mock vector distance calculation
  calculateDistance: (vec1: number[], vec2: number[]) => {
    // Simple cosine similarity mock
    return 0.85;
  },
};

// Mock transaction
export const createMockTransaction = () => {
  const mockTx = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };

  const mockClient = createMockClient({
    query: mockTx.query,
    release: jest.fn(),
  });

  return { client: mockClient, tx: mockTx };
};

// Mock database error types
export const mockDatabaseErrors = {
  uniqueConstraint: (() => {
    const error = new Error('duplicate key value violates unique constraint');
    (error as any).code = '23505';
    (error as any).constraint = 'messages_message_ts_key';
    return error;
  })(),
  
  foreignKeyConstraint: (() => {
    const error = new Error('insert or update on table violates foreign key constraint');
    (error as any).code = '23503';
    return error;
  })(),
  
  connectionError: new Error('connection refused'),
  
  timeout: (() => {
    const error = new Error('query timeout');
    (error as any).code = '57014';
    return error;
  })(),
};