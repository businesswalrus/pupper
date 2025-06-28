# Testing Strategy for Pup.ai v2

## Overview

This document outlines the comprehensive testing strategy for pup.ai v2, a context-aware Slack bot with personality and memory. Our testing approach focuses on ensuring reliability, performance, and maintainability while dealing with AI-driven features and real-time messaging.

## Testing Philosophy

1. **Test Pyramid**: Follow the testing pyramid with many unit tests, fewer integration tests, and minimal E2E tests
2. **Fail Fast**: Catch issues early in the development cycle
3. **Deterministic Testing**: Mock non-deterministic components (AI responses, timestamps, random values)
4. **Performance Aware**: Monitor and prevent performance regressions
5. **Security First**: Include security testing in the CI/CD pipeline

## Test Coverage Goals

- **Overall Coverage**: 85% minimum
- **Critical Paths**: 95% (message processing, AI responses, database operations)
- **New Code**: 90% for all new features
- **Mutation Score**: 60% minimum

## Testing Layers

### 1. Unit Tests (70% of tests)

**Location**: `src/**/__tests__/*.test.ts`

**Focus Areas**:
- Pure functions and utilities
- Individual repository methods
- AI prompt generation
- Message sanitization and validation
- Rate limiting logic
- Error handling

**Key Principles**:
- Fast execution (< 100ms per test)
- Complete isolation (no external dependencies)
- Deterministic results
- Single responsibility per test

**Example Test Structure**:
```typescript
describe('PersonalityEngine', () => {
  describe('determineMood', () => {
    it('should detect excited mood from deployment keywords', () => {
      // Arrange
      const messages = ['Ready for deployment!', 'Shipping new features'];
      
      // Act
      const mood = determineMood(messages);
      
      // Assert
      expect(mood.name).toBe('excited');
      expect(mood.intensity).toBeGreaterThan(0.7);
    });
  });
});
```

### 2. Integration Tests (20% of tests)

**Location**: `src/**/__tests__/*.integration.test.ts`

**Focus Areas**:
- Database operations with real PostgreSQL
- Redis caching and job queues
- Message processing pipeline
- Worker job execution
- API endpoint testing

**Test Environment**:
- Docker containers for PostgreSQL and Redis
- Test database with migrations
- Isolated test data per test suite

**Example**:
```typescript
describe('Message Processing Pipeline', () => {
  beforeAll(async () => {
    await setupTestDatabase();
    await startWorkers();
  });

  it('should process message through entire pipeline', async () => {
    // Create message -> Store -> Generate embedding -> Update user profile
    const result = await processMessage(mockSlackMessage);
    
    expect(result.stored).toBe(true);
    expect(result.embedding).toHaveLength(1536);
    expect(result.userProfileUpdated).toBe(true);
  });
});
```

### 3. E2E Tests (10% of tests)

**Location**: `e2e/**/*.e2e.test.ts`

**Focus Areas**:
- Critical user journeys
- Slack command handling
- Bot responses in real channels
- Error recovery scenarios

**Test Environment**:
- Dedicated Slack workspace
- Test bot instance
- Production-like deployment

### 4. Performance Tests

**Location**: `performance/**/*.perf.test.ts`

**Metrics**:
- Response time (p95 < 2s)
- Vector search performance
- Database query optimization
- Memory usage patterns
- Concurrent user handling

**Tools**:
- k6 for load testing
- Custom benchmarking scripts
- Database query analysis

### 5. Security Tests

**Automated Scans**:
- Dependency vulnerability scanning (npm audit, Snyk)
- Static code analysis (SonarQube, CodeQL)
- Secret detection (Gitleaks, TruffleHog)
- Container scanning (Trivy)

**Manual Reviews**:
- Authentication flow
- Data sanitization
- SQL injection prevention
- Rate limiting effectiveness

## Testing AI Components

### Challenges

