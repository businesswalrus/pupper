# pup.ai v2 Service Level Agreement (SLA)

## Executive Summary

This document defines the Service Level Agreement for pup.ai v2, the context-aware Slack bot platform. This SLA establishes performance metrics, availability targets, and operational procedures to ensure reliable service delivery.

## Service Overview

**Service Name**: pup.ai v2  
**Service Type**: Real-time Slack Bot Platform  
**Criticality**: Business Critical  
**Support Tier**: 24/7 Production Support

## Availability Targets

### Overall Service Availability
- **Target**: 99.9% uptime (monthly)
- **Allowed Downtime**: 43.8 minutes per month
- **Measurement Period**: Calendar month
- **Exclusions**: Scheduled maintenance windows

### Component-Level Targets

| Component | Availability Target | Max Downtime/Month |
|-----------|-------------------|-------------------|
| API Endpoints | 99.95% | 21.9 minutes |
| Message Processing | 99.9% | 43.8 minutes |
| Background Workers | 99.5% | 3.65 hours |
| Database (RDS) | 99.95% | 21.9 minutes |
| Cache (Redis) | 99.9% | 43.8 minutes |

## Performance Targets

### Response Time SLOs

| Operation | P50 Target | P95 Target | P99 Target |
|-----------|------------|------------|------------|
| Message Receipt | < 100ms | < 500ms | < 1s |
| Bot Response | < 2s | < 5s | < 10s |
| Embedding Generation | < 500ms | < 2s | < 5s |
| Search Query | < 200ms | < 1s | < 2s |
| Health Check | < 50ms | < 200ms | < 500ms |

### Throughput Targets

- **Message Processing**: 10,000 messages/minute
- **Concurrent Users**: 5,000 active users
- **API Requests**: 1,000 requests/second
- **Queue Processing**: 500 jobs/minute per worker

## Error Rate Targets

| Metric | Target | Action Threshold |
|--------|--------|------------------|
| Overall Error Rate | < 1% | > 5% triggers incident |
| 5xx Error Rate | < 0.1% | > 1% triggers incident |
| Database Error Rate | < 0.5% | > 2% triggers incident |
| External API Failures | < 2% | > 10% triggers incident |

## Data Durability and Recovery

### Backup Requirements
- **RPO (Recovery Point Objective)**: 1 hour
- **RTO (Recovery Time Objective)**: 4 hours
- **Backup Frequency**: 
  - Database: Continuous (point-in-time recovery)
  - Application State: Every 6 hours
  - Configurations: Real-time to Git

### Data Retention
- **Message History**: 90 days
- **User Profiles**: Indefinite
- **Audit Logs**: 1 year
- **Metrics**: 30 days
- **Application Logs**: 7 days

## Monitoring and Alerting

### Key Metrics Monitored

1. **Availability Metrics**
   - Uptime percentage
   - Health check success rate
   - Component availability

2. **Performance Metrics**
   - Response time percentiles
   - Queue depths
   - Processing rates
   - Resource utilization

3. **Business Metrics**
   - Active users
   - Messages processed
   - Bot interactions
   - Feature usage

### Alert Thresholds

| Alert | Warning | Critical | Page |
|-------|---------|----------|------|
| Error Rate | > 2% | > 5% | Yes |
| Response Time P95 | > 3s | > 5s | Yes |
| CPU Usage | > 70% | > 90% | No |
| Memory Usage | > 80% | > 95% | Yes |
| Queue Depth | > 1000 | > 5000 | Yes |
| Database Connections | > 80% | > 90% | Yes |

## Incident Response

### Severity Levels

| Severity | Definition | Response Time | Resolution Time |
|----------|-----------|---------------|-----------------|
| SEV1 | Complete service outage | 15 minutes | 2 hours |
| SEV2 | Major functionality impaired | 30 minutes | 4 hours |
| SEV3 | Minor functionality impaired | 2 hours | 8 hours |
| SEV4 | Cosmetic issues | Next business day | Best effort |

### Escalation Matrix

| Time After Detection | Escalation Level |
|---------------------|------------------|
| 0-15 minutes | On-call engineer |
| 15-30 minutes | Team lead |
| 30-60 minutes | Engineering manager |
| 60+ minutes | VP of Engineering |

### Communication Protocol

1. **Internal Communication**
   - Slack: #incidents channel
   - PagerDuty for critical alerts
   - War room: Zoom/Meet link in incident

2. **External Communication**
   - Status page updates within 15 minutes
   - Slack workspace notification for SEV1/SEV2
   - Email updates every 30 minutes during incidents

