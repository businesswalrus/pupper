import { createHmac } from 'crypto';
import { config } from './config';
import { logger } from './logger';

export class SlackAuthenticator {
  private static readonly VERSION = 'v0';
  private static readonly TIMESTAMP_TOLERANCE = 300; // 5 minutes in seconds
  
  static verifySlackSignature(
    signature: string | undefined,
    timestamp: string | undefined,
    body: string
  ): boolean {
    if (!signature || !timestamp) {
      logger.warn('Missing Slack signature or timestamp');
      return false;
    }
    
    // Check timestamp to prevent replay attacks
    const currentTime = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);
    
    if (Math.abs(currentTime - requestTime) > this.TIMESTAMP_TOLERANCE) {
      logger.warn('Slack request timestamp too old', {
        currentTime,
        requestTime,
        difference: Math.abs(currentTime - requestTime)
      });
      return false;
    }
    
    // Construct the base string
    const baseString = `${this.VERSION}:${timestamp}:${body}`;
    
    // Calculate expected signature
    const hmac = createHmac('sha256', config.slack.signingSecret);
    hmac.update(baseString);
    const expectedSignature = `${this.VERSION}=${hmac.digest('hex')}`;
    
    // Compare signatures using timing-safe comparison
    const isValid = this.timingSafeEqual(signature, expectedSignature);
    
    if (!isValid) {
      logger.warn('Invalid Slack signature', {
        provided: signature.substring(0, 10) + '...',
        expected: expectedSignature.substring(0, 10) + '...'
      });
    }
    
    return isValid;
  }
  
  private static timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }
}

// Middleware for Express routes
export function slackAuthMiddleware(req: any, res: any, next: any) {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  const rawBody = req.rawBody || '';
  
  if (!SlackAuthenticator.verifySlackSignature(signature, timestamp, rawBody)) {
    logger.error('Failed Slack authentication', {
      path: req.path,
      method: req.method
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}