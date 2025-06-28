import 'dotenv/config';
import { App } from '@slack/bolt';
import { handleMessage } from './bot';
import { runMigrations } from './db';
import { startWorker } from './worker';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  signingSecret: process.env.SLACK_SIGNING_SECRET || 'dummy',
});

async function start() {
  try {
    // Run database migrations
    console.log('Running migrations...');
    await runMigrations();
    
    // Start the worker
    console.log('Starting worker...');
    startWorker();
    
    // Register message handler
    app.message(async ({ message, say }) => {
      await handleMessage(message, say);
    });
    
    // Start the app
    await app.start();
    console.log('⚡️ pup.ai is running!');
    
    // Simple health check endpoint
    const express = (app as any).receiver.app;
    express.get('/health', (_req: any, res: any) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

start();