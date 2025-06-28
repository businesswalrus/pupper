-- Drop the old IVFFlat index
DROP INDEX IF EXISTS idx_messages_embedding;

-- Create HNSW index for better performance at scale
-- HNSW performs better than IVFFlat for datasets > 1M vectors
CREATE INDEX idx_messages_embedding_hnsw ON messages 
USING hnsw (embedding vector_cosine_ops) 
WITH (m = 16, ef_construction = 64);

-- Analyze embedding distribution to optimize similarity threshold
CREATE OR REPLACE FUNCTION analyze_embedding_similarity_distribution()
RETURNS TABLE(
    percentile float,
    similarity_threshold float
) AS $$
BEGIN
    RETURN QUERY
    WITH sample_pairs AS (
        SELECT 
            1 - (a.embedding <=> b.embedding) as similarity
        FROM 
            (SELECT embedding FROM messages WHERE embedding IS NOT NULL LIMIT 1000) a
        CROSS JOIN 
            (SELECT embedding FROM messages WHERE embedding IS NOT NULL LIMIT 1000) b
    )
    SELECT 
        p.percentile,
        percentile_cont(p.percentile) WITHIN GROUP (ORDER BY similarity) as threshold
    FROM 
        sample_pairs,
        (VALUES (0.5), (0.7), (0.8), (0.9), (0.95), (0.99)) as p(percentile)
    GROUP BY p.percentile;
END;
$$ LANGUAGE plpgsql;

-- Create composite indexes for common query patterns
CREATE INDEX idx_messages_channel_created_desc ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_channel_thread ON messages(channel_id, thread_ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX idx_messages_user_created ON messages(slack_user_id, created_at DESC);
CREATE INDEX idx_messages_ts_channel ON messages(message_ts, channel_id);

-- Partial index for messages without embeddings (for processing queue)
CREATE INDEX idx_messages_no_embedding ON messages(created_at) WHERE embedding IS NULL;

-- Create partitioned messages table for better performance at scale
CREATE TABLE messages_partitioned (
    LIKE messages INCLUDING ALL
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for the last 6 months
DO $$
DECLARE
    start_date date;
    end_date date;
    partition_name text;
BEGIN
    FOR i IN 0..5 LOOP
        start_date := date_trunc('month', CURRENT_DATE - (i || ' months')::interval);
        end_date := date_trunc('month', CURRENT_DATE - ((i-1) || ' months')::interval);
        partition_name := 'messages_' || to_char(start_date, 'YYYY_MM');
        
        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I PARTITION OF messages_partitioned
            FOR VALUES FROM (%L) TO (%L)',
            partition_name, start_date, end_date
        );
    END LOOP;
END $$;

-- Function to automatically create new partitions
CREATE OR REPLACE FUNCTION create_monthly_partition()
RETURNS void AS $$
DECLARE
    start_date date;
    end_date date;
    partition_name text;
BEGIN
    start_date := date_trunc('month', CURRENT_DATE + interval '1 month');
    end_date := date_trunc('month', CURRENT_DATE + interval '2 months');
    partition_name := 'messages_' || to_char(start_date, 'YYYY_MM');
    
    EXECUTE format('
        CREATE TABLE IF NOT EXISTS %I PARTITION OF messages_partitioned
        FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;

-- Schedule partition creation (requires pg_cron extension)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('create-partition', '0 0 25 * *', 'SELECT create_monthly_partition()');

-- Add statistics for query optimization
ALTER TABLE messages SET (autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.1);

-- Create materialized view for channel statistics
CREATE MATERIALIZED VIEW channel_message_stats AS
SELECT 
    channel_id,
    COUNT(*) as total_messages,
    COUNT(DISTINCT slack_user_id) as unique_users,
    MIN(created_at) as first_message_at,
    MAX(created_at) as last_message_at,
    AVG(LENGTH(message_text)) as avg_message_length
FROM messages
GROUP BY channel_id
WITH DATA;

CREATE INDEX idx_channel_stats_channel ON channel_message_stats(channel_id);

-- Refresh materialized view periodically
-- SELECT cron.schedule('refresh-channel-stats', '0 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY channel_message_stats');