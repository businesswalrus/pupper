# pup.ai v2 - Simplified Version

A witty Slack bot with memory, stripped down to its essential features.

## Core Features

1. **Listens to all messages** in channels where bot is present
2. **Stores messages** with vector embeddings for semantic search
3. **Responds when @mentioned** with contextual, personality-driven responses
4. **Remembers past conversations** using pgvector similarity search
5. **Maintains personality** - witty, sarcastic, but helpful

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL with pgvector extension
- Redis
- Slack app with Socket Mode enabled
- OpenAI API key

### Environment Variables

Copy `.env.simple.example` to `.env` and fill in your values:

```bash
cp .env.simple.example .env
```

### Database Setup

1. Create database with pgvector:
```sql
CREATE DATABASE pupai;
\c pupai;
CREATE EXTENSION vector;
```

2. Run migrations:
```bash
npm run db:migrate
```

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev
```

### Production Deployment

```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

### Docker Deployment

```bash
# Build image
docker build -f Dockerfile.simple -t pup-ai-simple .

# Run container
docker run -p 3000:3000 --env-file .env pup-ai-simple
```

## Simplified Architecture

```
Slack → Bot → PostgreSQL (messages + embeddings)
          ↓
       OpenAI (responses)
          ↓
       Redis (job queue)
```

## What Was Removed

- All security features (GDPR, audit logging, encryption)
- Complex worker system (kept only embedding worker)
- Advanced AI features (fact-checking, cost tracking)
- Database optimizations and monitoring
- TypeScript path aliases
- Multi-stage Docker builds
- Session management
- All enterprise features

## Why It's Better

1. **Deployable** - Simple single-stage Docker, no complex startup
2. **Maintainable** - Clear, simple code without abstractions
3. **Debuggable** - Easy to understand what's happening
4. **Fast** - No overhead from unnecessary features
5. **Focused** - Does one thing well: being a witty Slack bot

## Next Steps

Once this simplified version is working, you can gradually add back features:
1. Better semantic search with pgvector
2. Scheduled summarization
3. User profiling
4. Rate limiting
5. Monitoring

But only add what you actually need!