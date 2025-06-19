import { logger } from './logger';

export class InputSanitizer {
  private static readonly MAX_MESSAGE_LENGTH = 4000;
  private static readonly MAX_CHANNEL_ID_LENGTH = 50;
  private static readonly MAX_USER_ID_LENGTH = 50;
  
  // Regex patterns for validation
  private static readonly SLACK_ID_PATTERN = /^[A-Z0-9]+$/;
  private static readonly DANGEROUS_PATTERNS = [
    /<script[^>]*>.*?<\/script>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /<iframe/gi,
    /<object/gi,
    /<embed/gi,
  ];

  static sanitizeMessage(text: string | undefined | null): string {
    if (!text) return '';
    
    // Trim and limit length
    let sanitized = text.trim().substring(0, this.MAX_MESSAGE_LENGTH);
    
    // Remove potentially dangerous patterns
    for (const pattern of this.DANGEROUS_PATTERNS) {
      sanitized = sanitized.replace(pattern, '');
    }
    
    // Escape special characters for database storage
    sanitized = this.escapeHtml(sanitized);
    
    return sanitized;
  }

  static sanitizeSlackId(id: string | undefined | null, type: 'user' | 'channel'): string {
    if (!id) {
      throw new Error(`Invalid ${type} ID: empty or null`);
    }
    
    const maxLength = type === 'user' ? this.MAX_USER_ID_LENGTH : this.MAX_CHANNEL_ID_LENGTH;
    
    // Trim and check length
    const trimmed = id.trim();
    if (trimmed.length > maxLength) {
      throw new Error(`Invalid ${type} ID: exceeds maximum length`);
    }
    
    // Validate format (Slack IDs are alphanumeric uppercase)
    if (!this.SLACK_ID_PATTERN.test(trimmed)) {
      throw new Error(`Invalid ${type} ID format: ${trimmed}`);
    }
    
    return trimmed;
  }

  static sanitizeNumber(value: any, min: number, max: number, defaultValue: number): number {
    const num = parseInt(value, 10);
    
    if (isNaN(num)) {
      return defaultValue;
    }
    
    if (num < min) return min;
    if (num > max) return max;
    
    return num;
  }

  static sanitizeUsername(username: string | undefined | null): string {
    if (!username) return 'Unknown User';
    
    // Remove any control characters and limit length
    return username
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, '') // Remove control characters (using Unicode notation)
      .trim()
      .substring(0, 100);
  }

  static sanitizeSearchQuery(query: string | undefined | null): string {
    if (!query) return '';
    
    // Basic sanitization for search queries
    return query
      .trim()
      .substring(0, 200)
      .replace(/[<>]/g, ''); // Remove angle brackets to prevent tag injection
  }

  private static escapeHtml(text: string): string {
    const htmlEscapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };
    
    return text.replace(/[&<>"'/]/g, (match) => htmlEscapes[match] || match);
  }

  static detectPromptInjection(text: string): boolean {
    const suspiciousPatterns = [
      /ignore\s+previous\s+instructions/i,
      /disregard\s+all\s+prior/i,
      /system\s*:\s*you\s+are/i,
      /\[system\]/i,
      /<<<.*>>>/,
      /\{\{.*\}\}/,
    ];
    
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(text)) {
        logger.warn('Potential prompt injection detected', { 
          pattern: pattern.toString(),
          text: text.substring(0, 100) 
        });
        return true;
      }
    }
    
    return false;
  }
}

export function validateSlackEvent(event: any): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }
  
  // Check required fields
  const requiredFields = ['type', 'user', 'channel'];
  for (const field of requiredFields) {
    if (!event[field]) {
      logger.warn('Missing required field in Slack event', { field });
      return false;
    }
  }
  
  // Validate event type
  const validEventTypes = ['message', 'app_mention'];
  if (!validEventTypes.includes(event.type)) {
    logger.warn('Invalid event type', { type: event.type });
    return false;
  }
  
  return true;
}