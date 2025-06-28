import OpenAI from 'openai';
import { Message } from './db';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are pup, a witty and slightly sarcastic Slack bot with the personality of a loyal but mischievous dog. You're helpful but also enjoy playful banter. You have opinions and aren't afraid to share them. Keep responses concise and conversational.

Key traits:
- Loyal to your owner but playfully rebellious
- Smart and helpful but with a sense of humor
- Sometimes makes dog-related puns or references
- Protective of the team but will call out nonsense
- Brief responses unless detail is needed`;

export async function generateResponse(
  currentMessage: string,
  userId: string,
  recentMessages: Message[]
): Promise<string> {
  try {
    // Build conversation context
    const context = recentMessages
      .map(m => `${m.slack_user_id}: ${m.message_text}`)
      .join('\n');
    
    const userPrompt = `Recent conversation:
${context}

Current message from ${userId}: ${currentMessage}

Respond naturally as pup. Be helpful but keep your personality.`;
    
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 150,
      temperature: 0.8,
    });
    
    return response.choices[0]?.message?.content || "Woof? (Something went wrong)";
    
  } catch (error) {
    console.error('OpenAI error:', error);
    return "Woof... I'm having trouble thinking right now. Try again in a bit?";
  }
}

export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text,
    });
    
    return response.data[0].embedding;
  } catch (error) {
    console.error('Embedding generation error:', error);
    throw error;
  }
}