## Maintenance Windows

### Scheduled Maintenance
- **Frequency**: Monthly
- **Duration**: Up to 2 hours
- **Time**: Sunday 02:00-04:00 UTC
- **Notification**: 7 days in advance

### Emergency Maintenance
- **Notification**: Minimum 2 hours (when possible)
- **Approval**: VP of Engineering required
- **Communication**: All channels immediately

## SLA Calculations

### Availability Calculation
```
Availability % = (Total Minutes - Downtime Minutes) / Total Minutes × 100

Where:
- Total Minutes = Days in month × 24 × 60
- Downtime Minutes = Sum of all incident durations
- Excluded: Scheduled maintenance, force majeure
```

### Performance Calculation
```
SLO Achievement % = Successful Requests / Total Requests × 100

Where:
- Successful Request = Response within target time & no error
- Failed Request = Timeout, error, or exceeds target time
```

## Reporting

### Monthly SLA Report Contents
1. Overall availability percentage
2. Component-level availability
3. Performance metrics (P50, P95, P99)
4. Incident summary and RCA links
5. Improvement recommendations
6. Trend analysis

### Dashboard Access
- Real-time dashboard: https://grafana-production.pup-ai.com/sla
- Historical reports: https://reports.pup-ai.com/sla
- API metrics: https://api.pup-ai.com/metrics

## SLA Credits and Remedies

### Credit Schedule

| Monthly Uptime | Service Credit |
|----------------|----------------|
| < 99.9% | 10% |
| < 99.5% | 20% |
| < 99.0% | 30% |
| < 95.0% | 50% |

### Credit Request Process
1. Submit request within 30 days of incident
2. Include incident reference number
3. Email to: sla-credits@pup-ai.com
4. Response within 5 business days

## Exclusions

The following are excluded from SLA calculations:

1. **Scheduled Maintenance**: Pre-announced maintenance windows
2. **Force Majeure**: Natural disasters, war, terrorism
3. **External Dependencies**: 
   - Slack API outages
   - OpenAI API unavailability
   - AWS region failures
4. **Customer Issues**:
   - Incorrect API usage
   - Exceeding rate limits
   - Network connectivity issues
5. **Beta Features**: Features marked as beta or preview

## Service Dependencies

### Critical Dependencies
- **Slack API**: Required for all bot operations
- **OpenAI API**: Required for AI features
- **AWS Services**: EKS, RDS, ElastiCache, S3
- **Network Providers**: Internet connectivity

### Dependency SLAs
We aim to maintain our SLA despite dependency failures through:
- Redundancy and failover
- Caching strategies
- Graceful degradation
- Circuit breakers

## Continuous Improvement

### Quarterly Reviews
- SLA achievement analysis
- Incident pattern identification
- Capacity planning updates
- Performance optimization initiatives

### Annual Updates
- SLA target reassessment
- Technology stack evaluation
- Disaster recovery testing
- Full documentation review

## Contact Information

### Support Channels
- **Email**: support@pup-ai.com
- **Slack**: #pup-ai-support
- **Phone**: +1-xxx-xxx-xxxx (SEV1 only)
- **Status Page**: https://status.pup-ai.com

### Account Management
- **Customer Success**: success@pup-ai.com
- **Technical Account Manager**: tam@pup-ai.com

## Appendix A: Measurement Methodology

### Availability Monitoring
- **Health Checks**: Every 15 seconds from 3 geographic regions
- **Synthetic Monitoring**: Full user journey tests every 5 minutes
- **Real User Monitoring**: Actual user interaction tracking

### Performance Monitoring
- **APM Tool**: DataDog/New Relic with distributed tracing
- **Custom Metrics**: OpenTelemetry instrumentation
- **Log Analysis**: Centralized logging with correlation IDs

## Appendix B: Definitions

- **Downtime**: Period when service is unavailable or not meeting performance targets
- **Incident**: Any event that impacts service availability or performance
- **MTTD**: Mean Time to Detect - Average time to identify an issue
- **MTTR**: Mean Time to Repair - Average time to resolve an issue
- **Error Budget**: Allowed failures within SLA target (e.g., 0.1% for 99.9% SLA)

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2024-01-15 | Initial SLA definition | Platform Team |
| 1.1 | 2024-02-01 | Added performance targets | DevOps Team |
| 2.0 | 2024-03-01 | Updated for v2 architecture | Platform Team |

---

**Agreement Date**: _________________

**Customer**: _________________

**pup.ai Representative**: _________________

This SLA is subject to change with 30 days notice. Current version always available at https://docs.pup-ai.com/sla