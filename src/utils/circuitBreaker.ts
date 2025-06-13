import { CircuitBreakerError } from '@utils/errors';
import { logger } from '@utils/logger';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeout: number;
  slowCallDuration: number;
  slowCallThreshold: number;
  minimumCalls: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private callCount: number = 0;
  private slowCallCount: number = 0;
  private lastFailureTime?: Date;
  private readonly name: string;
  private readonly options: CircuitBreakerOptions;

  constructor(name: string, options: Partial<CircuitBreakerOptions> = {}) {
    this.name = name;
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      recoveryTimeout: options.recoveryTimeout || 60000, // 1 minute
      slowCallDuration: options.slowCallDuration || 3000, // 3 seconds
      slowCallThreshold: options.slowCallThreshold || 3,
      minimumCalls: options.minimumCalls || 10,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitState.HALF_OPEN;
        logger.info(`Circuit breaker ${this.name} entering HALF_OPEN state`);
      } else {
        throw new CircuitBreakerError(this.name);
      }
    }

    const start = Date.now();
    
    try {
      const result = await fn();
      const duration = Date.now() - start;
      
      this.recordSuccess(duration);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.recordFailure(duration);
      throw error;
    }
  }

  private recordSuccess(duration: number): void {
    this.callCount++;
    this.successCount++;

    if (duration > this.options.slowCallDuration) {
      this.slowCallCount++;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successCount >= 3) {
        this.reset();
        logger.info(`Circuit breaker ${this.name} closed after successful recovery`);
      }
    }
  }

  private recordFailure(duration: number): void {
    this.callCount++;
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (duration > this.options.slowCallDuration) {
      this.slowCallCount++;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.open();
      return;
    }

    // Check if we should open the circuit
    if (this.callCount >= this.options.minimumCalls) {
      const failureRate = this.failureCount / this.callCount;
      const slowCallRate = this.slowCallCount / this.callCount;

      if (
        failureRate > 0.5 || // 50% failure rate
        this.failureCount >= this.options.failureThreshold ||
        slowCallRate > 0.5 // 50% slow calls
      ) {
        this.open();
      }
    }
  }

  private open(): void {
    this.state = CircuitState.OPEN;
    logger.warn(`Circuit breaker ${this.name} opened`, {
      metadata: {
        failureCount: this.failureCount,
        callCount: this.callCount,
        slowCallCount: this.slowCallCount,
      },
    });
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.callCount = 0;
    this.slowCallCount = 0;
    this.lastFailureTime = undefined;
  }

  private shouldAttemptReset(): boolean {
    return (
      this.lastFailureTime !== undefined &&
      Date.now() - this.lastFailureTime.getTime() > this.options.recoveryTimeout
    );
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      callCount: this.callCount,
      slowCallCount: this.slowCallCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// Circuit breakers for different services
export const circuitBreakers = {
  openai: new CircuitBreaker('OpenAI', {
    failureThreshold: 5,
    recoveryTimeout: 60000,
    slowCallDuration: 5000,
  }),
  slack: new CircuitBreaker('Slack', {
    failureThreshold: 10,
    recoveryTimeout: 30000,
    slowCallDuration: 2000,
  }),
  database: new CircuitBreaker('Database', {
    failureThreshold: 3,
    recoveryTimeout: 30000,
    slowCallDuration: 1000,
  }),
  search: new CircuitBreaker('Search', {
    failureThreshold: 5,
    recoveryTimeout: 45000,
    slowCallDuration: 3000,
  }),
};