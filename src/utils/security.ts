import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { logger } from './logger';

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // Security headers to prevent common attacks
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Remove server header
  res.removeHeader('X-Powered-By');
  
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