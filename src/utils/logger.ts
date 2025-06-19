import { config } from '@utils/config';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogContext {
  userId?: string;
  channelId?: string;
  messageTs?: string;
  error?: Error;
  metadata?: Record<string, any>;
  // Additional context fields
  [key: string]: any;
}

class Logger {
  private logLevel: LogLevel;

  constructor() {
    this.logLevel = this.parseLogLevel(process.env.LOG_LEVEL || 'info');
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      case 'error': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  private formatMessage(
    level: string,
    message: string,
    context?: LogContext
  ): string {
    const timestamp = new Date().toISOString();
    const env = config.app.nodeEnv;
    
    const log: any = {
      timestamp,
      level,
      env,
      message,
    };

    if (context) {
      if (context.userId) log.userId = context.userId;
      if (context.channelId) log.channelId = context.channelId;
      if (context.messageTs) log.messageTs = context.messageTs;
      if (context.metadata) log.metadata = context.metadata;
      if (context.error) {
        log.error = {
          name: context.error.name,
          message: context.error.message,
        };
        // Only include stack trace in development
        if (env !== 'production') {
          log.error.stack = context.error.stack;
        }
      }
    }

    // In production, use JSON format for structured logging
    if (env === 'production') {
      // Import sanitizeLogData dynamically to avoid circular dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sanitizeLogData } = require('./security');
      return JSON.stringify(sanitizeLogData(log));
    }

    // In development, use human-readable format
    let formatted = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    if (context?.error) {
      formatted += `\n${context.error.stack}`;
    }
    return formatted;
  }

  debug(message: string, context?: LogContext): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      console.log(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.logLevel <= LogLevel.INFO) {
      console.log(this.formatMessage('info', message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.logLevel <= LogLevel.WARN) {
      console.warn(this.formatMessage('warn', message, context));
    }
  }

  error(message: string, context?: LogContext): void {
    if (this.logLevel <= LogLevel.ERROR) {
      console.error(this.formatMessage('error', message, context));
    }
  }

  // Performance tracking
  startTimer(operation: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.debug(`${operation} completed`, {
        metadata: { duration_ms: duration },
      });
    };
  }

  // API call logging
  logApiCall(
    service: string,
    operation: string,
    success: boolean,
    duration: number,
    error?: Error
  ): void {
    const level = success ? 'info' : 'error';
    const message = `API call to ${service}.${operation}`;
    
    this[level](message, {
      metadata: {
        service,
        operation,
        success,
        duration_ms: duration,
      },
      error,
    });
  }

  // Worker job logging
  logJob(
    queue: string,
    jobId: string,
    status: 'started' | 'completed' | 'failed',
    error?: Error
  ): void {
    const message = `Job ${jobId} in queue ${queue} ${status}`;
    
    if (status === 'failed') {
      this.error(message, { error, metadata: { queue, jobId } });
    } else {
      this.info(message, { metadata: { queue, jobId } });
    }
  }

  // Memory usage tracking
  logMemoryUsage(): void {
    const usage = process.memoryUsage();
    const formatted = {
      rss: `${Math.round(usage.rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)} MB`,
      external: `${Math.round(usage.external / 1024 / 1024)} MB`,
    };

    this.debug('Memory usage', { metadata: formatted });
  }
}

// Singleton instance
export const logger = new Logger();

// Periodic memory logging in development
if (config.app.nodeEnv === 'development') {
  setInterval(() => {
    logger.logMemoryUsage();
  }, 60000); // Every minute
}