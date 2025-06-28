/**
 * Debug utilities for development
 * Only active when NODE_ENV !== 'production'
 */

import { inspect } from 'util';
import { performance } from 'perf_hooks';
import { logger } from './logger';
import { isFeatureEnabled, FeatureFlag } from './featureFlags';

const isDebugMode = process.env.NODE_ENV !== 'production' && 
                   (process.env.DEBUG === 'true' || isFeatureEnabled(FeatureFlag.DEBUG_MODE));

/**
 * Debug logger that only logs in development
 */
export const debug = {
  log: (...args: any[]) => {
    if (isDebugMode) {
      console.log('[DEBUG]', ...args);
    }
  },
  
  error: (...args: any[]) => {
    if (isDebugMode) {
      console.error('[DEBUG ERROR]', ...args);
    }
  },
  
  table: (data: any) => {
    if (isDebugMode) {
      console.table(data);
    }
  },
  
  inspect: (obj: any, depth: number = 3) => {
    if (isDebugMode) {
      console.log(inspect(obj, { depth, colors: true }));
    }
  },
};

/**
 * Performance measurement utility
 */
export class PerformanceTimer {
  private startTime: number;
  private marks: Map<string, number> = new Map();
  private measurements: Array<{ name: string; duration: number }> = [];
  
  constructor(private name: string) {
    this.startTime = performance.now();
    debug.log(`⏱️  Starting timer: ${name}`);
  }
  
  mark(label: string): void {
    const now = performance.now();
    this.marks.set(label, now);
    const elapsed = now - this.startTime;
    debug.log(`⏱️  Mark '${label}': ${elapsed.toFixed(2)}ms`);
  }
  
  measure(name: string, startMark: string, endMark: string): number {
    const start = this.marks.get(startMark) || this.startTime;
    const end = this.marks.get(endMark) || performance.now();
    const duration = end - start;
    
    this.measurements.push({ name, duration });
    debug.log(`⏱️  Measurement '${name}': ${duration.toFixed(2)}ms`);
    
    return duration;
  }
  
  end(): void {
    const totalTime = performance.now() - this.startTime;
    debug.log(`⏱️  Timer '${this.name}' completed: ${totalTime.toFixed(2)}ms`);
    
    if (this.measurements.length > 0) {
      debug.table(this.measurements);
    }
  }
}

/**
 * Memory usage reporter
 */
export function reportMemoryUsage(label?: string): void {
  if (!isDebugMode) return;
  
  const usage = process.memoryUsage();
  const format = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  
  debug.log(`📊 Memory Usage${label ? ` (${label})` : ''}:`);
  debug.table({
    RSS: format(usage.rss),
    'Heap Total': format(usage.heapTotal),
    'Heap Used': format(usage.heapUsed),
    External: format(usage.external),
    'Array Buffers': format(usage.arrayBuffers || 0),
  });
}

/**
 * SQL query debugger
 */
export function debugQuery(query: string, params?: any[]): void {
  if (!isDebugMode) return;
  
  debug.log('🔍 SQL Query:');
  debug.log(query);
  
  if (params && params.length > 0) {
    debug.log('Parameters:', params);
  }
}

/**
 * API request/response debugger
 */
export function debugAPI(type: 'request' | 'response', data: any): void {
  if (!isDebugMode) return;
  
  const icon = type === 'request' ? '📤' : '📥';
  debug.log(`${icon} API ${type.toUpperCase()}:`);
  debug.inspect(data);
}

/**
 * Slack event debugger
 */
export function debugSlackEvent(event: any): void {
  if (!isDebugMode) return;
  
  debug.log('💬 Slack Event:');
  debug.inspect({
    type: event.type,
    user: event.user,
    channel: event.channel,
    text: event.text?.substring(0, 100) + (event.text?.length > 100 ? '...' : ''),
    ts: event.ts,
    thread_ts: event.thread_ts,
  });
}

/**
 * Feature flag debugger
 */
export function debugFeatureFlags(userId?: string): void {
  if (!isDebugMode) return;
  
  const { featureFlags } = require('./featureFlags');
  const allFlags = featureFlags.getAllConfigs();
  
  debug.log('🚩 Feature Flags:');
  const flagStatus = allFlags.map(config => ({
    flag: config.name,
    enabled: featureFlags.isEnabled(config.name, userId),
    default: config.defaultValue,
    rollout: config.rolloutPercentage || 'N/A',
  }));
  
  debug.table(flagStatus);
}

/**
 * Async function wrapper with timing
 */
export function withTiming<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  name?: string
): T {
  if (!isDebugMode) return fn;
  
  return (async (...args: Parameters<T>) => {
    const timer = new PerformanceTimer(name || fn.name || 'Anonymous');
    
    try {
      const result = await fn(...args);
      timer.end();
      return result;
    } catch (error) {
      timer.end();
      throw error;
    }
  }) as T;
}

/**
 * Debug decorator for class methods
 */
export function Debug(label?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    if (!isDebugMode) return descriptor;
    
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const className = target.constructor.name;
      const methodName = `${className}.${propertyKey}`;
      const debugLabel = label || methodName;
      
      debug.log(`🔸 Entering ${debugLabel}`, args);
      const timer = new PerformanceTimer(debugLabel);
      
      try {
        const result = await originalMethod.apply(this, args);
        timer.end();
        debug.log(`🔹 Exiting ${debugLabel}`, result);
        return result;
      } catch (error) {
        timer.end();
        debug.error(`❌ Error in ${debugLabel}:`, error);
        throw error;
      }
    };
    
    return descriptor;
  };
}

/**
 * Create a debug checkpoint
 */
export function checkpoint(name: string, data?: any): void {
  if (!isDebugMode) return;
  
  debug.log(`🚩 Checkpoint: ${name}`);
  if (data) {
    debug.inspect(data);
  }
  
  // Also report memory at checkpoints
  reportMemoryUsage(name);
}

/**
 * Export all debug utilities as a namespace
 */
export const Debug = {
  log: debug.log,
  error: debug.error,
  table: debug.table,
  inspect: debug.inspect,
  timer: (name: string) => new PerformanceTimer(name),
  memory: reportMemoryUsage,
  query: debugQuery,
  api: debugAPI,
  slackEvent: debugSlackEvent,
  featureFlags: debugFeatureFlags,
  checkpoint,
  withTiming,
};

// Export for use in REPL or debugging sessions
if (isDebugMode) {
  (global as any).Debug = Debug;
  debug.log('🐛 Debug utilities loaded. Access via global.Debug');
}