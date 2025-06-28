import { 
  MeterProvider, 
  PeriodicExportingMetricReader,
  ConsoleMetricExporter 
} from '@opentelemetry/sdk-metrics';
import { 
  NodeTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter
} from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { trace, metrics, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { config } from '@utils/config';
import { logger } from '@utils/logger';
import * as http from 'http';

// Custom span attributes
export const SpanAttributes = {
  USER_ID: 'pup.user.id',
  CHANNEL_ID: 'pup.channel.id',
  MESSAGE_TS: 'pup.message.ts',
  WORKER_TYPE: 'pup.worker.type',
  QUEUE_NAME: 'pup.queue.name',
  JOB_ID: 'pup.job.id',
  ERROR_TYPE: 'pup.error.type',
  AI_MODEL: 'pup.ai.model',
  AI_TOKENS: 'pup.ai.tokens',
};

class ObservabilityManager {
  private tracerProvider: NodeTracerProvider;
  private meterProvider: MeterProvider;
  private prometheusExporter: PrometheusExporter;
  private metricsServer?: http.Server;

  constructor() {
    this.tracerProvider = new NodeTracerProvider({
      resource: this.createResource(),
    });
    
    this.meterProvider = new MeterProvider({
      resource: this.createResource(),
    });

    this.prometheusExporter = new PrometheusExporter({
      port: parseInt(process.env.METRICS_PORT || '9090'),
      endpoint: '/metrics',
    }, () => {
      logger.info('Prometheus metrics server started', {
        port: process.env.METRICS_PORT || '9090'
      });
    });
  }

  private createResource(): Resource {
    return new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'pup-ai',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || 'unknown',
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.POD_NAMESPACE || 'default',
      [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: process.env.POD_NAME || `${process.hostname}-${process.pid}`,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
      'k8s.pod.name': process.env.POD_NAME,
      'k8s.pod.ip': process.env.POD_IP,
      'k8s.node.name': process.env.NODE_NAME,
      'k8s.namespace.name': process.env.POD_NAMESPACE,
    });
  }

  async initialize(): Promise<void> {
    try {
      // Configure trace exporters
      const traceExporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? new OTLPTraceExporter({
            url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
          })
        : new ConsoleSpanExporter();

      this.tracerProvider.addSpanProcessor(
        new BatchSpanProcessor(traceExporter, {
          maxQueueSize: 100,
          maxExportBatchSize: 50,
          scheduledDelayMillis: 500,
          exportTimeoutMillis: 30000,
        })
      );

      // Configure metric exporters
      const metricExporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? new OTLPMetricExporter({
            url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
          })
        : new ConsoleMetricExporter();

      this.meterProvider.addMetricReader(
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 60000,
        })
      );

      // Add Prometheus exporter for scraping
      this.meterProvider.addMetricReader(this.prometheusExporter);

      // Register providers
      this.tracerProvider.register();
      metrics.setGlobalMeterProvider(this.meterProvider);

      // Auto-instrumentation
      registerInstrumentations({
        instrumentations: [
          new HttpInstrumentation({
            requestHook: (span, request) => {
              span.setAttributes({
                'http.request.body.size': request.headers['content-length'] || 0,
              });
            },
          }),
          new ExpressInstrumentation(),
          new IORedisInstrumentation(),
          new PgInstrumentation({
            enhancedDatabaseReporting: true,
          }),
        ],
      });

      logger.info('Observability initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize observability', { error: error as Error });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await Promise.all([
        this.tracerProvider.shutdown(),
        this.meterProvider.shutdown(),
      ]);
      
      if (this.metricsServer) {
        await new Promise<void>((resolve) => {
          this.metricsServer!.close(() => resolve());
        });
      }
      
      logger.info('Observability shutdown complete');
    } catch (error) {
      logger.error('Error during observability shutdown', { error: error as Error });
    }
  }

  getTracer(name: string) {
    return trace.getTracer(name, process.env.npm_package_version);
  }

  getMeter(name: string) {
    return metrics.getMeter(name, process.env.npm_package_version);
  }
}

// Singleton instance
export const observability = new ObservabilityManager();

// Helper functions for tracing
export function createSpan(
  tracer: any,
  name: string,
  options?: any
) {
  return tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    ...options,
  });
}

