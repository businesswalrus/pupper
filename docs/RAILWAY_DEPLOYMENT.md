# Railway Deployment Guide for pup.ai v2

This guide provides a bulletproof deployment strategy specifically optimized for Railway's platform.

## Quick Start

1. **Validate your environment:**
   ```bash
   node scripts/validate-railway-env.js
   ```

2. **Deploy to Railway:**
   ```bash
   railway up
   ```

3. **Monitor deployment:**
   ```bash
   railway logs
   ```

## Railway Platform Characteristics

### Key Differences from Other Platforms

1. **Build System**
   - Railway uses Nixpacks by default but respects Dockerfile when present
   - Aggressive build caching can cause issues with package-lock.json
   - Environment variables are injected at build time

2. **File System**
   - Ephemeral filesystem - data doesn't persist between deployments
   - No write access to certain directories
   - Must use external storage for persistent data

3. **Networking**
   - Automatic HTTPS with custom domains
   - Internal networking between services
   - Health checks run from Railway infrastructure

4. **Resource Management**
   - Memory limits enforced at container level
   - Automatic scaling based on plan
   - CPU throttling on lower-tier plans

## Deployment Architecture

### Dockerfile Strategy

We use `Dockerfile.railway.v2` which is optimized for Railway:

```dockerfile
# Single-stage build (more reliable on Railway)
FROM node:20-alpine

# Railway-specific optimizations:
# 1. Handle missing package-lock.json gracefully
# 2. Use npm install fallback for flexibility
# 3. Aggressive cleanup to reduce image size
# 4. Non-root user for security
```

### Key Design Decisions

1. **Single-stage build**: More reliable than multi-stage on Railway
2. **Flexible dependency installation**: Handles both `npm ci` and `npm install`
3. **Health check script**: Custom script for detailed status reporting
4. **Startup script**: Railway-specific initialization sequence

## Environment Configuration

### Required Environment Variables

Set these in Railway dashboard under the Variables tab:

```bash
# Database (Railway PostgreSQL)
DATABASE_URL=postgresql://user:pass@host:5432/railway

# Redis (Railway Redis)
REDIS_URL=redis://default:pass@host:6379

# Slack Credentials
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# OpenAI
OPENAI_API_KEY=sk-your-api-key
```

### Optional Environment Variables

```bash
# Control migrations
SKIP_MIGRATIONS=false

# Node.js memory (set via railway.toml)
NODE_OPTIONS=--max-old-space-size=512

# Logging level
LOG_LEVEL=info
```

### Railway-Specific Variables

Railway automatically provides:
- `RAILWAY_ENVIRONMENT`: Current environment name
- `RAILWAY_STATIC_URL`: Public URL for your service
- `PORT`: Port to bind to (usually 3000)

## Pre-Deployment Checklist

### Local Testing

1. **Build Docker image locally:**
   ```bash
   docker build -f Dockerfile.railway.v2 -t pupper-test .
   ```

2. **Run with test environment:**
   ```bash
   docker run -p 3000:3000 \
     -e DATABASE_URL=your-test-db \
     -e REDIS_URL=your-test-redis \
     pupper-test
   ```

3. **Test health endpoint:**
   ```bash
   curl http://localhost:3000/health
   ```

### Validation Steps

- [ ] Run `node scripts/validate-railway-env.js`
- [ ] Ensure all environment variables are set in Railway
- [ ] Verify database migrations work locally
- [ ] Check Docker build succeeds
- [ ] Test health endpoint responds correctly

## Deployment Process

### First-Time Setup

1. **Create Railway project:**
   ```bash
   railway login
   railway init
   ```

2. **Add PostgreSQL and Redis:**
   ```bash
   railway add postgresql
   railway add redis
   ```

3. **Set environment variables:**
   ```bash
   railway variables set SLACK_BOT_TOKEN=xoxb-...
   railway variables set SLACK_APP_TOKEN=xapp-...
   # ... set all required variables
   ```

4. **Deploy:**
   ```bash
   railway up
   ```

### Subsequent Deployments

1. **Update BUILD_TIMESTAMP in railway.toml** (forces cache refresh)

2. **Deploy:**
   ```bash
   railway up
   ```

3. **Monitor logs:**
   ```bash
   railway logs -f
   ```

## Troubleshooting

### Common Issues and Solutions

#### 1. Package-lock.json Conflicts

**Problem**: Build fails with npm errors about package-lock.json

**Solution**: Our Dockerfile removes and regenerates package-lock.json:
```dockerfile
RUN rm -f package-lock.json npm-shrinkwrap.json
```

#### 2. TypeScript Path Aliases Not Resolving

