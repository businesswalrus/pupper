import { userRepository } from '@db/repositories/userRepository';
import { generateChatCompletion } from '@ai/openai';
import { 
  SYSTEM_PROMPT, 
  buildResponsePrompt, 
  buildInterjectionPrompt,
  formatUserContext 
} from '@ai/prompts';
import { buildConversationContext, formatMemoryContext } from '@ai/memory';
import { searchIntegration } from '@ai/searchIntegration';
import { logger } from '@utils/logger';

export interface Mood {
  name: string;
  intensity: number; // 0-1
  triggers: string[];
}

export interface PersonalityState {
  currentMood: Mood;
  recentTopics: string[];
  userOpinions: Map<string, string>;
}

// Bot moods based on conversation context
const MOODS: Record<string, Mood> = {
  excited: {
    name: 'excited',
    intensity: 0.8,
    triggers: ['deployment', 'shipping', 'launch', 'release', 'new feature'],
  },
  sarcastic: {
    name: 'sarcastic',
    intensity: 0.7,
    triggers: ['bug', 'broken', 'not working', 'error', 'failed'],
  },
  nostalgic: {
    name: 'nostalgic',
    intensity: 0.6,
    triggers: ['remember when', 'last time', 'used to', 'back in'],
  },
  helpful: {
    name: 'helpful',
    intensity: 0.5,
    triggers: ['help', 'how do I', 'what is', 'can someone', 'does anyone'],
  },
  neutral: {
    name: 'neutral',
    intensity: 0.5,
    triggers: [],
  },
};

// Personality state (in production, this would be persisted)
const personalityState: PersonalityState = {
  currentMood: MOODS.neutral,
  recentTopics: [],
  userOpinions: new Map(),
};

/**
 * Determine current mood based on recent messages
 */
export function determineMood(recentMessages: string[]): Mood {
  const messageText = recentMessages.join(' ').toLowerCase();
  
  for (const mood of Object.values(MOODS)) {
    if (mood.triggers.some(trigger => messageText.includes(trigger))) {
      return mood;
    }
  }
  
  return MOODS.neutral;
}

/**
 * Generate a contextual response
 */
export async function generateResponse(
  message: string,
  channelId: string,
  userId: string,
  userName: string,
  threadTs?: string
): Promise<string> {
  try {
    // Build conversation context first
    const context = await buildConversationContext(channelId, message, {
      recentLimit: 30,
      relevantLimit: 10,
      hours: 48,
      threadTs,
    });

    // Check if we need to search for information
    const searchContext = await searchIntegration.analyzeSearchNeed(
      message,
      userId,
      context.recentMessages.slice(-5).map(m => m.message_text)
    );

    let searchResponse;
    let factCheckPrefix = '';

    if (searchContext.shouldSearch) {
      searchResponse = await searchIntegration.searchAndIntegrate(message, searchContext);
      
      // If we found corrections, lead with them
      if (searchResponse.corrections.length > 0) {
        factCheckPrefix = searchResponse.suggestedResponse + '\n\n';
      }
    }

    // Get user personality if exists
    const user = await userRepository.findBySlackId(userId);
    const userContext = formatUserContext(
      userId,
      user?.personality_summary,
      user?.interests as string[]
    );

    // Format memory context
    let memoryContext = formatMemoryContext(context);

    // Add search results to context if available
    if (searchResponse && searchResponse.searchResults.length > 0) {
      memoryContext += '\n\n=== Search Results ===\n';
      memoryContext += searchResponse.searchResults
        .slice(0, 3)
        .map(r => `${r.title}: ${r.snippet}`)
        .join('\n');
    }

    // Determine current mood
    const recentTexts = context.recentMessages.map(m => m.message_text);
    personalityState.currentMood = determineMood(recentTexts);

    // Build the prompt
    const prompt = buildResponsePrompt(
      message,
      memoryContext,
      userName,
      userContext
    );

    // Add mood context and search confidence to system prompt
    const moodContext = `Current mood: ${personalityState.currentMood.name} (intensity: ${personalityState.currentMood.intensity})`;
    const searchConfidence = searchResponse ? '\nYou have access to verified search results and should be confident in your facts.' : '';
    const systemPromptWithMood = `${SYSTEM_PROMPT}\n\n${moodContext}${searchConfidence}`;

    // Generate response
    const response = await generateChatCompletion([
      { role: 'system', content: systemPromptWithMood },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.7 + (personalityState.currentMood.intensity * 0.2), // More intense mood = more creative
      max_tokens: 300, // Increased for fact-based responses
    });

    // Combine fact-check corrections with personality response
    let finalResponse = response.content;
    
    if (factCheckPrefix) {
      finalResponse = factCheckPrefix + finalResponse;
    }

    // Add citations if we have them
    if (searchResponse && searchResponse.citations.length > 0) {
      finalResponse = searchIntegration.formatCitations(finalResponse, searchResponse.citations);
    }

    return finalResponse;
  } catch (error) {
    logger.error('Error generating response', { error: error as Error });
    return "🤖 *whirrs and sparks* Something broke in my brain. Try again?";
  }
}