export async function withSpan<T>(
  tracer: any,
  name: string,
  fn: (span: any) => Promise<T>,
  options?: any
): Promise<T> {
  const span = createSpan(tracer, name, options);
  
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

// Correlation ID management
export class CorrelationManager {
  private static readonly CORRELATION_ID_KEY = 'correlationId';

  static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  static setCorrelationId(correlationId: string): void {
    context.active().setValue(Symbol.for(this.CORRELATION_ID_KEY), correlationId);
  }

  static getCorrelationId(): string | undefined {
    return context.active().getValue(Symbol.for(this.CORRELATION_ID_KEY)) as string;
  }

  static withCorrelationId<T>(correlationId: string, fn: () => T): T {
    return context.with(
      context.active().setValue(Symbol.for(this.CORRELATION_ID_KEY), correlationId),
      fn
    );
  }
}

// Custom metrics
export class Metrics {
  private static instance: Metrics;
  private meter: any;
  
  // Counters
  private messageCounter: any;
  private errorCounter: any;
  private apiCallCounter: any;
  
  // Histograms
  private responseTimeHistogram: any;
  private queueProcessingHistogram: any;
  private embeddingGenerationHistogram: any;
  
  // Gauges
  private activeConnectionsGauge: any;
  private queueDepthGauge: any;
  private memoryUsageGauge: any;

  private constructor() {
    this.meter = observability.getMeter('pup-ai-metrics');
    this.initializeMetrics();
  }

  static getInstance(): Metrics {
    if (!Metrics.instance) {
      Metrics.instance = new Metrics();
    }
    return Metrics.instance;
  }

  private initializeMetrics() {
    // Counters
    this.messageCounter = this.meter.createCounter('messages_processed_total', {
      description: 'Total number of messages processed',
    });

    this.errorCounter = this.meter.createCounter('errors_total', {
      description: 'Total number of errors',
    });

    this.apiCallCounter = this.meter.createCounter('api_calls_total', {
      description: 'Total number of API calls',
    });

    // Histograms
    this.responseTimeHistogram = this.meter.createHistogram('response_time_ms', {
      description: 'Response time in milliseconds',
      boundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    });

    this.queueProcessingHistogram = this.meter.createHistogram('queue_processing_time_ms', {
      description: 'Queue processing time in milliseconds',
      boundaries: [100, 500, 1000, 5000, 10000, 30000, 60000],
    });

    this.embeddingGenerationHistogram = this.meter.createHistogram('embedding_generation_time_ms', {
      description: 'Embedding generation time in milliseconds',
      boundaries: [100, 250, 500, 1000, 2500, 5000],
    });

    // Gauges
    this.activeConnectionsGauge = this.meter.createObservableGauge('active_connections', {
      description: 'Number of active connections',
    });

    this.queueDepthGauge = this.meter.createObservableGauge('queue_depth', {
      description: 'Current queue depth',
    });

    this.memoryUsageGauge = this.meter.createObservableGauge('memory_usage_bytes', {
      description: 'Memory usage in bytes',
    });

    // Set up gauge callbacks
    this.setupGaugeCallbacks();
  }

  private setupGaugeCallbacks() {
    // Memory usage callback
    this.memoryUsageGauge.addCallback((observableResult: any) => {
      const usage = process.memoryUsage();
      observableResult.observe(usage.heapUsed, { type: 'heap_used' });
      observableResult.observe(usage.heapTotal, { type: 'heap_total' });
      observableResult.observe(usage.rss, { type: 'rss' });
      observableResult.observe(usage.external, { type: 'external' });
    });
  }

  // Public methods for recording metrics
  recordMessage(channelId: string, userId: string, isBot: boolean) {
    this.messageCounter.add(1, {
      channel_id: channelId,
      user_id: userId,
      is_bot: isBot.toString(),
    });
  }

  recordError(errorType: string, component: string) {
    this.errorCounter.add(1, {
      error_type: errorType,
      component: component,
    });
  }

  recordApiCall(service: string, operation: string, success: boolean, duration: number) {
    this.apiCallCounter.add(1, {
      service,
      operation,
      success: success.toString(),
    });
    
    this.responseTimeHistogram.record(duration, {
      service,
      operation,
    });
  }

  recordQueueProcessing(queueName: string, success: boolean, duration: number) {
    this.queueProcessingHistogram.record(duration, {
      queue: queueName,
      success: success.toString(),
    });
  }

  recordEmbeddingGeneration(model: string, duration: number, tokens: number) {
    this.embeddingGenerationHistogram.record(duration, {
      model,
      token_bucket: this.getTokenBucket(tokens),
    });
  }

  private getTokenBucket(tokens: number): string {
    if (tokens <= 100) return '0-100';
    if (tokens <= 500) return '101-500';
    if (tokens <= 1000) return '501-1000';
    if (tokens <= 5000) return '1001-5000';
    return '5000+';
  }
}

// Export singleton instance
export const metrics = Metrics.getInstance();