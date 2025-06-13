# Deployment Guide for pup.ai v2

This guide covers deploying pup.ai v2 to Railway with PostgreSQL, Redis, and all required services.

## Prerequisites

1. Railway account (https://railway.app)
2. Slack App configured with:
   - Bot Token (xoxb-...)
   - App Token (xapp-...)
   - Signing Secret
   - Socket Mode enabled
3. OpenAI API key

## Deployment Steps

### 1. Database Setup

First, deploy PostgreSQL with pgvector extension:

```bash
# In Railway dashboard, add PostgreSQL service
# Then connect to the database and run:
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. Environment Variables

Set the following environment variables in Railway:

```bash
# Slack Configuration (REQUIRED)
SLACKBOTTOKEN=xoxb-your-bot-token
SLACKAPPTOKEN=xapp-your-app-token  
SLACKSIGNINGSECRET=your-signing-secret
MYUSERID=U0XXXXXXXXX  # Bot's Slack user ID

# OpenAI Configuration (REQUIRED)
OPENAPIKEY=sk-your-openai-api-key

# Database (Railway provides DATABASE_URL automatically)
# Redis (Railway provides REDIS_URL automatically)

# Optional Configuration
NODE_ENV=production
PORT=3000  # Railway will override this
LOG_LEVEL=info
```

### 3. Deploy from GitHub

1. Fork/clone this repository to your GitHub account
2. In Railway:
   - Create new project
   - Connect GitHub repository
   - Railway will auto-detect the Dockerfile
   - Deploy will start automatically

### 4. Run Database Migrations

After first deployment:

```bash
# Connect to Railway service
railway run npm run db:migrate
```

### 5. Verify Deployment

1. Check health endpoint: `https://your-app.railway.app/health`
2. Monitor logs in Railway dashboard
3. Verify bot appears online in Slack

## Configuration

### Memory Limits

The bot tracks memory usage. Adjust if needed:

```yaml
# In railway.toml or dashboard
memory: 512  # MB
```

### Worker Configuration

Workers are configured with rate limits:
- Embeddings: 25 concurrent, 1500/min
- Summaries: 2 concurrent, 10/hour  
- Profiles: 3 concurrent, 30/hour

### Monitoring

Monitor these metrics:
- Health endpoint status
- Circuit breaker states
- Worker queue sizes
- Memory usage
- API rate limits

## Troubleshooting

### Bot Not Responding

1. Check health endpoint
2. Verify environment variables
3. Check Slack app configuration
4. Review logs for errors

### Database Connection Issues

1. Ensure pgvector extension is installed
2. Check DATABASE_URL is set
3. Verify migrations have run

### High Memory Usage

1. Check worker queue sizes
2. Review message processing rate
3. Adjust worker concurrency

### OpenAI Rate Limits

The bot includes:
- Automatic retry with backoff
- Circuit breaker protection
- Rate limit handling

If hitting limits frequently:
1. Reduce worker concurrency
2. Increase retry delays
3. Consider upgrading OpenAI plan

## Maintenance

### Updating the Bot

```bash
git push origin main
# Railway auto-deploys on push
```

### Database Backups

Railway provides automatic backups. Additionally:

```bash
# Manual backup
pg_dump $DATABASE_URL > backup.sql
```

### Monitoring Logs

```bash
# View logs
railway logs

# Stream logs
railway logs -f
```

## Security Notes

- Never commit secrets to git
- Use Railway's environment variables
- Rotate API keys periodically
- Monitor for unusual activity

## Support

- Railway Discord: https://discord.gg/railway
- Issues: https://github.com/yourusername/pup-ai-v2/issues