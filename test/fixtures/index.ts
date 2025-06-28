/**
 * Test fixtures for consistent test data across the test suite
 */

import type { IUser, IMessage, IUserInteraction } from '@db/types';

// User fixtures
export const mockUsers = {
  alice: {
    id: 'user-001',
    slackId: 'U001ALICE',
    username: 'alice',
    realName: 'Alice Johnson',
    email: 'alice@example.com',
    personalityProfile: {
      traits: ['analytical', 'direct', 'helpful'],
      communicationStyle: 'formal',
      interests: ['data science', 'machine learning'],
      lastAnalyzed: new Date('2024-01-01'),
      interactionCount: 42,
    },
    createdAt: new Date('2023-01-01'),
    updatedAt: new Date('2024-01-01'),
  } as IUser,
  
  bob: {
    id: 'user-002',
    slackId: 'U002BOB',
    username: 'bob',
    realName: 'Bob Smith',
    email: 'bob@example.com',
    personalityProfile: {
      traits: ['creative', 'humorous', 'collaborative'],
      communicationStyle: 'casual',
      interests: ['design', 'music'],
      lastAnalyzed: new Date('2024-01-01'),
      interactionCount: 37,
    },
    createdAt: new Date('2023-02-01'),
    updatedAt: new Date('2024-01-01'),
  } as IUser,
};

// Message fixtures
export const mockMessages = {
  technical: {
    id: 'msg-001',
    slackUserId: 'U001ALICE',
    text: 'Has anyone tried the new pgvector extension?',
    channelId: 'C001GENERAL',
    messageTs: '1704067200.000001',
    threadTs: null,
    embedding: generateMockEmbedding(),
    metadata: {},
    createdAt: new Date('2024-01-01T00:00:00Z'),
  } as IMessage,
  
  casual: {
    id: 'msg-002',
    slackUserId: 'U002BOB',
    text: 'who else is ready for the weekend? 🎉',
    channelId: 'C002RANDOM',
    messageTs: '1704067260.000002',
    threadTs: null,
    embedding: generateMockEmbedding(),
    metadata: {},
    createdAt: new Date('2024-01-01T00:01:00Z'),
  } as IMessage,
  
  thread: {
    id: 'msg-003',
    slackUserId: 'U001ALICE',
    text: 'I\'ve been using it for similarity search',
    channelId: 'C001GENERAL',
    messageTs: '1704067320.000003',
    threadTs: '1704067200.000001',
    embedding: generateMockEmbedding(),
    metadata: {},
    createdAt: new Date('2024-01-01T00:02:00Z'),
  } as IMessage,
};

// Interaction fixtures
export const mockInteractions = {
  collaboration: {
    id: 'int-001',
    userId1: 'U001ALICE',
    userId2: 'U002BOB',
    interactionType: 'collaboration',
    interactionCount: 15,
    sentiment: 0.8,
    lastInteraction: new Date('2024-01-01'),
    topics: ['project', 'design', 'data'],
    createdAt: new Date('2023-06-01'),
    updatedAt: new Date('2024-01-01'),
  } as IUserInteraction,
};

// Slack event fixtures
export const mockSlackEvents = {
  message: {
    type: 'message',
    channel: 'C001GENERAL',
    user: 'U001ALICE',
    text: 'Hello, world!',
    ts: '1704067200.000001',
    team: 'T001TEAM',
  },
  
  threadMessage: {
    type: 'message',
    channel: 'C001GENERAL',
    user: 'U002BOB',
    text: 'Hello back!',
    ts: '1704067260.000002',
    thread_ts: '1704067200.000001',
    team: 'T001TEAM',
  },
  
  appMention: {
    type: 'app_mention',
    channel: 'C001GENERAL',
    user: 'U001ALICE',
    text: '<@U999BOTID> what do you think?',
    ts: '1704067320.000003',
    team: 'T001TEAM',
  },
};

// OpenAI response fixtures
export const mockOpenAIResponses = {
  embedding: {
    data: [{
      embedding: generateMockEmbedding(),
      index: 0,
      object: 'embedding',
    }],
    model: 'text-embedding-3-small',
    usage: {
      prompt_tokens: 8,
      total_tokens: 8,
    },
  },
  
  completion: {
    choices: [{
      message: {
        role: 'assistant',
        content: 'This is a mock response from the AI.',
      },
      finish_reason: 'stop',
      index: 0,
    }],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
    },
  },
};

// Helper functions
export function generateMockEmbedding(dimensions: number = 1536): number[] {
  return Array(dimensions).fill(0).map(() => Math.random() - 0.5);
}

export function createMockUser(overrides?: Partial<IUser>): IUser {
  return {
    ...mockUsers.alice,
    id: `user-${Date.now()}`,
    ...overrides,
  };
}

export function createMockMessage(overrides?: Partial<IMessage>): IMessage {
  return {
    ...mockMessages.technical,
    id: `msg-${Date.now()}`,
    messageTs: `${Date.now() / 1000}.000000`,
    createdAt: new Date(),
    ...overrides,
  };
}

export function createMockSlackEvent(type: 'message' | 'app_mention', overrides?: any) {
  const base = type === 'app_mention' ? mockSlackEvents.appMention : mockSlackEvents.message;
  return {
    ...base,
    ts: `${Date.now() / 1000}.000000`,
    ...overrides,
  };
}

// Mock services
export const mockServices = {
  openai: {
    embeddings: {
      create: jest.fn().mockResolvedValue(mockOpenAIResponses.embedding),
    },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue(mockOpenAIResponses.completion),
      },
    },
  },
  
  slack: {
    chat: {
      postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1234567890.123456' }),
    },
    users: {
      info: jest.fn().mockResolvedValue({ ok: true, user: mockUsers.alice }),
    },
  },
  
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  },
};