1. **Non-deterministic outputs**: AI responses vary even with same inputs
2. **External API dependencies**: OpenAI API calls are expensive and slow
3. **Context sensitivity**: Responses depend on conversation history

### Strategies

1. **Mock AI Responses**:
```typescript
const mockOpenAI = {
  chat: {
    completions: {
      create: jest.fn().mockResolvedValue({
        choices: [{ 
          message: { content: 'Mocked witty response' } 
        }]
      })
    }
  }
};
```

2. **Snapshot Testing**: For prompt generation and formatting
3. **Property-Based Testing**: For mood detection and personality traits
4. **Golden Path Testing**: Predefined scenarios with expected outcomes

## Test Data Management

### Fixtures
- User profiles with various personality traits
- Message sequences for different scenarios
- Embedding vectors for similarity testing
- Conversation summaries

### Factories
```typescript
createMockUser({ personality: 'helpful', interests: ['coding'] });
createMockMessage({ embedding: generateMockEmbedding() });
createMessageSequence(count: 10, mood: 'sarcastic');
```

### Database Seeding
- Minimal seed data for integration tests
- Larger datasets for performance testing
- Anonymized production data for realistic scenarios

## CI/CD Integration

### GitHub Actions Workflows

1. **On Every Push**:
   - Linting and formatting
   - Unit tests with coverage
   - Security scanning

2. **On Pull Requests**:
   - Full test suite
   - Performance comparison
   - Code quality metrics
   - Mutation testing (sampling)

3. **Nightly**:
   - Full mutation testing
   - E2E test suite
   - Security audit
   - Performance benchmarks

### Quality Gates

- **Coverage**: Fails if < 80%
- **Tests**: All must pass
- **Performance**: No regression > 10%
- **Security**: No high/critical vulnerabilities
- **Code Quality**: Complexity < 20

## Monitoring Test Health

### Metrics
- Test execution time trends
- Flaky test detection
- Coverage trends
- Failed test patterns

### Reporting
- Daily test summary to Slack
- Weekly quality report
- Coverage badges in README
- Performance dashboard

## Best Practices

### Writing Tests

1. **Arrange-Act-Assert** pattern
2. **Descriptive test names** that explain the scenario
3. **One assertion per test** when possible
4. **Test behavior, not implementation**
5. **Avoid testing framework code**

### Test Maintenance

1. **Fix flaky tests immediately**
2. **Refactor tests with production code**
3. **Delete obsolete tests**
4. **Keep tests simple and readable**
5. **Review test code in PRs**

### Performance

1. **Parallelize test execution**
2. **Use test database transactions**
3. **Minimize fixture setup**
4. **Cache dependencies in CI**
5. **Profile slow tests**

## Testing Checklist for New Features

- [ ] Unit tests for all new functions/methods
- [ ] Integration tests for database changes
- [ ] Update test fixtures if needed
- [ ] Performance impact assessed
- [ ] Security implications reviewed
- [ ] Documentation updated
- [ ] CI/CD pipeline passes
- [ ] Coverage threshold maintained

## Troubleshooting Common Issues

### Flaky Tests
- Check for timing issues
- Verify mock cleanup
- Look for shared state
- Add proper waits for async operations

### Slow Tests
- Profile with `--detectOpenHandles`
- Check for missing `done()` callbacks
- Optimize database queries
- Use connection pooling

### Coverage Gaps
- Run coverage locally first
- Check for untested error paths
- Add tests for edge cases
- Verify async code coverage

## Future Improvements

1. **Visual Regression Testing**: For any UI components
2. **Chaos Engineering**: Test resilience
3. **Contract Testing**: For external APIs
4. **Accessibility Testing**: Ensure inclusive design
5. **Load Testing**: Simulate high-traffic scenarios

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Library](https://testing-library.com/)
- [Stryker Mutator](https://stryker-mutator.io/)
- [SonarQube Rules](https://rules.sonarsource.com/typescript)
- [Railway Testing Guide](https://docs.railway.app/guides/testing)