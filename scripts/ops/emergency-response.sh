#!/bin/bash
# Emergency response script for pup.ai v2 incidents

set -euo pipefail

# Configuration
NAMESPACE=${NAMESPACE:-pup-ai}
BACKUP_DIR=${BACKUP_DIR:-/tmp/pup-ai-emergency-$(date +%Y%m%d-%H%M%S)}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Helper functions
log_info() {
    echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} $1"
}

log_error() {
    echo -e "${RED}[$(date +%H:%M:%S)]${NC} $1"
}

confirm_action() {
    local prompt=$1
    echo -ne "${YELLOW}$prompt (y/N): ${NC}"
    read -r response
    [[ "$response" =~ ^[Yy]$ ]]
}

# Emergency actions menu
show_menu() {
    echo ""
    echo -e "${BLUE}=== pup.ai Emergency Response ===${NC}"
    echo ""
    echo "1) Capture diagnostic information"
    echo "2) Scale down non-critical services"
    echo "3) Increase resource limits"
    echo "4) Clear caches and restart"
    echo "5) Enable maintenance mode"
    echo "6) Disable maintenance mode"
    echo "7) Emergency database operations"
    echo "8) Roll back deployment"
    echo "9) Export application state"
    echo "0) Exit"
    echo ""
    echo -n "Select action: "
}

# Function 1: Capture diagnostics
capture_diagnostics() {
    log_info "Capturing diagnostic information..."
    
    # Create diagnostics directory
    DIAG_DIR="$BACKUP_DIR/diagnostics"
    mkdir -p "$DIAG_DIR"
    
    # Capture pod status
    log_info "Capturing pod status..."
    kubectl get pods -n $NAMESPACE -o wide > "$DIAG_DIR/pod-status.txt"
    kubectl describe pods -n $NAMESPACE > "$DIAG_DIR/pod-descriptions.txt"
    
    # Capture recent events
    log_info "Capturing events..."
    kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp' > "$DIAG_DIR/events.txt"
    
    # Capture logs
    log_info "Capturing logs..."
    for pod in $(kubectl get pods -n $NAMESPACE -o jsonpath='{.items[*].metadata.name}'); do
        kubectl logs -n $NAMESPACE $pod --all-containers=true --since=1h > "$DIAG_DIR/logs-$pod.txt" 2>&1 || true
    done
    
    # Capture resource usage
    log_info "Capturing resource usage..."
    kubectl top nodes > "$DIAG_DIR/node-resources.txt" 2>&1 || true
    kubectl top pods -n $NAMESPACE > "$DIAG_DIR/pod-resources.txt" 2>&1 || true
    
    # Capture application metrics
    log_info "Capturing application metrics..."
    kubectl exec -n $NAMESPACE deployment/pup-ai -- curl -s localhost:9090/metrics > "$DIAG_DIR/app-metrics.txt" 2>&1 || true
    
    # Create archive
    tar -czf "$BACKUP_DIR/diagnostics-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$DIAG_DIR" .
    
    log_info "Diagnostics saved to: $BACKUP_DIR/diagnostics-$(date +%Y%m%d-%H%M%S).tar.gz"
}

# Function 2: Scale down non-critical services
scale_down_noncritical() {
    log_warn "This will scale down non-critical services to preserve resources."
    
    if confirm_action "Continue?"; then
        log_info "Scaling down worker deployments..."
        kubectl scale deployment pup-ai-workers --replicas=1 -n $NAMESPACE
        
        log_info "Pausing non-critical queues..."
        kubectl exec -n $NAMESPACE deployment/pup-ai-workers -- node -e "
            const { messageSummaryQueue, userProfileQueue } = require('./dist/workers/queues');
            Promise.all([
                messageSummaryQueue.pause(),
                userProfileQueue.pause()
            ]).then(() => console.log('Non-critical queues paused'));
        " || true
        
        log_info "Non-critical services scaled down"
    fi
}

# Function 3: Increase resource limits
increase_resources() {
    log_warn "This will increase resource limits for critical services."
    
    if confirm_action "Continue?"; then
        log_info "Increasing memory limits..."
        kubectl set resources deployment pup-ai \
            --limits=cpu=4000m,memory=8Gi \
            --requests=cpu=2000m,memory=4Gi \
            -n $NAMESPACE
        
        log_info "Increasing database connection pool..."
        kubectl set env deployment/pup-ai \
            DATABASE_POOL_SIZE=100 \
            DATABASE_POOL_MIN=20 \
            -n $NAMESPACE
        
        log_info "Resources increased. Pods will restart automatically."
    fi
}

# Function 4: Clear caches and restart
clear_caches_restart() {
    log_warn "This will clear all caches and restart the application."
    
    if confirm_action "Continue?"; then
        log_info "Clearing Redis cache..."
        kubectl exec -n $NAMESPACE deployment/pup-ai -- redis-cli FLUSHDB || true
        
        log_info "Clearing application caches..."
        kubectl exec -n $NAMESPACE deployment/pup-ai -- node -e "
            const { clearAllCaches } = require('./dist/utils/cache');
            clearAllCaches().then(() => console.log('Caches cleared'));
        " || true
        
        log_info "Restarting all pods..."
        kubectl rollout restart deployment -n $NAMESPACE
        
        log_info "Waiting for pods to be ready..."
        kubectl rollout status deployment/pup-ai -n $NAMESPACE --timeout=300s
        
        log_info "Application restarted with cleared caches"
    fi
}

