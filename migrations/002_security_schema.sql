-- Security Schema Migration
-- Adds tables for audit logging, security monitoring, and compliance

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  user_id VARCHAR(50),
  resource_type VARCHAR(50),
  resource_id VARCHAR(100),
  action VARCHAR(50),
  result VARCHAR(20) NOT NULL,
  metadata JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  session_id VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for audit logs
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

-- Audit retention policies
CREATE TABLE IF NOT EXISTS audit_retention_policies (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Security alerts table
CREATE TABLE IF NOT EXISTS security_alerts (
  id SERIAL PRIMARY KEY,
  alert_id VARCHAR(100) UNIQUE NOT NULL,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by VARCHAR(50),
  acknowledged_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for security alerts
CREATE INDEX IF NOT EXISTS idx_alerts_type ON security_alerts(type);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON security_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON security_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON security_alerts(acknowledged);

-- Security metrics table
CREATE TABLE IF NOT EXISTS security_metrics (
  id SERIAL PRIMARY KEY,
  metric_name VARCHAR(100) NOT NULL,
  metric_value NUMERIC NOT NULL,
  metric_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB DEFAULT '{}'
);

-- Index for security metrics
CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON security_metrics(metric_name, metric_timestamp);

-- Data retention policies
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(100) NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  date_column VARCHAR(100) NOT NULL,
  conditions TEXT,
  cascade_delete BOOLEAN DEFAULT false,
  last_cleanup TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User consent tracking (GDPR)
CREATE TABLE IF NOT EXISTS user_consent (
  id SERIAL PRIMARY KEY,
  slack_user_id VARCHAR(50) NOT NULL,
  consent_type VARCHAR(50) NOT NULL,
  granted BOOLEAN NOT NULL,
  granted_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(slack_user_id, consent_type)
);

-- Data export requests (GDPR)
CREATE TABLE IF NOT EXISTS data_export_requests (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(100) UNIQUE NOT NULL,
  slack_user_id VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  export_url TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for data export requests
CREATE INDEX IF NOT EXISTS idx_export_user ON data_export_requests(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_export_status ON data_export_requests(status);

-- Data deletion requests (GDPR)
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(100) UNIQUE NOT NULL,
  slack_user_id VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  deletion_scope VARCHAR(50) NOT NULL DEFAULT 'all',
  scheduled_for TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for data deletion requests
CREATE INDEX IF NOT EXISTS idx_deletion_user ON data_deletion_requests(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_deletion_status ON data_deletion_requests(status);

-- Add encryption indicator columns to sensitive tables
ALTER TABLE users ADD COLUMN IF NOT EXISTS encryption_version INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN DEFAULT false;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_security_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_audit_retention_policies_updated_at 
  BEFORE UPDATE ON audit_retention_policies
  FOR EACH ROW EXECUTE FUNCTION update_security_updated_at_column();

CREATE TRIGGER update_data_retention_policies_updated_at 
  BEFORE UPDATE ON data_retention_policies
  FOR EACH ROW EXECUTE FUNCTION update_security_updated_at_column();

CREATE TRIGGER update_user_consent_updated_at 
  BEFORE UPDATE ON user_consent
  FOR EACH ROW EXECUTE FUNCTION update_security_updated_at_column();

-- Insert default audit retention policies
INSERT INTO audit_retention_policies (event_type, retention_days) VALUES
  ('auth.%', 90),
  ('data.%', 365),
  ('user.%', 365),
  ('message.%', 180),
  ('security.%', 730),
  ('config.%', 365),
  ('compliance.%', 2555)
ON CONFLICT (event_type) DO NOTHING;

-- Insert default data retention policies
INSERT INTO data_retention_policies (table_name, retention_days, date_column) VALUES
  ('messages', 180, 'created_at'),
  ('conversation_summaries', 365, 'created_at'),
  ('user_interactions', 90, 'last_interaction_at'),
  ('audit_logs', 730, 'created_at')
ON CONFLICT (table_name) DO NOTHING;