#!/bin/bash
# Performance monitoring and reporting script for pup.ai v2

set -euo pipefail

# Configuration
NAMESPACE=${NAMESPACE:-pup-ai}
PROMETHEUS_URL=${PROMETHEUS_URL:-http://prometheus.observability:9090}
REPORT_DURATION=${REPORT_DURATION:-1h}  # 1h, 6h, 24h, 7d

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Helper functions
log_section() {
    echo ""
    echo -e "${BLUE}=== $1 ===${NC}"
    echo ""
}

query_prometheus() {
    local query=$1
    local result=$(kubectl exec -n observability deployment/kube-prometheus-stack-prometheus -- \
        curl -s "http://localhost:9090/api/v1/query?query=${query}" | \
        jq -r '.data.result[0].value[1] // "N/A"')
    echo "$result"
}

query_prometheus_range() {
    local query=$1
    local duration=$2
    kubectl exec -n observability deployment/kube-prometheus-stack-prometheus -- \
        curl -s "http://localhost:9090/api/v1/query_range?query=${query}&start=$(date -u -d "-${duration}" +%s)&end=$(date +%s)&step=60" | \
        jq -r '.data.result'
}

format_number() {
    local num=$1
    if [[ $num == "N/A" ]]; then
        echo "N/A"
    else
        printf "%.2f" "$num"
    fi
}

format_percentage() {
    local num=$1
    if [[ $num == "N/A" ]]; then
        echo "N/A"
    else
        printf "%.2f%%" "$(echo "$num * 100" | bc -l)"
    fi
}

# Header
echo "======================================"
echo "pup.ai v2 Performance Report"
echo "======================================"
echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "Duration: $REPORT_DURATION"
echo "Namespace: $NAMESPACE"
echo ""

# Response Time Analysis
log_section "Response Time Analysis"

# API response times
P50_RESPONSE=$(query_prometheus "histogram_quantile(0.50, rate(http_request_duration_seconds_bucket{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
P95_RESPONSE=$(query_prometheus "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
P99_RESPONSE=$(query_prometheus "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")

echo "HTTP Response Times:"
echo "  P50: $(format_number "$P50_RESPONSE")ms"
echo "  P95: $(format_number "$P95_RESPONSE")ms"
echo "  P99: $(format_number "$P99_RESPONSE")ms"

# Queue processing times
QUEUE_P50=$(query_prometheus "histogram_quantile(0.50, rate(queue_processing_time_ms_bucket{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
QUEUE_P95=$(query_prometheus "histogram_quantile(0.95, rate(queue_processing_time_ms_bucket{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")

echo ""
echo "Queue Processing Times:"
echo "  P50: $(format_number "$QUEUE_P50")ms"
echo "  P95: $(format_number "$QUEUE_P95")ms"

# Throughput Metrics
log_section "Throughput Metrics"

# Requests per second
RPS=$(query_prometheus "sum(rate(http_requests_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
echo "HTTP Requests/sec: $(format_number "$RPS")"

# Messages processed
MSG_RATE=$(query_prometheus "sum(rate(messages_processed_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
echo "Messages/sec: $(format_number "$MSG_RATE")"

# Queue throughput
QUEUE_RATE=$(query_prometheus "sum(rate(bullmq_queue_completed_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
echo "Queue Jobs/sec: $(format_number "$QUEUE_RATE")"

# Error Rates
log_section "Error Rates"

# Overall error rate
ERROR_RATE=$(query_prometheus "sum(rate(http_requests_total{namespace=\"${NAMESPACE}\",status=~\"5..\"}[${REPORT_DURATION}])) / sum(rate(http_requests_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
echo "HTTP Error Rate (5xx): $(format_percentage "$ERROR_RATE")"

# Job failure rate
JOB_FAILURE_RATE=$(query_prometheus "sum(rate(bullmq_queue_failed_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}])) / sum(rate(bullmq_queue_completed_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
echo "Job Failure Rate: $(format_percentage "$JOB_FAILURE_RATE")"

# Database error rate
DB_ERROR_RATE=$(query_prometheus "sum(rate(pg_errors_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}])) / sum(rate(pg_queries_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))")
echo "Database Error Rate: $(format_percentage "$DB_ERROR_RATE")"

# Resource Utilization
log_section "Resource Utilization"

# CPU usage
CPU_USAGE=$(query_prometheus "avg(rate(container_cpu_usage_seconds_total{namespace=\"${NAMESPACE}\",container!=\"\"}[${REPORT_DURATION}])) * 100")
echo "Average CPU Usage: $(format_percentage "$CPU_USAGE")"

# Memory usage
MEMORY_USAGE=$(query_prometheus "avg(container_memory_working_set_bytes{namespace=\"${NAMESPACE}\",container!=\"\"}) / avg(container_spec_memory_limit_bytes{namespace=\"${NAMESPACE}\",container!=\"\"})")
echo "Average Memory Usage: $(format_percentage "$MEMORY_USAGE")"

# Database connections
DB_CONNECTIONS=$(query_prometheus "avg(pg_pool_connections_busy{namespace=\"${NAMESPACE}\"}) / avg(pg_pool_connections_total{namespace=\"${NAMESPACE}\"})")
echo "Database Pool Usage: $(format_percentage "$DB_CONNECTIONS")"

# Queue Metrics
log_section "Queue Performance"

# Queue depths
echo "Current Queue Depths:"
kubectl exec -n $NAMESPACE deployment/pup-ai-workers -- node -e "
const { embeddingQueue, messageSummaryQueue, userProfileQueue } = require('./dist/workers/queues');
Promise.all([
    embeddingQueue.getJobCounts(),
    messageSummaryQueue.getJobCounts(),
    userProfileQueue.getJobCounts()
]).then(([e, m, u]) => {
    console.log('  Embeddings: waiting=' + e.waiting + ', active=' + e.active);
    console.log('  Summaries: waiting=' + m.waiting + ', active=' + m.active);
    console.log('  Profiles: waiting=' + u.waiting + ', active=' + u.active);
});
" 2>/dev/null || echo "  Unable to fetch queue metrics"

# Availability
log_section "Availability Metrics"

# Uptime calculation
UPTIME=$(query_prometheus "(1 - (sum(increase(http_requests_total{namespace=\"${NAMESPACE}\",status=\"503\"}[${REPORT_DURATION}])) / sum(increase(http_requests_total{namespace=\"${NAMESPACE}\"}[${REPORT_DURATION}]))))")
echo "Service Availability: $(format_percentage "$UPTIME")"

# Pod restarts
POD_RESTARTS=$(kubectl get pods -n $NAMESPACE -o json | jq '[.items[].status.containerStatuses[].restartCount] | add // 0')
echo "Total Pod Restarts: $POD_RESTARTS"

# External Dependencies
log_section "External Dependencies"

# Slack API latency
SLACK_LATENCY=$(query_prometheus "histogram_quantile(0.95, rate(external_api_duration_seconds_bucket{namespace=\"${NAMESPACE}\",service=\"slack\"}[${REPORT_DURATION}]))")
echo "Slack API P95 Latency: $(format_number "$SLACK_LATENCY")ms"

# OpenAI API latency
OPENAI_LATENCY=$(query_prometheus "histogram_quantile(0.95, rate(external_api_duration_seconds_bucket{namespace=\"${NAMESPACE}\",service=\"openai\"}[${REPORT_DURATION}]))")
echo "OpenAI API P95 Latency: $(format_number "$OPENAI_LATENCY")ms"

# Circuit breaker status
echo ""
echo "Circuit Breaker Status:"
kubectl exec -n $NAMESPACE deployment/pup-ai -- node -e "
const { circuitBreakers } = require('./dist/utils/circuitBreaker');
Object.entries(circuitBreakers).forEach(([name, breaker]) => {
    const stats = breaker.getStats();
    console.log('  ' + name + ': ' + stats.state);
});
" 2>/dev/null || echo "  Unable to fetch circuit breaker status"

# Top Slow Queries
log_section "Database Performance"

echo "Top 5 Slow Queries:"
kubectl exec -n $NAMESPACE deployment/pup-ai -- psql -c "
SELECT 
    calls,
    mean_exec_time::numeric(10,2) as avg_ms,
    max_exec_time::numeric(10,2) as max_ms,
    query
FROM pg_stat_statements 
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC 
LIMIT 5;
" 2>/dev/null || echo "Unable to fetch database metrics"

# Recommendations
log_section "Performance Recommendations"

RECOMMENDATIONS=()

# Check response times
if [[ $(echo "$P95_RESPONSE > 5" | bc -l) -eq 1 ]] 2>/dev/null; then
    RECOMMENDATIONS+=("⚠️  High P95 response time detected. Consider scaling horizontally.")
fi

# Check error rate
if [[ $(echo "$ERROR_RATE > 0.05" | bc -l) -eq 1 ]] 2>/dev/null; then
    RECOMMENDATIONS+=("⚠️  High error rate detected. Review application logs for issues.")
fi

# Check CPU usage
if [[ $(echo "$CPU_USAGE > 80" | bc -l) -eq 1 ]] 2>/dev/null; then
    RECOMMENDATIONS+=("⚠️  High CPU usage. Consider scaling up or optimizing code.")
fi

# Check memory usage
if [[ $(echo "$MEMORY_USAGE > 0.8" | bc -l) -eq 1 ]] 2>/dev/null; then
    RECOMMENDATIONS+=("⚠️  High memory usage. Check for memory leaks or increase limits.")
fi

# Check database connections
if [[ $(echo "$DB_CONNECTIONS > 0.8" | bc -l) -eq 1 ]] 2>/dev/null; then
    RECOMMENDATIONS+=("⚠️  High database connection usage. Consider increasing pool size.")
fi

if [ ${#RECOMMENDATIONS[@]} -eq 0 ]; then
    echo "✅ No performance issues detected"
else
    for rec in "${RECOMMENDATIONS[@]}"; do
        echo "$rec"
    done
fi

# Summary
echo ""
echo "======================================"
echo "Performance Score Card"
echo "======================================"

# Calculate performance score
SCORE=100
[[ $(echo "$P95_RESPONSE > 5" | bc -l) -eq 1 ]] 2>/dev/null && ((SCORE-=10))
[[ $(echo "$ERROR_RATE > 0.01" | bc -l) -eq 1 ]] 2>/dev/null && ((SCORE-=20))
[[ $(echo "$CPU_USAGE > 80" | bc -l) -eq 1 ]] 2>/dev/null && ((SCORE-=10))
[[ $(echo "$MEMORY_USAGE > 0.8" | bc -l) -eq 1 ]] 2>/dev/null && ((SCORE-=10))
[[ $POD_RESTARTS -gt 10 ]] && ((SCORE-=15))

echo "Overall Performance Score: $SCORE/100"

if [ $SCORE -ge 90 ]; then
    echo -e "${GREEN}Status: EXCELLENT${NC}"
elif [ $SCORE -ge 75 ]; then
    echo -e "${GREEN}Status: GOOD${NC}"
elif [ $SCORE -ge 60 ]; then
    echo -e "${YELLOW}Status: FAIR${NC}"
else
    echo -e "${RED}Status: POOR${NC}"
fi

echo ""
echo "Report generated at: $(date)