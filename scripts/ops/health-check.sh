#!/bin/bash
# Comprehensive health check script for pup.ai v2

set -euo pipefail

# Configuration
NAMESPACE=${NAMESPACE:-pup-ai}
SERVICE_URL=${SERVICE_URL:-https://pup-ai.company.com}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_status() {
    local name=$1
    local status=$2
    local details=$3
    
    if [ "$status" = "healthy" ] || [ "$status" = "up" ]; then
        echo -e "${GREEN}✓${NC} $name: $status $details"
    elif [ "$status" = "degraded" ] || [ "$status" = "warning" ]; then
        echo -e "${YELLOW}⚠${NC} $name: $status $details"
    else
        echo -e "${RED}✗${NC} $name: $status $details"
    fi
}

# Check Kubernetes cluster connectivity
log_info "Checking Kubernetes cluster connectivity..."
if kubectl cluster-info &>/dev/null; then
    check_status "Kubernetes Cluster" "healthy" ""
else
    check_status "Kubernetes Cluster" "down" "Cannot connect to cluster"
    exit 1
fi

# Check namespace
log_info "Checking namespace..."
if kubectl get namespace $NAMESPACE &>/dev/null; then
    check_status "Namespace" "healthy" "($NAMESPACE)"
else
    check_status "Namespace" "down" "Namespace $NAMESPACE not found"
    exit 1
fi

# Check deployments
log_info "Checking deployments..."
DEPLOYMENTS=$(kubectl get deployments -n $NAMESPACE -o json)
READY_DEPLOYMENTS=$(echo "$DEPLOYMENTS" | jq -r '.items[] | select(.status.replicas == .status.readyReplicas) | .metadata.name' | wc -l)
TOTAL_DEPLOYMENTS=$(echo "$DEPLOYMENTS" | jq -r '.items[].metadata.name' | wc -l)

if [ "$READY_DEPLOYMENTS" -eq "$TOTAL_DEPLOYMENTS" ]; then
    check_status "Deployments" "healthy" "($READY_DEPLOYMENTS/$TOTAL_DEPLOYMENTS ready)"
else
    check_status "Deployments" "degraded" "($READY_DEPLOYMENTS/$TOTAL_DEPLOYMENTS ready)"
    echo "$DEPLOYMENTS" | jq -r '.items[] | select(.status.replicas != .status.readyReplicas) | "  - \(.metadata.name): \(.status.readyReplicas)/\(.status.replicas) ready"'
fi

# Check pods
log_info "Checking pods..."
PODS=$(kubectl get pods -n $NAMESPACE -o json)
RUNNING_PODS=$(echo "$PODS" | jq -r '.items[] | select(.status.phase == "Running") | .metadata.name' | wc -l)
TOTAL_PODS=$(echo "$PODS" | jq -r '.items[].metadata.name' | wc -l)

if [ "$RUNNING_PODS" -eq "$TOTAL_PODS" ]; then
    check_status "Pods" "healthy" "($RUNNING_PODS/$TOTAL_PODS running)"
else
    check_status "Pods" "degraded" "($RUNNING_PODS/$TOTAL_PODS running)"
    echo "$PODS" | jq -r '.items[] | select(.status.phase != "Running") | "  - \(.metadata.name): \(.status.phase)"'
fi

# Check services
log_info "Checking services..."
SERVICES=$(kubectl get services -n $NAMESPACE -o json | jq -r '.items[].metadata.name')
SERVICE_COUNT=$(echo "$SERVICES" | wc -l)
check_status "Services" "healthy" "($SERVICE_COUNT services)"

# Check persistent volumes
log_info "Checking persistent volumes..."
PVC_BOUND=$(kubectl get pvc -n $NAMESPACE -o json | jq -r '.items[] | select(.status.phase == "Bound") | .metadata.name' | wc -l)
PVC_TOTAL=$(kubectl get pvc -n $NAMESPACE -o json | jq -r '.items[].metadata.name' | wc -l)

if [ "$PVC_TOTAL" -eq 0 ] || [ "$PVC_BOUND" -eq "$PVC_TOTAL" ]; then
    check_status "Persistent Volumes" "healthy" "($PVC_BOUND/$PVC_TOTAL bound)"
else
    check_status "Persistent Volumes" "degraded" "($PVC_BOUND/$PVC_TOTAL bound)"
