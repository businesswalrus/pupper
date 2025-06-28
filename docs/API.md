# API Reference

## Internal APIs

pup.ai v2 primarily uses internal APIs for component communication. While there's no public REST API, this document describes the internal service interfaces and data contracts.

## Service Interfaces

### Memory Service

Located in `src/ai/memory.ts`

#### `getRelevantContext(params: IContextParams): Promise<IMemoryContext>`

Retrieves relevant historical context for a message.

**Parameters:**
```typescript
interface IContextParams {
  query: string;           // The message text to find context for
  userId: string;          // Slack user ID
  channelId?: string;      // Optional channel filter
  limit?: number;          // Max results (default: 50)
  threshold?: number;      // Similarity threshold 0-1 (default: 0.7)
  timeWindow?: number;     // Hours to look back (default: 720)
}
```

**Response:**
```typescript
interface IMemoryContext {
  messages: IContextMessage[];
  userProfile: IUserProfile;
  conversationSummary?: string;
  relatedTopics: string[];
}

interface IContextMessage {
  id: string;
  text: string;
  userId: string;
  timestamp: Date;
  similarity: number;
  threadContext?: IThreadContext;
}
```

#### `storeMessage(message: ISlackMessage): Promise<void>`

Stores a new message and queues embedding generation.

**Parameters:**
```typescript
interface ISlackMessage {
  ts: string;
  user: string;
  text: string;
  channel: string;
  thread_ts?: string;
  attachments?: any[];
}
```

### Personality Service

Located in `src/ai/personality.ts`

#### `generateResponse(params: IResponseParams): Promise<IPersonalityResponse>`

Generates a personality-driven response.

**Parameters:**
```typescript
interface IResponseParams {
  message: string;
  context: IMemoryContext;
  mood?: BotMood;
  style?: ResponseStyle;
  maxTokens?: number;
}

enum BotMood {
  NEUTRAL = 'neutral',
  FRIENDLY = 'friendly',
  SARCASTIC = 'sarcastic',
  ENTHUSIASTIC = 'enthusiastic',
  THOUGHTFUL = 'thoughtful'
}

enum ResponseStyle {
  CASUAL = 'casual',
  PROFESSIONAL = 'professional',
  HUMOROUS = 'humorous',
  TECHNICAL = 'technical'
}
```

**Response:**
```typescript
interface IPersonalityResponse {
  text: string;
  mood: BotMood;
  confidence: number;
  reasoning?: string;
  suggestedFollowUp?: string;
}
```

### User Repository

Located in `src/db/repositories/userRepository.ts`

#### `findBySlackId(slackId: string): Promise<IUser | null>`

Retrieves user by Slack ID.

#### `upsertUser(userData: IUserData): Promise<IUser>`

Creates or updates a user record.

**Parameters:**
```typescript
interface IUserData {
  slackId: string;
  username: string;
  realName?: string;
  email?: string;
  personalityProfile?: IPersonalityProfile;
}

interface IPersonalityProfile {
  traits: string[];
  communicationStyle: string;
  interests: string[];
  lastAnalyzed: Date;
  interactionCount: number;
}
```

#### `updatePersonalityProfile(slackId: string, profile: Partial<IPersonalityProfile>): Promise<void>`

Updates user's personality profile.

### Message Repository

Located in `src/db/repositories/messageRepository.ts`

#### `searchSimilar(embedding: number[], options: ISearchOptions): Promise<IMessage[]>`

Performs vector similarity search.

**Parameters:**
```typescript
interface ISearchOptions {
  limit: number;
  threshold: number;
  userId?: string;
  channelId?: string;
  startDate?: Date;
  endDate?: Date;
}
```

#### `getConversationThread(threadTs: string, channelId: string): Promise<IMessage[]>`

Retrieves all messages in a thread.

### Search Service

Located in `src/services/webSearch.ts`

#### `search(query: string, options?: ISearchOptions): Promise<ISearchResult[]>`

Performs web search using Brave Search API.

**Parameters:**
```typescript
interface ISearchOptions {
  count?: number;        // Results to return (default: 5)
  freshness?: string;    // Time range: 'day', 'week', 'month'
  lang?: string;         // Language code (default: 'en')
}
```

