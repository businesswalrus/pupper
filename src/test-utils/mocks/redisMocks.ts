import { RedisClientType } from 'redis';

// Mock Redis client
export const createMockRedisClient = (overrides: any = {}): RedisClientType => {
  const mockClient = {
    // Connection methods
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    
    // Basic operations
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-1),
    
    // Hash operations
    hGet: jest.fn().mockResolvedValue(null),
    hSet: jest.fn().mockResolvedValue(1),
    hGetAll: jest.fn().mockResolvedValue({}),
    hDel: jest.fn().mockResolvedValue(1),
    hExists: jest.fn().mockResolvedValue(0),
    
    // List operations
    lPush: jest.fn().mockResolvedValue(1),
    rPush: jest.fn().mockResolvedValue(1),
    lPop: jest.fn().mockResolvedValue(null),
    rPop: jest.fn().mockResolvedValue(null),
    lRange: jest.fn().mockResolvedValue([]),
    lLen: jest.fn().mockResolvedValue(0),
    
    // Set operations
    sAdd: jest.fn().mockResolvedValue(1),
    sRem: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sIsMember: jest.fn().mockResolvedValue(0),
    sCard: jest.fn().mockResolvedValue(0),
    
    // Sorted set operations
    zAdd: jest.fn().mockResolvedValue(1),
    zRem: jest.fn().mockResolvedValue(1),
    zRange: jest.fn().mockResolvedValue([]),
    zRevRange: jest.fn().mockResolvedValue([]),
    zScore: jest.fn().mockResolvedValue(null),
    zCard: jest.fn().mockResolvedValue(0),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
    
    // Pub/Sub
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(0),
    
    // Transactions
    multi: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue([]),
      discard: jest.fn().mockResolvedValue(undefined),
    }),
    
    // Events
    on: jest.fn(),
    once: jest.fn(),
    off: jest.fn(),
    
    // State
    isOpen: true,
    isReady: true,
    
    ...overrides,
  };

  return mockClient as unknown as RedisClientType;
};

// Mock BullMQ Queue
export const createMockQueue = (overrides: any = {}) => ({
  add: jest.fn().mockResolvedValue({
    id: '1',
    name: 'test-job',
    data: {},
    opts: {},
    timestamp: Date.now(),
  }),
  addBulk: jest.fn().mockResolvedValue([]),
  pause: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  getJobs: jest.fn().mockResolvedValue([]),
  getJob: jest.fn().mockResolvedValue(null),
  getJobCounts: jest.fn().mockResolvedValue({
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
  }),
  clean: jest.fn().mockResolvedValue([]),
  drain: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  off: jest.fn(),
  ...overrides,
});

// Mock BullMQ Worker
export const createMockWorker = (overrides: any = {}) => ({
  run: jest.fn().mockResolvedValue(undefined),
  pause: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  off: jest.fn(),
  isRunning: jest.fn().mockReturnValue(true),
  isPaused: jest.fn().mockReturnValue(false),
  ...overrides,
});

// Mock BullMQ Job
export const createMockJob = (overrides: any = {}) => ({
  id: '1',
  name: 'test-job',
  data: {},
  opts: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
  attemptsMade: 0,
  timestamp: Date.now(),
  finishedOn: null,
  processedOn: null,
  progress: jest.fn().mockResolvedValue(undefined),
  log: jest.fn().mockResolvedValue(undefined),
  updateProgress: jest.fn().mockResolvedValue(undefined),
  getState: jest.fn().mockResolvedValue('waiting'),
  remove: jest.fn().mockResolvedValue(undefined),
  retry: jest.fn().mockResolvedValue(undefined),
  discard: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

// Mock cache data
export const mockCacheData = {
  userProfile: (userId: string) => ({
    key: `user:${userId}`,
    value: JSON.stringify({
      id: userId,
      name: 'Test User',
      cached_at: new Date().toISOString(),
    }),
    ttl: 3600,
  }),
  
  rateLimitKey: (userId: string, operation: string) => ({
    key: `rl:${operation}:${userId}`,
    members: Array.from({ length: 5 }, (_, i) => ({
      score: Date.now() - i * 1000,
      value: `${Date.now() - i * 1000}`,
    })),
  }),
  
  searchCache: (query: string) => ({
    key: `search:${Buffer.from(query).toString('base64')}`,
    value: JSON.stringify({
      results: ['result1', 'result2'],
      cached_at: new Date().toISOString(),
    }),
    ttl: 300,
  }),
};

// Mock Redis errors
export const mockRedisErrors = {
  connectionRefused: new Error('connect ECONNREFUSED 127.0.0.1:6379'),
  timeout: new Error('Connection timeout'),
  commandAborted: new Error('Command aborted due to connection close'),
  wrongType: new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
};