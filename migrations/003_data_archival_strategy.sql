-- Create archive schema for old messages
CREATE SCHEMA IF NOT EXISTS archive;

-- Archive messages table with same structure
CREATE TABLE IF NOT EXISTS archive.messages (
    LIKE public.messages INCLUDING ALL
);

-- Add archive timestamp
ALTER TABLE archive.messages ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create indexes on archive table
CREATE INDEX idx_archive_messages_channel_id ON archive.messages(channel_id);
CREATE INDEX idx_archive_messages_created_at ON archive.messages(created_at);
CREATE INDEX idx_archive_messages_archived_at ON archive.messages(archived_at);

-- Function to archive old messages
CREATE OR REPLACE FUNCTION archive_old_messages(months_old INTEGER DEFAULT 6)
RETURNS TABLE(archived_count BIGINT) AS $$
DECLARE
    cutoff_date TIMESTAMP WITH TIME ZONE;
BEGIN
    cutoff_date := CURRENT_TIMESTAMP - (months_old || ' months')::INTERVAL;
    
    -- Archive messages in batches to avoid locking
    WITH archived AS (
        INSERT INTO archive.messages
        SELECT *, CURRENT_TIMESTAMP as archived_at
        FROM public.messages
        WHERE created_at < cutoff_date
        RETURNING id
    ),
    deleted AS (
        DELETE FROM public.messages
        WHERE id IN (SELECT id FROM archived)
        RETURNING id
    )
    SELECT COUNT(*) INTO archived_count FROM deleted;
    
    -- Update statistics
    ANALYZE public.messages;
    ANALYZE archive.messages;
    
    RETURN QUERY SELECT archived_count;
END;
$$ LANGUAGE plpgsql;

-- Function to restore archived messages
CREATE OR REPLACE FUNCTION restore_archived_messages(
    channel_id_param VARCHAR(50),
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(restored_count BIGINT) AS $$
BEGIN
    WITH restored AS (
        INSERT INTO public.messages
        SELECT 
            id, slack_user_id, channel_id, message_text, message_ts,
            thread_ts, parent_user_ts, context, embedding, embedding_model,
            created_at
        FROM archive.messages
        WHERE channel_id = channel_id_param
          AND created_at BETWEEN start_date AND end_date
        ON CONFLICT (message_ts) DO NOTHING
        RETURNING id
    )
    SELECT COUNT(*) INTO restored_count FROM restored;
    
    RETURN QUERY SELECT restored_count;
END;
$$ LANGUAGE plpgsql;

-- Create a view that spans both current and archived messages
CREATE OR REPLACE VIEW all_messages AS
SELECT *, 'current' as source FROM public.messages
UNION ALL
SELECT 
    id, slack_user_id, channel_id, message_text, message_ts,
    thread_ts, parent_user_ts, context, embedding, embedding_model,
    created_at, 'archive' as source
FROM archive.messages;

-- Function to search across current and archived messages
CREATE OR REPLACE FUNCTION search_all_messages(
    embedding_param vector(1536),
    limit_param INTEGER DEFAULT 20,
    threshold_param FLOAT DEFAULT 0.7
)
RETURNS TABLE(
    id INTEGER,
    slack_user_id VARCHAR(50),
    channel_id VARCHAR(50),
    message_text TEXT,
    message_ts VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE,
    similarity FLOAT,
    source TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH combined_results AS (
        -- Search current messages
        SELECT 
            m.id, m.slack_user_id, m.channel_id, m.message_text, 
            m.message_ts, m.created_at,
            1 - (m.embedding <=> embedding_param) as similarity,
            'current'::TEXT as source
        FROM public.messages m
        WHERE m.embedding IS NOT NULL
          AND 1 - (m.embedding <=> embedding_param) > threshold_param
        
        UNION ALL
        
        -- Search archived messages
        SELECT 
            a.id, a.slack_user_id, a.channel_id, a.message_text,
            a.message_ts, a.created_at,
            1 - (a.embedding <=> embedding_param) as similarity,
            'archive'::TEXT as source
        FROM archive.messages a
        WHERE a.embedding IS NOT NULL
          AND 1 - (a.embedding <=> embedding_param) > threshold_param
    )
    SELECT * FROM combined_results
    ORDER BY similarity DESC
    LIMIT limit_param;
END;
$$ LANGUAGE plpgsql;

-- Automated archival job (requires pg_cron)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('archive-old-messages', '0 2 * * 0', 'SELECT archive_old_messages(6)');

-- Table to track archival history
CREATE TABLE IF NOT EXISTS archive.history (
    id SERIAL PRIMARY KEY,
    archived_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    messages_archived BIGINT,
    oldest_message_date TIMESTAMP WITH TIME ZONE,
    newest_message_date TIMESTAMP WITH TIME ZONE,
    duration_seconds FLOAT
);

-- Enhanced archival function with history tracking
CREATE OR REPLACE FUNCTION archive_old_messages_with_history(months_old INTEGER DEFAULT 6)
RETURNS TABLE(
    archived_count BIGINT,
    oldest_date TIMESTAMP WITH TIME ZONE,
    newest_date TIMESTAMP WITH TIME ZONE,
    duration FLOAT
) AS $$
DECLARE
    start_time TIMESTAMP;
    end_time TIMESTAMP;
    cutoff_date TIMESTAMP WITH TIME ZONE;
    v_archived_count BIGINT;
    v_oldest_date TIMESTAMP WITH TIME ZONE;
    v_newest_date TIMESTAMP WITH TIME ZONE;
    v_duration FLOAT;
BEGIN
    start_time := clock_timestamp();
    cutoff_date := CURRENT_TIMESTAMP - (months_old || ' months')::INTERVAL;
    
    -- Get date range before archiving
    SELECT MIN(created_at), MAX(created_at) INTO v_oldest_date, v_newest_date
    FROM public.messages
    WHERE created_at < cutoff_date;
    
    -- Perform archival
    SELECT * INTO v_archived_count FROM archive_old_messages(months_old);
    
    end_time := clock_timestamp();
    v_duration := EXTRACT(EPOCH FROM (end_time - start_time));
    
    -- Record in history
    INSERT INTO archive.history (
        messages_archived, 
        oldest_message_date, 
        newest_message_date, 
        duration_seconds
    ) VALUES (
        v_archived_count,
        v_oldest_date,
        v_newest_date,
        v_duration
    );
    
    RETURN QUERY SELECT v_archived_count, v_oldest_date, v_newest_date, v_duration;
END;
$$ LANGUAGE plpgsql;

-- Add compression to archive table for space savings
ALTER TABLE archive.messages SET (
    autovacuum_enabled = false,
    toast_compression = lz4
);

-- Create summary statistics for archived data
CREATE MATERIALIZED VIEW archive.channel_statistics AS
SELECT 
    channel_id,
    COUNT(*) as message_count,
    MIN(created_at) as earliest_message,
    MAX(created_at) as latest_message,
    pg_size_pretty(SUM(pg_column_size(message_text))) as text_size,
    COUNT(DISTINCT slack_user_id) as unique_users
FROM archive.messages
GROUP BY channel_id
WITH DATA;

CREATE INDEX idx_archive_stats_channel ON archive.channel_statistics(channel_id);