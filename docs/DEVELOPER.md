# Developer Guide

Welcome to pup.ai v2! This guide will help you get up and running with development in under an hour.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Development Workflow](#development-workflow)
4. [Project Structure](#project-structure)
5. [Common Tasks](#common-tasks)
6. [Debugging](#debugging)
7. [Testing](#testing)
8. [Best Practices](#best-practices)

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js 18+**: We recommend using [nvm](https://github.com/nvm-sh/nvm)
  ```bash
  nvm install 18
  nvm use 18
  ```

- **PostgreSQL 16+**: With pgvector extension
  ```bash
  # macOS
  brew install postgresql@16
  brew install pgvector
  
  # Ubuntu/Debian
  sudo apt install postgresql-16 postgresql-16-pgvector
  ```

- **Redis 7+**: For caching and job queues
  ```bash
  # macOS
  brew install redis
  
  # Ubuntu/Debian
  sudo apt install redis-server
  ```

- **Git**: For version control
- **VS Code**: Recommended editor with extensions

## Initial Setup

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/businesswalrus/pupper.git
cd pupper

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env
```

### 2. Configure Environment

Edit `.env` with your credentials:

```bash
# Required: Slack App Configuration
SLACK_BOT_TOKEN=xoxb-...      # From Slack App OAuth page
SLACK_APP_TOKEN=xapp-...      # From Slack App Socket Mode page
SLACK_SIGNING_SECRET=...      # From Slack App Basic Info page

# Required: Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pupper
REDIS_URL=redis://localhost:6379

# Required: AI Service
OPENAI_API_KEY=sk-...         # From OpenAI Dashboard

# Optional but recommended
LOG_LEVEL=debug
NODE_ENV=development
FEATURE_FLAGS=search,profiling,debug_mode
```

### 3. Database Setup

```bash
# Create databases
createdb pupper
createdb pupper_test

# Enable pgvector extension
psql -d pupper -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql -d pupper_test -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
npm run db:migrate

# Seed sample data
npm run db:seed
```

### 4. Slack App Configuration

1. Create a new Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode in the app settings
3. Add Bot Token Scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `users:read`
4. Install the app to your workspace
5. Copy the tokens to your `.env` file

### 5. Start Development

```bash
# Start the development server with hot reloading
npm run dev

# In another terminal, monitor logs
tail -f logs/*.log

# Optional: Start Docker services instead
make docker-dev
```

## Development Workflow

### Daily Workflow

1. **Start your day**
   ```bash
   git pull origin main
   npm install
   npm run db:migrate
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make changes with hot reloading**
   ```bash
   npm run dev
   ```

4. **Run quality checks before committing**
   ```bash
   npm run quality
   ```

5. **Commit with conventional commits**
   ```bash
   npm run commit
   # or
   git commit -m "feat: add awesome feature"
   ```

### Code Quality Tools

- **ESLint**: Automatically runs on save in VS Code
- **Prettier**: Formats code on save
- **TypeScript**: Type checking on build
- **Husky**: Pre-commit hooks for quality checks

## Project Structure

```
pupper/
├── src/
│   ├── ai/                 # AI and ML components
│   │   ├── memory.ts       # Memory retrieval system
│   │   ├── personality.ts  # Personality engine
│   │   └── prompts.ts      # Prompt templates
│   ├── bot/                # Slack bot handlers
│   │   ├── app.ts          # Bot initialization
│   │   ├── handlers/       # Event handlers
│   │   └── commands/       # Slash commands
│   ├── db/                 # Database layer
│   │   ├── connection.ts   # Database setup
│   │   └── repositories/   # Data access patterns
│   ├── mcp/                # Model Context Protocol
│   ├── services/           # External services
│   ├── utils/              # Shared utilities
│   └── workers/            # Background jobs
├── migrations/             # Database migrations
├── scripts/                # Utility scripts
├── docs/                   # Documentation
└── tests/                  # Test files
```

### Key Files to Know

- `src/index.ts` - Application entry point
- `src/bot/app.ts` - Bot configuration
- `src/ai/memory.ts` - Memory system core
- `src/ai/personality.ts` - Response generation
- `src/utils/config.ts` - Configuration management
- `src/workers/queues.ts` - Job queue setup

## Common Tasks

### Adding a New Slack Event Handler

1. Create handler in `src/bot/handlers/`:
```typescript
// src/bot/handlers/reaction.ts
import { App } from '@slack/bolt';

export function registerReactionHandlers(app: App) {
  app.event('reaction_added', async ({ event, client }) => {
    // Your handler logic
  });
}
```

2. Register in `src/bot/app.ts`:
```typescript
import { registerReactionHandlers } from './handlers/reaction';

registerReactionHandlers(app);
```

### Adding a New Repository Method

1. Add to repository interface:
```typescript
// src/db/repositories/userRepository.ts
export interface IUserRepository {
  // Existing methods...
  findByEmail(email: string): Promise<IUser | null>;
}
```

2. Implement the method:
```typescript
async findByEmail(email: string): Promise<IUser | null> {
  const result = await this.pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0] || null;
}
```

### Adding a Feature Flag

1. Add to enum in `src/utils/featureFlags.ts`:
```typescript
export enum FeatureFlag {
  // Existing flags...
  MY_NEW_FEATURE = 'my_new_feature',
}
```

2. Add configuration:
```typescript
[FeatureFlag.MY_NEW_FEATURE]: {
  name: FeatureFlag.MY_NEW_FEATURE,
  description: 'My awesome new feature',
  defaultValue: false,
  rolloutPercentage: 10, // Optional gradual rollout
}
```

3. Use in code:
```typescript
if (isFeatureEnabled(FeatureFlag.MY_NEW_FEATURE, userId)) {
  // Feature-specific code
}
```

## Debugging

### VS Code Debugging

1. Set breakpoints in your code
2. Press `F5` or use Debug panel
3. Select "Debug Bot" configuration

### Chrome DevTools

```bash
# Start with inspector
npm run debug

# Open Chrome and navigate to:
chrome://inspect

# Click "inspect" on the Node.js process
```

### Logging

```typescript
import { logger } from '@utils/logger';

// Different log levels
logger.debug('Detailed debug info', { userId, messageId });
logger.info('Normal operation', { action: 'message_processed' });
logger.warn('Warning condition', { warning: 'rate_limit_approaching' });
logger.error('Error occurred', { error, stack: error.stack });
```

### Database Query Debugging

Enable query logging in development:
```typescript
// src/db/connection.ts
const pool = new Pool({
  connectionString: DATABASE_URL,
  log: (msg) => logger.debug('SQL:', msg),
});
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test src/ai/memory.test.ts

# Run with coverage
npm run test:cov

# Run in watch mode
npm run test:watch

# Debug a test
npm run test:debug
```

### Writing Tests

Example unit test:
```typescript
// src/ai/__tests__/memory.test.ts
import { MemoryService } from '../memory';

describe('MemoryService', () => {
  let service: MemoryService;
  
  beforeEach(() => {
    service = new MemoryService();
  });
  
  it('should retrieve relevant context', async () => {
    const context = await service.getRelevantContext({
      query: 'test query',
      userId: 'U123',
      limit: 10,
    });
    
    expect(context.messages).toHaveLength(10);
    expect(context.userProfile).toBeDefined();
  });
});
```

### Testing Best Practices

1. **Mock external dependencies**
   ```typescript
   jest.mock('@utils/openai');
   ```

2. **Use test fixtures**
   ```typescript
   import { createMockUser, createMockMessage } from '@test/fixtures';
   ```

3. **Test error cases**
   ```typescript
   await expect(service.process(invalid)).rejects.toThrow();
   ```

## Best Practices

### Code Style

1. **Use TypeScript strictly**
   - Enable all strict checks
   - Avoid `any` types
   - Define interfaces for data shapes

2. **Follow naming conventions**
   - Interfaces: `IUserProfile`
   - Types: `MessageType`
   - Enums: `BotMood`
   - Files: `camelCase.ts`

3. **Organize imports**
   ```typescript
   // Node modules
   import { promisify } from 'util';
   
   // External packages
   import { App } from '@slack/bolt';
   
   // Internal modules
   import { logger } from '@utils/logger';
   
   // Types
   import type { IUser } from '@db/types';
   ```

### Performance

1. **Use connection pooling**
   ```typescript
   const pool = new Pool({ max: 20 });
   ```

2. **Cache frequently accessed data**
   ```typescript
   const cached = await redis.get(`user:${userId}`);
   if (cached) return JSON.parse(cached);
   ```

3. **Batch operations**
   ```typescript
   await messageRepo.insertBatch(messages);
   ```

### Security

1. **Validate all inputs**
   ```typescript
   const clean = sanitizeInput(userInput);
   ```

2. **Use parameterized queries**
   ```typescript
   await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
   ```

3. **Never log sensitive data**
   ```typescript
   logger.info('User authenticated', { userId }); // Not email/token
   ```

## Getting Help

- **Documentation**: Check `/docs` folder
- **Code Comments**: Well-documented codebase
- **Team**: Reach out in #dev-pupper Slack channel
- **Issues**: File on GitHub with reproduction steps

## Next Steps

1. Run the bot locally and send it a message
2. Explore the codebase structure
3. Pick up a "good first issue" from GitHub
4. Join our weekly dev sync meeting

Happy coding! 🐕