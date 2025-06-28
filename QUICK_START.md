# Quick Start Guide - Simplified pup.ai v2

## Overview
This is the dramatically simplified version of pup.ai v2. It's designed to be deployed in minutes, not hours.

## Phase 1 Setup (Current)

### 1. Prerequisites
- Node.js 18+
- PostgreSQL database
- Slack workspace with a bot app
- OpenAI API key

### 2. Local Development
```bash
# Copy the simplified files
cp package.simple.json package.json
cp tsconfig.simple.json tsconfig.json
cp railway.simple.toml railway.toml
cp .env.simple.example .env

# Install dependencies
npm install

# Set up your .env file with real values
# Edit .env with your actual tokens

# Run database migration
npm run db:migrate

# Start development server
npm run dev
```

### 3. Slack App Configuration
1. Create a new Slack app at api.slack.com
2. Enable Socket Mode
3. Add these OAuth scopes:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
4. Subscribe to events:
   - `app_mention`
   - `message.im`
5. Install to workspace

### 4. Deploy to Railway
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and initialize
railway login
railway init

# Link PostgreSQL
railway add

# Deploy
railway up
```

## What You Get
- A bot that responds to @mentions and DMs
- Stores all messages for context
- Uses last 10 messages for context
- Simple, reliable, fast

## Phase 2 Upgrades (When Ready)
1. Add user name tracking
2. Implement simple caching
3. Add time-based context windows
4. Introduce personality variations

## Phase 3 & Beyond
See SIMPLIFIED_ARCHITECTURE.md for the full roadmap

## Monitoring
- Check `/health` endpoint for status
- Railway provides logs and metrics
- PostgreSQL queries are logged

## Common Issues

### Bot not responding?
1. Check Socket Mode is enabled
2. Verify bot is in the channel
3. Check Railway logs for errors

### Slow responses?
- Normal in Phase 1 (no caching)
- Phase 2 adds response caching
- Consider upgrading OpenAI model

### Database errors?
- Ensure migrations ran (`npm run db:migrate`)
- Check DATABASE_URL is correct
- Verify PostgreSQL is accessible

## Keep It Simple
Remember: This is Phase 1. It's meant to be simple. Resist the urge to add features until the basics are rock solid.