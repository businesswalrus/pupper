// Jest setup file for global test configuration

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce noise in tests
process.env.DATABASE_URL = process.env.DATABASE_TEST_URL || 'postgresql://postgres:postgres@localhost:5432/pupper_test';
process.env.REDIS_URL = 'redis://localhost:6379/1'; // Use Redis DB 1 for tests

// Mock timers for consistent testing
global.Date.now = jest.fn(() => new Date('2024-01-01T00:00:00.000Z').getTime());

// Increase timeout for integration tests
if (process.env.TEST_TYPE === 'integration') {
  jest.setTimeout(30000);
}

// Mock console methods to reduce test output noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  // Keep warn and error for important messages
  warn: console.warn,
  error: console.error,
};

// Add custom matchers
expect.extend({
  toBeWithinRange(received, floor, ceiling) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
  
  toHaveTimestamp(received) {
    const pass = received instanceof Date || 
                 (typeof received === 'string' && !isNaN(Date.parse(received))) ||
                 (typeof received === 'number' && received > 0);
    if (pass) {
      return {
        message: () => `expected ${received} not to be a valid timestamp`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a valid timestamp`,
        pass: false,
      };
    }
  },
});

// Clean up after all tests
afterAll(async () => {
  // Close any open handles
  await new Promise(resolve => setTimeout(resolve, 500));
});