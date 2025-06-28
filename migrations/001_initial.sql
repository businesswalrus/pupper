-- Initial schema for pup.ai v2 (simplified)

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for efficient channel queries
CREATE INDEX IF NOT EXISTS idx_messages_channel_time 
  ON messages(channel_id, timestamp DESC);

-- Create index for deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique 
  ON messages(channel_id, timestamp, user_id);

-- Add comment for documentation
COMMENT ON TABLE messages IS 'Stores all Slack messages for context retrieval';
COMMENT ON COLUMN messages.user_id IS 'Slack user ID who sent the message';
COMMENT ON COLUMN messages.channel_id IS 'Slack channel ID where message was sent';
COMMENT ON COLUMN messages.text IS 'The actual message content';
COMMENT ON COLUMN messages.timestamp IS 'When the message was sent in Slack';