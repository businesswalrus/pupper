// Re-export all mocks and helpers for convenient importing
export * from './mocks/slackMocks';
export * from './mocks/openaiMocks';
export * from './mocks/databaseMocks';
export * from './mocks/redisMocks';
export * from './helpers';

// Common test setup that can be used across all tests
export const setupTests = () => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  
  // Increase test timeout for integration tests
  if (process.env.TEST_TYPE === 'integration') {
    jest.setTimeout(30000);
  }
  
  // Clear all mocks after each test
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  // Restore all mocks after test suite
  afterAll(() => {
    jest.restoreAllMocks();
  });
};