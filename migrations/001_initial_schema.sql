-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Users table with personality profiles
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    slack_user_id VARCHAR(50) UNIQUE NOT NULL,
    username VARCHAR(100),
    real_name VARCHAR(255),
    display_name VARCHAR(100),
    personality_summary TEXT,
    interests JSONB DEFAULT '[]'::jsonb,
    communication_style TEXT,
    memorable_quotes JSONB DEFAULT '[]'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Messages with embeddings
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    slack_user_id VARCHAR(50) NOT NULL,
    channel_id VARCHAR(50) NOT NULL,
    message_text TEXT NOT NULL,
    message_ts VARCHAR(20) UNIQUE NOT NULL, -- Slack timestamp for deduplication
    thread_ts VARCHAR(20), -- Thread timestamp if in a thread
    parent_user_ts VARCHAR(20), -- Parent message if this is a reply
    context JSONB DEFAULT '{}'::jsonb, -- Additional context (reactions, files, etc)
    embedding vector(1536), -- OpenAI embeddings dimension
    embedding_model VARCHAR(50), -- Track which model generated the embedding
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (slack_user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);

-- Conversation summaries
CREATE TABLE conversation_summaries (
    id SERIAL PRIMARY KEY,
    channel_id VARCHAR(50) NOT NULL,
    summary TEXT NOT NULL,
    key_topics JSONB DEFAULT '[]'::jsonb,
    participant_ids JSONB DEFAULT '[]'::jsonb,
    mood VARCHAR(50), -- Overall mood of the conversation
    notable_moments JSONB DEFAULT '[]'::jsonb,
    start_ts VARCHAR(20) NOT NULL,
    end_ts VARCHAR(20) NOT NULL,
    message_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User relationships and interactions
CREATE TABLE user_interactions (
    id SERIAL PRIMARY KEY,
    user_a_id VARCHAR(50) NOT NULL,
    user_b_id VARCHAR(50) NOT NULL,
    interaction_count INTEGER DEFAULT 1,
    topics_discussed JSONB DEFAULT '[]'::jsonb,
    relationship_notes TEXT,
    sentiment_score FLOAT DEFAULT 0.0, -- -1 to 1, tracking overall sentiment
    last_interaction_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_a_id) REFERENCES users(slack_user_id) ON DELETE CASCADE,
    FOREIGN KEY (user_b_id) REFERENCES users(slack_user_id) ON DELETE CASCADE,
    CONSTRAINT unique_user_pair UNIQUE (user_a_id, user_b_id)
);

-- Indexes for performance
CREATE INDEX idx_messages_channel_id ON messages(channel_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX idx_messages_slack_user_id ON messages(slack_user_id);
CREATE INDEX idx_messages_thread_ts ON messages(thread_ts) WHERE thread_ts IS NOT NULL;

-- Index for vector similarity search
CREATE INDEX idx_messages_embedding ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Index for conversation summaries
CREATE INDEX idx_summaries_channel_id ON conversation_summaries(channel_id);
CREATE INDEX idx_summaries_created_at ON conversation_summaries(created_at DESC);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_interactions_updated_at BEFORE UPDATE ON user_interactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();