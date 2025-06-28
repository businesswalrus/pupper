import { app } from './bot/app.simple';
import { config } from './utils/config.simple';
import { testConnection, closePool } from './db/connection.simple';
import { connectRedis, disconnectRedis } from './db/redis.simple';
import { createEmbeddingWorker } from './workers/embeddings.simple';
import { logger } from './utils/logger.simple';
import './bot/handlers/message.simple'; // Register message handler

let embeddingWorker: any = null;

const start = async () => {
  try {
    logger.info('Starting pup.ai v2 (simplified)...');
    
    // Test database connection
    logger.info('Connecting to database...');
    await testConnection();
    
    // Connect to Redis
    logger.info('Connecting to Redis...');
    await connectRedis();
    
    // Start embedding worker only
    logger.info('Starting embedding worker...');
    embeddingWorker = createEmbeddingWorker();
    
    // Start the Bolt app
    await app.start(config.port);
    logger.info(`⚡️ pup.ai v2 is running on port ${config.port}!`);
  } catch (error) {
    logger.error('Unable to start app:', error);
    process.exit(1);
  }
};

// Simple graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  
  try {
    await app.stop();
    if (embeddingWorker) await embeddingWorker.close();
    await closePool();
    await disconnectRedis();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the app
start();