# Simplified pup.ai v2 Architecture

## Core Philosophy
- Start with the absolute minimum that provides value
- Every added complexity must justify its existence
- Deployment simplicity is non-negotiable
- Features are added incrementally, not all at once

## Phase 1: Minimum Viable Bot (Week 1)

### Features
- Responds to direct mentions and DMs
- Stores all messages in PostgreSQL
- Uses OpenAI to generate responses with last 10 messages as context
- Single personality prompt

### Folder Structure
```
src/
├── index.ts           # Entry point & Slack event handler
├── db.ts              # Database connection & queries
├── ai.ts              # OpenAI integration
└── config.ts          # Environment configuration

migrations/
└── 001_initial.sql    # Create messages table

package.json
.env.example
railway.toml
```

### Database Schema (Minimal)
```sql
-- messages table
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_channel_time ON messages(channel_id, timestamp DESC);
```

### Key Simplifications
- NO background jobs (process synchronously)
- NO Redis/caching layer
- NO embeddings or vector search
- NO user profiles or personality tracking
- NO MCP servers
- Single process deployment

### Deployment
- One Railway service
- One PostgreSQL database
- Four environment variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OPENAI_API_KEY`, `DATABASE_URL`

## Phase 2: Enhanced Context (Week 2-3)

### Added Features
- Track user names for better context
- Time-aware context (last 24 hours)
- Simple personality variations (3 moods)
- Response caching to reduce OpenAI calls

### New Files
```
src/
├── cache.ts           # In-memory LRU cache
├── context.ts         # Context selection logic
└── users.ts           # User name tracking
```

### Database Changes
```sql
-- Add users table
CREATE TABLE users (
  user_id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add response cache
CREATE TABLE response_cache (
  id SERIAL PRIMARY KEY,
  prompt_hash VARCHAR(64) NOT NULL,
  response TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Phase 3: Semantic Memory (Week 4-5)

### Added Features
- Vector embeddings for semantic search
- Background job processing
- User personality profiles
- Conversation threading

### New Structure
```
src/
├── workers/
│   └── embeddings.ts  # Simple background processor
├── memory.ts          # Semantic search
└── personality.ts     # User profiling
```

### Infrastructure Changes
- Add Redis for simple job queue
- Add pgvector extension
- Add embedding column to messages

## Phase 4: Advanced Features (Week 6+)

### Consider Adding (If Needed)
- MCP servers for extensibility
- Conversation summaries
- Complex personality system
- BullMQ for robust job processing
- Monitoring and analytics

## Implementation Guidelines

### 1. Database Migrations
Use simple SQL files with a basic migration runner:
```typescript
// Simple migration runner
async function runMigrations() {
  const files = await fs.readdir('./migrations');
  for (const file of files.sort()) {
    await db.query(await fs.readFile(`./migrations/${file}`, 'utf8'));
  }
}
```

### 2. Error Handling
- Fail gracefully - bot should always respond, even if just "I'm having trouble right now"
- Log errors but don't crash
- Use timeouts for all external calls

### 3. Configuration
```typescript
// config.ts - Single source of truth
export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-3.5-turbo', // Start cheap
  },
  db: {
    connectionString: process.env.DATABASE_URL!,
  },
  app: {
    contextMessageCount: 10,
    cacheTTL: 3600, // 1 hour
  }
};
```

### 4. Deployment Checklist
- [ ] Single `npm start` command
- [ ] Health check endpoint
- [ ] Graceful shutdown
- [ ] Connection pooling
- [ ] Automatic migrations
- [ ] Environment validation

## Phase 1 Implementation Plan

### Day 1: Core Setup
1. Initialize project with TypeScript
2. Set up Slack Bolt app
3. Create basic PostgreSQL connection
4. Implement message storage

### Day 2: AI Integration
1. OpenAI client setup
2. Context retrieval (last N messages)
3. Response generation
4. Basic error handling

### Day 3: Polish & Deploy
1. Environment validation
2. Health check endpoint
3. Graceful shutdown
4. Deploy to Railway
5. Test in real Slack workspace

## Success Metrics
- Bot responds to mentions within 5 seconds
- 99% uptime
- Less than 50MB memory usage
- Single-click deployment
- Less than 500 lines of code in Phase 1

## Anti-Patterns to Avoid
- Don't add caching until you measure need
- Don't add background jobs until sync is too slow
- Don't add complex features until basics are rock solid
- Don't optimize until you have metrics
- Don't add abstractions until you have repetition