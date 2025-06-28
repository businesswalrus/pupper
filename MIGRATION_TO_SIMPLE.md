# Migration Guide: Complex → Simple pup.ai

This guide helps you transition from the over-engineered version to the simplified version.

## Step 1: Backup Current Data

```bash
# Backup database
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Note down environment variables
env | grep -E "(SLACK|OPENAI|DATABASE|REDIS)" > current_env.txt
```

## Step 2: Prepare New Environment

1. Copy essential environment variables:
```bash
cp .env.simple.example .env.simple
# Edit .env.simple with your actual values
```

2. Update package.json scripts to use simple versions:
```bash
# In package.json, update these scripts:
"dev": "tsx watch src/index.simple.ts",
"build": "tsc -p tsconfig.simple.json",
"start": "node dist/index.simple.js"
```

## Step 3: Build and Test Locally

```bash
# Install only needed dependencies
npm install @slack/bolt pg pgvector ioredis bullmq openai express dotenv

# Build the simple version
npm run build

# Test locally
npm run dev
```

## Step 4: Deploy to Railway

1. Update Railway environment variables - remove all except:
   - SLACK_BOT_TOKEN
   - SLACK_APP_TOKEN
   - SLACK_SIGNING_SECRET
   - SLACK_BOT_USER_ID
   - DATABASE_URL
   - REDIS_URL
   - OPENAI_API_KEY

2. Update Dockerfile reference:
```toml
# In railway.toml
[deploy]
dockerfilePath = "Dockerfile.simple"
```

3. Push changes:
```bash
git add .
git commit -m "Simplify pup.ai to core functionality"
git push
```

## Step 5: Verify Deployment

1. Check Railway logs for clean startup
2. Test bot responds to @mentions
3. Verify messages are being stored
4. Check embeddings are being generated

## What You Lose (Temporarily)

- Security features (can add back gradually)
- Advanced monitoring
- Complex caching strategies
- Multiple worker types
- Session management

## What You Gain

- **Deployability** - It actually works!
- **Simplicity** - Easy to debug
- **Speed** - Faster startup, less overhead
- **Maintainability** - Clear, understandable code
- **Focus** - Does core job well

## Rollback Plan

If needed, the original files are still there:
- Use `src/index.ts` instead of `src/index.simple.ts`
- Use `Dockerfile.production` instead of `Dockerfile.simple`
- Restore all environment variables

## Next Steps After Migration

Once stable, gradually add back only what you need:
1. Basic rate limiting (if getting hit hard)
2. Better error handling
3. Simple monitoring
4. Improved semantic search

Remember: Every feature has a cost. Only add what provides real value!