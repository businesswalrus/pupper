# pup.ai v2 DevOps Setup Guide

## Quick Start

### Prerequisites
- AWS CLI configured with appropriate permissions
- kubectl v1.28+
- Terraform v1.5+
- Helm v3.12+
- Docker

### 1. Infrastructure Deployment

```bash
# Clone the repository
git clone https://github.com/your-org/pupper.git
cd pupper

# Deploy infrastructure
cd terraform
terraform init
terraform plan -var-file=environments/production.tfvars
terraform apply -var-file=environments/production.tfvars

# Configure kubectl
aws eks update-kubeconfig --region us-east-1 --name pup-ai-production
```

### 2. Application Deployment

```bash
# Build and push Docker image
docker build -f Dockerfile.production -t pup-ai:v2.0.0 .
docker tag pup-ai:v2.0.0 $(terraform output -raw ecr_repository_url):v2.0.0
aws ecr get-login-password | docker login --username AWS --password-stdin $(terraform output -raw ecr_repository_url)
docker push $(terraform output -raw ecr_repository_url):v2.0.0

# Deploy to Kubernetes
cd k8s
kubectl apply -k overlays/production
```

### 3. Verify Deployment

```bash
# Run health check
./scripts/ops/health-check.sh

# View application logs
kubectl logs -n pup-ai -l app=pup-ai -f

# Access Grafana dashboard
kubectl port-forward -n observability svc/kube-prometheus-stack-grafana 3000:80
# Open http://localhost:3000 (admin/changeme)
```

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│   Slack Users   │────▶│  Load Balancer  │────▶│   Kubernetes    │
│                 │     │   (NGINX/ALB)   │     │    Cluster      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                ┌─────────────────────────┴─────────────────────────┐
                                │                                                   │
                        ┌───────▼────────┐  ┌──────────────┐  ┌──────────────┐   │
                        │                │  │              │  │              │   │
                        │   pup-ai Pods  │  │ Worker Pods  │  │ Monitoring   │   │
                        │   (3-50 pods)  │  │  (2-10 pods) │  │   Stack      │   │
                        │                │  │              │  │              │   │
                        └───────┬────────┘  └──────┬───────┘  └──────────────┘   │
                                │                  │                              │
                                └──────────┬───────┘                              │
                                          │                                       │
                                ┌─────────▼──────────┐                           │
                                │                    │                           │
                                │  Service Mesh     │                           │
                                │                    │                           │
                                └─────────┬──────────┘                           │
                                          │                                       │
                        ┌─────────────────┴─────────────────────┐               │
                        │                                       │               │
                ┌───────▼────────┐                    ┌─────────▼────────┐     │
                │                │                    │                  │     │
                │ RDS PostgreSQL │                    │ ElastiCache      │     │
                │  (Multi-AZ)    │                    │ Redis Cluster    │     │
                │                │                    │                  │     │
                └────────────────┘                    └──────────────────┘     │
                                                                                 │
                        ┌─────────────────────────────────────────────────────┘
                        │
                ┌───────▼────────┐     ┌──────────────┐     ┌──────────────┐
                │                │     │              │     │              │
                │  External APIs │     │    OpenAI    │     │   Slack API  │
                │                │     │              │     │              │
                └────────────────┘     └──────────────┘     └──────────────┘
```

## Key Components

### 1. Application Layer
- **Main Application**: Handles Slack events and user interactions
- **Workers**: Process background jobs (embeddings, summaries, profiles)
- **Health Checks**: Comprehensive health monitoring endpoints

### 2. Data Layer
- **PostgreSQL**: Primary datastore with pgvector for embeddings
- **Redis**: Caching and job queue management
- **S3**: Log storage and backups

### 3. Observability Layer
- **Prometheus**: Metrics collection and alerting
- **Grafana**: Visualization and dashboards
- **Loki**: Log aggregation
- **OpenTelemetry**: Distributed tracing

### 4. Infrastructure Layer
- **EKS**: Kubernetes orchestration
- **VPC**: Network isolation and security
- **KMS**: Encryption key management
- **IAM**: Access control and service accounts

## Common Operations

### Scaling Operations

```bash
# Scale application pods
kubectl scale deployment pup-ai --replicas=10 -n pup-ai

# Scale worker pods
kubectl scale deployment pup-ai-workers --replicas=5 -n pup-ai

# Enable cluster autoscaling
kubectl apply -f k8s/cluster-autoscaler.yaml
```

### Monitoring Operations

```bash
# View real-time metrics
./scripts/ops/performance-report.sh

