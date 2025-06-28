import {
  searchSimilarMessages,
  buildConversationContext,
  formatMemoryContext,
  findTriggerMessages,
  analyzeConversationPatterns,
  MemoryContext,
  SearchOptions
} from '../memory';
import { messageRepository } from '@db/repositories/messageRepository';
import { summaryRepository } from '@db/repositories/summaryRepository';
import { userRepository } from '@db/repositories/userRepository';
import { generateEmbedding } from '@ai/openai';
import {
  createMockMessage,
  createMockUser,
  createMockSummary,
  createMockEmbedding,
  setupTests
} from '@test-utils';

// Mock dependencies
jest.mock('@db/repositories/messageRepository');
jest.mock('@db/repositories/summaryRepository');
jest.mock('@db/repositories/userRepository');
jest.mock('@ai/openai');

describe('Memory Module', () => {
  setupTests();

  const mockEmbedding = createMockEmbedding(0.5);

  beforeEach(() => {
    (generateEmbedding as jest.Mock).mockResolvedValue({ embedding: mockEmbedding });
  });

  describe('searchSimilarMessages', () => {
    const mockMessages = [
      createMockMessage({ id: 1, message_text: 'How to use TypeScript?', channel_id: 'C123' }),
      createMockMessage({ id: 2, message_text: 'TypeScript is great!', channel_id: 'C123' }),
      createMockMessage({ id: 3, message_text: 'JavaScript vs TypeScript', channel_id: 'C456' }),
    ];

    beforeEach(() => {
      (messageRepository.findSimilar as jest.Mock).mockResolvedValue(mockMessages);
    });

    it('should search for similar messages with default options', async () => {
      const result = await searchSimilarMessages('TypeScript tutorial');

      expect(generateEmbedding).toHaveBeenCalledWith('TypeScript tutorial');
      expect(messageRepository.findSimilar).toHaveBeenCalledWith(
        mockEmbedding,
        20, // limit * 2
        0.7  // default threshold
      );
      expect(result).toHaveLength(3);
    });

    it('should filter by channel when specified', async () => {
      const result = await searchSimilarMessages('TypeScript', {
        channelId: 'C123',
        limit: 5
      });

      expect(result).toHaveLength(2);
      expect(result.every(msg => msg.channel_id === 'C123')).toBe(true);
    });

    it('should respect custom limit and threshold', async () => {
      await searchSimilarMessages('test query', {
        limit: 5,
        threshold: 0.85
      });

      expect(messageRepository.findSimilar).toHaveBeenCalledWith(
        mockEmbedding,
        10, // limit * 2
        0.85
      );
    });

    it('should handle errors gracefully', async () => {
      (generateEmbedding as jest.Mock).mockRejectedValue(new Error('Embedding error'));
      console.error = jest.fn();

      const result = await searchSimilarMessages('error test');

      expect(result).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(
        'Error searching similar messages:',
        expect.any(Error)
      );
    });

    it('should handle empty results', async () => {
      (messageRepository.findSimilar as jest.Mock).mockResolvedValue([]);

      const result = await searchSimilarMessages('no matches');

      expect(result).toEqual([]);
    });
  });

  describe('buildConversationContext', () => {
    const mockRecentMessages = [
      createMockMessage({ id: 1, message_text: 'Recent message 1' }),
      createMockMessage({ id: 2, message_text: 'Recent message 2' }),
    ];

    const mockRelevantMessages = [
      createMockMessage({ id: 3, message_text: 'Relevant message 1' }),
      createMockMessage({ id: 4, message_text: 'Relevant message 2' }),
    ];

    const mockThreadMessages = [
      createMockMessage({ id: 5, message_text: 'Thread message 1', thread_ts: '123.456' }),
      createMockMessage({ id: 6, message_text: 'Thread message 2', thread_ts: '123.456' }),
    ];

    const mockSummaries = [
      createMockSummary({ id: 1, summary_text: 'Yesterday we discussed features' }),
      createMockSummary({ id: 2, summary_text: 'Last week was about bugs' }),
    ];

    const mockUsers = new Map([
      ['U123', createMockUser({ slack_user_id: 'U123', username: 'alice' })],
      ['U456', createMockUser({ slack_user_id: 'U456', username: 'bob' })],
    ]);

    beforeEach(() => {
      (messageRepository.getRecentMessages as jest.Mock).mockResolvedValue(mockRecentMessages);
      (messageRepository.findSimilar as jest.Mock).mockResolvedValue(mockRelevantMessages);
      (messageRepository.findByChannel as jest.Mock).mockResolvedValue(mockThreadMessages);
      (messageRepository.countByChannel as jest.Mock).mockResolvedValue(100);
      (summaryRepository.findByChannel as jest.Mock).mockResolvedValue(mockSummaries);
      (userRepository.findBySlackId as jest.Mock).mockImplementation((id) => 
        Promise.resolve(mockUsers.get(id) || null)
      );
    });

    it('should build basic conversation context without query', async () => {
      const context = await buildConversationContext('C123');

      expect(messageRepository.getRecentMessages).toHaveBeenCalledWith('C123', 24, 20);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(context.recentMessages).toEqual(mockRecentMessages);
      expect(context.relevantMessages).toEqual([]);
      expect(context.totalMessages).toBe(100);
    });

    it('should include relevant messages when query provided', async () => {
      const context = await buildConversationContext('C123', 'search query');

      expect(generateEmbedding).toHaveBeenCalledWith('search query');
      expect(context.relevantMessages).toHaveLength(2);
      expect(context.relevantMessages).toEqual(mockRelevantMessages);
    });

    it('should remove duplicates between recent and relevant', async () => {
      // Make one relevant message same as recent
      const duplicateMessages = [
        mockRecentMessages[0], // Duplicate
        mockRelevantMessages[1],
      ];
      (messageRepository.findSimilar as jest.Mock).mockResolvedValue(duplicateMessages);

      const context = await buildConversationContext('C123', 'query');

      expect(context.relevantMessages).toHaveLength(1);
      expect(context.relevantMessages[0].id).toBe(4);
    });

    it('should include thread context when threadTs provided', async () => {
      const context = await buildConversationContext('C123', undefined, {
        threadTs: '123.456'
      });

      expect(messageRepository.findByChannel).toHaveBeenCalledWith('C123', {
        thread_ts: '123.456',
        limit: 50,
      });
      expect(context.threadContext).toEqual(mockThreadMessages);
    });

    it('should include summaries when requested', async () => {
      const context = await buildConversationContext('C123', undefined, {
        includeSummaries: true
      });

      expect(summaryRepository.findByChannel).toHaveBeenCalledWith('C123', 5);
      expect(context.conversationSummaries).toEqual(mockSummaries);
    });

    it('should skip summaries when not requested', async () => {
      const context = await buildConversationContext('C123', undefined, {
        includeSummaries: false
      });

      expect(summaryRepository.findByChannel).not.toHaveBeenCalled();
      expect(context.conversationSummaries).toBeUndefined();
    });

    it('should include user profiles when requested', async () => {
      const messagesWithUsers = [
        createMockMessage({ slack_user_id: 'U123' }),
        createMockMessage({ slack_user_id: 'U456' }),
      ];
      (messageRepository.getRecentMessages as jest.Mock).mockResolvedValue(messagesWithUsers);

      const context = await buildConversationContext('C123', undefined, {
        includeProfiles: true
      });

      expect(userRepository.findBySlackId).toHaveBeenCalledWith('U123');
      expect(userRepository.findBySlackId).toHaveBeenCalledWith('U456');
      expect(context.userProfiles?.size).toBe(2);
      expect(context.userProfiles?.get('U123')?.username).toBe('alice');
    });

    it('should handle custom options', async () => {
      await buildConversationContext('C123', 'query', {
        recentLimit: 50,
        relevantLimit: 20,
        hours: 48,
      });

      expect(messageRepository.getRecentMessages).toHaveBeenCalledWith('C123', 48, 50);
      expect(messageRepository.findSimilar).toHaveBeenCalledWith(mockEmbedding, 40, 0.7);
    });

    it('should handle errors gracefully', async () => {
      (messageRepository.getRecentMessages as jest.Mock).mockRejectedValue(new Error('DB error'));
      console.error = jest.fn();

      const context = await buildConversationContext('C123');

      expect(context).toEqual({
        recentMessages: [],
        relevantMessages: [],
        totalMessages: 0,
      });
      expect(console.error).toHaveBeenCalledWith(
        'Error building conversation context:',
        expect.any(Error)
      );
    });
  });

  describe('formatMemoryContext', () => {
    it('should format empty context', () => {
      const context: MemoryContext = {
        recentMessages: [],
        relevantMessages: [],
        totalMessages: 0,
      };

      const formatted = formatMemoryContext(context);

      expect(formatted).toBe('');
    });

    it('should format recent messages only', () => {
      const context: MemoryContext = {
        recentMessages: [
          createMockMessage({ slack_user_id: 'U123', message_text: 'Hello world' }),
          createMockMessage({ slack_user_id: 'U456', message_text: 'Hi there' }),
        ],
        relevantMessages: [],
        totalMessages: 10,
      };

      const formatted = formatMemoryContext(context);

      expect(formatted).toContain('=== Recent Conversation ===');
      expect(formatted).toContain('[U123]: Hello world');
      expect(formatted).toContain('[U456]: Hi there');
    });

    it('should include user names when profiles available', () => {
      const userProfiles = new Map([
        ['U123', createMockUser({ slack_user_id: 'U123', username: 'alice' })],
        ['U456', createMockUser({ slack_user_id: 'U456', username: 'bob' })],
      ]);

      const context: MemoryContext = {
        recentMessages: [
          createMockMessage({ slack_user_id: 'U123', message_text: 'Hello' }),
          createMockMessage({ slack_user_id: 'U456', message_text: 'Hi' }),
        ],
        relevantMessages: [],
        userProfiles,
        totalMessages: 10,
      };

      const formatted = formatMemoryContext(context);

      expect(formatted).toContain('[alice]: Hello');
      expect(formatted).toContain('[bob]: Hi');
    });

    it('should format all sections when available', () => {
      const context: MemoryContext = {
        recentMessages: [createMockMessage({ message_text: 'Recent' })],
        relevantMessages: [createMockMessage({ message_text: 'Relevant' })],
        threadContext: [createMockMessage({ message_text: 'Thread' })],
        conversationSummaries: [
          createMockSummary({ 
            summary_text: 'Summary of yesterday',
            key_topics: ['deployment', 'testing']
          })
        ],
        userProfiles: new Map([
          ['U123', createMockUser({ 
            slack_user_id: 'U123',
            username: 'alice',
            personality_summary: 'Always helpful'
          })]
        ]),
        totalMessages: 100,
      };

      const formatted = formatMemoryContext(context);

      expect(formatted).toContain('=== Recent Conversation History ===');
      expect(formatted).toContain('Summary of yesterday');
      expect(formatted).toContain('Topics: deployment, testing');
      expect(formatted).toContain('=== User Profiles ===');
      expect(formatted).toContain('alice: Always helpful');
      expect(formatted).toContain('=== Thread Context ===');
      expect(formatted).toContain('Thread');
      expect(formatted).toContain('=== Relevant Past Conversations ===');
      expect(formatted).toContain('Relevant');
      expect(formatted).toContain('=== Recent Conversation ===');
      expect(formatted).toContain('Recent');
    });

    it('should handle dates properly', () => {
      const pastDate = new Date('2024-01-15');
      const context: MemoryContext = {
        recentMessages: [],
        relevantMessages: [
          createMockMessage({ 
            message_text: 'Old message',
            created_at: pastDate
          })
        ],
        conversationSummaries: [
          createMockSummary({ 
            summary_text: 'Old summary',
            created_at: pastDate
          })
        ],
        totalMessages: 10,
      };

      const formatted = formatMemoryContext(context);

      expect(formatted).toContain('[1/15/2024');
    });
  });

  describe('findTriggerMessages', () => {
    beforeEach(() => {
      (messageRepository.findSimilar as jest.Mock).mockImplementation((embedding) => {
        // Return different messages for different embeddings
        return [
          createMockMessage({ id: Math.random(), message_text: 'Trigger message' })
        ];
      });
    });

    it('should find messages for multiple keywords', async () => {
      const keywords = ['help', 'error', 'bug'];
      const result = await findTriggerMessages('C123', keywords);

      expect(generateEmbedding).toHaveBeenCalledTimes(3);
      expect(generateEmbedding).toHaveBeenCalledWith('help');
      expect(generateEmbedding).toHaveBeenCalledWith('error');
      expect(generateEmbedding).toHaveBeenCalledWith('bug');
      expect(result).toHaveLength(3);
    });

    it('should remove duplicate messages', async () => {
      const duplicateMessage = createMockMessage({ id: 1, message_text: 'Duplicate' });
      (messageRepository.findSimilar as jest.Mock).mockResolvedValue([duplicateMessage]);

      const result = await findTriggerMessages('C123', ['test1', 'test2']);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });

    it('should use high threshold for trigger search', async () => {
      await findTriggerMessages('C123', ['urgent']);

      expect(messageRepository.findSimilar).toHaveBeenCalledWith(
        mockEmbedding,
        10, // limit * 2
        0.8 // high threshold
      );
    });

    it('should handle empty keywords', async () => {
      const result = await findTriggerMessages('C123', []);

      expect(result).toEqual([]);
      expect(generateEmbedding).not.toHaveBeenCalled();
    });
  });

  describe('analyzeConversationPatterns', () => {
    it('should analyze user conversation patterns', async () => {
      const userMessages = [
        createMockMessage({ slack_user_id: 'U123', message_text: 'Hello world' }),
        createMockMessage({ slack_user_id: 'U123', message_text: 'How are you doing?' }),
        createMockMessage({ slack_user_id: 'U456', message_text: 'Other user' }),
      ];
      (messageRepository.findByChannel as jest.Mock).mockResolvedValue(userMessages);

      const result = await analyzeConversationPatterns('C123', 'U123');

      expect(messageRepository.findByChannel).toHaveBeenCalledWith('C123', { limit: 100 });
      expect(result.messageCount).toBe(2);
      expect(result.averageLength).toBe(15); // (11 + 19) / 2
      expect(result.commonTopics).toEqual([]); // TODO placeholder
      expect(result.activeHours).toEqual([]); // TODO placeholder
    });

    it('should handle user with no messages', async () => {
      (messageRepository.findByChannel as jest.Mock).mockResolvedValue([
        createMockMessage({ slack_user_id: 'U456', message_text: 'Other user' }),
      ]);

      const result = await analyzeConversationPatterns('C123', 'U123');

      expect(result.messageCount).toBe(0);
      expect(result.averageLength).toBe(NaN);
    });

    it('should handle empty channel', async () => {
      (messageRepository.findByChannel as jest.Mock).mockResolvedValue([]);

      const result = await analyzeConversationPatterns('C123', 'U123');

      expect(result.messageCount).toBe(0);
      expect(result.averageLength).toBe(NaN);
    });
  });

  describe('Integration scenarios', () => {
    it('should build comprehensive context for AI response', async () => {
      // Set up rich context
      const messages = [
        createMockMessage({ 
          slack_user_id: 'U123', 
          message_text: 'Can someone help with TypeScript?',
          created_at: new Date(Date.now() - 60000)
        }),
        createMockMessage({ 
          slack_user_id: 'U456', 
          message_text: 'What specific issue are you having?',
          created_at: new Date()
        }),
      ];
      (messageRepository.getRecentMessages as jest.Mock).mockResolvedValue(messages);
      
      const relevantMessages = [
        createMockMessage({ 
          message_text: 'TypeScript interfaces are like contracts',
          created_at: new Date(Date.now() - 86400000) // Yesterday
        }),
      ];
      (messageRepository.findSimilar as jest.Mock).mockResolvedValue(relevantMessages);

      const summaries = [
        createMockSummary({
          summary_text: 'Team discussed TypeScript migration strategies',
          key_topics: ['typescript', 'migration', 'best-practices']
        })
      ];
      (summaryRepository.findByChannel as jest.Mock).mockResolvedValue(summaries);

      const users = new Map([
        ['U123', createMockUser({ 
          username: 'developer',
          personality_summary: 'Eager learner, asks good questions'
        })],
        ['U456', createMockUser({ 
          username: 'senior_dev',
          personality_summary: 'Patient mentor, TypeScript expert'
        })]
      ]);
      (userRepository.findBySlackId as jest.Mock).mockImplementation((id) => 
        Promise.resolve(users.get(id) || null)
      );

      const context = await buildConversationContext('C123', 'TypeScript help', {
        includeProfiles: true,
        includeSummaries: true
      });

      const formatted = formatMemoryContext(context);

      // Verify comprehensive context
      expect(formatted).toContain('Team discussed TypeScript migration strategies');
      expect(formatted).toContain('developer: Eager learner');
      expect(formatted).toContain('senior_dev: Patient mentor');
      expect(formatted).toContain('TypeScript interfaces are like contracts');
      expect(formatted).toContain('[developer]: Can someone help with TypeScript?');
      expect(formatted).toContain('[senior_dev]: What specific issue are you having?');
    });
  });
});