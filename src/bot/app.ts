import { App, ExpressReceiver } from '@slack/bolt';
import { config } from '@utils/config';
import { securityHeaders, corsOptions, requestLimits } from '@utils/security';
import { logger } from '@utils/logger';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { redis } from '@db/redis';

// Create Express app with security features
const expressApp = express();

// Trust proxy for accurate IP addresses
expressApp.set('trust proxy', 1);

// Security middleware
expressApp.use(helmet({
  contentSecurityPolicy: false, // We set our own CSP
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// CORS
expressApp.use(cors(corsOptions));

// Request size limits
expressApp.use(express.json({ limit: requestLimits.json }));
expressApp.use(express.urlencoded(requestLimits.urlencoded));

// Create Express receiver for Bolt
const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  app: expressApp,
});

// Session management setup
const setupSession = async () => {
  try {
    const redisClient = await redis.getClient();
    const redisStore = new RedisStore({
      client: redisClient,
      prefix: 'session:',
    });
    
    const sessionMiddleware = session({
      store: redisStore,
      secret: process.env.SESSION_SECRET || config.slack.signingSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.app.nodeEnv === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        sameSite: 'strict'
      },
      name: 'pup.session',
      genid: () => {
        const { encryption } = require('@utils/encryption');
        return encryption.generateSecureToken();
      }
    });
    
    expressApp.use(sessionMiddleware);
    logger.info('Session management initialized');
  } catch (error) {
    logger.error('Failed to initialize session', { error: error as Error });
  }
};

// Initialize session management
setupSession();

// Apply custom security headers
expressApp.use(securityHeaders);

// Create Bolt app with custom receiver
export const app = new App({
  token: config.slack.botToken,
  socketMode: true,
  appToken: config.slack.appToken,
  receiver,
});

// Add custom routes
expressApp.get('/health', async (req, res) => {
  const { healthCheckHandler } = await import('@utils/health');
  await healthCheckHandler(req, res);
});

// Security alerts endpoint
expressApp.get('/api/security/alerts', async (req: any, res: any) => {
  try {
    const { securityMonitor } = await import('@utils/securityMonitoring');
    const { CSRFProtection } = await import('@utils/security');
    
    // Generate CSRF token for API access
    if (req.session?.id) {
      const csrfToken = await CSRFProtection.generateToken(req.session.id);
      res.setHeader('X-CSRF-Token', csrfToken);
    }
    
    const alerts = await securityMonitor.getActiveAlerts();
    res.json({ alerts, success: true });
  } catch (error) {
    logger.error('Failed to get security alerts', { error: error as Error });
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

// GDPR data export endpoint
expressApp.post('/api/gdpr/export/:userId', async (req: any, res: any) => {
  try {
    const { GDPRCompliance } = await import('@utils/dataRetention');
    const { auditLogger, AuditEventType, AuditEventSeverity } = await import('@utils/auditLogger');
    
    const requestId = await GDPRCompliance.exportUserData(req.params.userId);
    
    await auditLogger.log({
      event_type: AuditEventType.COMPLIANCE_DATA_REQUEST,
      severity: AuditEventSeverity.INFO,
      user_id: req.params.userId,
      result: 'success',
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      metadata: { requestId }
    });
    
    res.json({ requestId, message: 'Export request created' });
  } catch (error) {
    logger.error('GDPR export failed', { error: error as Error });
    res.status(500).json({ error: 'Export request failed' });
  }
});

// GDPR data deletion endpoint
expressApp.post('/api/gdpr/delete/:userId', async (req: any, res: any) => {
  try {
    const { GDPRCompliance } = await import('@utils/dataRetention');
    const { auditLogger, AuditEventType, AuditEventSeverity } = await import('@utils/auditLogger');
    
    const requestId = await GDPRCompliance.deleteUserData(
      req.params.userId,
      req.body.scope || 'all'
    );
    
    await auditLogger.log({
      event_type: AuditEventType.COMPLIANCE_DATA_DELETION,
      severity: AuditEventSeverity.INFO,
      user_id: req.params.userId,
      result: 'success',
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      metadata: { requestId, scope: req.body.scope || 'all' }
    });
    
    res.json({ requestId, message: 'Deletion request created' });
  } catch (error) {
    logger.error('GDPR deletion failed', { error: error as Error });
    res.status(500).json({ error: 'Deletion request failed' });
  }
});

// Consent management endpoint
expressApp.post('/api/gdpr/consent/:userId', async (req: any, res: any) => {
  try {
    const { GDPRCompliance } = await import('@utils/dataRetention');
    
    await GDPRCompliance.recordConsent(
      req.params.userId,
      req.body.consentType,
      req.body.granted,
      req.ip,
      req.headers['user-agent']
    );
    
    res.json({ success: true, message: 'Consent recorded' });
  } catch (error) {
    logger.error('Consent recording failed', { error: error as Error });
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// Security metrics endpoint
expressApp.get('/api/security/metrics', async (req: any, res: any) => {
  try {
    const { pool } = await import('@db/connection');
    
    const metrics = await pool.query(`
      SELECT 
        metric_name,
        AVG(metric_value) as avg_value,
        MAX(metric_value) as max_value,
        MIN(metric_value) as min_value,
        COUNT(*) as data_points
      FROM security_metrics
      WHERE metric_timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY metric_name
    `);
    
    res.json({ metrics: metrics.rows, success: true });
  } catch (error) {
    logger.error('Failed to get security metrics', { error: error as Error });
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

// Initialize security features
export async function initializeSecurity() {
  try {
    // Initialize encryption
    const { encryption } = await import('@utils/encryption');
    const masterSecret = process.env.ENCRYPTION_MASTER_KEY || config.slack.signingSecret;
    await encryption.initialize(masterSecret);
    
    // Initialize audit logging
    const { auditLogger } = await import('@utils/auditLogger');
    await auditLogger.initialize();
    
    // Initialize data retention
    const { DataRetentionService, GDPRCompliance } = await import('@utils/dataRetention');
    await DataRetentionService.initialize();
    await GDPRCompliance.initialize();
    
    // Initialize security monitoring
    const { securityMonitor } = await import('@utils/securityMonitoring');
    await securityMonitor.initialize();
    
    // Register security middleware
    const { securityMiddleware } = await import('@bot/middleware/security');
    securityMiddleware.registerAll(app);
    
    // Schedule periodic security tasks
    scheduleSecurityTasks();
    
    logger.info('Security features initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize security features', { error: error as Error });
    throw error;
  }
}

// Schedule periodic security tasks
function scheduleSecurityTasks() {
  // Data retention cleanup - daily at 2 AM
  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour === 2) {
      const { DataRetentionService } = await import('@utils/dataRetention');
      await DataRetentionService.executeRetention();
    }
  }, 3600000); // Check every hour
  
  // Audit log cleanup - daily at 3 AM
  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour === 3) {
      const { auditLogger } = await import('@utils/auditLogger');
      await auditLogger.cleanupOldLogs();
    }
  }, 3600000); // Check every hour
  
  logger.info('Security tasks scheduled');
}