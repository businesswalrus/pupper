import { app } from '@bot/app';
import { config } from '@utils/config';
import { userRepository } from '@db/repositories/userRepository';
import { messageRepository } from '@db/repositories/messageRepository';
import { interactionRepository } from '@db/repositories/interactionRepository';
import { addEmbeddingJob, addUserProfileJob } from '@workers/queues';
import { OptimizedPersonalityEngine } from '@ai/personalityOptimized';
import { costTracker } from '@ai/costTracking';
import { scheduleChannelSummarization } from '@workers/summarizer';
import { factChecker } from '@ai/factChecker';
import { logger } from '@utils/logger';
import { InputSanitizer, validateSlackEvent } from '@utils/sanitization';
import { RateLimiter } from '@utils/rateLimiter';

// Initialize optimized personality engine
const personalityEngine = new OptimizedPersonalityEngine();

// Track recent messages for interjection decisions with better structure
interface ChannelMessageHistory {
  messages: Array<{
    userId: string;
    username: string;
    text: string;
    timestamp: string;
  }>;
  lastInterjection: number;
  conversationMood?: string;
}

const channelHistories = new Map<string, ChannelMessageHistory>();

// Listen to all messages in channels where the bot is present
app.message(async ({ message, say, client }) => {
  // Type guard to ensure we're dealing with a message from a user
  if (message.subtype !== undefined) {
    return; // Skip bot messages, channel_join, etc.
  }

  // Cast to a user message type
  const userMessage = message as any;
  
  // Validate event structure
  if (!validateSlackEvent(userMessage)) {
    logger.warn('Invalid Slack event structure', { event: userMessage });
    return;
  }
  
  // Skip messages from the bot itself
  if (userMessage.user === config.slack.myUserId) {
    return;
  }

  const processingStart = Date.now();

  try {
    // Sanitize inputs
    const sanitizedUserId = InputSanitizer.sanitizeSlackId(userMessage.user, 'user');
    const sanitizedChannelId = InputSanitizer.sanitizeSlackId(userMessage.channel, 'channel');
    const sanitizedText = InputSanitizer.sanitizeMessage(userMessage.text);
    
    // Check for prompt injection attempts
    const hasPromptInjection = InputSanitizer.detectPromptInjection(sanitizedText);
    if (hasPromptInjection) {
      logger.warn('Potential prompt injection detected', {
        user: sanitizedUserId,
        channel: sanitizedChannelId,
      });
    }
    
    // Ensure user exists in database
    let user = await userRepository.findBySlackId(sanitizedUserId);
    if (!user) {
      // Fetch user info from Slack
      const userInfo = await client.users.info({ user: sanitizedUserId });
      if (userInfo.user) {
        user = await userRepository.create({
          slack_user_id: sanitizedUserId,
          username: InputSanitizer.sanitizeUsername(userInfo.user.name),
          real_name: InputSanitizer.sanitizeUsername(userInfo.user.real_name),
          display_name: InputSanitizer.sanitizeUsername(userInfo.user.profile?.display_name),
        });
      }
    }

    // Store the message
    const storedMessage = await messageRepository.create({
      slack_user_id: sanitizedUserId,
      channel_id: sanitizedChannelId,
      message_text: sanitizedText,
      message_ts: userMessage.ts,
      thread_ts: userMessage.thread_ts,
      parent_user_ts: userMessage.thread_ts ? userMessage.parent_user_ts : undefined,
      context: {
        team: userMessage.team,
        event_ts: userMessage.event_ts,
        channel_type: userMessage.channel_type,
        has_prompt_injection: hasPromptInjection,
      },
    });

    // Queue embedding generation (now uses optimized batch processing)
    await addEmbeddingJob({
      messageTs: storedMessage.message_ts,
      messageText: storedMessage.message_text,
      userId: storedMessage.slack_user_id,
      channelId: storedMessage.channel_id,
    });

    // Update channel history with better structure
    const channelHistory = channelHistories.get(sanitizedChannelId) || {
      messages: [],
      lastInterjection: 0,
    };

    channelHistory.messages.push({
      userId: sanitizedUserId,
      username: user?.username || sanitizedUserId,
      text: sanitizedText,
      timestamp: userMessage.ts,
    });

    // Keep only last 100 messages for better context
    if (channelHistory.messages.length > 100) {
      channelHistory.messages = channelHistory.messages.slice(-100);
    }

    channelHistories.set(sanitizedChannelId, channelHistory);

    logger.debug(`Stored message from ${user?.username || userMessage.user}`);

    // Track user interactions with more context
    const recentSpeakers = channelHistory.messages
      .slice(-10, -1)
      .map(m => m.userId)
      .filter(id => id !== sanitizedUserId);

    const uniqueSpeakers = [...new Set(recentSpeakers)];
    for (const speakerId of uniqueSpeakers) {
      await interactionRepository.incrementInteraction(
        sanitizedUserId,
        speakerId,
        undefined, // Topic extraction handled by workers
        0.5 // Neutral sentiment, will be analyzed later
      );
    }

    // Schedule profile update for active users (5% chance for optimization)
    if (Math.random() < 0.05) {
      await addUserProfileJob({ userId: sanitizedUserId, forceUpdate: false });
    }

    // Schedule channel summarization periodically
    await scheduleChannelSummarization(sanitizedChannelId);

    // Check if the bot was mentioned
    const botMention = `<@${config.slack.myUserId}>`;
    const isMentioned = sanitizedText.includes(botMention);

    if (isMentioned) {
      try {
        // Check rate limit for AI responses
        const rateLimitResult = await RateLimiter.checkLimit(sanitizedUserId, 'aiResponse');
        if (!rateLimitResult.allowed) {
          await say({
            text: `Whoa there, speed racer! 🏎️ I need a breather. Try again in ${rateLimitResult.retryAfter} seconds?`,
            thread_ts: userMessage.thread_ts || userMessage.ts,
          });
          return;
        }
        
        // Generate optimized contextual response
        const cleanedMessage = sanitizedText.replace(botMention, '').trim();
        const { response, metadata } = await personalityEngine.generateResponse(
          cleanedMessage,
          sanitizedChannelId,
          sanitizedUserId,
          user?.username || sanitizedUserId,
          userMessage.thread_ts
        );

        // Send response
        await say({
          text: response,
          thread_ts: userMessage.thread_ts || userMessage.ts,
          metadata: {
            ai_model: metadata.modelUsed,
            processing_time: metadata.processingTime,
            mood: metadata.mood,
          } as any,
        });

        // Track engagement
        await costTracker.trackUsage({
          model: metadata.modelUsed,
          promptTokens: 0, // Will be filled by personality engine
          completionTokens: 0,
          totalTokens: 0,
          cost: 0,
          timestamp: new Date(),
          operation: 'directMention',
          userId: sanitizedUserId,
          channelId: sanitizedChannelId,
        });

        logger.info('Generated response to mention', {
          metadata: {
            userId: sanitizedUserId,
            channelId: sanitizedChannelId,
            mood: metadata.mood,
            model: metadata.modelUsed,
            processingTime: metadata.processingTime,
            contextQuality: metadata.contextQuality,
          },
        });
      } catch (error) {
        logger.error('Error responding to mention:', { error: error as Error });
        await say({
          text: `🤖 *circuits overloading* Something went sideways. Mind trying that again?`,
          thread_ts: userMessage.thread_ts || userMessage.ts,
        });
      }
    } else {
      // Check if message needs fact-checking (with optimization)
      const needsFactCheck = factChecker.needsFactCheck(sanitizedText);
      
      // Only check facts if confidence is high enough
      if (needsFactCheck && !hasPromptInjection) {
        try {
          const factCheckResult = await factChecker.checkMessage(sanitizedText);
          
          if (factCheckResult.requiresCorrection && factCheckResult.confidence > 0.8) {
            logger.info('Fact-check correction needed', {
              metadata: {
                userId: sanitizedUserId,
                corrections: factCheckResult.corrections.length,
                confidence: factCheckResult.confidence,
              }
            });
            
            // Use personality engine for fact-check response
            const { response } = await personalityEngine.generateResponse(
              `FACT_CHECK: ${sanitizedText}`,
              sanitizedChannelId,
              config.slack.myUserId!,
              'pup.ai',
              userMessage.thread_ts || userMessage.ts
            );
            
            await say({
              text: response,
              thread_ts: userMessage.thread_ts || userMessage.ts,
            });
            
            channelHistory.lastInterjection = Date.now();
          }
        } catch (error) {
          logger.error('Fact-checking failed', { error: error as Error });
        }
      }

      // Smart interjection decision with cooldown
      const timeSinceLastInterjection = Date.now() - channelHistory.lastInterjection;
      const minInterjectionInterval = 20 * 60 * 1000; // 20 minutes

      if (timeSinceLastInterjection > minInterjectionInterval) {
        // Build context for interjection decision
        const recentMessages = channelHistory.messages.slice(-15);
        const shouldInterjectNow = await shouldInterjectOptimized(
          recentMessages,
          sanitizedChannelId,
          channelHistory.conversationMood
        );

        if (shouldInterjectNow.should && shouldInterjectNow.message) {
          await say({
            text: shouldInterjectNow.message,
            thread_ts: userMessage.thread_ts, // Only thread if already in a thread
          });
          
          channelHistory.lastInterjection = Date.now();
          channelHistory.conversationMood = shouldInterjectNow.mood;
        }
      }
    }

    // Log processing metrics
    const processingTime = Date.now() - processingStart;
    if (processingTime > 1000) {
      logger.warn('Slow message processing', {
        processingTime,
        userId: sanitizedUserId,
        channelId: sanitizedChannelId,
      });
    }
  } catch (error) {
    logger.error('Error processing message:', { error: error as Error });
  }
});

