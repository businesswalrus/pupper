export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 'VALIDATION_ERROR', 400);
    this.details = details;
  }

  details?: any;
}

export class DatabaseError extends AppError {
  constructor(message: string, originalError?: Error) {
    super(message, 'DATABASE_ERROR', 500);
    this.originalError = originalError;
  }

  originalError?: Error;
}

export class ApiError extends AppError {
  constructor(
    message: string,
    service: string,
    originalError?: Error
  ) {
    super(message, 'API_ERROR', 503);
    this.service = service;
    this.originalError = originalError;
  }

  service: string;
  originalError?: Error;
}

export class RateLimitError extends AppError {
  constructor(
    message: string,
    retryAfter?: number
  ) {
    super(message, 'RATE_LIMIT_ERROR', 429);
    this.retryAfter = retryAfter;
  }

  retryAfter?: number;
}

export class CircuitBreakerError extends AppError {
  constructor(
    service: string,
    message: string = `Circuit breaker is open for ${service}`
  ) {
    super(message, 'CIRCUIT_BREAKER_OPEN', 503);
    this.service = service;
  }

  service: string;
}

// Error handler utility
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

// Async error wrapper for route handlers
export function asyncHandler<T extends (...args: any[]) => Promise<any>>(
  fn: T
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      // Let the global error handler deal with it
      throw error;
    }
  }) as T;
}