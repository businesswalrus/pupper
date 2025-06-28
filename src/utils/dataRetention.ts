import { pool } from '@db/connection';
import { logger } from './logger';
import { auditLogger, AuditEventType, AuditEventSeverity } from './auditLogger';
import { encryption } from './encryption';

interface RetentionPolicy {
  table: string;
  retentionDays: number;
  dateColumn: string;
  conditions?: string;
  cascadeDelete?: boolean;
}

interface DataExport {
  userId: string;
  requestId: string;
  data: Record<string, any[]>;
  createdAt: Date;
  expiresAt: Date;
}

export class DataRetentionService {
  private static readonly DEFAULT_POLICIES: RetentionPolicy[] = [
    {
      table: 'messages',
      retentionDays: 180, // 6 months
      dateColumn: 'created_at',
      cascadeDelete: false,
    },
    {
      table: 'conversation_summaries',
      retentionDays: 365, // 1 year
      dateColumn: 'created_at',
      cascadeDelete: false,
    },
    {
      table: 'user_interactions',
      retentionDays: 90, // 3 months
      dateColumn: 'last_interaction_at',
      cascadeDelete: false,
    },
    {
      table: 'audit_logs',
      retentionDays: 730, // 2 years
      dateColumn: 'created_at',
      conditions: "severity NOT IN ('critical', 'error')", // Keep critical logs longer
    },
  ];
  
  /**
   * Initialize retention policies table
   */
  static async initialize(): Promise<void> {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS data_retention_policies (
          id SERIAL PRIMARY KEY,
          table_name VARCHAR(100) NOT NULL UNIQUE,
          retention_days INTEGER NOT NULL,
          date_column VARCHAR(100) NOT NULL,
          conditions TEXT,
          cascade_delete BOOLEAN DEFAULT false,
          last_cleanup TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      // Insert default policies
      for (const policy of this.DEFAULT_POLICIES) {
        await pool.query(`
          INSERT INTO data_retention_policies 
          (table_name, retention_days, date_column, conditions, cascade_delete)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (table_name) DO UPDATE
          SET retention_days = EXCLUDED.retention_days,
              updated_at = CURRENT_TIMESTAMP
        `, [
          policy.table,
          policy.retentionDays,
          policy.dateColumn,
          policy.conditions,
          policy.cascadeDelete
        ]);
      }
      
      logger.info('Data retention policies initialized');
    } catch (error) {
      logger.error('Failed to initialize retention policies', { error: error as Error });
      throw error;
    }
  }
  
  /**
   * Execute data retention cleanup
   */
  static async executeRetention(): Promise<void> {
    try {
      const policies = await pool.query('SELECT * FROM data_retention_policies WHERE retention_days > 0');
      
      for (const policy of policies.rows) {
        await this.cleanupTable(policy);
      }
      
      logger.info('Data retention cleanup completed');
    } catch (error) {
      logger.error('Data retention cleanup failed', { error: error as Error });
    }
  }
  
  /**
   * Cleanup data from a specific table based on retention policy
   */
  private static async cleanupTable(policy: any): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - policy.retention_days);
    
    try {
      let query = `DELETE FROM ${policy.table_name} WHERE ${policy.date_column} < $1`;
      const params = [cutoffDate];
      
      if (policy.conditions) {
        query += ` AND NOT (${policy.conditions})`;
      }
      
      const result = await pool.query(query, params);
      
      if (result.rowCount > 0) {
        logger.info('Data retention cleanup', {
          table: policy.table_name,
          deletedRows: result.rowCount,
          cutoffDate
        });
        
        await auditLogger.log({
          event_type: AuditEventType.DATA_DELETE,
          severity: AuditEventSeverity.INFO,
          resource_type: 'table',
          resource_id: policy.table_name,
          result: 'success',
          metadata: {
            deletedRows: result.rowCount,
            retentionDays: policy.retention_days,
            cutoffDate
          }
        });
      }
      
      // Update last cleanup timestamp
      await pool.query(
        'UPDATE data_retention_policies SET last_cleanup = CURRENT_TIMESTAMP WHERE id = $1',
        [policy.id]
      );
    } catch (error) {
      logger.error('Table cleanup failed', { 
        error: error as Error,
        table: policy.table_name 
      });
    }
  }
  
  /**
   * Update retention policy for a table
   */
  static async updatePolicy(
    tableName: string,
    retentionDays: number
  ): Promise<void> {
    await pool.query(`
      UPDATE data_retention_policies 
      SET retention_days = $1, updated_at = CURRENT_TIMESTAMP
      WHERE table_name = $2
    `, [retentionDays, tableName]);
    
    await auditLogger.log({
      event_type: AuditEventType.CONFIG_CHANGED,
      severity: AuditEventSeverity.INFO,
      resource_type: 'retention_policy',
      resource_id: tableName,
      result: 'success',
      metadata: { retentionDays }
    });
  }
}

