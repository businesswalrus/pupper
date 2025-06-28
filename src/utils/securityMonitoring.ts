import { redis } from '@db/redis';
import { pool } from '@db/connection';
import { logger } from './logger';
import { auditLogger, AuditEventType, AuditEventSeverity } from './auditLogger';
import { app } from '@bot/app';

interface SecurityAlert {
  id: string;
  type: SecurityAlertType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  metadata: Record<string, any>;
  createdAt: Date;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}

export enum SecurityAlertType {
  MULTIPLE_FAILED_LOGINS = 'multiple_failed_logins',
  SUSPICIOUS_DATA_ACCESS = 'suspicious_data_access',
  RATE_LIMIT_ABUSE = 'rate_limit_abuse',
  POTENTIAL_DATA_BREACH = 'potential_data_breach',
  UNAUTHORIZED_ACCESS = 'unauthorized_access',
  ANOMALOUS_BEHAVIOR = 'anomalous_behavior',
  SYSTEM_VULNERABILITY = 'system_vulnerability',
  COMPLIANCE_VIOLATION = 'compliance_violation',
}

interface SecurityMetric {
  name: string;
  value: number;
  threshold: number;
  window: number; // in seconds
}

export class SecurityMonitor {
  private static readonly ALERT_CHANNEL = process.env.SECURITY_ALERT_CHANNEL || '#security-alerts';
  private static readonly METRICS_PREFIX = 'security:metrics:';
  private static readonly ALERTS_PREFIX = 'security:alerts:';
  
  private static readonly SECURITY_THRESHOLDS = {
    failedLogins: { threshold: 5, window: 300 }, // 5 failed logins in 5 minutes
    dataAccess: { threshold: 1000, window: 3600 }, // 1000 data accesses in 1 hour
    rateLimitHits: { threshold: 10, window: 600 }, // 10 rate limit hits in 10 minutes
    suspiciousPatterns: { threshold: 3, window: 1800 }, // 3 suspicious patterns in 30 minutes
  };
  
  /**
   * Initialize security monitoring
   */
  static async initialize(): Promise<void> {
    try {
      // Create alerts table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS security_alerts (
          id SERIAL PRIMARY KEY,
          alert_id VARCHAR(100) UNIQUE NOT NULL,
          type VARCHAR(50) NOT NULL,
          severity VARCHAR(20) NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          acknowledged BOOLEAN DEFAULT false,
          acknowledged_by VARCHAR(50),
          acknowledged_at TIMESTAMP WITH TIME ZONE,
          
          INDEX idx_alerts_type (type),
          INDEX idx_alerts_severity (severity),
          INDEX idx_alerts_created (created_at),
          INDEX idx_alerts_acknowledged (acknowledged)
        );
      `);
      
      // Create security metrics table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS security_metrics (
          id SERIAL PRIMARY KEY,
          metric_name VARCHAR(100) NOT NULL,
          metric_value NUMERIC NOT NULL,
          metric_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          metadata JSONB DEFAULT '{}',
          
          INDEX idx_metrics_name_time (metric_name, metric_timestamp)
        );
      `);
      
      // Start monitoring loops
      this.startMonitoringLoops();
      
