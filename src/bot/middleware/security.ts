import { Request, Response, NextFunction } from 'express';
import { SlackEventMiddlewareArgs, SlackCommandMiddlewareArgs } from '@slack/bolt';
import { config } from '@utils/config';
import { logger } from '@utils/logger';
import { RateLimiter } from '@utils/rateLimiter';
import { SlackAuthenticator } from '@utils/slackAuth';
import { InputSanitizer } from '@utils/sanitization';
import { auditLogger, AuditEventType, AuditEventSeverity } from '@utils/auditLogger';
import { SecurityContext, IPAccessControl, CSRFProtection } from '@utils/security';
import { encryption } from '@utils/encryption';

// Initialize encryption service
const initializeEncryption = async () => {
  const masterSecret = process.env.ENCRYPTION_MASTER_KEY || config.slack.signingSecret;
  await encryption.initialize(masterSecret);
};

// Call initialization
initializeEncryption().catch(error => {
  logger.error('Failed to initialize encryption', { error });
  process.exit(1);
});

/**
 * Slack event authentication middleware
 */
export async function slackEventAuth({ 
  event, 
  context, 
  next 
}: SlackEventMiddlewareArgs<'message' | 'app_mention'>) {
  try {
    // Skip for bot's own messages
    if ('user' in event && event.user === config.slack.myUserId) {
      return;
    }
    
    // Validate event structure
    if (!event || typeof event !== 'object') {
      logger.warn('Invalid event structure');
      return;
    }
    
    // Create security context
    const securityContext = new SecurityContext(context.retryNum?.toString() || 'default');
    
    if ('user' in event && event.user) {
      // Basic permissions for all authenticated users
      await securityContext.authenticate(event.user, ['message.read', 'message.write']);
      
      // Store security context
      context.securityContext = securityContext;
    }
    
    await next();
  } catch (error) {
    logger.error('Slack event auth failed', { error: error as Error });
    // Don't throw - let Slack retry
  }
}

/**
 * Rate limiting middleware for Slack events
 */
export async function slackRateLimit({ 
  event, 
  next 
}: SlackEventMiddlewareArgs<'message' | 'app_mention'>) {
  if (!('user' in event) || !event.user) {
    await next();
    return;
  }
  
  try {
    // Check rate limit
    const result = await RateLimiter.checkLimit(event.user, 'message');
    
    if (!result.allowed) {
      logger.warn('Rate limit exceeded for Slack user', {
        userId: event.user,
        remaining: result.remaining,
        resetAt: result.resetAt
      });
      
      await auditLogger.logSecurityEvent(
        AuditEventType.SECURITY_RATE_LIMIT,
        event.user,
        { 
          limitType: 'message',
          resetAt: result.resetAt 
        }
      );
      
      // Don't process the message
      return;
    }
    
    await next();
  } catch (error) {
    logger.error('Rate limit check failed', { error: error as Error });
    // Continue on error
    await next();
  }
}

/**
 * Input sanitization middleware
 */
export async function sanitizeInput({ 
  event, 
  context,
  next 
}: SlackEventMiddlewareArgs<'message' | 'app_mention'>) {
  try {
    // Sanitize message text
    if ('text' in event && event.text) {
      const sanitized = InputSanitizer.sanitizeMessage(event.text);
      
      // Check for prompt injection
      if (InputSanitizer.detectPromptInjection(event.text)) {
        logger.warn('Potential prompt injection detected', {
          user: 'user' in event ? event.user : 'unknown',
          text: sanitized.substring(0, 100)
        });
        
        await auditLogger.logSecurityEvent(
          AuditEventType.SECURITY_SUSPICIOUS_ACTIVITY,
          'user' in event ? event.user : undefined,
          { reason: 'Potential prompt injection' }
        );
        
        // Add flag to context
        context.suspiciousContent = true;
      }
      
      // Store sanitized version
      context.sanitizedText = sanitized;
    }
    
    await next();
  } catch (error) {
    logger.error('Input sanitization failed', { error: error as Error });
    await next();
  }
}

/**
 * Audit logging middleware
 */
export async function auditLog({ 
  event, 
  context,
  next 
}: SlackEventMiddlewareArgs<'message' | 'app_mention'>) {
  const startTime = Date.now();
  
  try {
    await next();
    
    // Log successful message processing
    if ('user' in event && event.user && 'channel' in event) {
      await auditLogger.log({
        event_type: AuditEventType.MESSAGE_SENT,
        severity: AuditEventSeverity.INFO,
        user_id: event.user,
        resource_type: 'channel',
        resource_id: event.channel,
        result: 'success',
        metadata: {
          processingTime: Date.now() - startTime,
          messageType: event.type,
          hasThread: 'thread_ts' in event && !!event.thread_ts
        }
      });
    }
  } catch (error) {
    // Log failed message processing
    if ('user' in event && event.user) {
      await auditLogger.log({
        event_type: AuditEventType.MESSAGE_SENT,
        severity: AuditEventSeverity.ERROR,
        user_id: event.user,
        result: 'failure',
        error_message: error instanceof Error ? error.message : String(error),
        metadata: {
          processingTime: Date.now() - startTime
        }
      });
    }
    throw error;
  }
}

