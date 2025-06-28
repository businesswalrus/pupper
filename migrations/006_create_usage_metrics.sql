-- Create usage_metrics table for cost tracking
CREATE TABLE IF NOT EXISTS usage_metrics (
  id SERIAL PRIMARY KEY,
  service VARCHAR(50) NOT NULL,
  operation VARCHAR(100) NOT NULL,
  user_id VARCHAR(50),
  quantity DECIMAL(10, 4) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  cost DECIMAL(10, 6) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_usage_metrics_timestamp ON usage_metrics(timestamp);
CREATE INDEX idx_usage_metrics_service ON usage_metrics(service);
CREATE INDEX idx_usage_metrics_user_id ON usage_metrics(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_usage_metrics_service_operation ON usage_metrics(service, operation);
CREATE INDEX idx_usage_metrics_timestamp_service ON usage_metrics(timestamp, service);

-- Composite index for cost reports
CREATE INDEX idx_usage_metrics_reporting ON usage_metrics(timestamp, service, user_id, cost);

-- Partial index for recent data (last 30 days)
CREATE INDEX idx_usage_metrics_recent ON usage_metrics(timestamp)
WHERE timestamp > NOW() - INTERVAL '30 days';

-- Create a summary view for quick cost analysis
CREATE OR REPLACE VIEW cost_summary AS
SELECT 
  DATE_TRUNC('day', timestamp) as day,
  service,
  COUNT(*) as request_count,
  SUM(quantity) as total_quantity,
  SUM(cost) as total_cost,
  AVG(cost) as avg_cost_per_request
FROM usage_metrics
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', timestamp), service
ORDER BY day DESC, service;

-- Create a user cost view
CREATE OR REPLACE VIEW user_cost_summary AS
SELECT 
  user_id,
  DATE_TRUNC('day', timestamp) as day,
  service,
  COUNT(*) as request_count,
  SUM(cost) as total_cost
FROM usage_metrics
WHERE user_id IS NOT NULL
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY user_id, DATE_TRUNC('day', timestamp), service
ORDER BY day DESC, total_cost DESC;

-- Function to get cost trends
CREATE OR REPLACE FUNCTION get_cost_trends(
  p_period INTERVAL DEFAULT '7 days'
) RETURNS TABLE (
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  total_cost DECIMAL,
  avg_daily_cost DECIMAL,
  growth_rate DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  WITH daily_costs AS (
    SELECT 
      DATE_TRUNC('day', timestamp) as day,
      SUM(cost) as daily_cost
    FROM usage_metrics
    WHERE timestamp > NOW() - p_period * 2
    GROUP BY day
  ),
  period_comparison AS (
    SELECT 
      CASE 
        WHEN day > NOW() - p_period THEN 'current'
        ELSE 'previous'
      END as period,
      AVG(daily_cost) as avg_cost,
      MIN(day) as period_start,
      MAX(day) as period_end,
      SUM(daily_cost) as total_cost
    FROM daily_costs
    GROUP BY CASE 
      WHEN day > NOW() - p_period THEN 'current'
      ELSE 'previous'
    END
  )
  SELECT 
    current.period_start,
    current.period_end,
    current.total_cost,
    current.avg_cost as avg_daily_cost,
    CASE 
      WHEN previous.avg_cost > 0 THEN 
        ((current.avg_cost - previous.avg_cost) / previous.avg_cost) * 100
      ELSE 0
    END as growth_rate
  FROM period_comparison current
  LEFT JOIN period_comparison previous ON previous.period = 'previous'
  WHERE current.period = 'current';
END;
$$ LANGUAGE plpgsql;

-- Add partitioning for large-scale data (optional)
-- This creates monthly partitions for better performance
CREATE OR REPLACE FUNCTION create_usage_metrics_partition()
RETURNS void AS $$
DECLARE
  partition_date DATE;
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_date := DATE_TRUNC('month', NOW());
  partition_name := 'usage_metrics_' || TO_CHAR(partition_date, 'YYYY_MM');
  start_date := partition_date;
  end_date := partition_date + INTERVAL '1 month';
  
  -- Check if partition already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename = partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF usage_metrics
      FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
    
    RAISE NOTICE 'Created partition % for usage_metrics', partition_name;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Schedule automatic partition creation (requires pg_cron extension)
-- Uncomment if pg_cron is available:
-- SELECT cron.schedule('create-usage-partitions', '0 0 1 * *', 'SELECT create_usage_metrics_partition();');