import { Message, User } from '@db/types';

/**
 * Test data generators and utilities
 */

// Generate a unique ID for tests
let idCounter = 1;
export const generateId = (prefix: string = '') => `${prefix}${idCounter++}`;

// Generate timestamps
export const generateTimestamp = (offsetMs: number = 0) => {
  const now = Date.now() + offsetMs;
  return `${Math.floor(now / 1000)}.${(now % 1000).toString().padStart(6, '0')}`;
};

// Create a delay for async testing
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Mock environment variables
export const mockEnv = (overrides: Record<string, string> = {}) => {
  const original = process.env;
  
  beforeEach(() => {
    process.env = {
      ...original,
      NODE_ENV: 'test',
      SLACK_BOT_TOKEN: 'xoxb-test-token',
      SLACK_APP_TOKEN: 'xapp-test-token',
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      OPENAI_API_KEY: 'sk-test-key',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'error', // Reduce noise in tests
      ...overrides,
    };
  });
  
  afterEach(() => {
    process.env = original;
  });
};

// Create test message sequences
export const createMessageSequence = (count: number, channelId: string, userId: string) => {
  const messages: Partial<Message>[] = [];
  const baseTime = Date.now() - count * 60000; // Start from count minutes ago
  
  for (let i = 0; i < count; i++) {
    messages.push({
      slack_user_id: userId,
      channel_id: channelId,
      message_text: `Test message ${i + 1}`,
      message_ts: generateTimestamp(baseTime + i * 60000),
      created_at: new Date(baseTime + i * 60000),
    });
  }
  
  return messages;
};

// Create a conversation thread
export const createThread = (mainMessage: Partial<Message>, replies: number = 3) => {
  const thread: Partial<Message>[] = [mainMessage];
  const threadTs = mainMessage.message_ts || generateTimestamp();
  
  for (let i = 0; i < replies; i++) {
    thread.push({
      ...mainMessage,
      message_text: `Reply ${i + 1}`,
      message_ts: generateTimestamp(i * 1000),
      thread_ts: threadTs,
      parent_user_ts: threadTs,
    });
  }
  
  return thread;
};

// Test assertions for AI responses
export const assertAIResponse = (response: string, expectations: {
  minLength?: number;
  maxLength?: number;
  contains?: string[];
  notContains?: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
}) => {
  if (expectations.minLength) {
    expect(response.length).toBeGreaterThanOrEqual(expectations.minLength);
  }
  
  if (expectations.maxLength) {
    expect(response.length).toBeLessThanOrEqual(expectations.maxLength);
  }
  
  if (expectations.contains) {
    expectations.contains.forEach(text => {
      expect(response.toLowerCase()).toContain(text.toLowerCase());
    });
  }
  
  if (expectations.notContains) {
    expectations.notContains.forEach(text => {
      expect(response.toLowerCase()).not.toContain(text.toLowerCase());
    });
  }
  
  // Simple sentiment check
  if (expectations.sentiment) {
    const positiveWords = ['great', 'awesome', 'excellent', 'good', 'happy'];
    const negativeWords = ['bad', 'terrible', 'awful', 'sad', 'angry'];
    
    const hasPositive = positiveWords.some(word => response.toLowerCase().includes(word));
    const hasNegative = negativeWords.some(word => response.toLowerCase().includes(word));
    
    switch (expectations.sentiment) {
      case 'positive':
        expect(hasPositive).toBe(true);
        expect(hasNegative).toBe(false);
        break;
      case 'negative':
        expect(hasNegative).toBe(true);
        expect(hasPositive).toBe(false);
        break;
      case 'neutral':
        expect(hasPositive).toBe(false);
        expect(hasNegative).toBe(false);
        break;
    }
  }
};

// Wait for all promises to settle
export const waitForPromises = () => new Promise(resolve => setImmediate(resolve));

// Mock console methods for cleaner test output
export const mockConsole = () => {
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  
  beforeEach(() => {
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
    console.info = jest.fn();
  });
  
  afterEach(() => {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
  });
  
  return {
    getConsoleOutput: () => ({
      log: (console.log as jest.Mock).mock.calls,
      error: (console.error as jest.Mock).mock.calls,
      warn: (console.warn as jest.Mock).mock.calls,
      info: (console.info as jest.Mock).mock.calls,
    }),
  };
};

// Performance testing helper
export const measurePerformance = async (fn: () => Promise<any>, iterations: number = 100) => {
  const times: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1000000); // Convert to milliseconds
  }
  
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const sorted = times.sort((a, b) => a - b);
  const p95 = sorted[Math.floor(times.length * 0.95)];
  const p99 = sorted[Math.floor(times.length * 0.99)];
  
  return {
    average: avg,
    median: sorted[Math.floor(times.length / 2)],
    p95,
    p99,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
};

// Snapshot testing for complex objects
export const createSnapshot = (obj: any, replacer?: (key: string, value: any) => any) => {
  return JSON.stringify(obj, replacer || ((key, value) => {
    // Replace dynamic values with stable ones
    if (key === 'id' && typeof value === 'number') return '[ID]';
    if (key === 'created_at' || key === 'updated_at') return '[TIMESTAMP]';
    if (key === 'message_ts' && typeof value === 'string') return '[MESSAGE_TS]';
    if (key === 'embedding' && Array.isArray(value)) return '[EMBEDDING_VECTOR]';
    return value;
  }), 2);
};