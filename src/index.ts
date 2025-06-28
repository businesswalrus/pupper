console.log('Starting pup.ai v2 - Loading modules...');

import { app, initializeSecurity } from '@bot/app';
import { config } from '@utils/config';
import { testConnection, closePool } from '@db/connection';
import { connectRedis, disconnectRedis } from '@db/redis';
import { createEmbeddingWorker, processUnembeddedMessages } from '@workers/embeddings';
import { createSummarizerWorker } from '@workers/summarizer';
import { createProfilerWorker, scheduleActiveUserProfiling } from '@workers/profiler';
import { Worker } from 'bullmq';
import { logger } from '@utils/logger';
import { isOperationalError } from '@utils/errors';
import '@utils/validation'; // Validates environment on load
import '@bot/handlers/message'; // Import message handler to register it
import '@bot/commands/search'; // Import search commands

console.log('Modules loaded successfully');

let embeddingWorker: Worker | null = null;
let summarizerWorker: Worker | null = null;
let profilerWorker: Worker | null = null;

const start = async () => {
  try {
    logger.info('Starting pup.ai v2...');
    logger.info(`Environment: ${config.app.nodeEnv}`);
    logger.info(`Port: ${config.app.port}`);
    
    // Test database connection
    logger.info('Connecting to database...');
    await testConnection();
    logger.info('Database connected successfully');
    
    // Connect to Redis
    logger.info('Connecting to Redis...');
    await connectRedis();
    logger.info('Redis connected successfully');
    
    // Initialize security features
    logger.info('Initializing security features...');
    await initializeSecurity();
    logger.info('Security features initialized');

    // Start all workers
    logger.info('Starting background workers...');
    embeddingWorker = createEmbeddingWorker();
    summarizerWorker = createSummarizerWorker();
    profilerWorker = createProfilerWorker();
    logger.info('Background workers started');

    // Process any existing messages without embeddings
    setTimeout(async () => {
      await processUnembeddedMessages();
      await scheduleActiveUserProfiling();
    }, 5000); // Wait 5 seconds after startup

    // Start the Bolt app
    logger.info('Starting Slack app...');
    await app.start(config.app.port);
    logger.info(`⚡️ pup.ai v2 is running on port ${config.app.port} in ${config.app.nodeEnv} mode!`);
    logger.info(`🐕 Bot user ID: ${config.slack.myUserId}`);
    logger.info(`💾 Database connected, Redis connected`);
    logger.info(`🧠 AI features enabled with memory and personality`);
  } catch (error) {
    logger.error('Unable to start app', { error: error as Error });
    console.error('Startup error:', error); // Also log to console for Railway
    process.exit(1);
  }
};

// Handle graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  
  try {
    // Stop accepting new requests
    await app.stop();
    
    // Stop workers
    if (embeddingWorker) {
      await embeddingWorker.close();
    }
    if (summarizerWorker) {
      await summarizerWorker.close();
    }
    if (profilerWorker) {
      await profilerWorker.close();
    }
    
    // Close database connections
    await closePool();
    
    // Close Redis connection
    await disconnectRedis();
    
    console.log('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Global error handlers
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception', { error });
  
  // Only exit for non-operational errors
  if (!isOperationalError(error)) {
    logger.error('Non-operational error, exiting...');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  logger.error('Unhandled Rejection', { 
    error: reason instanceof Error ? reason : new Error(String(reason)),
    metadata: { promise: promise.toString() }
  });
  
  // Only exit for non-operational errors
  if (reason instanceof Error && !isOperationalError(reason)) {
    logger.error('Non-operational rejection, exiting...');
    process.exit(1);
  }
});

// Start the app
console.log('Calling start() function...');
start().catch((error) => {
  console.error('Failed to start app:', error);
  process.exit(1);
});