fi

# Check HPA status
log_info "Checking horizontal pod autoscalers..."
HPA_DATA=$(kubectl get hpa -n $NAMESPACE -o json 2>/dev/null)
if [ $? -eq 0 ] && [ "$(echo "$HPA_DATA" | jq '.items | length')" -gt 0 ]; then
    echo "$HPA_DATA" | jq -r '.items[] | "  - \(.metadata.name): \(.status.currentReplicas)/\(.spec.minReplicas)-\(.spec.maxReplicas) replicas, \(.status.currentCPUUtilizationPercentage // 0)% CPU"'
else
    log_info "No HPA configured"
fi

# Check application health endpoint
log_info "Checking application health endpoint..."
if command -v curl &>/dev/null; then
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 $SERVICE_URL/health || echo "000")
    
    if [ "$HTTP_STATUS" = "200" ]; then
        HEALTH_RESPONSE=$(curl -s --connect-timeout 5 $SERVICE_URL/health?detailed=true)
        APP_STATUS=$(echo "$HEALTH_RESPONSE" | jq -r '.status // "unknown"')
        check_status "Application Health" "$APP_STATUS" "(HTTP $HTTP_STATUS)"
        
        # Check individual services
        echo "$HEALTH_RESPONSE" | jq -r '.services | to_entries[] | "  - \(.key): \(.value.status)"' 2>/dev/null
    else
        check_status "Application Health" "down" "(HTTP $HTTP_STATUS)"
    fi
else
    log_warn "curl not available, skipping HTTP health check"
fi

# Check resource usage
log_info "Checking resource usage..."
if kubectl top nodes &>/dev/null; then
    echo "Node resource usage:"
    kubectl top nodes | head -5
    echo ""
    echo "Pod resource usage (top 5):"
    kubectl top pods -n $NAMESPACE --sort-by=cpu | head -6
else
    log_warn "Metrics server not available, skipping resource usage check"
fi

# Check recent events
log_info "Checking recent warning events..."
WARNING_EVENTS=$(kubectl get events -n $NAMESPACE --field-selector type=Warning -o json | jq -r '.items | length')
if [ "$WARNING_EVENTS" -gt 0 ]; then
    echo -e "${YELLOW}Found $WARNING_EVENTS warning events:${NC}"
    kubectl get events -n $NAMESPACE --field-selector type=Warning --sort-by='.lastTimestamp' | tail -5
else
    check_status "Recent Events" "healthy" "(no warnings)"
fi

# Check certificate expiration
log_info "Checking certificate expiration..."
CERTS=$(kubectl get certificates -n $NAMESPACE -o json 2>/dev/null)
if [ $? -eq 0 ] && [ "$(echo "$CERTS" | jq '.items | length')" -gt 0 ]; then
    echo "$CERTS" | jq -r '.items[] | 
        .metadata.name as $name | 
        .status.notAfter as $expiry | 
        if $expiry then
            (($expiry | fromdateiso8601) - now) / 86400 | floor as $days |
            if $days < 30 then
                "  - \($name): expires in \($days) days ⚠️"
            else
                "  - \($name): expires in \($days) days ✓"
            end
        else
            "  - \($name): no expiry info"
        end'
else
    log_info "No certificates found or cert-manager not installed"
fi

# Summary
echo ""
echo "================================"
echo "Health Check Summary"
echo "================================"
echo "Timestamp: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "Namespace: $NAMESPACE"
echo "Service URL: $SERVICE_URL"
echo ""

# Calculate overall health
CRITICAL_ISSUES=0
if [ "$READY_DEPLOYMENTS" -ne "$TOTAL_DEPLOYMENTS" ]; then
    ((CRITICAL_ISSUES++))
fi
if [ "$RUNNING_PODS" -ne "$TOTAL_PODS" ]; then
    ((CRITICAL_ISSUES++))
fi
if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "000" ]; then
    ((CRITICAL_ISSUES++))
fi

if [ $CRITICAL_ISSUES -eq 0 ]; then
    echo -e "${GREEN}Overall Status: HEALTHY ✓${NC}"
    exit 0
else
    echo -e "${RED}Overall Status: UNHEALTHY ✗${NC}"
    echo "Critical issues found: $CRITICAL_ISSUES"
    exit 1
fi