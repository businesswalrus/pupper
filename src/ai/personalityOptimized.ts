import { userRepository } from '@db/repositories/userRepository';
import { generateChatCompletion } from '@ai/openai';
import { OptimizedMemorySystem } from '@ai/memoryOptimized';
import { searchIntegration } from '@ai/searchIntegration';
import { costTracker } from '@ai/costTracking';
import { PromptOptimizer, PromptTemplateBuilder, OPTIMIZED_PROMPTS } from '@ai/prompts/promptOptimizer';
import { logger } from '@utils/logger';
import { Redis } from 'ioredis';
import { config } from '@utils/config';

export interface EnhancedMood {
  name: string;
  intensity: number; // 0-1
  triggers: string[];
  responseModifiers: {
    temperature: number;
    lengthBias: number; // -1 (shorter) to 1 (longer)
    humorLevel: number; // 0-1
    formalityLevel: number; // 0-1
  };
}

export interface ResponseMetadata {
  mood: string;
  confidence: number;
  factChecked: boolean;
  contextQuality: number;
  modelUsed: string;
  promptVariant?: string;
  processingTime: number;
}

/**
 * Enhanced personality system with optimizations
 */
export class OptimizedPersonalityEngine {
  private memorySystem: OptimizedMemorySystem;
  private promptOptimizer: PromptOptimizer;
  private redis: Redis;
  private responseCache: Map<string, { response: string; metadata: ResponseMetadata }>;
  
  // Enhanced mood system
  private readonly MOODS: Record<string, EnhancedMood> = {
    excited: {
      name: 'excited',
      intensity: 0.8,
      triggers: ['ship', 'deploy', 'launch', 'release', 'merge', 'production', '🚀'],
      responseModifiers: {
        temperature: 0.9,
        lengthBias: 0.2,
        humorLevel: 0.9,
        formalityLevel: 0.2,
      },
    },
    sarcastic: {
      name: 'sarcastic',
      intensity: 0.7,
      triggers: ['bug', 'broken', 'not working', 'error', 'failed', 'oops', '🤦'],
      responseModifiers: {
        temperature: 0.8,
        lengthBias: 0,
        humorLevel: 1.0,
        formalityLevel: 0.1,
      },
    },
    analytical: {
      name: 'analytical',
      intensity: 0.6,
      triggers: ['analyze', 'data', 'metrics', 'performance', 'why', 'how does'],
      responseModifiers: {
        temperature: 0.6,
        lengthBias: 0.5,
        humorLevel: 0.3,
        formalityLevel: 0.7,
      },
    },
    helpful: {
      name: 'helpful',
      intensity: 0.5,
      triggers: ['help', 'how do I', 'what is', 'can someone', 'stuck', 'question'],
      responseModifiers: {
        temperature: 0.7,
        lengthBias: 0.3,
        humorLevel: 0.4,
        formalityLevel: 0.5,
      },
    },
    nostalgic: {
      name: 'nostalgic',
      intensity: 0.6,
      triggers: ['remember when', 'last time', 'used to', 'back in', 'old days'],
      responseModifiers: {
        temperature: 0.7,
        lengthBias: 0.2,
        humorLevel: 0.6,
        formalityLevel: 0.3,
      },
    },
    neutral: {
      name: 'neutral',
      intensity: 0.5,
      triggers: [],
      responseModifiers: {
        temperature: 0.7,
        lengthBias: 0,
        humorLevel: 0.5,
        formalityLevel: 0.4,
      },
    },
  };

  constructor() {
    this.memorySystem = new OptimizedMemorySystem();
    this.promptOptimizer = new PromptOptimizer();
    this.redis = new Redis(config.redis.url);
    this.responseCache = new Map();
  }

