// Database types based on PostgreSQL schema

export interface User {
  id: number;
  slack_user_id: string;
  username?: string;
  real_name?: string;
  display_name?: string;
  personality_summary?: string;
  interests?: string[];
  communication_style?: string;
  memorable_quotes?: string[];
  metadata?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
  // Additional fields from profile that might be stored in metadata
  email?: string;
  avatar_url?: string;
  personality_profile?: {
    traits?: string[];
    interests?: string[];
    communication_style?: string;
    last_updated?: string;
  };
}

export interface Message {
  id: number;
  slack_user_id: string;
  channel_id: string;
  message_text: string;
  message_ts: string;
  thread_ts?: string | null;
  parent_user_ts?: string | null;
  context?: MessageContext;
  embedding?: number[] | null;
  embedding_model?: string;
  created_at: Date;
  updated_at?: Date;
  // Virtual fields for queries
  similarity?: number;
}

export interface MessageContext {
  team_id?: string;
  user_context?: Record<string, any>;
  reactions?: Array<{
    name: string;
    users: string[];
    count: number;
  }>;
  attachments?: any[];
  files?: any[];
  blocks?: any[];
}

export interface ConversationSummary {
  id: number;
  channel_id: string;
  summary: string;
  key_topics?: string[];
  participant_ids?: string[];
  mood?: string;
  notable_moments?: Array<{
    timestamp: string;
    description: string;
    participants?: string[];
  }>;
  start_ts: string;
  end_ts: string;
  message_count?: number;
  created_at: Date;
  // Additional computed fields
  summary_text?: string;
  summary_date?: Date;
  metadata?: Record<string, any>;
}

export interface UserInteraction {
  id: number;
  user_a_id: string;
  user_b_id: string;
  interaction_count?: number;
  topics_discussed?: string[];
  relationship_notes?: string;
  sentiment_score?: number;
  last_interaction_at: Date;
  updated_at: Date;
  // Renamed fields for consistency
  user_id?: string;
  target_user_id?: string;
  interaction_type?: string;
  last_interaction?: Date;
  context?: {
    common_channels?: string[];
    interaction_patterns?: string[];
  };
}

// Query result types
export interface MessageWithUser extends Message {
  user?: User;
  username?: string;
  display_name?: string;
}

export interface SimilarMessage extends Message {
  similarity: number;
  relevance_score?: number;
}

export interface ChannelStats {
  channel_id: string;
  total_messages: number;
  unique_users: number;
  first_message_at: Date;
  last_message_at: Date;
  avg_message_length: number;
}

// Repository method types
export interface CreateMessageData {
  slack_user_id: string;
  channel_id: string;
  message_text: string;
  message_ts: string;
  thread_ts?: string;
  parent_user_ts?: string;
  context?: MessageContext;
  embedding?: number[];
  embedding_model?: string;
}

export interface CreateUserData {
  slack_user_id: string;
  username?: string;
  real_name?: string;
  display_name?: string;
  personality_summary?: string;
  interests?: string[];
  communication_style?: string;
  memorable_quotes?: string[];
  metadata?: Record<string, any>;
}

export interface UpdateUserData {
  username?: string;
  real_name?: string;
  display_name?: string;
  personality_summary?: string;
  interests?: string[];
  communication_style?: string;
  memorable_quotes?: string[];
  metadata?: Record<string, any>;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  similarity_threshold?: number;
  time_range_hours?: number;
  exclude_user_ids?: string[];
}

export interface UserProfileUpdate {
  personality_traits?: string[];
  interests?: string[];
  communication_style?: string;
  memorable_quotes?: string[];
  interaction_patterns?: Record<string, any>;
}