import { pool } from '@db/connection';
import { logger } from './logger';
import { encryption } from './encryption';

export enum AuditEventType {
  // Authentication events
  AUTH_LOGIN = 'auth.login',
  AUTH_LOGOUT = 'auth.logout',
  AUTH_FAILED = 'auth.failed',
  AUTH_TOKEN_REFRESH = 'auth.token_refresh',
  
  // Data access events
  DATA_READ = 'data.read',
  DATA_WRITE = 'data.write',
  DATA_DELETE = 'data.delete',
  DATA_EXPORT = 'data.export',
  
  // User events
  USER_CREATED = 'user.created',
  USER_UPDATED = 'user.updated',
  USER_DELETED = 'user.deleted',
  USER_PROFILE_VIEWED = 'user.profile_viewed',
  
  // Message events
  MESSAGE_SENT = 'message.sent',
  MESSAGE_EDITED = 'message.edited',
  MESSAGE_DELETED = 'message.deleted',
  MESSAGE_SEARCH = 'message.search',
  
  // Security events
  SECURITY_VIOLATION = 'security.violation',
  SECURITY_RATE_LIMIT = 'security.rate_limit',
  SECURITY_SUSPICIOUS_ACTIVITY = 'security.suspicious',
  SECURITY_ENCRYPTION = 'security.encryption',
  
  // Configuration events
  CONFIG_CHANGED = 'config.changed',
  CONFIG_ACCESSED = 'config.accessed',
  
  // Compliance events
  COMPLIANCE_DATA_REQUEST = 'compliance.data_request',
  COMPLIANCE_DATA_DELETION = 'compliance.data_deletion',
  COMPLIANCE_CONSENT_UPDATED = 'compliance.consent_updated',
}

export enum AuditEventSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

interface AuditEvent {
  event_type: AuditEventType;
  severity: AuditEventSeverity;
  user_id?: string;
  resource_type?: string;
  resource_id?: string;
  action?: string;
  result: 'success' | 'failure';
  metadata?: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  error_message?: string;
}

export class AuditLogger {
  private static initialized = false;
  