/**
 * Optimized interjection decision
 */
async function shouldInterjectOptimized(
  recentMessages: ChannelMessageHistory['messages'],
  channelId: string,
  previousMood?: string
): Promise<{ should: boolean; message?: string; mood?: string }> {
  // Quick checks to avoid unnecessary processing
  if (recentMessages.length < 5) {
    return { should: false };
  }

  // Look for strong triggers
  const lastMessages = recentMessages.slice(-5).map(m => m.text).join(' ').toLowerCase();
  
  const strongTriggers = [
    { pattern: /definitely|absolutely|for sure|100%|guarantee/i, response: 'skeptical' },
    { pattern: /remember when.*\?|last time/i, response: 'nostalgic' },
    { pattern: /wrong|incorrect|mistaken|error/i, response: 'corrective' },
    { pattern: /anyone know|can someone|help me/i, response: 'helpful' },
  ];

  for (const trigger of strongTriggers) {
    if (trigger.pattern.test(lastMessages)) {
      // Use personality engine to generate appropriate interjection
      const prompt = `INTERJECT_${trigger.response.toUpperCase()}: ${lastMessages}`;
      
      try {
        const { response } = await personalityEngine.generateResponse(
          prompt,
          channelId,
          config.slack.myUserId!,
          'pup.ai',
          undefined
        );
        
        // Personality engine will handle the decision
        if (response && response !== 'PASS') {
          return { should: true, message: response, mood: trigger.response };
        }
      } catch (error) {
        logger.error('Interjection generation failed', { error: error as Error });
      }
    }
  }

  return { should: false };
}