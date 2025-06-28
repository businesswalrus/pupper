# Production Deployment Guide for pup.ai v2

## Table of Contents
1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Infrastructure Setup](#infrastructure-setup)
4. [Application Deployment](#application-deployment)
5. [Monitoring and Observability](#monitoring-and-observability)
6. [Scaling and Performance](#scaling-and-performance)
7. [Disaster Recovery](#disaster-recovery)
8. [Troubleshooting](#troubleshooting)

## Overview

This guide covers the complete production deployment of pup.ai v2, a context-aware Slack bot with personality and memory. The deployment uses:

- **AWS EKS** for Kubernetes orchestration
- **RDS PostgreSQL** with pgvector for persistent storage
- **ElastiCache Redis** for caching and job queues
- **Prometheus/Grafana** for monitoring
- **OpenTelemetry** for distributed tracing
- **Terraform** for infrastructure as code

## Prerequisites

### Required Tools
```bash
# Install required tools
brew install terraform kubectl helm aws-cli jq

# Install specific versions
terraform version  # >= 1.5.0
kubectl version   # >= 1.28.0
helm version      # >= 3.12.0
aws --version     # >= 2.13.0
```

### AWS Permissions
Ensure your AWS IAM user has the following permissions:
- EKS full access
- VPC full access
- RDS full access
- ElastiCache full access
- IAM role creation
- S3 bucket creation
- KMS key management
- Route53 (for DNS)

### Domain Setup
- Domain registered and DNS managed by Route53
- SSL certificates will be automatically provisioned via Let's Encrypt

## Infrastructure Setup

### 1. Initialize Terraform Backend
```bash
# Create S3 bucket for Terraform state
aws s3 mb s3://pup-ai-terraform-state --region us-east-1

# Create DynamoDB table for state locking
aws dynamodb create-table \
  --table-name pup-ai-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
  --region us-east-1
```

### 2. Configure Secrets
```bash
# Store sensitive values in AWS Secrets Manager
aws secretsmanager create-secret \
  --name pup-ai-production-secrets \
  --secret-string '{
    "slack_bot_token": "xoxb-your-token",
    "slack_app_token": "xapp-your-token",
    "slack_signing_secret": "your-secret",
    "openai_api_key": "sk-your-key"
  }'
```

### 3. Deploy Infrastructure
```bash
cd terraform

# Initialize Terraform
terraform init

# Plan deployment
terraform plan -var-file=environments/production.tfvars -out=tfplan

# Apply infrastructure
terraform apply tfplan

# Save outputs
terraform output -json > outputs.json
```

### 4. Configure kubectl
```bash
# Update kubeconfig
aws eks update-kubeconfig \
  --region us-east-1 \
  --name $(terraform output -raw eks_cluster_name)

# Verify connection
kubectl get nodes
```

## Application Deployment

### 1. Build and Push Docker Image
```bash
# Build production image
docker build -f Dockerfile.production -t pup-ai:v2.0.0 .

# Tag for ECR
docker tag pup-ai:v2.0.0 $(terraform output -raw ecr_repository_url):v2.0.0

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $(terraform output -raw ecr_repository_url)

# Push image
docker push $(terraform output -raw ecr_repository_url):v2.0.0
```

### 2. Create Kubernetes Secrets
```bash
# Create namespace
kubectl create namespace pup-ai

# Create secret from AWS Secrets Manager
kubectl create secret generic pup-ai-secrets \
  --from-literal=SLACK_BOT_TOKEN=$(aws secretsmanager get-secret-value --secret-id pup-ai-production-secrets | jq -r '.SecretString | fromjson.slack_bot_token') \
  --from-literal=SLACK_APP_TOKEN=$(aws secretsmanager get-secret-value --secret-id pup-ai-production-secrets | jq -r '.SecretString | fromjson.slack_app_token') \
  --from-literal=SLACK_SIGNING_SECRET=$(aws secretsmanager get-secret-value --secret-id pup-ai-production-secrets | jq -r '.SecretString | fromjson.slack_signing_secret') \
  --from-literal=OPENAI_API_KEY=$(aws secretsmanager get-secret-value --secret-id pup-ai-production-secrets | jq -r '.SecretString | fromjson.openai_api_key') \
  --from-literal=DATABASE_URL="postgresql://pupai_admin:$(terraform output -raw rds_password)@$(terraform output -raw rds_endpoint)/pupai?sslmode=require" \
  --from-literal=REDIS_URL="redis://$(terraform output -raw redis_endpoint)" \
  -n pup-ai
```

### 3. Deploy Application
```bash
# Update image in kustomization
cd k8s
kustomize edit set image your-registry.com/pup-ai=$(terraform output -raw ecr_repository_url):v2.0.0

# Deploy using kustomize
kubectl apply -k overlays/production

# Verify deployment
kubectl get pods -n pup-ai
kubectl get svc -n pup-ai
kubectl get ingress -n pup-ai
```

### 4. Run Database Migrations
```bash
# Run migrations as a one-time job
kubectl run db-migrate \
  --image=$(terraform output -raw ecr_repository_url):v2.0.0 \
  --restart=Never \
  --rm -it \
  --namespace=pup-ai \
  --env="DATABASE_URL=postgresql://pupai_admin:$(terraform output -raw rds_password)@$(terraform output -raw rds_endpoint)/pupai?sslmode=require" \
  -- npm run db:migrate
```

## Monitoring and Observability

### 1. Access Grafana
```bash
# Get Grafana password
kubectl get secret -n observability kube-prometheus-stack-grafana \
  -o jsonpath="{.data.admin-password}" | base64 --decode

# Access via port-forward (for initial setup)
kubectl port-forward -n observability svc/kube-prometheus-stack-grafana 3000:80

# Or via ingress
echo "https://grafana-production.pup-ai.com"
```

### 2. Configure Alerts
1. Login to Grafana
2. Navigate to Alerting > Contact points
3. Configure Slack webhook
4. Test alert delivery

### 3. View Application Metrics
- **Application Dashboard**: `https://grafana-production.pup-ai.com/d/pup-ai-overview`
- **Kubernetes Dashboard**: `https://grafana-production.pup-ai.com/d/kubernetes-cluster`
- **Node Metrics**: `https://grafana-production.pup-ai.com/d/node-exporter`

### 4. Access Logs
```bash
# View application logs
kubectl logs -n pup-ai -l app=pup-ai -f

# Query logs via Loki
curl -G -s "http://loki.observability:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={namespace="pup-ai"}' | jq
```

### 5. Distributed Tracing
```bash
# Access Jaeger UI (if deployed)
kubectl port-forward -n observability svc/jaeger-query 16686:80

# View traces at http://localhost:16686
```

## Scaling and Performance

### 1. Horizontal Pod Autoscaling
```bash
# View HPA status
kubectl get hpa -n pup-ai

# Manually scale if needed
kubectl scale deployment pup-ai --replicas=10 -n pup-ai
```

### 2. Cluster Autoscaling
```bash
# Check cluster autoscaler logs
kubectl logs -n kube-system -l app.kubernetes.io/name=cluster-autoscaler -f

# View node scaling events
kubectl get events -n kube-system | grep cluster-autoscaler
```

### 3. Worker Scaling
```bash
# Scale worker deployment
kubectl scale deployment pup-ai-workers --replicas=5 -n pup-ai

# Monitor queue depths
kubectl exec -n pup-ai deployment/pup-ai -- node -e "
  const { getQueueStats } = require('./dist/workers/queues');
  getQueueStats().then(console.log);
"
```

### 4. Performance Tuning
```bash
# Update resource limits
kubectl set resources deployment pup-ai \
  --requests=cpu=1000m,memory=2Gi \
  --limits=cpu=4000m,memory=8Gi \
  -n pup-ai

# Adjust database connections
kubectl set env deployment/pup-ai DATABASE_POOL_SIZE=50 -n pup-ai
```

## Disaster Recovery

### 1. Backup Procedures

#### Database Backup
```bash
# Manual backup
aws rds create-db-snapshot \
  --db-instance-identifier pup-ai-production-postgres \
  --db-snapshot-identifier pup-ai-manual-$(date +%Y%m%d-%H%M%S)

# List backups
aws rds describe-db-snapshots \
  --db-instance-identifier pup-ai-production-postgres
```

#### Kubernetes Resources Backup
```bash
# Install Velero for cluster backup
helm install velero vmware-tanzu/velero \
  --namespace velero \
  --create-namespace \
  --set-file credentials.secretContents.cloud=velero-credentials \
  --set configuration.provider=aws \
  --set configuration.backupStorageLocation.bucket=pup-ai-velero-backups \
  --set configuration.backupStorageLocation.config.region=us-east-1

# Create backup
velero backup create pup-ai-backup --include-namespaces pup-ai
```

### 2. Restore Procedures

#### Database Restore
```bash
# Restore from snapshot
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier pup-ai-production-postgres-restored \
  --db-snapshot-identifier pup-ai-manual-20240115-120000

# Update application to use new endpoint
kubectl set env deployment/pup-ai \
  DATABASE_URL="postgresql://pupai_admin:password@new-endpoint:5432/pupai" \
  -n pup-ai
```

#### Kubernetes Restore
```bash
# Restore from Velero backup
velero restore create --from-backup pup-ai-backup
```

### 3. Failover Procedures

#### Region Failover
1. Update Route53 health checks
2. Promote read replica in backup region
3. Update application configuration
4. Verify data consistency

## Troubleshooting

### Common Issues

#### 1. Pod Crash Loops
```bash
# Check pod logs
kubectl logs -n pup-ai <pod-name> --previous

# Describe pod for events
kubectl describe pod -n pup-ai <pod-name>

# Check resource limits
kubectl top pod -n pup-ai
```

#### 2. Database Connection Issues
```bash
# Test database connectivity
kubectl run -it --rm debug \
  --image=postgres:15 \
  --restart=Never \
  -n pup-ai \
  -- psql "postgresql://pupai_admin:password@endpoint:5432/pupai?sslmode=require"

# Check security groups
aws ec2 describe-security-groups --group-ids <sg-id>
```

#### 3. High Memory Usage
```bash
# Get memory usage
kubectl top pods -n pup-ai

# Check for memory leaks
kubectl exec -n pup-ai <pod-name> -- node --inspect=0.0.0.0:9229

# Connect debugger
kubectl port-forward -n pup-ai <pod-name> 9229:9229
```

#### 4. Slow Response Times
```bash
# Check metrics
curl http://localhost:9090/metrics | grep response_time

# View traces
# Access Jaeger UI and filter by slow requests

# Database slow queries
kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
  SELECT query, calls, mean_exec_time 
  FROM pg_stat_statements 
  ORDER BY mean_exec_time DESC 
  LIMIT 10;
"
```

### Health Check Endpoints

```bash
# Application health
curl https://pup-ai.company.com/health

# Detailed health with subsystems
curl https://pup-ai.company.com/health?detailed=true

# Kubernetes probes
curl http://<pod-ip>:3000/health -H "X-Probe-Type: liveness"
curl http://<pod-ip>:3000/health -H "X-Probe-Type: readiness"
curl http://<pod-ip>:3000/health -H "X-Probe-Type: startup"
```

### Emergency Procedures

#### 1. Emergency Shutdown
```bash
# Scale down all deployments
kubectl scale deployment --all --replicas=0 -n pup-ai

# Pause queues
kubectl exec -n pup-ai deployment/pup-ai-workers -- node -e "
  const { pauseAllQueues } = require('./dist/workers/queues');
  pauseAllQueues();
"
```

#### 2. Emergency Restore
```bash
# Quick restore from latest backup
./scripts/emergency-restore.sh

# Verify data integrity
kubectl exec -n pup-ai deployment/pup-ai -- npm run verify:data
```

## Maintenance Windows

### Scheduled Maintenance
- **Database**: Sundays 04:00-05:00 UTC
- **Redis**: Sundays 05:00-06:00 UTC
- **Kubernetes**: First Sunday of month 06:00-08:00 UTC

### Pre-maintenance Checklist
1. [ ] Notify users via Slack
2. [ ] Create fresh backups
3. [ ] Scale up replicas
4. [ ] Enable maintenance mode
5. [ ] Monitor error rates

### Post-maintenance Checklist
1. [ ] Verify all services healthy
2. [ ] Run integration tests
3. [ ] Check monitoring dashboards
4. [ ] Disable maintenance mode
5. [ ] Send completion notification

## Support and Escalation

### Escalation Path
1. **L1 Support**: Check runbooks and dashboards
2. **L2 Support**: Platform team on-call
3. **L3 Support**: Senior engineers
4. **Critical**: Wake up CTO

### Key Contacts
- Platform Team: #platform-team
- On-call: PagerDuty
- Security: security@company.com
- AWS Support: Premium support case

### Useful Commands Reference
```bash
# Quick status check
./scripts/health-check.sh

# View recent errors
./scripts/recent-errors.sh

# Performance report
./scripts/performance-report.sh

# Security scan
./scripts/security-scan.sh
```