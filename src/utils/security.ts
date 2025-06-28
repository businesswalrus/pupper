import { Request, Response, NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { config } from './config';
import { logger } from './logger';
import { auditLogger, AuditEventType, AuditEventSeverity } from './auditLogger';
import { encryption } from './encryption';
import { redis } from '@db/redis';

const randomBytesAsync = promisify(randomBytes);

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // Enhanced security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "font-src 'self'; " +
    "connect-src 'self' https://api.slack.com https://slack.com; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'"
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
  );
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Expect-CT', 'max-age=86400, enforce');
  
  // Remove server headers
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  
  next();
}

export function sanitizeLogData(data: any): any {
  if (!data) return data;
  
  const sensitiveKeys = [
    'password',
    'token',
    'apikey',
    'api_key',
    'secret',
    'authorization',
    'cookie',
    'session',
    'credit_card',
    'ssn',
  ];
  
  if (typeof data === 'string') {
    // Redact potential tokens in strings
    return data.replace(/xox[baprs]-[0-9a-zA-Z-]+/g, '[REDACTED_TOKEN]')
               .replace(/sk-[0-9a-zA-Z-]+/g, '[REDACTED_API_KEY]');
  }
  
  if (Array.isArray(data)) {
    return data.map(item => sanitizeLogData(item));
  }
  
  if (typeof data === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeLogData(value);
      }
    }
    return sanitized;
  }
  
  return data;
}

export function maskSensitiveData(text: string): string {
  // Mask email addresses
  text = text.replace(/([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/g, 
    (_match, local, domain) => {
      const maskedLocal = local.charAt(0) + '*'.repeat(local.length - 2) + local.charAt(local.length - 1);
      return `${maskedLocal}@${domain}`;
    });
  
  // Mask phone numbers (US format)
  text = text.replace(/(\d{3})[-.\s]?(\d{3})[-.\s]?(\d{4})/g, 
    (_match, area, _middle, last) => `${area}-***-${last}`);
  
  // Mask credit card numbers
  text = text.replace(/\b(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})\b/g,
    (_match, first, _second, _third, fourth) => `${first}-****-****-${fourth}`);
  
  // Mask SSNs
  text = text.replace(/\b(\d{3})-(\d{2})-(\d{4})\b/g,
    (_match, _area, _group, serial) => `***-**-${serial}`);
  
  return text;
}

// CORS configuration
export const corsOptions = {
  origin: (origin: string | undefined, callback: any) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) {
      return callback(null, true);
    }
    
    if (config.app.nodeEnv === 'development') {
      // Allow all origins in development
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS: Origin not allowed', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

// Request size limits
export const requestLimits = {
  json: '1mb',
  urlencoded: { extended: true, limit: '1mb' },
  text: '1mb',
  raw: '1mb',
};

// Request signing for webhooks and API calls
export class RequestSigner {
  private static readonly SIGNATURE_HEADER = 'X-Signature';
  private static readonly TIMESTAMP_HEADER = 'X-Timestamp';
  private static readonly NONCE_HEADER = 'X-Nonce';
  private static readonly VERSION = 'v1';
  private static readonly TIMESTAMP_TOLERANCE = 300; // 5 minutes
  
  /**
   * Sign an outgoing request
   */
  static async signRequest(
    method: string,
    url: string,
    body: any,
    secret: string
  ): Promise<Record<string, string>> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = (await randomBytesAsync(16)).toString('hex');
    
    // Create signature base string
    const baseString = [
      this.VERSION,
      timestamp,
      nonce,
      method.toUpperCase(),
      url,
      typeof body === 'object' ? JSON.stringify(body) : body || ''
    ].join('.');
    
    // Generate signature
    const signature = createHmac('sha256', secret)
      .update(baseString)
      .digest('hex');
    
    return {
      [this.SIGNATURE_HEADER]: `${this.VERSION}=${signature}`,
      [this.TIMESTAMP_HEADER]: timestamp,
      [this.NONCE_HEADER]: nonce,
    };
  }
  
  /**
   * Verify an incoming request signature
   */
  static async verifyRequest(
    req: Request,
    secret: string
  ): Promise<boolean> {
    const signature = req.headers[this.SIGNATURE_HEADER.toLowerCase()] as string;
    const timestamp = req.headers[this.TIMESTAMP_HEADER.toLowerCase()] as string;
    const nonce = req.headers[this.NONCE_HEADER.toLowerCase()] as string;
    
    if (!signature || !timestamp || !nonce) {
      logger.warn('Missing signature headers');
      return false;
    }
    
    // Check timestamp
    const currentTime = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);
    
    if (Math.abs(currentTime - requestTime) > this.TIMESTAMP_TOLERANCE) {
      logger.warn('Request timestamp too old');
      await auditLogger.logSecurityEvent(
        AuditEventType.SECURITY_VIOLATION,
        undefined,
        { reason: 'Expired timestamp', age: Math.abs(currentTime - requestTime) }
      );
      return false;
    }
    
    // Check nonce for replay protection
    const nonceKey = `nonce:${nonce}`;
    const redisClient = await redis.getClient();
    const exists = await redisClient.exists(nonceKey);
    
    if (exists) {
      logger.warn('Nonce already used');
      await auditLogger.logSecurityEvent(
        AuditEventType.SECURITY_VIOLATION,
        undefined,
        { reason: 'Duplicate nonce', nonce }
      );
      return false;
    }
    
    // Store nonce with expiration
    await redisClient.setEx(nonceKey, this.TIMESTAMP_TOLERANCE * 2, '1');
    
    // Reconstruct base string
    const baseString = [
      this.VERSION,
      timestamp,
      nonce,
      req.method.toUpperCase(),
      req.originalUrl || req.url,
      req.body ? JSON.stringify(req.body) : ''
    ].join('.');
    
    // Calculate expected signature
    const expectedSignature = `${this.VERSION}=` + createHmac('sha256', secret)
      .update(baseString)
      .digest('hex');
    
    // Compare signatures
    const isValid = this.timingSafeCompare(signature, expectedSignature);
    
    if (!isValid) {
      await auditLogger.logSecurityEvent(
        AuditEventType.SECURITY_VIOLATION,
        undefined,
        { reason: 'Invalid signature' }
      );
    }
    
    return isValid;
  }
  
  private static timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    
    return timingSafeEqual(bufferA, bufferB);
  }
}

