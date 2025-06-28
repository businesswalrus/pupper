import { ChatCompletion, Embedding } from 'openai/resources';

// Mock OpenAI client
export const createMockOpenAIClient = (overrides: any = {}) => {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue(createMockChatCompletion()),
      },
    },
    embeddings: {
      create: jest.fn().mockResolvedValue(createMockEmbeddingResponse()),
    },
    ...overrides,
  };
};

// Mock chat completion response
export const createMockChatCompletion = (overrides: Partial<ChatCompletion> = {}): ChatCompletion => ({
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: Date.now(),
  model: 'gpt-4',
  usage: {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  },
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'This is a test response from the AI.',
      },
      finish_reason: 'stop',
      index: 0,
    },
  ],
  ...overrides,
} as ChatCompletion);

// Mock embedding response
export const createMockEmbeddingResponse = (overrides: any = {}) => ({
  object: 'list',
  data: [
    {
      object: 'embedding',
      index: 0,
      embedding: createMockEmbedding(),
    },
  ],
  model: 'text-embedding-ada-002',
  usage: {
    prompt_tokens: 8,
    total_tokens: 8,
  },
  ...overrides,
});

// Create a mock embedding vector (1536 dimensions for ada-002)
export const createMockEmbedding = (seed: number = 0.5): number[] => {
  const dimensions = 1536;
  const embedding = new Array(dimensions);
  
  // Generate deterministic but varied values based on seed
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = Math.sin(seed * (i + 1)) * 0.5;
  }
  
  return embedding;
};

// Mock function calling response
export const createMockFunctionCall = (functionName: string, args: any) => ({
  id: 'chatcmpl-function123',
  object: 'chat.completion',
  created: Date.now(),
  model: 'gpt-4',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        function_call: {
          name: functionName,
          arguments: JSON.stringify(args),
        },
      },
      finish_reason: 'function_call',
      index: 0,
    },
  ],
  usage: {
    prompt_tokens: 150,
    completion_tokens: 30,
    total_tokens: 180,
  },
});

// Mock streaming response
export const createMockStreamResponse = (content: string) => {
  const chunks = content.split(' ').map((word, index) => ({
    id: `chatcmpl-stream${index}`,
    object: 'chat.completion.chunk',
    created: Date.now(),
    model: 'gpt-4',
    choices: [
      {
        delta: {
          content: index === 0 ? word : ` ${word}`,
        },
        index: 0,
        finish_reason: null,
      },
    ],
  }));

  // Add final chunk
  chunks.push({
    id: `chatcmpl-stream${chunks.length}`,
    object: 'chat.completion.chunk',
    created: Date.now(),
    model: 'gpt-4',
    choices: [
      {
        delta: {},
        index: 0,
        finish_reason: 'stop',
      },
    ],
  });

  return chunks;
};

// Common test prompts and responses
export const mockPrompts = {
  personality: {
    prompt: 'You are Pup, a witty and slightly sarcastic AI assistant.',
    response: 'Oh great, another human to entertain. What can I help you with today?',
  },
  factCheck: {
    prompt: 'Is the Earth flat?',
    response: 'No, the Earth is not flat. It is an oblate spheroid.',
  },
  search: {
    prompt: 'What is the weather like today?',
    response: 'I would need to search for current weather information to answer that.',
  },
};

// Mock error responses
export const mockOpenAIErrors = {
  rateLimited: {
    error: {
      message: 'Rate limit exceeded',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  },
  invalidRequest: {
    error: {
      message: 'Invalid request',
      type: 'invalid_request_error',
      code: 'invalid_request',
    },
  },
  timeout: new Error('Request timeout'),
};