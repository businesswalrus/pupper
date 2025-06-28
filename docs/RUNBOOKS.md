# pup.ai v2 Operational Runbooks

## Table of Contents
1. [High Error Rate](#runbook-high-error-rate)
2. [Database Connection Pool Exhaustion](#runbook-database-pool-exhaustion)
3. [Memory Pressure](#runbook-memory-pressure)
4. [Queue Backlog](#runbook-queue-backlog)
5. [Pod Restarts](#runbook-pod-restarts)
6. [Slack API Rate Limiting](#runbook-slack-rate-limiting)
7. [OpenAI API Failures](#runbook-openai-failures)
8. [Redis Connection Issues](#runbook-redis-connection-issues)
9. [Disk Space Issues](#runbook-disk-space-issues)
10. [Certificate Expiration](#runbook-certificate-expiration)

---

## Runbook: High Error Rate

### Alert Details
- **Alert Name**: PupAIHighErrorRate
- **Severity**: Critical
- **Threshold**: Error rate > 5% for 5 minutes

### Impact
- Users may experience failures when interacting with the bot
- Messages may not be processed or responded to
- Data loss possible if errors are in the storage layer

### Detection
```bash
# Check current error rate
kubectl exec -n pup-ai deployment/pup-ai -- curl -s localhost:9090/metrics | grep http_requests_total

# View recent errors in logs
kubectl logs -n pup-ai -l app=pup-ai --since=10m | grep ERROR

# Check error distribution by type
kubectl logs -n pup-ai -l app=pup-ai --since=1h | jq -r '.error.name' | sort | uniq -c
```

### Diagnosis Steps
1. **Identify error source**:
   ```bash
   # Group errors by component
   kubectl logs -n pup-ai -l app=pup-ai --since=10m | jq -r '.metadata.component' | sort | uniq -c
   
   # Check specific error messages
   kubectl logs -n pup-ai -l app=pup-ai --since=10m | jq -r 'select(.level=="error") | .message'
   ```

2. **Check external dependencies**:
   ```bash
   # Database health
   kubectl exec -n pup-ai deployment/pup-ai -- pg_isready -h $DB_HOST
   
   # Redis health
   kubectl exec -n pup-ai deployment/pup-ai -- redis-cli -h $REDIS_HOST ping
   
   # Slack API status
   curl -s https://status.slack.com/api/v2.0.0/current | jq
   ```

3. **Resource constraints**:
   ```bash
   # CPU and memory usage
   kubectl top pods -n pup-ai
   
   # Check for OOM kills
   kubectl describe pods -n pup-ai | grep -i "OOMKilled"
   ```

### Resolution Steps

#### Quick Mitigation
1. **Scale up pods** (if resource-related):
   ```bash
   kubectl scale deployment pup-ai --replicas=10 -n pup-ai
   ```

2. **Enable circuit breakers**:
   ```bash
   kubectl set env deployment/pup-ai CIRCUIT_BREAKER_ENABLED=true -n pup-ai
   ```

3. **Increase rate limits**:
   ```bash
   kubectl set env deployment/pup-ai \
     OPENAI_RATE_LIMIT_REQUESTS=5000 \
     OPENAI_RATE_LIMIT_WINDOW=60000 \
     -n pup-ai
   ```

#### Root Cause Fix
1. **For database errors**:
   ```bash
   # Increase connection pool
   kubectl set env deployment/pup-ai DATABASE_POOL_SIZE=50 -n pup-ai
   
   # Check for long-running queries
   kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
     SELECT pid, now() - pg_stat_activity.query_start AS duration, query 
     FROM pg_stat_activity 
     WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes';
   "
   ```

2. **For memory issues**:
   ```bash
   # Increase memory limits
   kubectl set resources deployment pup-ai --limits=memory=8Gi -n pup-ai
   
   # Enable memory profiling
   kubectl set env deployment/pup-ai NODE_OPTIONS="--max-old-space-size=7168 --heapsnapshot-signal=SIGUSR2" -n pup-ai
   ```

3. **For API failures**:
   ```bash
   # Rotate API keys if compromised
   kubectl create secret generic pup-ai-secrets --from-literal=OPENAI_API_KEY=new-key --dry-run=client -o yaml | kubectl apply -f -
   
   # Implement retry logic
   kubectl set env deployment/pup-ai API_RETRY_ATTEMPTS=5 -n pup-ai
   ```

### Verification
```bash
# Monitor error rate
watch 'kubectl exec -n pup-ai deployment/pup-ai -- curl -s localhost:9090/metrics | grep error_rate'

# Check logs for recovery
kubectl logs -n pup-ai -l app=pup-ai -f | grep -E "(ERROR|recovered|success)"

# Verify user impact
kubectl exec -n pup-ai deployment/pup-ai -- node -e "
  const { checkUserImpact } = require('./dist/utils/monitoring');
  checkUserImpact().then(console.log);
"
```

---

## Runbook: Database Connection Pool Exhaustion

### Alert Details
- **Alert Name**: PupAIDatabasePoolExhaustion
- **Severity**: Critical
- **Threshold**: > 90% of connections in use for 5 minutes

### Impact
- New database queries will fail
- Application requests will timeout
- Queue processing will be blocked

### Detection
```bash
# Check current pool usage
kubectl exec -n pup-ai deployment/pup-ai -- node -e "
  const { pool } = require('./dist/db/connection');
  console.log({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount
  });
"

# View connection stats in database
kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
  SELECT count(*) as connections, 
         state, 
         usename, 
         application_name 
  FROM pg_stat_activity 
  GROUP BY state, usename, application_name 
  ORDER BY count(*) DESC;
"
```

### Diagnosis Steps
1. **Identify connection leaks**:
   ```bash
   # Long-running connections
   kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
     SELECT pid, 
            now() - backend_start as connection_time,
            state,
            query
     FROM pg_stat_activity 
     WHERE datname = 'pupai'
     ORDER BY connection_time DESC
     LIMIT 20;
   "
   ```

2. **Check for blocking queries**:
   ```bash
   kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
     SELECT blocked_locks.pid AS blocked_pid,
            blocked_activity.usename AS blocked_user,
            blocking_locks.pid AS blocking_pid,
            blocking_activity.usename AS blocking_user,
            blocked_activity.query AS blocked_statement,
            blocking_activity.query AS blocking_statement
     FROM pg_catalog.pg_locks blocked_locks
     JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
     JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
     WHERE NOT blocked_locks.granted;
   "
   ```

### Resolution Steps

#### Immediate Actions
1. **Kill idle connections**:
   ```bash
   kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
     SELECT pg_terminate_backend(pid) 
     FROM pg_stat_activity 
     WHERE datname = 'pupai' 
       AND state = 'idle' 
       AND state_change < current_timestamp - interval '10 minutes';
   "
   ```

2. **Increase pool size temporarily**:
   ```bash
   kubectl set env deployment/pup-ai \
     DATABASE_POOL_SIZE=100 \
     DATABASE_POOL_MIN=10 \
     -n pup-ai
   
   # Restart pods to apply
   kubectl rollout restart deployment/pup-ai -n pup-ai
   ```

3. **Enable connection timeout**:
   ```bash
   kubectl set env deployment/pup-ai \
     DATABASE_CONNECTION_TIMEOUT=5000 \
     DATABASE_IDLE_TIMEOUT=30000 \
     -n pup-ai
   ```

#### Long-term Fixes
1. **Implement connection pooling best practices**:
   ```javascript
   // Update connection handling
   const poolConfig = {
     max: 50,
     min: 5,
     idleTimeoutMillis: 30000,
     connectionTimeoutMillis: 5000,
     maxUses: 7500, // Recreate connection after 7500 uses
     allowExitOnIdle: true
   };
   ```

2. **Add monitoring**:
   ```bash
   # Deploy pgbouncer for better connection management
   kubectl apply -f k8s/pgbouncer-deployment.yaml
   ```

### Verification
```bash
# Monitor pool recovery
watch 'kubectl exec -n pup-ai deployment/pup-ai -- node -e "
  const { pool } = require(\"./dist/db/connection\");
  console.log(JSON.stringify({
    total: pool.totalCount,
    idle: pool.idleCount,
    busy: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount
  }));
"'

# Check application health
curl https://pup-ai.company.com/health | jq .services.database
```

---

## Runbook: Memory Pressure

### Alert Details
- **Alert Name**: PupAIMemoryPressure
- **Severity**: Warning
- **Threshold**: Memory usage > 90% for 10 minutes

### Impact
- Application performance degradation
- Increased garbage collection pauses
- Potential OOM kills and pod restarts

### Detection
```bash
# Current memory usage
kubectl top pods -n pup-ai --containers

# Memory trends
kubectl exec -n pup-ai deployment/pup-ai -- node -e "
  console.log(process.memoryUsage());
  if (global.gc) {
    global.gc();
    console.log('After GC:', process.memoryUsage());
  }
"

# Check for memory leaks
kubectl logs -n pup-ai -l app=pup-ai --since=1h | grep "JavaScript heap out of memory"
```

### Diagnosis Steps
1. **Heap snapshot**:
   ```bash
   # Trigger heap snapshot
   kubectl exec -n pup-ai <pod-name> -- kill -USR2 1
   
   # Download snapshot
   kubectl cp pup-ai/<pod-name>:/app/heapsnapshot-*.heapsnapshot ./heap-analysis/
   ```

2. **Identify memory consumers**:
   ```bash
   # Check cache sizes
   kubectl exec -n pup-ai deployment/pup-ai -- redis-cli info memory
   
   # Database connection count
   kubectl exec -n pup-ai deployment/pup-ai -- node -e "
     const { pool } = require('./dist/db/connection');
     console.log('DB Connections:', pool.totalCount);
   "
   ```

### Resolution Steps

#### Quick Fix
1. **Force garbage collection**:
   ```bash
   kubectl exec -n pup-ai deployment/pup-ai -- node -e "
     if (global.gc) {
       console.log('Before GC:', process.memoryUsage());
       global.gc();
       console.log('After GC:', process.memoryUsage());
     }
   "
   ```

2. **Restart high-memory pods**:
   ```bash
   # Find and restart high-memory pods
   kubectl get pods -n pup-ai -o json | jq -r '.items[] | select(.status.containerStatuses[0].name=="pup-ai") | .metadata.name' | \
   while read pod; do
     memory=$(kubectl top pod $pod -n pup-ai --no-headers | awk '{print $3}' | sed 's/Mi//')
     if [ $memory -gt 3500 ]; then
       echo "Restarting $pod (${memory}Mi)"
       kubectl delete pod $pod -n pup-ai
     fi
   done
   ```

3. **Clear caches**:
   ```bash
   kubectl exec -n pup-ai deployment/pup-ai -- redis-cli FLUSHDB
   ```

#### Permanent Solution
1. **Increase memory limits**:
   ```bash
   kubectl set resources deployment pup-ai \
     --requests=memory=2Gi \
     --limits=memory=8Gi \
     -n pup-ai
   ```

2. **Optimize Node.js memory**:
   ```bash
   kubectl set env deployment/pup-ai \
     NODE_OPTIONS="--max-old-space-size=7168 --optimize-for-size" \
     -n pup-ai
   ```

### Verification
```bash
# Monitor memory usage
watch 'kubectl top pods -n pup-ai --containers'

# Check GC metrics
kubectl exec -n pup-ai deployment/pup-ai -- node -e "
  const v8 = require('v8');
  console.log(v8.getHeapStatistics());
"
```

---

## Runbook: Queue Backlog

### Alert Details
- **Alert Name**: PupAIQueueBacklog
- **Severity**: Warning
- **Threshold**: > 1000 jobs waiting for 15 minutes

### Impact
- Delayed message processing
- Increased response times
- Memory pressure from queue growth

### Detection
```bash
# Check all queue depths
kubectl exec -n pup-ai deployment/pup-ai-workers -- node -e "
  const { embeddingQueue, messageSummaryQueue, userProfileQueue } = require('./dist/workers/queues');
  Promise.all([
    embeddingQueue.getJobCounts(),
    messageSummaryQueue.getJobCounts(),
    userProfileQueue.getJobCounts()
  ]).then(([e, m, u]) => {
    console.log('Embeddings:', e);
    console.log('Summaries:', m);
    console.log('Profiles:', u);
  });
"

# Check processing rate
kubectl logs -n pup-ai -l app=pup-ai-workers --since=10m | grep "Job completed" | wc -l
```

### Resolution Steps

#### Immediate Scaling
1. **Scale workers**:
   ```bash
   # Scale up worker deployment
   kubectl scale deployment pup-ai-workers --replicas=10 -n pup-ai
   
   # Add more concurrent workers per pod
   kubectl set env deployment/pup-ai-workers \
     WORKER_CONCURRENCY=10 \
     EMBEDDING_QUEUE_CONCURRENCY=5 \
     -n pup-ai
   ```

2. **Process priority jobs**:
   ```bash
   # Pause non-critical queues
   kubectl exec -n pup-ai deployment/pup-ai-workers -- node -e "
     const { messageSummaryQueue, userProfileQueue } = require('./dist/workers/queues');
     Promise.all([
       messageSummaryQueue.pause(),
       userProfileQueue.pause()
     ]).then(() => console.log('Non-critical queues paused'));
   "
   ```

#### Long-term Optimization
1. **Implement batch processing**:
   ```javascript
   // Process embeddings in batches
   const batchSize = 10;
   const jobs = await embeddingQueue.getJobs(['waiting'], 0, batchSize);
   await Promise.all(jobs.map(job => processEmbedding(job)));
   ```

2. **Add dedicated worker nodes**:
   ```bash
   # Deploy spot instances for workers
   kubectl apply -f k8s/spot-worker-nodepool.yaml
   ```

### Verification
```bash
# Monitor queue drain rate
watch 'kubectl exec -n pup-ai deployment/pup-ai-workers -- node -e "
  const { embeddingQueue } = require(\"./dist/workers/queues\");
  embeddingQueue.getJobCounts().then(counts => {
    console.log(new Date().toISOString(), JSON.stringify(counts));
  });
"'
```

---

## Runbook: Slack API Rate Limiting

### Alert Details
- **Alert Name**: SlackAPIRateLimit
- **Severity**: Warning
- **Description**: Receiving 429 responses from Slack API

### Impact
- Messages not being sent
- Delayed responses to users
- Potential message loss

### Detection
```bash
# Check for rate limit errors
kubectl logs -n pup-ai -l app=pup-ai --since=10m | grep -E "(429|rate.limit)"

# View current rate limit headers
kubectl logs -n pup-ai -l app=pup-ai --since=1h | jq -r 'select(.metadata.service=="slack") | .metadata.headers'
```

### Resolution Steps

1. **Implement exponential backoff**:
   ```bash
   kubectl set env deployment/pup-ai \
     SLACK_RETRY_ENABLED=true \
     SLACK_RETRY_MAX_ATTEMPTS=5 \
     SLACK_RETRY_INITIAL_DELAY=1000 \
     -n pup-ai
   ```

2. **Queue Slack operations**:
   ```bash
   # Enable Slack operation queuing
   kubectl set env deployment/pup-ai SLACK_QUEUE_ENABLED=true -n pup-ai
   ```

3. **Distribute load**:
   ```bash
   # Add jitter to requests
   kubectl set env deployment/pup-ai SLACK_REQUEST_JITTER=true -n pup-ai
   ```

### Verification
```bash
# Monitor Slack API calls
kubectl logs -n pup-ai -l app=pup-ai -f | grep -E "slack.*api" | jq -r '[.timestamp, .metadata.status, .metadata.remaining] | @csv'
```

---

## Quick Reference Card

### Essential Commands
```bash
# Health check
curl https://pup-ai.company.com/health?detailed=true | jq

# View errors
kubectl logs -n pup-ai -l app=pup-ai --since=10m | jq 'select(.level=="error")'

# Resource usage
kubectl top pods -n pup-ai --containers

# Queue status
kubectl exec -n pup-ai deployment/pup-ai-workers -- npm run queue:status

# Database connections
kubectl exec -n pup-ai deployment/pup-ai -- psql -c "SELECT count(*) FROM pg_stat_activity;"

# Redis info
kubectl exec -n pup-ai deployment/pup-ai -- redis-cli info

# Restart all pods
kubectl rollout restart deployment -n pup-ai

# Emergency scale
kubectl scale deployment --all --replicas=10 -n pup-ai
```

### Emergency Contacts
- **Platform On-Call**: PagerDuty - platform-oncall
- **Database Team**: #database-team (Slack)
- **Security Team**: security@company.com
- **AWS Support**: Premium support console

### Monitoring Links
- Grafana: https://grafana-production.pup-ai.com
- Prometheus: https://prometheus-production.pup-ai.com
- Jaeger: https://tracing-production.pup-ai.com
- Kibana: https://logs-production.pup-ai.com