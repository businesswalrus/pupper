#!/usr/bin/env ts-node
/**
 * Migration script to upgrade to optimized AI system
 * 
 * This script:
 * 1. Creates necessary database indexes
 * 2. Migrates existing embeddings to cached format
 * 3. Updates worker configurations
 * 4. Validates the migration
 */

import { pool } from '@db/connection';
import { createSearchIndexes } from '@ai/retrieval/hybridSearch';
import { TwoTierEmbeddingCache } from '@ai/embeddings/cache';
import { BatchEmbeddingProcessor } from '@ai/embeddings/batchProcessor';
import { bulkProcessUnembeddedMessages, analyzeEmbeddingUsage } from '@workers/embeddingsOptimized';
import { logger } from '@utils/logger';
import { config } from '@utils/config';

async function main() {
  logger.info('Starting migration to optimized AI system...');

  try {
    // Step 1: Create search indexes
    logger.info('Creating search indexes...');
    await createSearchIndexes();
    
    // Create additional indexes for optimization
    const additionalIndexes = [
      // Index for embedding lookups
      `CREATE INDEX IF NOT EXISTS idx_messages_embedding_exists 
       ON messages(message_ts) WHERE embedding IS NOT NULL`,
      
      // Index for cost tracking queries
      `CREATE INDEX IF NOT EXISTS idx_messages_user_created 
       ON messages(slack_user_id, created_at DESC)`,
    ];

    for (const query of additionalIndexes) {
      await pool.query(query);
    }
    logger.info('✅ Database indexes created');

    // Step 2: Analyze current state
    logger.info('Analyzing current embedding coverage...');
    const preStats = await analyzeEmbeddingUsage();
    logger.info('Current state:', {
      coverage: `${preStats.coverage.toFixed(1)}%`,
      embedded: preStats.embeddedMessages,
      total: preStats.totalMessages,
    });

    // Step 3: Cache existing embeddings
    logger.info('Caching existing embeddings...');
    const cache = new TwoTierEmbeddingCache();
    const batchProcessor = new BatchEmbeddingProcessor(cache);

    const existingEmbeddings = await pool.query(`
      SELECT message_ts, message_text, embedding
      FROM messages
      WHERE embedding IS NOT NULL
      LIMIT 10000
    `);

    logger.info(`Found ${existingEmbeddings.rows.length} existing embeddings to cache`);

    // Cache in batches
    const batchSize = 100;
    for (let i = 0; i < existingEmbeddings.rows.length; i += batchSize) {
      const batch = existingEmbeddings.rows.slice(i, i + batchSize);
      const cacheEntries: Array<[string, number[]]> = batch.map(row => {
        const embedding = Array.isArray(row.embedding) 
          ? row.embedding 
          : JSON.parse(row.embedding.replace(/^\[|\]$/g, '').split(',').map(Number));
        
        return [
          generateTextHash(row.message_text),
          embedding
        ];
      });

      await cache.mset(cacheEntries);
      
      if (i % 1000 === 0) {
        logger.info(`Cached ${i + batch.length} embeddings`);
      }
    }
    logger.info('✅ Existing embeddings cached');

    // Step 4: Process unembedded messages
    const unembeddedCount = preStats.totalMessages - preStats.embeddedMessages;
    if (unembeddedCount > 0) {
      logger.info(`Processing ${unembeddedCount} unembedded messages...`);
      
      const processLimit = Math.min(unembeddedCount, 1000); // Process up to 1000 in migration
      await bulkProcessUnembeddedMessages(processLimit, 50);
      
      logger.info('✅ Unembedded messages processed');
    }

    // Step 5: Create monitoring tables
    logger.info('Creating monitoring tables...');
    const monitoringTables = `
      -- Search performance logs
      CREATE TABLE IF NOT EXISTS search_logs (
        id SERIAL PRIMARY KEY,
        query TEXT,
        channel_id VARCHAR(255),
        search_type VARCHAR(50),
        relevance_score FLOAT,
        result_count INT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Prompt test results
      CREATE TABLE IF NOT EXISTS prompt_test_results (
        id SERIAL PRIMARY KEY,
        test_id VARCHAR(255),
        variant_id VARCHAR(255),
        user_id VARCHAR(255),
        quality_score FLOAT,
        response_time INT,
        tokens_used INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- AI interaction logs
      CREATE TABLE IF NOT EXISTS ai_interactions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255),
        channel_id VARCHAR(255),
        message_type VARCHAR(50),
        mood VARCHAR(50),
        context_quality FLOAT,
        model_used VARCHAR(100),
        tokens_used INT,
        cost DECIMAL(10, 6),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await pool.query(monitoringTables);
    logger.info('✅ Monitoring tables created');

    // Step 6: Validate migration
    logger.info('Validating migration...');
    const postStats = await analyzeEmbeddingUsage();
    const cacheStats = cache.getStats();

    logger.info('Migration complete!', {
      coverage: {
        before: `${preStats.coverage.toFixed(1)}%`,
        after: `${postStats.coverage.toFixed(1)}%`,
      },
      embeddings: {
        before: preStats.embeddedMessages,
        after: postStats.embeddedMessages,
        added: postStats.embeddedMessages - preStats.embeddedMessages,
      },
      cache: {
        entries: cacheStats.sets,
        hitRate: `${cacheStats.hitRate.toFixed(1)}%`,
      },
    });

    // Step 7: Update environment variables reminder
    logger.info('\n⚠️  Environment variables to set:');
    logger.info('AI_DAILY_BUDGET=10  # Daily spending limit in USD');
    logger.info('AI_HOURLY_BUDGET=1  # Hourly spending limit in USD');

    await cache.close();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', { error: error as Error });
    process.exit(1);
  }
}

function generateTextHash(text: string): string {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(text.normalize())
    .digest('hex')
    .substring(0, 16);
}

// Run migration
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});