      logger.info('Security monitoring initialized');
    } catch (error) {
      logger.error('Failed to initialize security monitoring', { error: error as Error });
      throw error;
    }
  }
  
  /**
   * Record a security metric
   */
  static async recordMetric(
    name: string,
    value: number,
    metadata?: Record<string, any>
  ): Promise<void> {
    try {
      // Store in Redis for real-time monitoring
      const redisClient = await redis.getClient();
      const key = `${this.METRICS_PREFIX}${name}`;
      const timestamp = Date.now();
      
      await redisClient.zAdd(key, { score: timestamp, value: JSON.stringify({ value, timestamp }) });
      await redisClient.expire(key, 86400); // 24 hour expiry
      
      // Store in database for historical analysis
      await pool.query(`
        INSERT INTO security_metrics (metric_name, metric_value, metadata)
        VALUES ($1, $2, $3)
      `, [name, value, JSON.stringify(metadata || {})]);
      
      // Check thresholds
      await this.checkThresholds(name);
    } catch (error) {
      logger.error('Failed to record security metric', { error: error as Error, metric: name });
    }
  }
  
  /**
   * Create a security alert
   */
  static async createAlert(
    type: SecurityAlertType,
    severity: 'low' | 'medium' | 'high' | 'critical',
    title: string,
    description: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Store alert
      await pool.query(`
        INSERT INTO security_alerts 
        (alert_id, type, severity, title, description, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [alertId, type, severity, title, description, JSON.stringify(metadata || {})]);
      
      // Store in Redis for quick access
      const redisClient = await redis.getClient();
      const alert: SecurityAlert = {
        id: alertId,
        type,
        severity,
        title,
        description,
        metadata: metadata || {},
        createdAt: new Date(),
        acknowledged: false,
      };
      
      await redisClient.setEx(
        `${this.ALERTS_PREFIX}${alertId}`,
        86400 * 7, // 7 days
        JSON.stringify(alert)
      );
      
      // Send notification
      await this.notifySecurityTeam(alert);
      
      // Log to audit
      await auditLogger.log({
        event_type: AuditEventType.SECURITY_VIOLATION,
        severity: severity === 'critical' ? AuditEventSeverity.CRITICAL : AuditEventSeverity.WARNING,
        result: 'failure',
        metadata: {
          alertType: type,
          alertId,
          ...metadata
        }
      });
    } catch (error) {
      logger.error('Failed to create security alert', { error: error as Error, type, severity });
    }
  }
  
  /**
   * Check metric thresholds
   */
  private static async checkThresholds(metricName: string): Promise<void> {
    const threshold = this.SECURITY_THRESHOLDS[metricName as keyof typeof this.SECURITY_THRESHOLDS];
    if (!threshold) return;
    
    try {
      const redisClient = await redis.getClient();
      const key = `${this.METRICS_PREFIX}${metricName}`;
      const windowStart = Date.now() - (threshold.window * 1000);
      
      // Get metrics within window
      const metrics = await redisClient.zRangeByScore(
        key,
        windowStart,
        Date.now()
      );
      
      let totalValue = 0;
      for (const metric of metrics) {
        const data = JSON.parse(metric);
        totalValue += data.value;
      }
      
      if (totalValue >= threshold.threshold) {
        await this.createAlert(
          this.getAlertTypeForMetric(metricName),
          this.getSeverityForThreshold(totalValue, threshold.threshold),
          `${metricName} threshold exceeded`,
          `${metricName} has reached ${totalValue} (threshold: ${threshold.threshold}) in the last ${threshold.window} seconds`,
          {
            metric: metricName,
            currentValue: totalValue,
            threshold: threshold.threshold,
            window: threshold.window
          }
        );
      }
    } catch (error) {
      logger.error('Failed to check threshold', { error: error as Error, metric: metricName });
    }
  }
  
  /**
   * Notify security team about an alert
   */
  private static async notifySecurityTeam(alert: SecurityAlert): Promise<void> {
    try {
      // Send Slack notification
      const blocks = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `🚨 Security Alert: ${alert.title}`,
            emoji: true
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Severity:* ${alert.severity.toUpperCase()}`
            },
            {
              type: 'mrkdwn',
              text: `*Type:* ${alert.type}`
            },
            {
              type: 'mrkdwn',
              text: `*Time:* ${alert.createdAt.toISOString()}`
            },
            {
              type: 'mrkdwn',
              text: `*Alert ID:* ${alert.id}`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Description:*\n${alert.description}`
          }
        }
      ];
      
      if (Object.keys(alert.metadata).length > 0) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Details:*\n\`\`\`${JSON.stringify(alert.metadata, null, 2)}\`\`\``
          }
        });
      }
      
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Acknowledge Alert',
              emoji: true
            },
            value: alert.id,
            action_id: 'acknowledge_alert',
            style: alert.severity === 'critical' ? 'danger' : 'primary'
          }
        ]
      });
      
      await app.client.chat.postMessage({
        channel: this.ALERT_CHANNEL,
        text: `Security Alert: ${alert.title}`,
        blocks
      });
      
      // For critical alerts, also send DM to admins
      if (alert.severity === 'critical') {
        const admins = process.env.SECURITY_ADMIN_IDS?.split(',') || [];
        for (const adminId of admins) {
          await app.client.chat.postMessage({
            channel: adminId,
            text: `🚨 CRITICAL Security Alert: ${alert.title}`,
            blocks
          });
        }
      }
    } catch (error) {
      logger.error('Failed to notify security team', { error: error as Error, alertId: alert.id });
    }
  }
  
  /**
   * Start monitoring loops
   */
  private static startMonitoringLoops(): void {
    // Monitor audit logs for suspicious patterns
    setInterval(async () => {
      await this.monitorAuditLogs();
    }, 60000); // Every minute
    
    // Monitor system health
    setInterval(async () => {
      await this.monitorSystemHealth();
    }, 300000); // Every 5 minutes
    
    // Clean up old metrics
    setInterval(async () => {
      await this.cleanupOldMetrics();
    }, 3600000); // Every hour
  }
  
  /**
   * Monitor audit logs for suspicious patterns
   */
  private static async monitorAuditLogs(): Promise<void> {
    try {
      // Check for multiple failed logins
      const failedLogins = await pool.query(`
        SELECT user_id, COUNT(*) as count
        FROM audit_logs
        WHERE event_type = $1
          AND result = 'failure'
          AND created_at > NOW() - INTERVAL '5 minutes'
        GROUP BY user_id
        HAVING COUNT(*) >= 5
      `, [AuditEventType.AUTH_FAILED]);
      
      for (const row of failedLogins.rows) {
        await this.createAlert(
          SecurityAlertType.MULTIPLE_FAILED_LOGINS,
          'high',
          'Multiple Failed Login Attempts',
          `User ${row.user_id} has failed ${row.count} login attempts in the last 5 minutes`,
          { userId: row.user_id, attempts: row.count }
        );
      }
      
      // Check for excessive data access
      const dataAccess = await pool.query(`
        SELECT user_id, COUNT(*) as count
        FROM audit_logs
        WHERE event_type IN ($1, $2)
          AND created_at > NOW() - INTERVAL '1 hour'
        GROUP BY user_id
        HAVING COUNT(*) > 1000
      `, [AuditEventType.DATA_READ, AuditEventType.DATA_EXPORT]);
      
      for (const row of dataAccess.rows) {
        await this.createAlert(
          SecurityAlertType.SUSPICIOUS_DATA_ACCESS,
          'medium',
          'Excessive Data Access',
          `User ${row.user_id} has accessed data ${row.count} times in the last hour`,
          { userId: row.user_id, accessCount: row.count }
        );
      }
    } catch (error) {
      logger.error('Failed to monitor audit logs', { error: error as Error });
    }
  }
  
  /**
   * Monitor system health
   */
  private static async monitorSystemHealth(): Promise<void> {
    try {
      // Check database connections
      const dbStats = await pool.query(`
        SELECT count(*) as connections
        FROM pg_stat_activity
        WHERE state = 'active'
      `);
      
      await this.recordMetric('db_active_connections', dbStats.rows[0].connections);
      
      // Check Redis memory usage
      const redisClient = await redis.getClient();
      const info = await redisClient.info('memory');
      const memoryUsed = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0');
      
      await this.recordMetric('redis_memory_bytes', memoryUsed);
      
      // Check message queue health
      const queueInfo = await redisClient.lLen('bull:embeddings:wait');
      await this.recordMetric('queue_backlog', queueInfo);
      
    } catch (error) {
      logger.error('Failed to monitor system health', { error: error as Error });
    }
  }
  
  /**
   * Clean up old metrics
   */
  private static async cleanupOldMetrics(): Promise<void> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7); // Keep 7 days of metrics
      
      await pool.query(
        'DELETE FROM security_metrics WHERE metric_timestamp < $1',
        [cutoff]
      );
    } catch (error) {
      logger.error('Failed to cleanup old metrics', { error: error as Error });
    }
  }
  
  /**
   * Get alert type for a metric
   */
  private static getAlertTypeForMetric(metric: string): SecurityAlertType {
    const mapping: Record<string, SecurityAlertType> = {
      failedLogins: SecurityAlertType.MULTIPLE_FAILED_LOGINS,
      dataAccess: SecurityAlertType.SUSPICIOUS_DATA_ACCESS,
      rateLimitHits: SecurityAlertType.RATE_LIMIT_ABUSE,
      suspiciousPatterns: SecurityAlertType.ANOMALOUS_BEHAVIOR,
    };
    
    return mapping[metric] || SecurityAlertType.ANOMALOUS_BEHAVIOR;
  }
  
  /**
   * Get severity based on how much threshold was exceeded
   */
  private static getSeverityForThreshold(
    value: number,
    threshold: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    const ratio = value / threshold;
    
    if (ratio >= 5) return 'critical';
    if (ratio >= 2) return 'high';
    if (ratio >= 1.5) return 'medium';
    return 'low';
  }
  
  /**
   * Acknowledge an alert
   */
  static async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
    await pool.query(`
      UPDATE security_alerts
      SET acknowledged = true,
          acknowledged_by = $1,
          acknowledged_at = CURRENT_TIMESTAMP
      WHERE alert_id = $2
    `, [userId, alertId]);
    
    const redisClient = await redis.getClient();
    await redisClient.del(`${this.ALERTS_PREFIX}${alertId}`);
  }
  
  /**
   * Get active alerts
   */
  static async getActiveAlerts(): Promise<SecurityAlert[]> {
    const result = await pool.query(`
      SELECT * FROM security_alerts
      WHERE acknowledged = false
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY 
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at DESC
    `);
    
    return result.rows.map(row => ({
      id: row.alert_id,
      type: row.type,
      severity: row.severity,
      title: row.title,
      description: row.description,
      metadata: row.metadata,
      createdAt: row.created_at,
      acknowledged: row.acknowledged,
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: row.acknowledged_at,
    }));
  }
}

// Export singleton
export const securityMonitor = SecurityMonitor;