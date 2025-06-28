import { config } from '@utils/config';
import { CorrelationManager, SpanAttributes } from '@utils/observability';
import { trace, context } from '@opentelemetry/api';
import * as winston from 'winston';
import * as Transport from 'winston-transport';

export interface LogContext {
  userId?: string;
  channelId?: string;
  messageTs?: string;
  error?: Error;
  metadata?: Record<string, any>;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  duration?: number;
  [key: string]: any;
}

// Custom error serializer
function serializeError(error: Error): Record<string, any> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    // Include any custom error properties
    ...Object.getOwnPropertyNames(error).reduce((acc, key) => {
      if (!['name', 'message', 'stack'].includes(key)) {
        acc[key] = (error as any)[key];
      }
      return acc;
    }, {} as Record<string, any>),
  };
}

// Custom log formatter for structured logging
const structuredFormat = winston.format.printf(({ 
  timestamp, 
  level, 
  message, 
  ...metadata 
}) => {
  const log: any = {
    '@timestamp': timestamp,
    level,
    message,
    service: process.env.OTEL_SERVICE_NAME || 'pup-ai',
    environment: config.app.nodeEnv,
    version: process.env.npm_package_version || 'unknown',
    host: {
      name: process.env.HOSTNAME || require('os').hostname(),
      pod: process.env.POD_NAME,
      node: process.env.NODE_NAME,
    },
  };

  // Add OpenTelemetry context
  const span = trace.getActiveSpan();
  if (span) {
    const spanContext = span.spanContext();
    log.trace = {
      id: spanContext.traceId,
      span_id: spanContext.spanId,
      flags: spanContext.traceFlags,
    };
  }

  // Add correlation ID
  const correlationId = metadata.correlationId || CorrelationManager.getCorrelationId();
  if (correlationId) {
    log.correlation_id = correlationId;
  }

  // Add metadata
  if (Object.keys(metadata).length > 0) {
    log.metadata = metadata;
  }

  return JSON.stringify(log);
});

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let output = `[${timestamp}] ${level}: ${message}`;
    
    const correlationId = metadata.correlationId || CorrelationManager.getCorrelationId();
    if (correlationId) {
      output += ` [${correlationId}]`;
    }

    if (metadata.error) {
      output += `\n${metadata.error.stack}`;
    }

    if (metadata.duration) {
      output += ` (${metadata.duration}ms)`;
    }

    return output;
  })
);

// Custom transport for sending logs to external services
class ExternalLogTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: any, callback: () => void): void {
    // Here you would send logs to external service
    // For example, to Elasticsearch, Datadog, etc.
    setImmediate(() => {
      this.emit('logged', info);
    });
    callback();
  }
}

class EnhancedLogger {
  private logger: winston.Logger;
  private contextCache: WeakMap<any, LogContext> = new WeakMap();

