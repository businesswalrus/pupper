# Contributing to pup.ai v2

Thank you for your interest in contributing to pup.ai! We welcome contributions from the community and are grateful for any help you can provide.

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [How to Contribute](#how-to-contribute)
4. [Development Process](#development-process)
5. [Coding Standards](#coding-standards)
6. [Commit Guidelines](#commit-guidelines)
7. [Pull Request Process](#pull-request-process)
8. [Testing Requirements](#testing-requirements)

## Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please:

- Be respectful and considerate
- Welcome newcomers and help them get started
- Focus on constructive criticism
- Respect differing viewpoints and experiences

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/pupper.git
   cd pupper
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/businesswalrus/pupper.git
   ```
4. Follow the setup instructions in [DEVELOPER.md](./DEVELOPER.md)

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce**
- **Expected behavior**
- **Actual behavior**
- **Screenshots** (if applicable)
- **Environment details** (OS, Node version, etc.)

Example:
```markdown
**Bug**: Bot crashes when processing emoji reactions

**Steps to reproduce**:
1. React to any message with 🎉 emoji
2. Bot attempts to process reaction
3. Application crashes with error

**Expected**: Bot should acknowledge reaction
**Actual**: Application crashes with "undefined is not a function"

**Environment**:
- Node.js: 18.17.0
- OS: macOS 13.5
- PostgreSQL: 16.1
```

### Suggesting Features

Feature requests are welcome! Please include:

- **Use case**: Why is this feature needed?
- **Proposed solution**: How should it work?
- **Alternatives considered**: Other approaches you've thought about
- **Additional context**: Mockups, examples, etc.

### Code Contributions

1. **Find an issue**: Look for issues labeled `good first issue` or `help wanted`
2. **Comment on the issue**: Let us know you're working on it
3. **Create a branch**: Use descriptive names like `feature/add-reaction-handler`
4. **Make your changes**: Follow our coding standards
5. **Write tests**: Ensure your changes are tested
6. **Submit a PR**: Link to the issue you're addressing

## Development Process

### 1. Branch Naming

Use descriptive branch names:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test additions/updates
- `chore/` - Maintenance tasks

Examples:
```bash
git checkout -b feature/add-sentiment-analysis
git checkout -b fix/memory-leak-in-worker
git checkout -b docs/update-api-reference
```

### 2. Development Workflow

```bash
# Sync with upstream
git fetch upstream
git checkout main
git merge upstream/main

# Create feature branch
git checkout -b feature/your-feature

# Make changes and commit
npm run dev  # Development with hot reload
npm test     # Run tests
npm run quality  # Quality checks

# Push to your fork
git push origin feature/your-feature
```

### 3. Keeping Your Fork Updated

```bash
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
```

## Coding Standards

### TypeScript Guidelines

1. **Use strict mode**
   ```typescript
   // tsconfig.json should have:
   "strict": true
   ```

2. **Define interfaces for data structures**
   ```typescript
   interface IUserMessage {
     id: string;
     userId: string;
     text: string;
     timestamp: Date;
   }
   ```

3. **Avoid `any` type**
   ```typescript
   // Bad
   function process(data: any) { }
   
   // Good
   function process(data: IUserMessage) { }
   ```

4. **Use enums for constants**
   ```typescript
   enum MessageType {
     TEXT = 'text',
     IMAGE = 'image',
     THREAD = 'thread'
   }
   ```

### Code Organization

1. **One class/interface per file**
2. **Group related functionality**
3. **Keep functions small and focused**
4. **Use meaningful variable names**

### Error Handling

```typescript
// Always handle errors appropriately
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  logger.error('Operation failed', { error, context });
  throw new CustomError('Operation failed', error);
}
```

### Documentation

1. **Document complex logic**
   ```typescript
   /**
    * Calculates similarity between two messages using cosine similarity.
    * Returns a value between 0 (no similarity) and 1 (identical).
    * 
    * @param embedding1 - First message embedding vector
    * @param embedding2 - Second message embedding vector
    * @returns Similarity score between 0 and 1
    */
   function calculateSimilarity(embedding1: number[], embedding2: number[]): number {
     // Implementation
   }
   ```

2. **Use JSDoc for public APIs**
3. **Include examples in comments**

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):

### Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test additions/modifications
- `build`: Build system changes
- `ci`: CI configuration changes
- `chore`: Other changes

### Examples

```bash
# Feature
git commit -m "feat(memory): add semantic search with pgvector"

# Bug fix
git commit -m "fix(bot): handle undefined user in message handler"

# Documentation
git commit -m "docs(api): update response format documentation"

# With body
git commit -m "feat(personality): implement mood-based responses

- Add mood tracking system
- Integrate sentiment analysis
- Update response generation logic

Closes #123"
```

### Using Commitizen

For interactive commit message creation:
```bash
npm run commit
```

## Pull Request Process

### Before Submitting

1. **Update documentation** if needed
2. **Add tests** for new functionality
3. **Run quality checks**:
   ```bash
   npm run quality
   ```
4. **Update CHANGELOG** if significant changes

### PR Template

When creating a PR, include:

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex logic
- [ ] Documentation updated
- [ ] No new warnings

## Related Issues
Closes #123
```

### Review Process

1. **Automated checks** must pass
2. **Code review** by at least one maintainer
3. **Address feedback** promptly
4. **Squash commits** if requested

## Testing Requirements

### Test Coverage

- New features must include tests
- Bug fixes should include regression tests
- Maintain >80% coverage on critical paths

### Test Structure

```typescript
describe('MemoryService', () => {
  describe('getRelevantContext', () => {
    it('should return relevant messages', async () => {
      // Arrange
      const query = 'test query';
      const expectedMessages = createMockMessages();
      
      // Act
      const result = await service.getRelevantContext(query);
      
      // Assert
      expect(result.messages).toEqual(expectedMessages);
    });
    
    it('should handle errors gracefully', async () => {
      // Test error cases
    });
  });
});
```

### Testing Best Practices

1. **Test behavior, not implementation**
2. **Use descriptive test names**
3. **Keep tests independent**
4. **Mock external dependencies**
5. **Test edge cases**

## Recognition

Contributors will be:
- Listed in our CONTRIBUTORS.md file
- Mentioned in release notes
- Given credit in relevant documentation

## Questions?

- Check existing issues and PRs
- Ask in discussions
- Reach out on our Slack channel

Thank you for contributing to pup.ai! 🐕