// CSRF Protection
export class CSRFProtection {
  private static readonly TOKEN_LENGTH = 32;
  private static readonly COOKIE_NAME = 'csrf-token';
  private static readonly HEADER_NAME = 'X-CSRF-Token';
  private static readonly TOKEN_EXPIRY = 3600; // 1 hour
  
  /**
   * Generate a CSRF token
   */
  static async generateToken(sessionId: string): Promise<string> {
    const token = (await randomBytesAsync(this.TOKEN_LENGTH)).toString('hex');
    const hashedToken = encryption.hashData(token + sessionId);
    
    // Store token in Redis
    const redisClient = await redis.getClient();
    await redisClient.setEx(
      `csrf:${sessionId}:${hashedToken}`,
      this.TOKEN_EXPIRY,
      '1'
    );
    
    return token;
  }
  
  /**
   * Verify a CSRF token
   */
  static async verifyToken(
    token: string,
    sessionId: string
  ): Promise<boolean> {
    if (!token || !sessionId) return false;
    
    const hashedToken = encryption.hashData(token + sessionId);
    const redisClient = await redis.getClient();
    
    const exists = await redisClient.exists(`csrf:${sessionId}:${hashedToken}`);
    
    if (!exists) {
      await auditLogger.logSecurityEvent(
        AuditEventType.SECURITY_VIOLATION,
        sessionId,
        { reason: 'Invalid CSRF token' }
      );
    }
    
    return exists === 1;
  }
  
  /**
   * Express middleware for CSRF protection
   */
  static middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      // Skip CSRF for safe methods
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
      }
      
      const sessionId = (req as any).session?.id;
      if (!sessionId) {
        return res.status(401).json({ error: 'No session' });
      }
      
      const token = req.headers[this.HEADER_NAME.toLowerCase()] as string ||
                   req.body?._csrf ||
                   req.query?._csrf;
      
      const isValid = await this.verifyToken(token, sessionId);
      
      if (!isValid) {
        logger.warn('CSRF token validation failed', { 
          sessionId,
          method: req.method,
          path: req.path 
        });
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }
      
      next();
    };
  }
}

// Zero-Trust Security Context
export class SecurityContext {
  private userId?: string;
  private sessionId: string;
  private permissions: Set<string> = new Set();
  private metadata: Record<string, any> = {};
  
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  
  async authenticate(userId: string, permissions: string[]): Promise<void> {
    this.userId = userId;
    this.permissions = new Set(permissions);
    
    await auditLogger.log({
      event_type: AuditEventType.AUTH_LOGIN,
      severity: AuditEventSeverity.INFO,
      user_id: userId,
      result: 'success',
      metadata: { permissions },
    });
  }
  
  hasPermission(permission: string): boolean {
    return this.permissions.has(permission);
  }
  
  requirePermission(permission: string): void {
    if (!this.hasPermission(permission)) {
      throw new SecurityError(`Missing required permission: ${permission}`);
    }
  }
  
  getUserId(): string | undefined {
    return this.userId;
  }
  
  getSessionId(): string {
    return this.sessionId;
  }
  
  setMetadata(key: string, value: any): void {
    this.metadata[key] = value;
  }
  
  getMetadata(key: string): any {
    return this.metadata[key];
  }
}

// Security Error class
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

// IP-based access control
export class IPAccessControl {
  private static readonly WHITELIST_KEY = 'security:ip:whitelist';
  private static readonly BLACKLIST_KEY = 'security:ip:blacklist';
  
  static async addToWhitelist(ip: string): Promise<void> {
    const redisClient = await redis.getClient();
    await redisClient.sAdd(this.WHITELIST_KEY, ip);
  }
  
  static async addToBlacklist(ip: string): Promise<void> {
    const redisClient = await redis.getClient();
    await redisClient.sAdd(this.BLACKLIST_KEY, ip);
    
    await auditLogger.logSecurityEvent(
      AuditEventType.SECURITY_VIOLATION,
      undefined,
      { reason: 'IP blacklisted', ip }
    );
  }
  
  static async checkAccess(ip: string): Promise<boolean> {
    const redisClient = await redis.getClient();
    
    // Check blacklist first
    const isBlacklisted = await redisClient.sIsMember(this.BLACKLIST_KEY, ip);
    if (isBlacklisted) return false;
    
    // If whitelist exists, check if IP is in it
    const whitelistSize = await redisClient.sCard(this.WHITELIST_KEY);
    if (whitelistSize > 0) {
      return await redisClient.sIsMember(this.WHITELIST_KEY, ip);
    }
    
    // No whitelist means all IPs are allowed (except blacklisted)
    return true;
  }
  
  static middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const ip = req.ip || req.socket.remoteAddress || '';
      
      const hasAccess = await this.checkAccess(ip);
      if (!hasAccess) {
        logger.warn('IP access denied', { ip });
        return res.status(403).json({ error: 'Access denied' });
      }
      
      next();
    };
  }
}