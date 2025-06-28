import { app } from '../app.simple';
import { config } from '../../utils/config.simple';
import { pool } from '../../db/connection.simple';
import { addEmbeddingJob } from '../../workers/embeddings.simple';
import { generateResponse } from '../../ai/personality.simple';
import { logger } from '../../utils/logger.simple';

// Simple message handler
app.message(async ({ message, say, client }) => {
  // Skip bot messages and subtypes
  if (message.subtype !== undefined) return;
  
  const userMessage = message as any;
  
  // Skip messages from the bot itself
  if (userMessage.user === config.myUserId) return;
  
  try {
    // Ensure user exists
    await pool.query(`
      INSERT INTO users (slack_user_id, username)
      VALUES ($1, $1)
      ON CONFLICT (slack_user_id) DO NOTHING
    `, [userMessage.user]);
    
    // Store the message
    await pool.query(`
      INSERT INTO messages (
        slack_user_id, 
        channel_id, 
        message_text, 
        message_ts,
        thread_ts,
        created_at
      ) 
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (message_ts) DO NOTHING
    `, [
      userMessage.user,
      userMessage.channel,
      userMessage.text,
      userMessage.ts,
      userMessage.thread_ts || null
    ]);
    
    // Queue embedding generation
    await addEmbeddingJob({
      messageTs: userMessage.ts,
      messageText: userMessage.text,
      userId: userMessage.user,
      channelId: userMessage.channel,
    });
    
    logger.info(`Stored message from ${userMessage.user}: ${userMessage.text}`);
    
    // Check if bot was mentioned
    const botMention = `<@${config.myUserId}>`;
    if (userMessage.text && userMessage.text.includes(botMention)) {
      try {
        // Generate response
        const response = await generateResponse(
          userMessage.text.replace(botMention, '').trim(),
          userMessage.channel,
          userMessage.user,
          userMessage.thread_ts
        );
        
        await say({
          text: response,
          thread_ts: userMessage.thread_ts || userMessage.ts,
        });
      } catch (error) {
        logger.error('Error responding to mention:', error);
        await say({
          text: `Something went wrong, but I'm still here! 🤖`,
          thread_ts: userMessage.thread_ts || userMessage.ts,
        });
      }
    }
  } catch (error) {
    logger.error('Error processing message:', error);
  }
});