**Response:**
```typescript
interface ISearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: Date;
  relevanceScore: number;
}
```

## Data Models

### User Model

```typescript
interface IUser {
  id: string;
  slackId: string;
  username: string;
  realName?: string;
  email?: string;
  personalityProfile: IPersonalityProfile;
  createdAt: Date;
  updatedAt: Date;
}
```

### Message Model

```typescript
interface IMessage {
  id: string;
  slackUserId: string;
  text: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  embedding?: number[];
  metadata?: Record<string, any>;
  createdAt: Date;
}
```

### Interaction Model

```typescript
interface IUserInteraction {
  id: string;
  userId1: string;
  userId2: string;
  interactionType: InteractionType;
  interactionCount: number;
  sentiment: number;        // -1 to 1
  lastInteraction: Date;
  topics: string[];
  createdAt: Date;
  updatedAt: Date;
}

enum InteractionType {
  COLLABORATION = 'collaboration',
  CASUAL = 'casual',
  TECHNICAL = 'technical',
  SUPPORT = 'support',
  CONFLICT = 'conflict'
}
```

### Summary Model

```typescript
interface IConversationSummary {
  id: string;
  channelId: string;
  summaryDate: Date;
  summaryText: string;
  keyTopics: string[];
  participantCount: number;
  messageCount: number;
  sentiment: number;
  createdAt: Date;
}
```

## Event Contracts

### Slack Events

Events received from Slack are typed as:

```typescript
interface ISlackMessageEvent {
  type: 'message';
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
}
```

### Internal Events

Events emitted internally:

```typescript
interface IMessageStoredEvent {
  type: 'message.stored';
  messageId: string;
  userId: string;
  channelId: string;
  timestamp: Date;
}

interface IEmbeddingGeneratedEvent {
  type: 'embedding.generated';
  messageId: string;
  dimensions: number;
  model: string;
}

interface IProfileUpdatedEvent {
  type: 'profile.updated';
  userId: string;
  changes: string[];
  timestamp: Date;
}
```

## Queue Job Contracts

### Embedding Job

```typescript
interface IEmbeddingJob {
  messageId: string;
  text: string;
  userId: string;
  priority?: number;
}
```

### Summary Job

```typescript
interface ISummaryJob {
  channelId: string;
  date: Date;
  forceRegenerate?: boolean;
}
```

### Profile Job

```typescript
interface IProfileJob {
  userId: string;
  recentMessageIds: string[];
  fullAnalysis?: boolean;
}
```

## Error Response Format

All services follow a consistent error format:

```typescript
interface IErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
    traceId?: string;
  };
}
```

Common error codes:

- `VALIDATION_ERROR`: Invalid input parameters
- `NOT_FOUND`: Resource not found
- `RATE_LIMITED`: Rate limit exceeded
- `INTERNAL_ERROR`: Unexpected server error
- `DEPENDENCY_ERROR`: External service failure

## Rate Limits

Internal rate limits by service:

| Service | Limit | Window |
|---------|-------|--------|
| OpenAI Embeddings | 60 | 1 minute |
| OpenAI Completions | 20 | 1 minute |
| Brave Search | 100 | 1 hour |
| Database Writes | 1000 | 1 minute |
| Vector Search | 100 | 1 minute |

## Webhook Endpoints

### Health Check

`GET /health`

Returns system health status:

```typescript
interface IHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  services: {
    database: ServiceStatus;
    redis: ServiceStatus;
    slack: ServiceStatus;
    openai: ServiceStatus;
  };
}

interface ServiceStatus {
  status: 'up' | 'down' | 'degraded';
  latency?: number;
  error?: string;
}
```

### Metrics

`GET /metrics`

Returns Prometheus-formatted metrics:

```
# HELP pupper_messages_processed_total Total messages processed
# TYPE pupper_messages_processed_total counter
pupper_messages_processed_total 1234

# HELP pupper_response_time_seconds Response time in seconds
# TYPE pupper_response_time_seconds histogram
pupper_response_time_seconds_bucket{le="0.1"} 100
pupper_response_time_seconds_bucket{le="0.5"} 200
pupper_response_time_seconds_bucket{le="1"} 250
```