  /**
   * Generate an optimized response
   */
  async generateResponse(
    message: string,
    channelId: string,
    userId: string,
    userName: string,
    threadTs?: string
  ): Promise<{ response: string; metadata: ResponseMetadata }> {
    const startTime = Date.now();

    // Check response cache
    const cacheKey = `${channelId}:${message.substring(0, 50)}:${threadTs || 'main'}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached && Date.now() - cached.metadata.processingTime < 60000) {
      logger.debug('Using cached response');
      return cached;
    }

    try {
      // Build optimized context
      const context = await this.memorySystem.buildContext(channelId, message, {
        threadTs,
        semanticWeight: 0.7,
        diversityWeight: 0.2,
        recentLimit: 25,
        relevantLimit: 15,
      });

      // Determine mood from context
      const mood = this.determineMood(context.recentMessages.map(m => m.message_text), message);

      // Check if fact-checking is needed
      const searchContext = await searchIntegration.analyzeSearchNeed(
        message,
        userId,
        context.recentMessages.slice(-5).map(m => m.message_text)
      );

      let searchResponse;
      if (searchContext.shouldSearch) {
        searchResponse = await searchIntegration.searchAndIntegrate(message, searchContext);
      }

      // Select optimal model based on context
      const modelSelection = await costTracker.selectOptimalModel(message, {
        requiresSearch: searchContext.shouldSearch,
        conversationLength: context.recentMessages.length,
        responseComplexity: this.assessComplexity(message, context),
      });

      // Get or create prompt variant
      let systemPrompt = OPTIMIZED_PROMPTS.SYSTEM_BALANCED;
      let promptVariantId: string | undefined;

      const activeTest = await this.promptOptimizer.getActiveTest('system');
      if (activeTest) {
        const variant = await this.promptOptimizer.selectVariant(activeTest.id, userId);
        if (variant) {
          systemPrompt = variant.systemPrompt || systemPrompt;
          promptVariantId = variant.id;
        }
      }

      // Build response prompt
      const formattedContext = this.memorySystem.formatContext(context, {
        maxTokens: 3000,
        includeScores: false,
        prioritizeRecent: true,
      });

      const responsePrompt = PromptTemplateBuilder.buildOptimal('response', {
        conversationLength: context.recentMessages.length,
        complexity: this.assessComplexity(message, context),
        hasFactChecking: searchContext.shouldSearch,
      }, {
        context: formattedContext,
        message,
        userName,
      });

      // Add search results to prompt if available
      let enhancedPrompt = responsePrompt;
      if (searchResponse && searchResponse.searchResults.length > 0) {
        enhancedPrompt += '\n\n=== Verified Information ===\n';
        enhancedPrompt += searchResponse.searchResults
          .slice(0, 3)
          .map(r => `${r.title}: ${r.snippet} [${r.url}]`)
          .join('\n');
      }

      // Generate response with mood-adjusted parameters
      const moodModifiers = mood.responseModifiers;
      const temperature = 0.7 + (moodModifiers.temperature - 0.7) * mood.intensity;
      const maxTokens = Math.round(200 * (1 + moodModifiers.lengthBias));

      const response = await generateChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: enhancedPrompt },
      ], {
        temperature,
        max_tokens: Math.max(100, Math.min(400, maxTokens)),
        model: modelSelection.model,
      });

      // Apply post-processing based on mood
      let finalResponse = this.applyMoodPostProcessing(response.content, mood);

      // Add citations if available
      if (searchResponse && searchResponse.citations.length > 0) {
        finalResponse = searchIntegration.formatCitations(finalResponse, searchResponse.citations);
      }

      // Track usage and costs
      await costTracker.trackUsage({
        model: modelSelection.model,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
        cost: 0, // Will be calculated by tracker
        timestamp: new Date(),
        operation: 'generateResponse',
        userId,
        channelId,
      });

      // Track prompt test metrics if applicable
      if (activeTest && promptVariantId) {
        const quality = context.contextWindow.quality;
        await this.promptOptimizer.trackMetrics(activeTest.id, promptVariantId, {
          quality,
          responseTime: Date.now() - startTime,
          tokens: response.usage.total_tokens,
        });
      }

      const metadata: ResponseMetadata = {
        mood: mood.name,
        confidence: context.contextWindow.quality,
        factChecked: searchContext.shouldSearch,
        contextQuality: context.contextWindow.quality,
        modelUsed: modelSelection.model,
        promptVariant: promptVariantId,
        processingTime: Date.now() - startTime,
      };

      // Cache the response
      this.responseCache.set(cacheKey, { response: finalResponse, metadata });

      // Update user interaction data
      await this.updateUserInteraction(userId, userName, message, finalResponse);

      return { response: finalResponse, metadata };
    } catch (error) {
      logger.error('Error generating optimized response', { error: error as Error });
      
      const metadata: ResponseMetadata = {
        mood: 'neutral',
        confidence: 0,
        factChecked: false,
        contextQuality: 0,
        modelUsed: 'error',
        processingTime: Date.now() - startTime,
      };

      return {
        response: "🤖 *sparks fly* My circuits are a bit scrambled. Try again?",
        metadata,
      };
    }
  }

  /**
   * Determine mood from conversation context
   */
  private determineMood(recentMessages: string[], currentMessage: string): EnhancedMood {
    const allText = [...recentMessages, currentMessage].join(' ').toLowerCase();
    
    // Score each mood based on trigger matches
    let bestMood = this.MOODS.neutral;
    let bestScore = 0;

    for (const mood of Object.values(this.MOODS)) {
      if (mood.triggers.length === 0) continue;

      let score = 0;
      for (const trigger of mood.triggers) {
        const matches = (allText.match(new RegExp(trigger, 'gi')) || []).length;
        score += matches * mood.intensity;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMood = mood;
      }
    }

    // Decay intensity based on how many messages ago the triggers were
    const recentText = recentMessages.slice(-3).join(' ').toLowerCase();
    let recentTriggers = 0;
    for (const trigger of bestMood.triggers) {
      if (recentText.includes(trigger)) recentTriggers++;
    }

    const adjustedMood = {
      ...bestMood,
      intensity: bestMood.intensity * (0.5 + 0.5 * (recentTriggers / bestMood.triggers.length)),
    };

    return adjustedMood;
  }

  /**
   * Assess message complexity
   */
  private assessComplexity(
    message: string,
    context: any
  ): 'simple' | 'moderate' | 'complex' {
    const factors = {
      messageLength: message.length,
      questionWords: ['why', 'how', 'what', 'when', 'where', 'analyze', 'explain'].filter(w => 
        message.toLowerCase().includes(w)
      ).length,
      technicalTerms: ['api', 'database', 'algorithm', 'function', 'error', 'debug'].filter(w =>
        message.toLowerCase().includes(w)
      ).length,
      contextSize: context.recentMessages.length + context.relevantMessages.length,
    };

    const complexityScore = 
      (factors.messageLength > 100 ? 1 : 0) +
      (factors.questionWords > 1 ? 1 : 0) +
      (factors.technicalTerms > 0 ? 1 : 0) +
      (factors.contextSize > 30 ? 1 : 0);

    if (complexityScore >= 3) return 'complex';
    if (complexityScore >= 1) return 'moderate';
    return 'simple';
  }

  /**
   * Apply mood-based post-processing
   */
  private applyMoodPostProcessing(response: string, mood: EnhancedMood): string {
    // Add mood-specific elements
    if (mood.name === 'excited' && mood.intensity > 0.7) {
      // Add excitement indicators
      if (!response.includes('!') && Math.random() < mood.intensity) {
        response = response.replace(/\.$/, '!');
      }
      // Maybe add an emoji
      if (Math.random() < mood.intensity * 0.5) {
        response += ' 🚀';
      }
    } else if (mood.name === 'sarcastic' && mood.intensity > 0.6) {
      // Add sarcastic elements
      if (Math.random() < mood.intensity * 0.3) {
        response = `*${response}*`; // Italicize for sarcasm
      }
    }

    // Adjust formality based on mood
    if (mood.responseModifiers.formalityLevel < 0.3) {
      // Make more casual
      response = response
        .replace(/\bI am\b/g, "I'm")
        .replace(/\bYou are\b/g, "You're")
        .replace(/\bIt is\b/g, "It's");
    }

    return response;
  }

  /**
   * Update user interaction tracking
   */
  private async updateUserInteraction(
    userId: string,
    userName: string,
    message: string,
    response: string
  ): Promise<void> {
    try {
      // Track interaction for personality learning
      const key = `user:interaction:${userId}`;
      const interaction = {
        timestamp: Date.now(),
        message: message.substring(0, 200),
        response: response.substring(0, 200),
      };

      await this.redis.zadd(key, Date.now(), JSON.stringify(interaction));
      await this.redis.expire(key, 30 * 24 * 60 * 60); // 30 days

      // Occasionally update personality profile
      if (Math.random() < 0.05) { // 5% chance
        await this.updateUserPersonality(userId, userName);
      }
    } catch (error) {
      logger.error('Failed to update user interaction', { error: error as Error });
    }
  }

  /**
   * Update user personality profile
   */
  private async updateUserPersonality(userId: string, userName: string): Promise<void> {
    try {
      // Get recent interactions
      const interactions = await this.redis.zrange(
        `user:interaction:${userId}`,
        -50,
        -1
      );

      if (interactions.length < 10) return; // Need enough data

      const messages = interactions.map(i => {
        try {
          return JSON.parse(i).message;
        } catch {
          return '';
        }
      }).filter(m => m);

      // Generate personality summary
      const prompt = PromptTemplateBuilder.build(
        `Analyze these messages from ${userName} and create a personality profile (2-3 sentences, witty):

Messages:
${messages.slice(-30).join('\n')}

Profile:`,
        {}
      );

      const response = await generateChatCompletion([
        { role: 'system', content: 'You are an expert at reading people and describing them cleverly.' },
        { role: 'user', content: prompt },
      ], {
        temperature: 0.8,
        max_tokens: 100,
        model: 'gpt-3.5-turbo', // Use cheaper model for this
      });

      // Update user profile
      await userRepository.update(userId, {
        personality_summary: response.content,
        last_interaction: new Date(),
      });

      logger.info('Updated user personality', { userId, userName });
    } catch (error) {
      logger.error('Failed to update user personality', { error: error as Error });
    }
  }

  /**
   * Clear response cache
   */
  clearCache(): void {
    this.responseCache.clear();
    this.memorySystem.clearCache();
  }
}