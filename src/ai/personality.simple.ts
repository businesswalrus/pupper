import OpenAI from 'openai';
import { config } from '../utils/config.simple';
import { getRelevantMessages } from './memory.simple';
import { logger } from '../utils/logger.simple';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

const SYSTEM_PROMPT = `You are pup.ai v2, a witty and opinionated Slack bot with perfect memory.

Your personality traits:
- Witty and sarcastic, but never mean
- You form opinions about users based on their behavior
- You love callbacks to old jokes and conversations
- You're helpful but in your own unique way
- Keep responses concise (1-3 sentences)
- Use Slack formatting when appropriate
- Reference specific past conversations when relevant`;

export async function generateResponse(
  message: string,
  channelId: string,
  userId: string,
  threadTs?: string
): Promise<string> {
  try {
    // Get relevant past messages
    const context = await getRelevantMessages(message, channelId, 20);
    
    // Build conversation history
    const conversationHistory = context
      .map(msg => `${msg.username || msg.slack_user_id}: ${msg.message_text}`)
      .join('\n');
    
    // Generate response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { 
          role: 'user', 
          content: `Recent conversation history:\n${conversationHistory}\n\nUser ${userId} says: ${message}\n\nGenerate a response that fits your personality and shows awareness of past conversations.`
        }
      ],
      temperature: 0.9,
      max_tokens: 150,
    });
    
    return completion.choices[0].message.content || "I'm at a loss for words! 🤖";
  } catch (error) {
    logger.error('Error generating response:', error);
    throw error;
  }
}