/**
 * Express middleware for webhook signature verification
 */
export function webhookSignatureVerification(secret: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const rawBody = (req as any).rawBody || '';
    
    if (!SlackAuthenticator.verifySlackSignature(signature, timestamp, rawBody)) {
      logger.error('Invalid webhook signature', {
        path: req.path,
        method: req.method
      });
      
      await auditLogger.logSecurityEvent(
        AuditEventType.SECURITY_VIOLATION,
        undefined,
        { 
          reason: 'Invalid webhook signature',
          path: req.path 
        }
      );
      
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
  };
}

/**
 * Security context middleware for Express routes
 */
export function securityContextMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Create security context
    const sessionId = (req as any).session?.id || req.headers['x-session-id'] as string || 'anonymous';
    const securityContext = new SecurityContext(sessionId);
    
    // Store in request
    (req as any).securityContext = securityContext;
    
    // Log API access
    await auditLogger.log({
      event_type: AuditEventType.DATA_READ,
      severity: AuditEventSeverity.INFO,
      user_id: securityContext.getUserId(),
      resource_type: 'api',
      resource_id: req.path,
      action: req.method,
      result: 'success',
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      session_id: sessionId
    });
    
    next();
  };
}

/**
 * Data encryption middleware
 */
export async function encryptSensitiveData({ 
  event, 
  context,
  next 
}: SlackEventMiddlewareArgs<'message' | 'app_mention'>) {
  try {
    // Mark sensitive fields for encryption
    if ('text' in event && event.text) {
      // Check if message contains sensitive data
      const hasSensitiveData = /\b(?:\d{3}-\d{2}-\d{4}|(?:\d{4}[\s-]?){3}\d{4})\b/.test(event.text);
      
      if (hasSensitiveData) {
        context.requiresEncryption = true;
        logger.info('Sensitive data detected in message');
      }
    }
    
    await next();
  } catch (error) {
    logger.error('Encryption check failed', { error: error as Error });
    await next();
  }
}

/**
 * Command authorization middleware
 */
export async function commandAuthorization({ 
  command, 
  ack, 
  context,
  next 
}: SlackCommandMiddlewareArgs) {
  try {
    // Create security context
    const securityContext = new SecurityContext(command.trigger_id);
    await securityContext.authenticate(command.user_id, ['command.execute']);
    
    // Check command-specific permissions
    const commandPermissions: Record<string, string[]> = {
      '/search': ['search.execute'],
      '/export': ['data.export'],
      '/delete': ['data.delete'],
      '/admin': ['admin.access'],
    };
    
    const requiredPermissions = commandPermissions[command.command] || [];
    
    for (const permission of requiredPermissions) {
      if (!securityContext.hasPermission(permission)) {
        await ack({
          response_type: 'ephemeral',
          text: `🔒 You don't have permission to use ${command.command}`
        });
        
        await auditLogger.logSecurityEvent(
          AuditEventType.SECURITY_VIOLATION,
          command.user_id,
          { 
            reason: 'Insufficient permissions',
            command: command.command,
            requiredPermission: permission 
          }
        );
        
        return;
      }
    }
    
    context.securityContext = securityContext;
    await next();
  } catch (error) {
    logger.error('Command authorization failed', { error: error as Error });
    await ack({
      response_type: 'ephemeral',
      text: '❌ Authorization failed'
    });
  }
}

/**
 * Register all security middleware
 */
export function registerSecurityMiddleware(app: any) {
  // Slack event middleware
  app.use(slackEventAuth);
  app.use(slackRateLimit);
  app.use(sanitizeInput);
  app.use(encryptSensitiveData);
  app.use(auditLog);
  
  // Express middleware for custom routes
  const expressApp = app.receiver.app;
  
  // Apply security headers
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    // Import and use security headers from security.ts
    const { securityHeaders } = require('@utils/security');
    securityHeaders(req, res, next);
  });
  
  // IP access control
  expressApp.use(IPAccessControl.middleware());
  
  // CSRF protection for non-Slack routes
  expressApp.use('/api/*', CSRFProtection.middleware());
  
  // Security context
  expressApp.use(securityContextMiddleware());
  
  logger.info('Security middleware registered');
}

// Export middleware collection
export const securityMiddleware = {
  slackEventAuth,
  slackRateLimit,
  sanitizeInput,
  encryptSensitiveData,
  auditLog,
  commandAuthorization,
  webhookSignatureVerification,
  securityContextMiddleware,
  registerAll: registerSecurityMiddleware,
};