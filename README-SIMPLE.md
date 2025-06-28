# pup.ai Simple Version

This is the simplified, deployable version of pup.ai - a Slack bot with personality and memory.

## Features

- ✅ Responds to mentions and DMs
- ✅ Remembers conversations using embeddings
- ✅ Has a witty, dog-like personality
- ✅ Simple to deploy and maintain

## Quick Start

### 1. Setup Environment

```bash
cp .env.simple .env
# Edit .env with your credentials
```

### 2. Install Dependencies

```bash
cp package.simple.json package.json
cp tsconfig.simple.json tsconfig.json
npm install
```

### 3. Run Locally

```bash
npm run dev
```

### 4. Deploy to Railway

```bash
# Copy simple configurations
cp railway.simple.toml railway.toml
cp Dockerfile.simple Dockerfile

# Deploy
railway up
```

## Project Structure

```
src/simple/
├── index.ts    # App entry point (52 lines)
├── bot.ts      # Message handling (88 lines)
├── db.ts       # Database operations (128 lines)
├── ai.ts       # OpenAI integration (65 lines)
└── worker.ts   # Background jobs (88 lines)

Total: ~421 lines of code
```

## Environment Variables

Required:
- `SLACK_BOT_TOKEN` - Bot user OAuth token (xoxb-)
- `SLACK_APP_TOKEN` - App-level token (xapp-)
- `SLACK_SIGNING_SECRET` - For request verification
- `OPENAI_API_KEY` - OpenAI API key
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string

Optional:
- `SLACK_BOT_USER_ID` - Bot's user ID (defaults to U07TRRMHGVC)
- `MY_USER_ID` - Your Slack user ID for special handling

## Database Setup

The app will automatically run migrations on startup. Make sure your PostgreSQL database has the pgvector extension available:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## How It Works

1. **Message Reception**: Bot listens to all messages in channels it's in
2. **Storage**: Saves messages to PostgreSQL
3. **Embeddings**: Background worker generates embeddings for semantic search
4. **Response**: When triggered, uses recent messages as context for AI response
5. **Personality**: Maintains a consistent witty, dog-like personality

## Deployment Tips

- Railway will automatically detect the Dockerfile
- Make sure all environment variables are set in Railway
- The health check endpoint is `/health`
- Migrations run automatically on startup

## Troubleshooting

If deployment fails:
1. Check environment variables are set correctly
2. Ensure PostgreSQL has pgvector extension
3. Verify Redis is accessible
4. Check Railway logs: `railway logs`

## Future Enhancements

Only add these if you actually need them:
- User personality profiles
- Conversation summaries  
- More sophisticated memory retrieval
- Rate limiting and caching
- Advanced monitoring

Remember: **Keep it simple!** This version works and deploys reliably.