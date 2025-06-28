import { GenericMessageEvent } from '@slack/bolt';
import { saveMessage, getRecentMessages } from './db';
import { generateResponse } from './ai';
import { addEmbeddingJob } from './worker';

const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || 'U07TRRMHGVC';
const MY_USER_ID = process.env.MY_USER_ID || '';

export async function handleMessage(
  message: GenericMessageEvent,
  say: any
): Promise<void> {
  try {
    // Skip bot's own messages
    if (message.user === BOT_USER_ID) return;
    
    // Skip messages without text
    if (!message.text) return;
    
    // Save the message
    const savedMessage = await saveMessage({
      slack_user_id: message.user || 'unknown',
      channel_id: message.channel,
      message_text: message.text,
      message_ts: message.ts,
      thread_ts: (message as any).thread_ts,
    });
    
    // Queue embedding generation
    if (savedMessage.id) {
      await addEmbeddingJob(savedMessage.id);
    }
    
    // Check if bot should respond
    const shouldRespond = await checkShouldRespond(message);
    if (!shouldRespond) return;
    
    // Get context
    const recentMessages = await getRecentMessages(message.channel, 20);
    
    // Generate response
    const response = await generateResponse(
      message.text,
      message.user || 'unknown',
      recentMessages
    );
    
    // Send response
    await say({
      text: response,
      thread_ts: (message as any).thread_ts || message.ts,
    });
    
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

async function checkShouldRespond(message: GenericMessageEvent): Promise<boolean> {
  const text = message.text?.toLowerCase() || '';
  
  // Always respond to direct mentions
  if (text.includes(`<@${BOT_USER_ID}>`)) return true;
  
  // Always respond in DMs
  if (message.channel_type === 'im') return true;
  
  // Respond to certain keywords
  const triggers = ['pup', 'pupper', 'good boy', 'bad dog'];
  if (triggers.some(trigger => text.includes(trigger))) return true;
  
  // 10% chance to interject randomly
  if (Math.random() < 0.1) return true;
  
  // Special handling for owner
  if (MY_USER_ID && message.user === MY_USER_ID && text.includes('?')) {
    return Math.random() < 0.3; // 30% chance to respond to owner's questions
  }
  
  return false;
}