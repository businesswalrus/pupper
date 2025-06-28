import { 
  determineMood, 
  generateResponse, 
  shouldInterject, 
  updateUserOpinion,
  Mood,
  PersonalityState
} from '../personality';
import { userRepository } from '@db/repositories/userRepository';
import { generateChatCompletion } from '@ai/openai';
import { buildConversationContext, formatMemoryContext } from '@ai/memory';
import { searchIntegration } from '@ai/searchIntegration';
import { logger } from '@utils/logger';
import { 
  createMockUser, 
  createMockMessage,
  createMockChatCompletion,
  mockEnv
} from '@test-utils';

// Mock all dependencies
jest.mock('@db/repositories/userRepository');
jest.mock('@ai/openai');
jest.mock('@ai/memory');
jest.mock('@ai/searchIntegration');
jest.mock('@utils/logger');

describe('Personality Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv();
  });

  describe('determineMood', () => {
    it('should detect excited mood from deployment keywords', () => {
      const messages = [
        'We are ready for deployment!',
        'Time to ship this feature',
        'New release coming up'
      ];
      
      const mood = determineMood(messages);
      
      expect(mood.name).toBe('excited');
      expect(mood.intensity).toBe(0.8);
    });

    it('should detect sarcastic mood from error keywords', () => {
      const messages = [
        'The build is broken again',
        'Another bug in production',
        'Everything is not working'
      ];
      
      const mood = determineMood(messages);
      
      expect(mood.name).toBe('sarcastic');
      expect(mood.intensity).toBe(0.7);
    });

    it('should detect nostalgic mood from past references', () => {
      const messages = [
        'Remember when we used jQuery?',
        'Back in my day, we wrote vanilla JS',
        'I used to deploy via FTP'
      ];
      
      const mood = determineMood(messages);
      
      expect(mood.name).toBe('nostalgic');
      expect(mood.intensity).toBe(0.6);
    });

    it('should detect helpful mood from help requests', () => {
      const messages = [
        'Can someone help me with this?',
        'How do I configure webpack?',
        'What is the best way to test this?'
      ];
      
      const mood = determineMood(messages);
      
      expect(mood.name).toBe('helpful');
      expect(mood.intensity).toBe(0.5);
    });

    it('should return neutral mood when no triggers match', () => {
      const messages = [
        'Good morning everyone',
        'The weather is nice today',
        'Just had lunch'
      ];
      
      const mood = determineMood(messages);
      
      expect(mood.name).toBe('neutral');
      expect(mood.intensity).toBe(0.5);
    });

    it('should handle empty message array', () => {
      const mood = determineMood([]);
      
      expect(mood.name).toBe('neutral');
    });

    it('should be case insensitive', () => {
      const messages = [
        'DEPLOYMENT IS READY',
        'SHIPPING TODAY',
        'NEW FEATURE LAUNCH'
      ];
      
      const mood = determineMood(messages);
      
      expect(mood.name).toBe('excited');
    });
  });

  describe('generateResponse', () => {
    const mockConversationContext = {
      recentMessages: [
        createMockMessage({ message_text: 'Hello there' }),
        createMockMessage({ message_text: 'How are you?' })
      ],
      relevantMessages: [],
      summary: 'Recent casual greetings'
    };

    beforeEach(() => {
      (buildConversationContext as jest.Mock).mockResolvedValue(mockConversationContext);
      (formatMemoryContext as jest.Mock).mockReturnValue('Formatted memory context');
      (generateChatCompletion as jest.Mock).mockResolvedValue(createMockChatCompletion({
        choices: [{
          message: { role: 'assistant', content: 'Hello! I am doing great!' },
          finish_reason: 'stop',
          index: 0
        }]
      }));
      (userRepository.findBySlackId as jest.Mock).mockResolvedValue(createMockUser());
      (searchIntegration.analyzeSearchNeed as jest.Mock).mockResolvedValue({
        shouldSearch: false
      });
    });

    it('should generate a basic response without search', async () => {
      const response = await generateResponse(
        'Hello, how are you?',
        'C123',
        'U123',
        'testuser'
      );

      expect(response).toBe('Hello! I am doing great!');
      expect(buildConversationContext).toHaveBeenCalledWith('C123', 'Hello, how are you?', {
        recentLimit: 30,
        relevantLimit: 10,
        hours: 48,
        threadTs: undefined
      });
      expect(searchIntegration.analyzeSearchNeed).toHaveBeenCalled();
      expect(generateChatCompletion).toHaveBeenCalled();
    });

    it('should include search results when needed', async () => {
      const mockSearchResponse = {
        shouldSearch: true,
        searchResults: [
          { title: 'Test Result', snippet: 'This is a test result' }
        ],
        corrections: [],
        citations: ['[1] Test Source'],
        suggestedResponse: ''
      };

      (searchIntegration.analyzeSearchNeed as jest.Mock).mockResolvedValue({
        shouldSearch: true
      });
      (searchIntegration.searchAndIntegrate as jest.Mock).mockResolvedValue(mockSearchResponse);
      (searchIntegration.formatCitations as jest.Mock).mockReturnValue('Response with citations [1]');

      const response = await generateResponse(
        'What is TypeScript?',
        'C123',
        'U123',
        'testuser'
      );

      expect(searchIntegration.searchAndIntegrate).toHaveBeenCalled();
      expect(searchIntegration.formatCitations).toHaveBeenCalled();
      expect(response).toBe('Response with citations [1]');
    });

    it('should include fact corrections when available', async () => {
      const mockSearchResponse = {
        shouldSearch: true,
        searchResults: [],
        corrections: ['Actually, JavaScript was created in 1995, not 1993'],
        citations: [],
        suggestedResponse: 'Actually, JavaScript was created in 1995, not 1993.'
      };

      (searchIntegration.analyzeSearchNeed as jest.Mock).mockResolvedValue({
        shouldSearch: true
      });
      (searchIntegration.searchAndIntegrate as jest.Mock).mockResolvedValue(mockSearchResponse);

      const response = await generateResponse(
        'JavaScript was created in 1993',
        'C123',
        'U123',
        'testuser'
      );

      expect(response).toContain('Actually, JavaScript was created in 1995, not 1993');
    });

    it('should handle thread context', async () => {
      await generateResponse(
        'Reply in thread',
        'C123',
        'U123',
        'testuser',
        '1234567890.123456'
      );

      expect(buildConversationContext).toHaveBeenCalledWith(
        'C123',
        'Reply in thread',
        expect.objectContaining({
          threadTs: '1234567890.123456'
        })
      );
    });

    it('should adjust temperature based on mood', async () => {
      // Set up messages that trigger excited mood
      const excitedContext = {
        ...mockConversationContext,
        recentMessages: [
          createMockMessage({ message_text: 'Time for deployment!' }),
          createMockMessage({ message_text: 'Shipping the new feature!' })
        ]
      };
      (buildConversationContext as jest.Mock).mockResolvedValue(excitedContext);

      await generateResponse(
        'Ready to ship!',
        'C123',
        'U123',
        'testuser'
      );

      // Check that temperature was adjusted based on excited mood (0.8 intensity)
      expect(generateChatCompletion).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          temperature: 0.7 + (0.8 * 0.2), // 0.86
          max_tokens: 300
        })
      );
    });

    it('should handle errors gracefully', async () => {
      (buildConversationContext as jest.Mock).mockRejectedValue(new Error('Context error'));

      const response = await generateResponse(
        'Hello',
        'C123',
        'U123',
        'testuser'
      );

      expect(response).toBe("🤖 *whirrs and sparks* Something broke in my brain. Try again?");
      expect(logger.error).toHaveBeenCalledWith('Error generating response', {
        error: expect.any(Error)
      });
    });

    it('should work without user personality data', async () => {
      (userRepository.findBySlackId as jest.Mock).mockResolvedValue(null);

      const response = await generateResponse(
        'Hello',
        'C123',
        'U123',
        'testuser'
      );

      expect(response).toBe('Hello! I am doing great!');
    });
  });

  describe('shouldInterject', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should not interject if last interjection was too recent', async () => {
      const recentMessages = [
        'This is interesting',
        'Tell me more',
        'I agree with that'
      ];

      // Simulate recent interjection (5 minutes ago)
      const channelId = 'C123';
      await shouldInterject(recentMessages, channelId);
      
      // Move time forward by 5 minutes
      jest.advanceTimersByTime(5 * 60 * 1000);

      const result = await shouldInterject(recentMessages, channelId);
      
      expect(result.should).toBe(false);
      expect(result.message).toBeUndefined();
    });

    it('should interject when AI decides to', async () => {
      const recentMessages = [
        'JavaScript is the best language',
        'No, Python is better',
        'You are both wrong, Rust is superior'
      ];

      (generateChatCompletion as jest.Mock).mockResolvedValue(createMockChatCompletion({
        choices: [{
          message: { 
            role: 'assistant', 
            content: 'INTERJECT: Actually, the best language is the one that solves your problem!' 
          },
          finish_reason: 'stop',
          index: 0
        }]
      }));

      // Move time forward to allow interjection
      jest.advanceTimersByTime(31 * 60 * 1000);

      const result = await shouldInterject(recentMessages, 'C456');
      
      expect(result.should).toBe(true);
      expect(result.message).toBe('Actually, the best language is the one that solves your problem!');
    });

    it('should not interject when AI decides not to', async () => {
      const recentMessages = [
        'The weather is nice today',
        'Yes, very sunny',
        'Perfect for a walk'
      ];

      (generateChatCompletion as jest.Mock).mockResolvedValue(createMockChatCompletion({
        choices: [{
          message: { 
            role: 'assistant', 
            content: 'NO_INTERJECT' 
          },
          finish_reason: 'stop',
          index: 0
        }]
      }));

      jest.advanceTimersByTime(31 * 60 * 1000);

      const result = await shouldInterject(recentMessages, 'C789');
      
      expect(result.should).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      (generateChatCompletion as jest.Mock).mockRejectedValue(new Error('AI error'));

      jest.advanceTimersByTime(31 * 60 * 1000);

      const result = await shouldInterject(['test'], 'C999');
      
      expect(result.should).toBe(false);
      expect(console.error).toHaveBeenCalledWith('Error checking interjection:', expect.any(Error));
    });
  });

  describe('updateUserOpinion', () => {
    beforeEach(() => {
      // Mock Math.random to control probability
      jest.spyOn(Math, 'random');
    });

    afterEach(() => {
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('should update user opinion 10% of the time', async () => {
      const mockUser = createMockUser();
      (userRepository.findBySlackId as jest.Mock).mockResolvedValue(mockUser);
      (generateChatCompletion as jest.Mock).mockResolvedValue(createMockChatCompletion({
        choices: [{
          message: { 
            role: 'assistant', 
            content: 'This user seems to love asking questions!' 
          },
          finish_reason: 'stop',
          index: 0
        }]
      }));

      // Force update (10% chance)
      (Math.random as jest.Mock).mockReturnValue(0.05);

      await updateUserOpinion('U123', 'testuser', [
        'How does this work?',
        'What about that feature?',
        'Can you explain this?'
      ]);

      expect(userRepository.update).toHaveBeenCalledWith('U123', {
        personality_summary: 'This user seems to love asking questions!'
      });
    });

    it('should skip update 90% of the time', async () => {
      (Math.random as jest.Mock).mockReturnValue(0.5);

      await updateUserOpinion('U123', 'testuser', ['Hello']);

      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('should handle missing user gracefully', async () => {
      (userRepository.findBySlackId as jest.Mock).mockResolvedValue(null);
      (Math.random as jest.Mock).mockReturnValue(0.05);

      await updateUserOpinion('U123', 'testuser', ['Hello']);

      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      (userRepository.findBySlackId as jest.Mock).mockRejectedValue(new Error('DB error'));
      (Math.random as jest.Mock).mockReturnValue(0.05);

      // Should not throw
      await expect(updateUserOpinion('U123', 'testuser', ['Hello'])).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith('Error updating user opinion:', expect.any(Error));
    });
  });

  describe('Integration scenarios', () => {
    it('should maintain mood continuity across multiple responses', async () => {
      const excitedContext = {
        recentMessages: [
          createMockMessage({ message_text: 'We are shipping today!' }),
          createMockMessage({ message_text: 'Deployment successful!' })
        ],
        relevantMessages: [],
        summary: 'Team is excited about deployment'
      };

      (buildConversationContext as jest.Mock).mockResolvedValue(excitedContext);
      (formatMemoryContext as jest.Mock).mockReturnValue('Excited deployment context');
      (generateChatCompletion as jest.Mock).mockResolvedValue(createMockChatCompletion());
      (userRepository.findBySlackId as jest.Mock).mockResolvedValue(null);
      (searchIntegration.analyzeSearchNeed as jest.Mock).mockResolvedValue({
        shouldSearch: false
      });

      // First response
      await generateResponse('Great job team!', 'C123', 'U123', 'user1');

      // Verify excited mood was used
      const systemPromptCall = (generateChatCompletion as jest.Mock).mock.calls[0][0][0];
      expect(systemPromptCall.content).toContain('Current mood: excited');
      expect(systemPromptCall.content).toContain('intensity: 0.8');
    });

    it('should handle complex search and personality integration', async () => {
      const mockUser = createMockUser({
        personality_summary: 'Always asks about performance',
        interests: ['optimization', 'benchmarks']
      });

      const mockSearchResponse = {
        shouldSearch: true,
        searchResults: [
          { 
            title: 'V8 Performance Tips', 
            snippet: 'Use performance.now() for accurate timing' 
          }
        ],
        corrections: [],
        citations: ['[1] V8 Blog - Performance Best Practices'],
        suggestedResponse: ''
      };

      (userRepository.findBySlackId as jest.Mock).mockResolvedValue(mockUser);
      (searchIntegration.analyzeSearchNeed as jest.Mock).mockResolvedValue({
        shouldSearch: true
      });
      (searchIntegration.searchAndIntegrate as jest.Mock).mockResolvedValue(mockSearchResponse);
      (searchIntegration.formatCitations as jest.Mock).mockImplementation((text, citations) => 
        `${text}\n\nSources: ${citations.join(', ')}`
      );
      (buildConversationContext as jest.Mock).mockResolvedValue({
        recentMessages: [
          createMockMessage({ message_text: 'How do I measure JavaScript performance?' })
        ],
        relevantMessages: [],
        summary: 'Discussion about performance'
      });
      (formatMemoryContext as jest.Mock).mockReturnValue('Performance discussion context');
      (generateChatCompletion as jest.Mock).mockResolvedValue(createMockChatCompletion({
        choices: [{
          message: { 
            role: 'assistant', 
            content: 'For accurate performance measurement, use performance.now()!' 
          },
          finish_reason: 'stop',
          index: 0
        }]
      }));

      const response = await generateResponse(
        'How do I measure performance?',
        'C123',
        'U123',
        'perfuser'
      );

      expect(response).toContain('performance.now()');
      expect(response).toContain('Sources: [1] V8 Blog');
      
      // Verify user context was included
      const userCall = (generateChatCompletion as jest.Mock).mock.calls[0][0][1];
      expect(userCall.content).toContain('Always asks about performance');
      expect(userCall.content).toContain('optimization');
    });
  });
});