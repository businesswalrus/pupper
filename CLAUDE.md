# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is pup.ai v2, a context-aware Slack bot with personality and memory. The bot:
- Maintains conversation memory using PostgreSQL with pgvector embeddings
- Builds user personality profiles over time
- Has an opinionated, humorous personality
- Uses MCP (Model Context Protocol) for extensibility
- Deploys to Railway

## Development Commands

### Project Setup
```bash
npm install
npm run db:migrate    # Run database migrations
npm run db:seed       # Seed initial data (if applicable)
```

### Development
```bash
npm run dev           # Start development server with hot reload
npm run build         # Build TypeScript to JavaScript
npm run start         # Start production server
```

### Code Quality
```bash
npm run lint          # Run ESLint
npm run lint:fix      # Fix auto-fixable ESLint issues
npm run typecheck     # Run TypeScript type checking
npm run test          # Run all tests
npm run test:unit     # Run unit tests only
npm run test:integration  # Run integration tests
```

### Database Operations
```bash
npm run db:create -- migration-name   # Create new migration
npm run db:migrate    # Run pending migrations
npm run db:rollback   # Rollback last migration
npm run db:reset      # Reset database (caution: deletes all data)
```

## Architecture Overview

### Message Processing Pipeline
1. **Slack Event Reception** (`src/bot/handlers/`): All messages in channels where bot is present are captured
2. **Message Storage** (`src/db/queries.ts`): Messages are stored with deduplication logic
3. **Embedding Generation** (`src/workers/embeddings.ts`): Background job generates OpenAI embeddings via BullMQ
4. **Context Analysis** (`src/ai/memory.ts`): When bot needs to respond, it performs semantic search on message history
5. **Response Generation** (`src/ai/personality.ts`): Bot generates contextual responses using personality engine

### Key Components

**Bot Personality System** (`src/ai/personality.ts`):
- Maintains different "moods" based on recent interactions
- Forms opinions about users based on stored interaction history
- Implements contextual humor and callback mechanisms

**Memory Retrieval** (`src/ai/memory.ts`):
- Uses pgvector for semantic similarity search
- Implements conversation threading and context windows
- Prioritizes recent and highly relevant messages

**MCP Integration** (`src/mcp/`):
- PostgreSQL MCP server for database operations
- Brave Search MCP server for web searches
- Custom Slack MCP server for extended Slack operations

**Background Workers** (`src/workers/`):
- BullMQ-based job processing
- Handles embedding generation, summarization, and profile updates
- Implements retry logic and error handling

### Database Schema
The system uses PostgreSQL with pgvector extension:
- `users`: Stores Slack user info and personality profiles (JSONB for flexible attributes)
- `messages`: Stores all messages with vector embeddings (1536 dimensions for OpenAI)
- `conversation_summaries`: Daily/periodic conversation summaries
- `user_interactions`: Tracks relationships between users

### Environment Configuration
Required environment variables:
- `SLACK_BOT_TOKEN`: Bot user OAuth token (xoxb-)
- `SLACK_APP_TOKEN`: App-level token for Socket Mode (xapp-)
- `SLACK_SIGNING_SECRET`: For request verification
- `OPENAI_API_KEY`: For embeddings and AI responses
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection for caching and job queue

### Testing Strategy
- Unit tests mock external services (Slack API, OpenAI, database)
- Integration tests use test database and mock MCP servers
- Use `@slack/bolt/dist/test-helpers` for Slack event mocking

### Railway Deployment
The project includes a `railway.toml` for deployment configuration:
- Automatic database migrations on deploy
- Environment variable injection
- Health check endpoint at `/health`

## Important Implementation Notes

1. **Rate Limiting**: OpenAI API calls are rate-limited using a token bucket algorithm
2. **Message Deduplication**: Messages are deduplicated by `message_ts` to prevent duplicates
3. **Vector Search**: Use cosine similarity for semantic search, with a threshold of 0.7 for relevance
4. **Error Handling**: All async operations should have try-catch blocks with fallback behavior
5. **Memory Context**: Limit context window to 50 most relevant messages to avoid token limits

## MCP Server Details

The project implements Model Context Protocol servers for:
- **PostgreSQL Operations**: CRUD operations on user profiles and message history
- **Brave Search**: Web search integration for current events
- **Slack Extended**: Access to Slack-specific data not available through Bolt.js

MCP servers are initialized in `src/mcp/client.ts` and used throughout the application for extensible functionality.