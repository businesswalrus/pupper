// Re-export repositories with caching applied
export { messageRepository } from './cachedMessageRepository';
export { userRepository } from './userRepository';
export { summaryRepository } from './summaryRepository';
export { interactionRepository } from './interactionRepository';

// Export base repositories if needed
export { MessageRepository } from './messageRepository';
export { UserRepository } from './userRepository';
export { SummaryRepository } from './summaryRepository';
export { InteractionRepository } from './interactionRepository';

// Export types
export type { Message, MessageSearchOptions } from './messageRepository';
export type { User, UserUpdateData } from './userRepository';
export type { ConversationSummary } from './summaryRepository';
export type { UserInteraction } from './interactionRepository';