# Function 5: Enable maintenance mode
enable_maintenance() {
    log_warn "This will enable maintenance mode. Users will see a maintenance message."
    
    if confirm_action "Continue?"; then
        log_info "Enabling maintenance mode..."
        
        # Create maintenance ConfigMap
        kubectl create configmap maintenance-mode \
            --from-literal=enabled=true \
            --from-literal=message="We are currently performing maintenance. Service will be restored shortly." \
            -n $NAMESPACE \
            --dry-run=client -o yaml | kubectl apply -f -
        
        # Update deployment to use maintenance mode
        kubectl set env deployment/pup-ai MAINTENANCE_MODE=true -n $NAMESPACE
        
        log_info "Maintenance mode enabled"
    fi
}

# Function 6: Disable maintenance mode
disable_maintenance() {
    log_info "Disabling maintenance mode..."
    
    kubectl delete configmap maintenance-mode -n $NAMESPACE --ignore-not-found=true
    kubectl set env deployment/pup-ai MAINTENANCE_MODE- -n $NAMESPACE
    
    log_info "Maintenance mode disabled"
}

# Function 7: Emergency database operations
emergency_db_ops() {
    echo ""
    echo "Database Emergency Operations:"
    echo "1) Kill long-running queries"
    echo "2) Terminate idle connections"
    echo "3) Analyze and vacuum tables"
    echo "4) Reset database statistics"
    echo "5) Back to main menu"
    echo ""
    echo -n "Select operation: "
    read -r db_choice
    
    case $db_choice in
        1)
            log_info "Killing queries running longer than 5 minutes..."
            kubectl exec -n $NAMESPACE deployment/pup-ai -- psql -c "
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes'
                AND state = 'active';
            "
            ;;
        2)
            log_info "Terminating idle connections..."
            kubectl exec -n $NAMESPACE deployment/pup-ai -- psql -c "
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE state = 'idle'
                AND state_change < current_timestamp - interval '10 minutes';
            "
            ;;
        3)
            log_info "Running ANALYZE and VACUUM..."
            kubectl exec -n $NAMESPACE deployment/pup-ai -- psql -c "ANALYZE;" &
            kubectl exec -n $NAMESPACE deployment/pup-ai -- psql -c "VACUUM;" &
            wait
            ;;
        4)
            log_info "Resetting database statistics..."
            kubectl exec -n $NAMESPACE deployment/pup-ai -- psql -c "SELECT pg_stat_reset();"
            ;;
    esac
}

# Function 8: Roll back deployment
rollback_deployment() {
    log_warn "This will roll back to the previous deployment version."
    
    if confirm_action "Continue?"; then
        log_info "Current deployment status:"
        kubectl rollout history deployment/pup-ai -n $NAMESPACE
        
        log_info "Rolling back..."
        kubectl rollout undo deployment/pup-ai -n $NAMESPACE
        
        log_info "Waiting for rollback to complete..."
        kubectl rollout status deployment/pup-ai -n $NAMESPACE --timeout=300s
        
        log_info "Rollback completed"
    fi
}

# Function 9: Export application state
export_state() {
    log_info "Exporting application state..."
    
    STATE_DIR="$BACKUP_DIR/state"
    mkdir -p "$STATE_DIR"
    
    # Export Kubernetes resources
    log_info "Exporting Kubernetes resources..."
    kubectl get all,configmap,secret,pvc -n $NAMESPACE -o yaml > "$STATE_DIR/k8s-resources.yaml"
    
    # Export database schema
    log_info "Exporting database schema..."
    kubectl exec -n $NAMESPACE deployment/pup-ai -- pg_dump --schema-only > "$STATE_DIR/db-schema.sql" 2>/dev/null || true
    
    # Export queue state
    log_info "Exporting queue state..."
    kubectl exec -n $NAMESPACE deployment/pup-ai-workers -- node -e "
        const { exportQueueState } = require('./dist/workers/utils');
        exportQueueState().then(state => console.log(JSON.stringify(state, null, 2)));
    " > "$STATE_DIR/queue-state.json" 2>/dev/null || true
    
    # Create archive
    tar -czf "$BACKUP_DIR/state-export-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$STATE_DIR" .
    
    log_info "State exported to: $BACKUP_DIR/state-export-$(date +%Y%m%d-%H%M%S).tar.gz"
}

# Main script
echo -e "${RED}╔════════════════════════════════════════╗${NC}"
echo -e "${RED}║   pup.ai EMERGENCY RESPONSE SYSTEM     ║${NC}"
echo -e "${RED}╚════════════════════════════════════════╝${NC}"
echo ""
log_warn "This script performs emergency operations. Use with caution!"
echo ""

# Check cluster connectivity
if ! kubectl cluster-info &>/dev/null; then
    log_error "Cannot connect to Kubernetes cluster!"
    exit 1
fi

# Main loop
while true; do
    show_menu
    read -r choice
    
    case $choice in
        1) capture_diagnostics ;;
        2) scale_down_noncritical ;;
        3) increase_resources ;;
        4) clear_caches_restart ;;
        5) enable_maintenance ;;
        6) disable_maintenance ;;
        7) emergency_db_ops ;;
        8) rollback_deployment ;;
        9) export_state ;;
        0) 
            log_info "Exiting emergency response system"
            exit 0 
            ;;
        *)
            log_error "Invalid option"
            ;;
    esac
    
    echo ""
    echo "Press Enter to continue..."
    read -r
done