# Check queue depths
kubectl exec -n pup-ai deployment/pup-ai-workers -- npm run queue:status

# View error logs
kubectl logs -n pup-ai -l app=pup-ai --since=1h | grep ERROR
```

### Emergency Operations

```bash
# Run emergency response script
./scripts/ops/emergency-response.sh

# Quick health check
curl https://pup-ai.company.com/health

# Force restart all pods
kubectl rollout restart deployment -n pup-ai
```

## Deployment Strategies

### Blue-Green Deployment

```bash
# Deploy new version to green environment
kubectl set image deployment/pup-ai-green pup-ai=your-registry.com/pup-ai:v2.1.0 -n pup-ai

# Scale up green
kubectl scale deployment pup-ai-green --replicas=3 -n pup-ai

# Switch traffic to green
kubectl patch service pup-ai-active -n pup-ai -p '{"spec":{"selector":{"version":"green"}}}'

# Scale down blue
kubectl scale deployment pup-ai-blue --replicas=0 -n pup-ai
```

### Rolling Update

```bash
# Update image with rolling update
kubectl set image deployment/pup-ai pup-ai=your-registry.com/pup-ai:v2.1.0 -n pup-ai

# Monitor rollout
kubectl rollout status deployment/pup-ai -n pup-ai

# Rollback if needed
kubectl rollout undo deployment/pup-ai -n pup-ai
```

## Troubleshooting

### Pod Issues

```bash
# Check pod status
kubectl get pods -n pup-ai

# Describe problematic pod
kubectl describe pod <pod-name> -n pup-ai

# View pod logs
kubectl logs <pod-name> -n pup-ai --previous

# Execute commands in pod
kubectl exec -it <pod-name> -n pup-ai -- /bin/sh
```

### Database Issues

```bash
# Check database connections
kubectl exec -n pup-ai deployment/pup-ai -- psql -c "SELECT count(*) FROM pg_stat_activity;"

# Kill long-running queries
kubectl exec -n pup-ai deployment/pup-ai -- psql -c "
  SELECT pg_terminate_backend(pid) 
  FROM pg_stat_activity 
  WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes';
"
```

### Performance Issues

```bash
# Check resource usage
kubectl top pods -n pup-ai

# View queue backlogs
kubectl exec -n pup-ai deployment/pup-ai-workers -- node -e "
  const { getQueueStats } = require('./dist/workers/queues');
  getQueueStats().then(console.log);
"

# Generate performance report
./scripts/ops/performance-report.sh
```

## Security Best Practices

1. **Secrets Management**
   - Use External Secrets Operator
   - Rotate credentials regularly
   - Never commit secrets to Git

2. **Network Security**
   - Network policies enabled
   - TLS for all external traffic
   - Private subnets for databases

3. **Access Control**
   - RBAC configured
   - Service accounts with minimal permissions
   - Audit logging enabled

4. **Container Security**
   - Non-root containers
   - Read-only root filesystem
   - Security scanning in CI/CD

## Backup and Recovery

### Automated Backups
- RDS: Continuous backups with 30-day retention
- Redis: Daily snapshots
- Kubernetes: Velero for cluster state

### Manual Backup

```bash
# Backup database
kubectl exec -n pup-ai deployment/pup-ai -- pg_dump > backup-$(date +%Y%m%d).sql

# Backup Kubernetes resources
kubectl get all,configmap,secret -n pup-ai -o yaml > k8s-backup-$(date +%Y%m%d).yaml
```

### Restore Procedures

```bash
# Restore database
kubectl exec -i -n pup-ai deployment/pup-ai -- psql < backup-20240115.sql

# Restore Kubernetes resources
kubectl apply -f k8s-backup-20240115.yaml
```

## Maintenance

### Regular Tasks
- Review and rotate logs (weekly)
- Update dependencies (monthly)
- Security patches (as needed)
- Performance optimization (quarterly)

### Health Checks
- Automated health checks every 15 seconds
- Synthetic monitoring every 5 minutes
- Full system audit monthly

## Support

### Documentation
- [Production Deployment Guide](./PRODUCTION_DEPLOYMENT.md)
- [Operational Runbooks](./RUNBOOKS.md)
- [Service Level Agreement](./SLA.md)

### Monitoring Dashboards
- Grafana: https://grafana-production.pup-ai.com
- Prometheus: https://prometheus-production.pup-ai.com
- Status Page: https://status.pup-ai.com

### Contact
- Platform Team: #platform-team (Slack)
- On-Call: PagerDuty
- Email: devops@pup-ai.com

---

For detailed information about specific components or procedures, refer to the comprehensive documentation in the `/docs` directory.