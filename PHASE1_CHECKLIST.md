# Phase 1 Implementation Checklist

## Pre-Development (30 minutes)
- [ ] Create Slack app at api.slack.com
- [ ] Generate bot token (xoxb-)
- [ ] Generate app token (xapp-)
- [ ] Enable Socket Mode
- [ ] Create OpenAI account and get API key
- [ ] Set up PostgreSQL database (local or cloud)

## Development Setup (15 minutes)
- [ ] Copy simplified files to main structure
  ```bash
  cp package.simple.json package.json
  cp tsconfig.simple.json tsconfig.json
  cp railway.simple.toml railway.toml
  ```
- [ ] Install dependencies: `npm install`
- [ ] Create `.env` from `.env.simple.example`
- [ ] Fill in all environment variables

## Core Implementation (2 hours)
- [ ] Test database connection
  ```bash
  npm run db:migrate
  ```
- [ ] Start development server
  ```bash
  npm run dev
  ```
- [ ] Test bot responds to mentions
- [ ] Test bot responds to DMs
- [ ] Verify messages are stored in database
- [ ] Check health endpoint: `curl localhost:3000/health`

## Slack Configuration (30 minutes)
- [ ] Add OAuth scopes:
  - [ ] app_mentions:read
  - [ ] channels:history  
  - [ ] chat:write
  - [ ] im:history
  - [ ] im:read
  - [ ] im:write
- [ ] Subscribe to events:
  - [ ] app_mention
  - [ ] message.im
- [ ] Install app to workspace
- [ ] Add bot to test channel

## Local Testing (30 minutes)
- [ ] Send mention to bot
- [ ] Send DM to bot
- [ ] Check multiple messages for context
- [ ] Test error handling (disconnect DB)
- [ ] Monitor logs for issues

## Deployment (30 minutes)
- [ ] Install Railway CLI
- [ ] Create new Railway project
- [ ] Add PostgreSQL database
- [ ] Set environment variables in Railway
- [ ] Deploy: `railway up`
- [ ] Test production health check
- [ ] Test bot in production

## Post-Deployment (15 minutes)
- [ ] Document Slack app credentials
- [ ] Set up basic monitoring
- [ ] Create runbook for common issues
- [ ] Share bot with team for testing

## Success Criteria
- [ ] Bot responds within 5 seconds
- [ ] All messages are stored
- [ ] Context includes last 10 messages
- [ ] Zero crashes in first 24 hours
- [ ] Deployment takes <5 minutes

## Total Time: ~4 hours

## Next Steps
1. Run for 1 week
2. Collect metrics
3. Gather user feedback
4. Plan Phase 2 based on data

## Emergency Rollback
If issues arise:
```bash
# Rollback to previous deployment
railway rollback

# Or disable bot temporarily
# Remove SLACK_BOT_TOKEN from Railway
railway vars remove SLACK_BOT_TOKEN
railway deploy
```

Remember: Perfect is the enemy of good. Ship Phase 1, learn, iterate.