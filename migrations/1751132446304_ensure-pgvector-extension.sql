-- Ensure pgvector extension is installed
-- This is critical for Railway deployments where extensions aren't auto-installed

-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify the extension is installed
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RAISE EXCEPTION 'pgvector extension failed to install';
    END IF;
END $$;

-- Down Migration
-- Note: We don't drop the extension as other tables might depend on it
-- DROP EXTENSION IF EXISTS vector;