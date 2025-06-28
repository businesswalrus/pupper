import {
  SYSTEM_PROMPT,
  MEMORY_CONTEXT_PROMPT,
  RESPONSE_GENERATION_PROMPT,
  INTERJECTION_DECISION_PROMPT,
  USER_ANALYSIS_PROMPT,
  CONVERSATION_SUMMARY_PROMPT,
  buildResponsePrompt,
  buildInterjectionPrompt,
  buildUserAnalysisPrompt,
  formatUserContext
} from '../prompts';

describe('Prompts Module', () => {
  describe('System prompts', () => {
    it('should have a comprehensive system prompt', () => {
      expect(SYSTEM_PROMPT).toContain('pup.ai v2');
      expect(SYSTEM_PROMPT).toContain('witty and opinionated');
      expect(SYSTEM_PROMPT).toContain('fact-check');
      expect(SYSTEM_PROMPT).toContain('Slack formatting');
      expect(SYSTEM_PROMPT).not.toContain('{{'); // No template variables
    });

    it('should have memory context prompt', () => {
      expect(MEMORY_CONTEXT_PROMPT).toContain('conversation history');
      expect(MEMORY_CONTEXT_PROMPT).toContain('relationships between users');
      expect(MEMORY_CONTEXT_PROMPT).toContain('running jokes');
    });

    it('should have response generation prompt', () => {
      expect(RESPONSE_GENERATION_PROMPT).toContain('conversation flow');
      expect(RESPONSE_GENERATION_PROMPT).toContain('past conversations');
      expect(RESPONSE_GENERATION_PROMPT).toContain('concise and impactful');
    });

    it('should have interjection decision prompt', () => {
      expect(INTERJECTION_DECISION_PROMPT).toContain('INTERJECT:');
      expect(INTERJECTION_DECISION_PROMPT).toContain('PASS');
      expect(INTERJECTION_DECISION_PROMPT).toContain('selective');
    });

    it('should have user analysis prompt', () => {
      expect(USER_ANALYSIS_PROMPT).toContain('communication patterns');
      expect(USER_ANALYSIS_PROMPT).toContain('personality profile');
      expect(USER_ANALYSIS_PROMPT).toContain('witty summary');
    });

    it('should have conversation summary prompt', () => {
      expect(CONVERSATION_SUMMARY_PROMPT).toContain('Key topics');
      expect(CONVERSATION_SUMMARY_PROMPT).toContain('memorable moments');
      expect(CONVERSATION_SUMMARY_PROMPT).toContain('overall mood');
    });
  });

  describe('buildResponsePrompt', () => {
    it('should build basic response prompt', () => {
      const prompt = buildResponsePrompt(
        'Hello, how are you?',
        'Previous conversation about TypeScript',
        'alice'
      );

      expect(prompt).toContain(MEMORY_CONTEXT_PROMPT);
      expect(prompt).toContain('Memory Context:');
      expect(prompt).toContain('Previous conversation about TypeScript');
      expect(prompt).toContain('Current message from alice: Hello, how are you?');
      expect(prompt).toContain(RESPONSE_GENERATION_PROMPT);
    });

    it('should include additional context when provided', () => {
      const prompt = buildResponsePrompt(
        'What about performance?',
        'Discussion about optimization',
        'bob',
        'User frequently asks about performance topics'
      );

      expect(prompt).toContain('Additional Context:');
      expect(prompt).toContain('User frequently asks about performance topics');
    });

    it('should handle special characters in message', () => {
      const prompt = buildResponsePrompt(
        'Can you help with `code` and *formatting*?',
        'Context',
        'user123'
      );

      expect(prompt).toContain('Can you help with `code` and *formatting*?');
    });

    it('should maintain proper spacing between sections', () => {
      const prompt = buildResponsePrompt(
        'Test message',
        'Test context',
        'testuser'
      );

      const lines = prompt.split('\n');
      
      // Check for empty lines between sections
      const memoryIndex = lines.indexOf('Memory Context:');
      const currentIndex = lines.findIndex(l => l.startsWith('Current message from'));
      
      expect(lines[memoryIndex - 1]).toBe('');
      expect(lines[currentIndex - 1]).toBe('');
    });
  });

  describe('buildInterjectionPrompt', () => {
    it('should build interjection prompt with conversation', () => {
      const conversation = `alice: JavaScript is better than TypeScript
bob: I disagree, TypeScript is superior
alice: But JavaScript is more flexible`;

      const prompt = buildInterjectionPrompt(conversation);

      expect(prompt).toContain(INTERJECTION_DECISION_PROMPT);
      expect(prompt).toContain('Recent conversation:');
      expect(prompt).toContain(conversation);
    });

    it('should handle empty conversation', () => {
      const prompt = buildInterjectionPrompt('');

      expect(prompt).toContain(INTERJECTION_DECISION_PROMPT);
      expect(prompt).toContain('Recent conversation:\n');
    });

    it('should handle multi-line conversations', () => {
      const conversation = [
        'user1: First message',
        'user2: Second message',
        'user3: Third message with\nmultiple lines'
      ].join('\n');

      const prompt = buildInterjectionPrompt(conversation);

      expect(prompt).toContain('First message');
      expect(prompt).toContain('Second message');
      expect(prompt).toContain('multiple lines');
    });
  });

  describe('buildUserAnalysisPrompt', () => {
    it('should build user analysis prompt', () => {
      const messages = [
        'Hello everyone!',
        'How can I help?',
        'That sounds great 👍'
      ];

      const prompt = buildUserAnalysisPrompt(messages, 'helpful_user');

      expect(prompt).toContain(USER_ANALYSIS_PROMPT);
      expect(prompt).toContain('Analyzing user: helpful_user');
      expect(prompt).toContain('Sample messages:');
      expect(prompt).toContain('Hello everyone!');
      expect(prompt).toContain('How can I help?');
      expect(prompt).toContain('That sounds great 👍');
    });

    it('should limit to 50 messages', () => {
      const messages = Array.from({ length: 100 }, (_, i) => `Message ${i}`);
      
      const prompt = buildUserAnalysisPrompt(messages, 'prolific_user');

      expect(prompt).toContain('Message 0');
      expect(prompt).toContain('Message 49');
      expect(prompt).not.toContain('Message 50');
      expect(prompt).not.toContain('Message 99');
    });

    it('should handle empty messages array', () => {
      const prompt = buildUserAnalysisPrompt([], 'silent_user');

      expect(prompt).toContain('Analyzing user: silent_user');
      expect(prompt).toContain('Sample messages:\n');
    });

    it('should preserve message formatting', () => {
      const messages = [
        '```javascript\nconst test = true;\n```',
        '*bold text* and _italic text_',
        'Regular message with :emoji:'
      ];

      const prompt = buildUserAnalysisPrompt(messages, 'formatted_user');

      expect(prompt).toContain('```javascript');
      expect(prompt).toContain('const test = true;');
      expect(prompt).toContain('*bold text*');
      expect(prompt).toContain(':emoji:');
    });
  });

  describe('formatUserContext', () => {
    it('should format basic user context', () => {
      const context = formatUserContext(
        'U123',
        'Always asking questions, very curious',
        ['javascript', 'testing', 'performance']
      );

      expect(context).toContain('User U123 personality: Always asking questions, very curious');
      expect(context).toContain('Recent topics: javascript, testing, performance');
    });

    it('should handle only personality', () => {
      const context = formatUserContext(
        'U456',
        'Senior developer, patient mentor'
      );

      expect(context).toBe('User U456 personality: Senior developer, patient mentor');
    });

    it('should handle only topics', () => {
      const context = formatUserContext(
        'U789',
        undefined,
        ['react', 'state management']
      );

      expect(context).toBe('Recent topics: react, state management');
    });

    it('should handle no data', () => {
      const context = formatUserContext('U999');

      expect(context).toBe('');
    });

    it('should handle empty topics array', () => {
      const context = formatUserContext(
        'U111',
        'New user',
        []
      );

      expect(context).toBe('User U111 personality: New user');
    });
  });

  describe('Prompt consistency', () => {
    it('should have consistent formatting instructions', () => {
      const prompts = [
        SYSTEM_PROMPT,
        RESPONSE_GENERATION_PROMPT,
        CONVERSATION_SUMMARY_PROMPT
      ];

      prompts.forEach(prompt => {
        // Check for numbered lists
        expect(prompt).toMatch(/\d+\./);
      });
    });

    it('should maintain consistent tone instructions', () => {
      expect(SYSTEM_PROMPT).toContain('witty');
      expect(USER_ANALYSIS_PROMPT).toContain('witty');
      expect(RESPONSE_GENERATION_PROMPT).toContain('funny/sarcastic');
    });

    it('should emphasize conciseness consistently', () => {
      expect(SYSTEM_PROMPT).toContain('concise');
      expect(RESPONSE_GENERATION_PROMPT).toContain('concise');
      expect(CONVERSATION_SUMMARY_PROMPT).toContain('concise');
    });
  });

  describe('Integration with personality', () => {
    it('should create comprehensive response prompt', () => {
      const memoryContext = `=== User Profiles ===
alice: Always helpful, loves TypeScript
bob: Skeptical about new technologies

=== Recent Conversation ===
[alice]: Should we migrate to TypeScript?
[bob]: I'm not sure it's worth the effort`;

      const userContext = formatUserContext(
        'U123',
        'Early adopter, enthusiastic',
        ['typescript', 'migration', 'tooling']
      );

      const prompt = buildResponsePrompt(
        'I think TypeScript would really help us!',
        memoryContext,
        'charlie',
        userContext
      );

      // Verify all components are included
      expect(prompt).toContain('Always helpful, loves TypeScript');
      expect(prompt).toContain('Skeptical about new technologies');
      expect(prompt).toContain('Should we migrate to TypeScript?');
      expect(prompt).toContain('Early adopter, enthusiastic');
      expect(prompt).toContain('typescript, migration, tooling');
      expect(prompt).toContain('Current message from charlie: I think TypeScript would really help us!');
    });
  });
});