**Problem**: Runtime errors about missing modules (@bot/*, @ai/*, etc.)

**Solution**: We use tsconfig-paths in production:
```javascript
// In start-railway.js
require('tsconfig-paths/register');
```

#### 3. Migration Failures

**Problem**: Database migrations fail during startup

**Solution**: 
- Check DATABASE_URL is correct
- Verify database is accessible
- Use `SKIP_MIGRATIONS=true` to debug
- Run migrations manually: `railway run npm run db:migrate`

#### 4. Memory Issues

**Problem**: Application crashes with heap errors

**Solution**: Configured in railway.toml:
```toml
[build.args]
NODE_OPTIONS = "--max-old-space-size=1024"

[deploy]
memoryLimit = "1024"
```

#### 5. Health Check Timeouts

**Problem**: Deployment marked as failed due to health check

**Solution**: Extended timeouts in railway.toml:
```toml
healthcheckTimeout = 30
startCommand = "node scripts/start-railway.js"
```

### Debug Commands

```bash
# View current environment variables
railway variables

# Run commands in Railway environment
railway run npm run db:migrate
railway run node scripts/test-connection.js

# SSH into running container (if available on your plan)
railway shell

# View deployment logs
railway logs --tail 100
```

## Rollback Strategy

### Automatic Rollback

Railway automatically rolls back if:
- Health checks fail continuously
- Container crashes repeatedly
- Build fails

### Manual Rollback

1. **Via Dashboard:**
   - Go to your project on railway.app
   - Click on the service
   - Go to Settings → Deployments
   - Click "Redeploy" on a previous successful deployment

2. **Via CLI:**
   ```bash
   # List recent deployments
   railway deployments
   
   # Rollback to specific deployment
   railway redeploy <deployment-id>
   ```

## Performance Optimization

### Railway-Specific Optimizations

1. **Reduce Cold Starts:**
   - Keep image size small
   - Minimize dependencies
   - Use health checks to keep container warm

2. **Optimize Build Times:**
   - Use `.dockerignore` effectively
   - Cache npm dependencies properly
   - Avoid unnecessary file copies

3. **Memory Management:**
   - Set appropriate Node.js memory limits
   - Use connection pooling for databases
   - Implement proper cleanup in shutdown handlers

### Monitoring

1. **Railway Dashboard:**
   - CPU and memory usage
   - Request metrics
   - Error rates

2. **Application Logs:**
   ```bash
   railway logs -f | grep ERROR
   railway logs -f | grep "Health check"
   ```

3. **Custom Metrics:**
   - Implement `/metrics` endpoint
   - Use Railway's metrics API
   - Set up external monitoring (Datadog, New Relic)

## Best Practices

### Do's

- ✅ Always validate before deploying
- ✅ Use Railway's environment variables
- ✅ Implement comprehensive health checks
- ✅ Handle database connections gracefully
- ✅ Log startup progress for debugging
- ✅ Use Railway CLI for deployments
- ✅ Monitor logs during deployment

### Don'ts

- ❌ Don't rely on filesystem for storage
- ❌ Don't hardcode environment values
- ❌ Don't skip health check implementation
- ❌ Don't ignore memory limits
- ❌ Don't use nodemon or dev tools in production
- ❌ Don't ignore build cache issues

## Security Considerations

1. **Environment Variables:**
   - Never commit secrets to git
   - Use Railway's variable groups for different environments
   - Rotate credentials regularly

2. **Container Security:**
   - Run as non-root user
   - Use official base images
   - Keep dependencies updated

3. **Network Security:**
   - Use Railway's internal networking for service communication
   - Implement rate limiting
   - Validate all inputs

## Disaster Recovery

### Backup Strategy

1. **Database:**
   ```bash
   # Create backup
   railway run pg_dump $DATABASE_URL > backup.sql
   
   # Restore backup
   railway run psql $DATABASE_URL < backup.sql
   ```

2. **Environment:**
   ```bash
   # Export all variables
   railway variables > env-backup.txt
   ```

### Recovery Steps

1. **Complete Failure:**
   - Create new Railway project
   - Restore database from backup
   - Set environment variables
   - Deploy known good commit

2. **Partial Failure:**
   - Identify failing component
   - Use `SKIP_MIGRATIONS=true` if needed
   - Deploy with increased logging
   - Fix issues incrementally

## Conclusion

This deployment strategy is designed to handle Railway's unique characteristics and provide reliable, reproducible deployments. Always test changes locally first and monitor deployments closely.

For additional help:
- Railway Documentation: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Project Issues: https://github.com/businesswalrus/pupper/issues