  /**
   * Initialize audit logging system
   */
  static async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Create audit log table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(100) NOT NULL,
          severity VARCHAR(20) NOT NULL,
          user_id VARCHAR(50),
          resource_type VARCHAR(50),
          resource_id VARCHAR(100),
          action VARCHAR(50),
          result VARCHAR(20) NOT NULL,
          metadata JSONB DEFAULT '{}',
          ip_address INET,
          user_agent TEXT,
          session_id VARCHAR(100),
          error_message TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          
          -- Indexes for performance
          INDEX idx_audit_event_type (event_type),
          INDEX idx_audit_user_id (user_id),
          INDEX idx_audit_created_at (created_at),
          INDEX idx_audit_severity (severity),
          INDEX idx_audit_resource (resource_type, resource_id)
        );
      `);
      
      // Create audit log retention policy table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_retention_policies (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(100) NOT NULL UNIQUE,
          retention_days INTEGER NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      // Insert default retention policies
      await this.initializeDefaultRetentionPolicies();
      
      this.initialized = true;
      logger.info('Audit logging system initialized');
    } catch (error) {
      logger.error('Failed to initialize audit logging', { error: error as Error });
      throw error;
    }
  }
  
  /**
   * Log an audit event
   */
  static async log(event: AuditEvent): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      // Sanitize metadata to remove sensitive information
      const sanitizedMetadata = this.sanitizeMetadata(event.metadata || {});
      
      // Insert audit log
      await pool.query(`
        INSERT INTO audit_logs (
          event_type, severity, user_id, resource_type, resource_id,
          action, result, metadata, ip_address, user_agent, session_id, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        event.event_type,
        event.severity,
        event.user_id,
        event.resource_type,
        event.resource_id,
        event.action,
        event.result,
        JSON.stringify(sanitizedMetadata),
        event.ip_address,
        event.user_agent,
        event.session_id,
        event.error_message
      ]);
      
      // Log critical events to system logger as well
      if (event.severity === AuditEventSeverity.CRITICAL) {
        logger.error('Critical audit event', { auditEvent: event });
      }
      
      // Check for suspicious patterns
      await this.checkSuspiciousActivity(event);
    } catch (error) {
      logger.error('Failed to log audit event', { error: error as Error, event });
    }
  }
  
  /**
   * Log a security event
   */
  static async logSecurityEvent(
    type: AuditEventType,
    userId: string | undefined,
    details: Record<string, any>,
    severity: AuditEventSeverity = AuditEventSeverity.WARNING
  ): Promise<void> {
    await this.log({
      event_type: type,
      severity,
      user_id: userId,
      result: 'failure',
      metadata: details,
    });
  }
  
  /**
   * Log data access
   */
  static async logDataAccess(
    userId: string,
    resourceType: string,
    resourceId: string,
    action: 'read' | 'write' | 'delete',
    success: boolean = true
  ): Promise<void> {
    const eventTypeMap = {
      read: AuditEventType.DATA_READ,
      write: AuditEventType.DATA_WRITE,
      delete: AuditEventType.DATA_DELETE,
    };
    
    await this.log({
      event_type: eventTypeMap[action],
      severity: AuditEventSeverity.INFO,
      user_id: userId,
      resource_type: resourceType,
      resource_id: resourceId,
      action,
      result: success ? 'success' : 'failure',
    });
  }
  
  /**
   * Query audit logs
   */
  static async query(filters: {
    eventType?: AuditEventType;
    userId?: string;
    resourceType?: string;
    resourceId?: string;
    startDate?: Date;
    endDate?: Date;
    severity?: AuditEventSeverity;
    limit?: number;
  }): Promise<any[]> {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;
    
    if (filters.eventType) {
      query += ` AND event_type = $${paramIndex++}`;
      params.push(filters.eventType);
    }
    
    if (filters.userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(filters.userId);
    }
    
    if (filters.resourceType) {
      query += ` AND resource_type = $${paramIndex++}`;
      params.push(filters.resourceType);
    }
    
    if (filters.resourceId) {
      query += ` AND resource_id = $${paramIndex++}`;
      params.push(filters.resourceId);
    }
    
    if (filters.severity) {
      query += ` AND severity = $${paramIndex++}`;
      params.push(filters.severity);
    }
    
    if (filters.startDate) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(filters.startDate);
    }
    
    if (filters.endDate) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(filters.endDate);
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (filters.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }
    
    const result = await pool.query(query, params);
    return result.rows;
  }
  
  /**
   * Clean up old audit logs based on retention policies
   */
  static async cleanupOldLogs(): Promise<void> {
    try {
      const policies = await pool.query('SELECT * FROM audit_retention_policies');
      
      for (const policy of policies.rows) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - policy.retention_days);
        
        const result = await pool.query(
          'DELETE FROM audit_logs WHERE event_type = $1 AND created_at < $2',
          [policy.event_type, cutoffDate]
        );
        
        if (result.rowCount > 0) {
          logger.info('Cleaned up old audit logs', {
            eventType: policy.event_type,
            deletedCount: result.rowCount,
            cutoffDate
          });
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old audit logs', { error: error as Error });
    }
  }
  
  /**
   * Generate audit report
   */
  static async generateReport(startDate: Date, endDate: Date): Promise<any> {
    const summary = await pool.query(`
      SELECT 
        event_type,
        severity,
        result,
        COUNT(*) as count
      FROM audit_logs
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY event_type, severity, result
      ORDER BY count DESC
    `, [startDate, endDate]);
    
    const userActivity = await pool.query(`
      SELECT 
        user_id,
        COUNT(*) as event_count,
        COUNT(DISTINCT event_type) as unique_events
      FROM audit_logs
      WHERE created_at BETWEEN $1 AND $2
        AND user_id IS NOT NULL
      GROUP BY user_id
      ORDER BY event_count DESC
      LIMIT 20
    `, [startDate, endDate]);
    
    const securityEvents = await pool.query(`
      SELECT *
      FROM audit_logs
      WHERE created_at BETWEEN $1 AND $2
        AND (severity IN ('warning', 'error', 'critical')
             OR event_type LIKE 'security.%')
      ORDER BY created_at DESC
    `, [startDate, endDate]);
    
    return {
      period: { startDate, endDate },
      summary: summary.rows,
      topUsers: userActivity.rows,
      securityEvents: securityEvents.rows,
      generatedAt: new Date(),
    };
  }
  
  /**
   * Check for suspicious activity patterns
   */
  private static async checkSuspiciousActivity(event: AuditEvent): Promise<void> {
    if (!event.user_id) return;
    
    // Check for rapid failed authentication attempts
    if (event.event_type === AuditEventType.AUTH_FAILED) {
      const recentFailures = await pool.query(`
        SELECT COUNT(*) as count
        FROM audit_logs
        WHERE user_id = $1
          AND event_type = $2
          AND result = 'failure'
          AND created_at > NOW() - INTERVAL '5 minutes'
      `, [event.user_id, AuditEventType.AUTH_FAILED]);
      
      if (recentFailures.rows[0].count >= 5) {
        await this.logSecurityEvent(
          AuditEventType.SECURITY_SUSPICIOUS_ACTIVITY,
          event.user_id,
          { reason: 'Multiple failed authentication attempts', count: recentFailures.rows[0].count },
          AuditEventSeverity.CRITICAL
        );
      }
    }
    
    // Check for unusual data access patterns
    if (event.event_type === AuditEventType.DATA_READ) {
      const recentAccess = await pool.query(`
        SELECT COUNT(*) as count
        FROM audit_logs
        WHERE user_id = $1
          AND event_type = $2
          AND created_at > NOW() - INTERVAL '1 minute'
      `, [event.user_id, AuditEventType.DATA_READ]);
      
      if (recentAccess.rows[0].count >= 100) {
        await this.logSecurityEvent(
          AuditEventType.SECURITY_SUSPICIOUS_ACTIVITY,
          event.user_id,
          { reason: 'Excessive data access', count: recentAccess.rows[0].count },
          AuditEventSeverity.WARNING
        );
      }
    }
  }
  
  /**
   * Sanitize metadata to remove sensitive information
   */
  private static sanitizeMetadata(metadata: Record<string, any>): Record<string, any> {
    const sanitized = { ...metadata };
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'credential'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }
  
  /**
   * Initialize default retention policies
   */
  private static async initializeDefaultRetentionPolicies(): Promise<void> {
    const defaultPolicies = [
      { event_type: 'auth.%', retention_days: 90 },
      { event_type: 'data.%', retention_days: 365 },
      { event_type: 'user.%', retention_days: 365 },
      { event_type: 'message.%', retention_days: 180 },
      { event_type: 'security.%', retention_days: 730 }, // 2 years
      { event_type: 'config.%', retention_days: 365 },
      { event_type: 'compliance.%', retention_days: 2555 }, // 7 years
    ];
    
    for (const policy of defaultPolicies) {
      await pool.query(`
        INSERT INTO audit_retention_policies (event_type, retention_days)
        VALUES ($1, $2)
        ON CONFLICT (event_type) DO NOTHING
      `, [policy.event_type, policy.retention_days]);
    }
  }
}

// Export singleton
export const auditLogger = AuditLogger;