  constructor() {
    const transports: winston.transport[] = [];

    // Console transport for all environments
    transports.push(
      new winston.transports.Console({
        format: config.app.nodeEnv === 'production' ? structuredFormat : consoleFormat,
      })
    );

    // File transport for production
    if (config.app.nodeEnv === 'production') {
      transports.push(
        new winston.transports.File({
          filename: '/app/logs/error.log',
          level: 'error',
          format: structuredFormat,
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
        }),
        new winston.transports.File({
          filename: '/app/logs/combined.log',
          format: structuredFormat,
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 10,
        })
      );

      // External log transport
      if (process.env.EXTERNAL_LOGGING_ENABLED === 'true') {
        transports.push(new ExternalLogTransport());
      }
    }

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] })
      ),
      transports,
      exitOnError: false,
    });

    // Handle uncaught exceptions and rejections
    this.logger.exceptions.handle(
      new winston.transports.File({ 
        filename: '/app/logs/exceptions.log',
        format: structuredFormat,
      })
    );

    this.logger.rejections.handle(
      new winston.transports.File({ 
        filename: '/app/logs/rejections.log',
        format: structuredFormat,
      })
    );
  }

  // Create a child logger with persistent context
  child(context: LogContext): EnhancedLogger {
    const childLogger = Object.create(this);
    childLogger.defaultContext = context;
    return childLogger;
  }

  private enrichContext(context?: LogContext): LogContext {
    const enriched: LogContext = {
      ...this.defaultContext,
      ...context,
    };

    // Add OpenTelemetry context
    const span = trace.getActiveSpan();
    if (span) {
      const spanContext = span.spanContext();
      enriched.traceId = spanContext.traceId;
      enriched.spanId = spanContext.spanId;
      
      // Add custom span attributes
      const attributes = span.attributes || {};
      if (attributes[SpanAttributes.USER_ID]) {
        enriched.userId = enriched.userId || attributes[SpanAttributes.USER_ID] as string;
      }
      if (attributes[SpanAttributes.CHANNEL_ID]) {
        enriched.channelId = enriched.channelId || attributes[SpanAttributes.CHANNEL_ID] as string;
      }
    }

    // Add correlation ID
    if (!enriched.correlationId) {
      enriched.correlationId = CorrelationManager.getCorrelationId();
    }

    // Serialize error if present
    if (enriched.error) {
      enriched.error = serializeError(enriched.error) as any;
    }

    // Sanitize sensitive data
    return this.sanitizeContext(enriched);
  }

  private sanitizeContext(context: LogContext): LogContext {
    const sanitized = { ...context };
    
    // List of sensitive field patterns
    const sensitivePatterns = [
      /token/i,
      /password/i,
      /secret/i,
      /key/i,
      /auth/i,
      /cookie/i,
      /session/i,
    ];

    const sanitize = (obj: any): any => {
      if (typeof obj !== 'object' || obj === null) return obj;
      
      const result: any = Array.isArray(obj) ? [] : {};
      
      for (const [key, value] of Object.entries(obj)) {
        // Check if key matches sensitive patterns
        const isSensitive = sensitivePatterns.some(pattern => pattern.test(key));
        
        if (isSensitive) {
          result[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          result[key] = sanitize(value);
        } else {
          result[key] = value;
        }
      }
      
      return result;
    };

    if (sanitized.metadata) {
      sanitized.metadata = sanitize(sanitized.metadata);
    }

    return sanitized;
  }

  // Main logging methods
  debug(message: string, context?: LogContext): void {
    this.logger.debug(message, this.enrichContext(context));
  }

  info(message: string, context?: LogContext): void {
    this.logger.info(message, this.enrichContext(context));
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn(message, this.enrichContext(context));
  }

  error(message: string, context?: LogContext): void {
    this.logger.error(message, this.enrichContext(context));
  }

  // Performance logging
  startTimer(operation: string, context?: LogContext): () => void {
    const start = Date.now();
    const correlationId = CorrelationManager.generateId();
    
    this.debug(`${operation} started`, {
      ...context,
      correlationId,
      operation,
    });

    return () => {
      const duration = Date.now() - start;
      this.info(`${operation} completed`, {
        ...context,
        correlationId,
        operation,
        duration,
        metadata: {
          ...context?.metadata,
          duration_ms: duration,
        },
      });
    };
  }

  // API call logging with automatic timing
  async logApiCall<T>(
    service: string,
    operation: string,
    fn: () => Promise<T>,
    context?: LogContext
  ): Promise<T> {
    const start = Date.now();
    const correlationId = CorrelationManager.generateId();
    
    this.debug(`API call to ${service}.${operation} started`, {
      ...context,
      correlationId,
      metadata: {
        service,
        operation,
      },
    });

    try {
      const result = await fn();
      const duration = Date.now() - start;
      
      this.info(`API call to ${service}.${operation} succeeded`, {
        ...context,
        correlationId,
        duration,
        metadata: {
          service,
          operation,
          success: true,
          duration_ms: duration,
        },
      });

      return result;
    } catch (error) {
      const duration = Date.now() - start;
      
      this.error(`API call to ${service}.${operation} failed`, {
        ...context,
        correlationId,
        duration,
        error: error as Error,
        metadata: {
          service,
          operation,
          success: false,
          duration_ms: duration,
        },
      });

      throw error;
    }
  }

  // Worker job logging
  logJob(
    queue: string,
    jobId: string,
    status: 'started' | 'completed' | 'failed' | 'retrying',
    context?: LogContext
  ): void {
    const level = status === 'failed' ? 'error' : 'info';
    const message = `Job ${jobId} in queue ${queue} ${status}`;
    
    this[level](message, {
      ...context,
      metadata: {
        ...context?.metadata,
        queue,
        jobId,
        jobStatus: status,
      },
    });
  }

  // Batch operation logging
  logBatch(
    operation: string,
    items: number,
    status: 'started' | 'completed' | 'failed',
    context?: LogContext
  ): void {
    const message = `Batch ${operation} ${status} for ${items} items`;
    
    this.info(message, {
      ...context,
      metadata: {
        ...context?.metadata,
        operation,
        batchSize: items,
        status,
      },
    });
  }

  // Memory usage tracking
  logMemoryUsage(context?: LogContext): void {
    const usage = process.memoryUsage();
    
    this.debug('Memory usage', {
      ...context,
      metadata: {
        memory: {
          rss: `${Math.round(usage.rss / 1024 / 1024)} MB`,
          heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)} MB`,
          heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)} MB`,
          external: `${Math.round(usage.external / 1024 / 1024)} MB`,
          arrayBuffers: `${Math.round(usage.arrayBuffers / 1024 / 1024)} MB`,
        },
      },
    });
  }

  // Query all logs (for debugging)
  async query(options: {
    from?: Date;
    to?: Date;
    level?: string;
    correlationId?: string;
    userId?: string;
    limit?: number;
  }): Promise<any[]> {
    // This would query your log storage
    // Implementation depends on your logging backend
    return [];
  }

  // Flush logs before shutdown
  async flush(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.on('finish', resolve);
      this.logger.end();
    });
  }
}

// Singleton instance
export const logger = new EnhancedLogger();

// Middleware for Express to add correlation ID
export function loggingMiddleware(req: any, res: any, next: () => void): void {
  const correlationId = req.headers['x-correlation-id'] || CorrelationManager.generateId();
  
  // Set correlation ID in context
  CorrelationManager.setCorrelationId(correlationId);
  
  // Add to response headers
  res.setHeader('X-Correlation-Id', correlationId);
  
  // Log request
  const timer = logger.startTimer('http_request', {
    correlationId,
    metadata: {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    },
  });

  // Log response when finished
  res.on('finish', () => {
    timer();
    logger.info('HTTP request completed', {
      correlationId,
      metadata: {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        contentLength: res.get('content-length'),
      },
    });
  });

  next();
}

// Periodic memory logging
if (config.app.nodeEnv === 'development') {
  setInterval(() => {
    logger.logMemoryUsage();
  }, 60000); // Every minute
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, flushing logs...');
  await logger.flush();
});

declare module 'winston' {
  interface Logger {
    defaultContext?: LogContext;
  }
}