/**
 * Optimized AI System Entry Point
 * 
 * This module exports the optimized AI components for pup.ai v2.
 * All AI operations should use these optimized interfaces for
 * better performance, cost efficiency, and quality.
 */

// Export optimized components
export { OptimizedPersonalityEngine } from './personalityOptimized';
export { OptimizedMemorySystem } from './memoryOptimized';
export { BatchEmbeddingProcessor, deduplicateBySemanticSimilarity } from './embeddings/batchProcessor';
export { TwoTierEmbeddingCache, RedisEmbeddingCache } from './embeddings/cache';
export { HybridSearchEngine, ThreadRetriever, createSearchIndexes } from './retrieval/hybridSearch';
export { costTracker, CostTracker } from './costTracking';
export { PromptOptimizer, PromptTemplateBuilder, OPTIMIZED_PROMPTS } from './prompts/promptOptimizer';
export { AIPerformanceDashboard, aiDashboard } from './monitoring/performanceDashboard';

// Re-export existing utilities
export { generateEmbedding, generateChatCompletion, openai } from './openai';
export { searchIntegration } from './searchIntegration';

// Type exports
export type { 
  OptimizedMemoryContext,
  ContextBuildOptions 
} from './memoryOptimized';

export type {
  HybridSearchOptions,
  ScoredMessage
} from './retrieval/hybridSearch';

export type {
  EnhancedMood,
  ResponseMetadata
} from './personalityOptimized';

export type {
  PromptVariant,
  PromptTest,
  PromptMetrics
} from './prompts/promptOptimizer';

export type {
  UsageMetrics,
  CostReport
} from './costTracking';

export type {
  AIPerformanceMetrics
} from './monitoring/performanceDashboard';

/**
 * Initialize AI system with optimizations
 */
export async function initializeAI(): Promise<void> {
  const { logger } = await import('@utils/logger');
  
  try {
    logger.info('Initializing optimized AI system...');

    // Create search indexes
    await createSearchIndexes();
    logger.info('✅ Search indexes created');

    // Test OpenAI connection
    const { testOpenAIConnection } = await import('./openai');
    const connected = await testOpenAIConnection();
    if (!connected) {
      throw new Error('Failed to connect to OpenAI');
    }
    logger.info('✅ OpenAI connection verified');

    // Initialize personality engine (singleton)
    const { OptimizedPersonalityEngine } = await import('./personalityOptimized');
    const personalityEngine = new OptimizedPersonalityEngine();
    logger.info('✅ Personality engine initialized');

    // Start cost tracking
    logger.info('✅ Cost tracking active');

    logger.info('🚀 Optimized AI system initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize AI system', { error: error as Error });
    throw error;
  }
}

/**
 * Shutdown AI system gracefully
 */
export async function shutdownAI(): Promise<void> {
  const { logger } = await import('@utils/logger');
  
  try {
    logger.info('Shutting down AI system...');

    // Close cache connections
    const cache = new TwoTierEmbeddingCache();
    await cache.close();

    // Export final cost report
    const report = await costTracker.generateReport(1);
    logger.info('Final cost report', { report });

    logger.info('AI system shutdown complete');
  } catch (error) {
    logger.error('Error during AI shutdown', { error: error as Error });
  }
}