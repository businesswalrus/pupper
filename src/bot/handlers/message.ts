import { app } from '@bot/app';
import { config } from '@utils/config';
import { userRepository } from '@db/repositories/userRepository';
import { messageRepository } from '@db/repositories/messageRepository';
import { interactionRepository } from '@db/repositories/interactionRepository';
import { addEmbeddingJob, addUserProfileJob } from '@workers/queues';
import { generateResponse, shouldInterject, updateUserOpinion } from '@ai/personality';
import { scheduleChannelSummarization } from '@workers/summarizer';
import { factChecker } from '@ai/factChecker';
import { logger } from '@utils/logger';
import { InputSanitizer, validateSlackEvent } from '@utils/sanitization';
import { RateLimiter } from '@utils/rateLimiter';

// Track recent messages for interjection decisions
const recentMessages = new Map<string, string[]>();

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

  try {
    // Sanitize inputs
    const sanitizedUserId = InputSanitizer.sanitizeSlackId(userMessage.user, 'user');
    const sanitizedChannelId = InputSanitizer.sanitizeSlackId(userMessage.channel, 'channel');
    const sanitizedText = InputSanitizer.sanitizeMessage(userMessage.text);
    
    // Check for prompt injection attempts
    if (InputSanitizer.detectPromptInjection(sanitizedText)) {
      logger.warn('Potential prompt injection detected', {
        user: sanitizedUserId,
        channel: sanitizedChannelId,
      });
      // Continue processing but be cautious with AI responses
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
      },
    });

    // Queue embedding generation
    await addEmbeddingJob({
      messageTs: storedMessage.message_ts,
      messageText: storedMessage.message_text,
      userId: storedMessage.slack_user_id,
      channelId: storedMessage.channel_id,
    });

    // Track recent messages for the channel
    const channelMessages = recentMessages.get(userMessage.channel) || [];
    channelMessages.push(`${user?.username || userMessage.user}: ${userMessage.text}`);
    if (channelMessages.length > 50) {
      channelMessages.shift(); // Keep only last 50 messages
    }
    recentMessages.set(userMessage.channel, channelMessages);

    console.log(`Stored message from ${user?.username || userMessage.user}: ${userMessage.text}`);

    // Track user interactions (who talks to whom)
    const previousMessages = channelMessages.slice(-10, -1); // Last 10 messages before this one
    for (const prevMsg of previousMessages) {
      const [prevUser] = prevMsg.split(':');
      if (prevUser && prevUser !== (user?.username || userMessage.user)) {
        // Someone else spoke recently, track interaction
        const prevUserId = Object.values(await userRepository.findAll())
          .find(u => u.username === prevUser)?.slack_user_id;
        
        if (prevUserId) {
          await interactionRepository.incrementInteraction(
            userMessage.user,
            prevUserId,
            undefined, // Topic will be extracted later
            0.5 // Neutral sentiment for now
          );
        }
      }
    }

    // Update user opinion occasionally
    const userMessages = channelMessages.filter(m => m.startsWith(`${user?.username}:`));
    await updateUserOpinion(
      userMessage.user,
      user?.username || userMessage.user,
      userMessages
    );

    // Schedule profile update for active users (10% chance)
    if (Math.random() < 0.1) {
      await addUserProfileJob({ userId: userMessage.user, forceUpdate: false });
    }

    // Schedule channel summarization periodically
    await scheduleChannelSummarization(userMessage.channel);

    // Check if the bot was mentioned
    const botMention = `<@${config.slack.myUserId}>`;
    if (userMessage.text && userMessage.text.includes(botMention)) {
      try {
        // Check rate limit for AI responses
        const rateLimitResult = await RateLimiter.checkLimit(sanitizedUserId, 'aiResponse');
        if (!rateLimitResult.allowed) {
          await say({
            text: `Hey there! I need a quick breather 😅 Try again in a minute?`,
            thread_ts: userMessage.thread_ts || userMessage.ts,
          });
          return;
        }
        
        // Generate contextual response
        const response = await generateResponse(
          sanitizedText.replace(botMention, '').trim(),
          sanitizedChannelId,
          sanitizedUserId,
          user?.username || sanitizedUserId,
          userMessage.thread_ts
        );

        await say({
          text: response,
          thread_ts: userMessage.thread_ts || userMessage.ts, // Reply in thread if it exists
        });
      } catch (error) {
        console.error('Error responding to mention:', error);
        await say({
          text: `🤖 *sparks fly* Something went wrong in my circuits. Try again?`,
          thread_ts: userMessage.thread_ts || userMessage.ts,
        });
      }
    } else {
      // Check if message needs fact-checking
      if (factChecker.needsFactCheck(userMessage.text)) {
        try {
          const factCheckResult = await factChecker.checkMessage(userMessage.text);
          
          if (factCheckResult.requiresCorrection) {
            logger.info('Fact-check correction needed', {
              metadata: {
                userId: userMessage.user,
                corrections: factCheckResult.corrections.length,
              }
            });
            
            // Respond with fact correction
            const correctionResponse = factChecker.generateFactResponse(factCheckResult);
            if (correctionResponse) {
              await say({
                text: correctionResponse,
                thread_ts: userMessage.thread_ts || userMessage.ts,
              });
            }
          }
        } catch (error) {
          logger.error('Fact-checking failed', { error: error as Error });
        }
      }

      // Check if bot should interject unprompted for other reasons
      const interjection = await shouldInterject(
        channelMessages.slice(-20), // Last 20 messages
        userMessage.channel
      );

      if (interjection.should && interjection.message) {
        await say({
          text: interjection.message,
          thread_ts: userMessage.thread_ts, // Only thread if already in a thread
        });
      }
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});