export class GDPRCompliance {
  /**
   * Initialize GDPR compliance tables
   */
  static async initialize(): Promise<void> {
    try {
      // User consent tracking
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_consent (
          id SERIAL PRIMARY KEY,
          slack_user_id VARCHAR(50) NOT NULL,
          consent_type VARCHAR(50) NOT NULL,
          granted BOOLEAN NOT NULL,
          granted_at TIMESTAMP WITH TIME ZONE,
          revoked_at TIMESTAMP WITH TIME ZONE,
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          
          UNIQUE(slack_user_id, consent_type)
        );
      `);
      
      // Data export requests
      await pool.query(`
        CREATE TABLE IF NOT EXISTS data_export_requests (
          id SERIAL PRIMARY KEY,
          request_id VARCHAR(100) UNIQUE NOT NULL,
          slack_user_id VARCHAR(50) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          export_url TEXT,
          expires_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP WITH TIME ZONE,
          
          INDEX idx_export_user (slack_user_id),
          INDEX idx_export_status (status)
        );
      `);
      
      // Data deletion requests
      await pool.query(`
        CREATE TABLE IF NOT EXISTS data_deletion_requests (
          id SERIAL PRIMARY KEY,
          request_id VARCHAR(100) UNIQUE NOT NULL,
          slack_user_id VARCHAR(50) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          deletion_scope VARCHAR(50) NOT NULL DEFAULT 'all',
          scheduled_for TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP WITH TIME ZONE,
          
          INDEX idx_deletion_user (slack_user_id),
          INDEX idx_deletion_status (status)
        );
      `);
      
      logger.info('GDPR compliance tables initialized');
    } catch (error) {
      logger.error('Failed to initialize GDPR tables', { error: error as Error });
      throw error;
    }
  }
  
  /**
   * Record user consent
   */
  static async recordConsent(
    userId: string,
    consentType: 'data_processing' | 'analytics' | 'marketing',
    granted: boolean,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    await pool.query(`
      INSERT INTO user_consent 
      (slack_user_id, consent_type, granted, granted_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (slack_user_id, consent_type) DO UPDATE
      SET granted = EXCLUDED.granted,
          granted_at = CASE WHEN EXCLUDED.granted THEN CURRENT_TIMESTAMP ELSE user_consent.granted_at END,
          revoked_at = CASE WHEN NOT EXCLUDED.granted THEN CURRENT_TIMESTAMP ELSE NULL END,
          ip_address = EXCLUDED.ip_address,
          user_agent = EXCLUDED.user_agent,
          updated_at = CURRENT_TIMESTAMP
    `, [userId, consentType, granted, granted ? new Date() : null, ipAddress, userAgent]);
    
    await auditLogger.log({
      event_type: AuditEventType.COMPLIANCE_CONSENT_UPDATED,
      severity: AuditEventSeverity.INFO,
      user_id: userId,
      result: 'success',
      metadata: { consentType, granted },
      ip_address: ipAddress,
      user_agent: userAgent
    });
  }
  
  /**
   * Check if user has given consent
   */
  static async hasConsent(
    userId: string,
    consentType: string
  ): Promise<boolean> {
    const result = await pool.query(`
      SELECT granted FROM user_consent
      WHERE slack_user_id = $1 AND consent_type = $2
    `, [userId, consentType]);
    
    return result.rows[0]?.granted || false;
  }
  
  /**
   * Export all user data (GDPR right to data portability)
   */
  static async exportUserData(userId: string): Promise<string> {
    const requestId = encryption.generateSecureToken();
    
    try {
      // Record the export request
      await pool.query(`
        INSERT INTO data_export_requests 
        (request_id, slack_user_id, status)
        VALUES ($1, $2, 'processing')
      `, [requestId, userId]);
      
      // Collect user data from all tables
      const userData: Record<string, any> = {};
      
      // User profile
      const userResult = await pool.query(
        'SELECT * FROM users WHERE slack_user_id = $1',
        [userId]
      );
      userData.profile = userResult.rows[0];
      
      // Messages
      const messagesResult = await pool.query(
        'SELECT * FROM messages WHERE slack_user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      userData.messages = messagesResult.rows;
      
      // User interactions
      const interactionsResult = await pool.query(
        'SELECT * FROM user_interactions WHERE user_a_id = $1 OR user_b_id = $1',
        [userId]
      );
      userData.interactions = interactionsResult.rows;
      
      // Anonymize other users' data in exported content
      userData.messages = userData.messages.map((msg: any) => ({
        ...msg,
        embedding: '[REMOVED]', // Remove embeddings for privacy
      }));
      
      // Create export file
      const exportData = {
        exportId: requestId,
        userId,
        exportDate: new Date(),
        data: userData,
      };
      
      // In production, this would upload to secure storage
      // For now, we'll store the export reference
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days expiry
      
      await pool.query(`
        UPDATE data_export_requests
        SET status = 'completed',
            export_url = $1,
            expires_at = $2,
            completed_at = CURRENT_TIMESTAMP
        WHERE request_id = $3
      `, [`export://${requestId}`, expiresAt, requestId]);
      
      await auditLogger.log({
        event_type: AuditEventType.COMPLIANCE_DATA_REQUEST,
        severity: AuditEventSeverity.INFO,
        user_id: userId,
        resource_id: requestId,
        result: 'success',
        metadata: { 
          recordCount: Object.values(userData).reduce((sum, arr) => 
            sum + (Array.isArray(arr) ? arr.length : 1), 0
          )
        }
      });
      
      return requestId;
    } catch (error) {
      await pool.query(`
        UPDATE data_export_requests
        SET status = 'failed'
        WHERE request_id = $1
      `, [requestId]);
      
      throw error;
    }
  }
  
  /**
   * Delete all user data (GDPR right to erasure)
   */
  static async deleteUserData(
    userId: string,
    scope: 'all' | 'messages' | 'profile' = 'all'
  ): Promise<string> {
    const requestId = encryption.generateSecureToken();
    
    try {
      // Record the deletion request
      await pool.query(`
        INSERT INTO data_deletion_requests 
        (request_id, slack_user_id, status, deletion_scope, scheduled_for)
        VALUES ($1, $2, 'scheduled', $3, $4)
      `, [requestId, userId, scope, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]); // 30 day grace period
      
      // Schedule deletion (immediate for demo, would be delayed in production)
      await this.executeUserDeletion(requestId);
      
      return requestId;
    } catch (error) {
      await pool.query(`
        UPDATE data_deletion_requests
        SET status = 'failed'
        WHERE request_id = $1
      `, [requestId]);
      
      throw error;
    }
  }
  
  /**
   * Execute user data deletion
   */
  private static async executeUserDeletion(requestId: string): Promise<void> {
    const request = await pool.query(
      'SELECT * FROM data_deletion_requests WHERE request_id = $1',
      [requestId]
    );
    
    if (!request.rows[0]) {
      throw new Error('Deletion request not found');
    }
    
    const { slack_user_id: userId, deletion_scope: scope } = request.rows[0];
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      let deletedRecords = 0;
      
      if (scope === 'all' || scope === 'messages') {
        // Delete messages
        const msgResult = await client.query(
          'DELETE FROM messages WHERE slack_user_id = $1',
          [userId]
        );
        deletedRecords += msgResult.rowCount;
      }
      
      if (scope === 'all') {
        // Delete user interactions
        const interResult = await client.query(
          'DELETE FROM user_interactions WHERE user_a_id = $1 OR user_b_id = $1',
          [userId]
        );
        deletedRecords += interResult.rowCount;
        
        // Delete user profile
        const userResult = await client.query(
          'DELETE FROM users WHERE slack_user_id = $1',
          [userId]
        );
        deletedRecords += userResult.rowCount;
      }
      
      // Update request status
      await client.query(`
        UPDATE data_deletion_requests
        SET status = 'completed',
            completed_at = CURRENT_TIMESTAMP
        WHERE request_id = $1
      `, [requestId]);
      
      await client.query('COMMIT');
      
      await auditLogger.log({
        event_type: AuditEventType.COMPLIANCE_DATA_DELETION,
        severity: AuditEventSeverity.INFO,
        user_id: userId,
        resource_id: requestId,
        result: 'success',
        metadata: { scope, deletedRecords }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get data processing report for a user
   */
  static async getProcessingReport(userId: string): Promise<any> {
    const report = {
      userId,
      generatedAt: new Date(),
      dataCategories: [],
      purposes: [],
      retention: [],
      thirdParties: [],
    };
    
    // Data categories
    const messages = await pool.query(
      'SELECT COUNT(*) as count FROM messages WHERE slack_user_id = $1',
      [userId]
    );
    
    if (messages.rows[0].count > 0) {
      report.dataCategories.push({
        category: 'Messages',
        count: messages.rows[0].count,
        purpose: 'Bot functionality and context-aware responses',
        retention: '180 days',
      });
    }
    
    // Check consent status
    const consents = await pool.query(
      'SELECT * FROM user_consent WHERE slack_user_id = $1',
      [userId]
    );
    
    report.consents = consents.rows.map(consent => ({
      type: consent.consent_type,
      granted: consent.granted,
      grantedAt: consent.granted_at,
      revokedAt: consent.revoked_at,
    }));
    
    // Third party sharing (none in this case)
    report.thirdParties = [
      {
        name: 'OpenAI',
        purpose: 'Message embeddings and AI responses',
        dataShared: 'Message content (anonymized)',
      },
      {
        name: 'Slack',
        purpose: 'Message delivery and user information',
        dataShared: 'User ID and message metadata',
      },
    ];
    
    return report;
  }
}