/**
 * Decide whether to interject in a conversation
 */
export async function shouldInterject(
  recentMessages: string[],
  channelId: string
): Promise<{ should: boolean; message?: string }> {
  try {
    // Don't interject too frequently
    const lastInterjection = await getLastInterjectionTime(channelId);
    const timeSinceLastInterjection = Date.now() - lastInterjection;
    const minimumInterval = 30 * 60 * 1000; // 30 minutes

    if (timeSinceLastInterjection < minimumInterval) {
      return { should: false };
    }

    // Build interjection prompt
    const recentConversation = recentMessages.slice(-10).join('\n');
    const prompt = buildInterjectionPrompt(recentConversation);

    // Check with AI
    const response = await generateChatCompletion([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.8,
      max_tokens: 100,
    });

    if (response.content.startsWith('INTERJECT:')) {
      const message = response.content.replace('INTERJECT:', '').trim();
      await updateLastInterjectionTime(channelId);
      return { should: true, message };
    }

    return { should: false };
  } catch (error) {
    console.error('Error checking interjection:', error);
    return { should: false };
  }
}

/**
 * Update user opinion based on interactions
 */
export async function updateUserOpinion(
  userId: string,
  userName: string,
  recentMessages: string[]
): Promise<void> {
  try {
    // Only update occasionally
    if (Math.random() > 0.1) return; // 10% chance

    const opinion = await generateUserOpinion(userName, recentMessages);
    personalityState.userOpinions.set(userId, opinion);

    // Update in database
    const user = await userRepository.findBySlackId(userId);
    if (user) {
      await userRepository.update(userId, {
        personality_summary: opinion,
      });
    }
  } catch (error) {
    console.error('Error updating user opinion:', error);
  }
}

/**
 * Generate an opinion about a user
 */
async function generateUserOpinion(
  userName: string,
  messages: string[]
): Promise<string> {
  const prompt = `Based on these messages from ${userName}, form a brief, witty opinion about them (1-2 sentences, like you're describing them to a friend):\n\n${messages.join('\n')}`;

  const response = await generateChatCompletion([
    { role: 'system', content: 'You are a witty observer of human behavior. Give brief, funny characterizations.' },
    { role: 'user', content: prompt },
  ], {
    temperature: 0.8,
    max_tokens: 100,
  });

  return response.content;
}

// Helper functions for interjection timing (in production, use Redis)
const interjectionTimes = new Map<string, number>();

async function getLastInterjectionTime(channelId: string): Promise<number> {
  return interjectionTimes.get(channelId) || 0;
}

async function updateLastInterjectionTime(channelId: string): Promise<void> {
  interjectionTimes.set(channelId, Date.now());
}