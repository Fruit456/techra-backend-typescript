-- Phase 7 & 8: Multi-tenant support and admin features
-- This script is idempotent and safe to run multiple times

-- Add tenant_id to existing tables (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='trains' AND column_name='tenant_id') THEN
    ALTER TABLE trains ADD COLUMN tenant_id VARCHAR(100) DEFAULT 'default';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='aggregates' AND column_name='is_spare') THEN
    ALTER TABLE aggregates ADD COLUMN is_spare BOOLEAN DEFAULT false;
  END IF;
END $$;

-- Create tenants table
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    logo_url TEXT,
    primary_color VARCHAR(7) DEFAULT '#3B82F6',
    language VARCHAR(5) DEFAULT 'sv',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create train_configurations table
CREATE TABLE IF NOT EXISTS train_configurations (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(100) REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    wagon_count INTEGER NOT NULL DEFAULT 5,
    wagon_types JSONB NOT NULL,
    custom_labels JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id)
);

-- Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(100),
    user_email VARCHAR(255),
    user_name VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(50),
    old_value JSONB,
    new_value JSONB,
    description TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create aggregate_replacements table for tracking swaps
CREATE TABLE IF NOT EXISTS aggregate_replacements (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(100),
    old_aggregate_id INTEGER REFERENCES aggregates(id),
    new_aggregate_id INTEGER REFERENCES aggregates(id),
    wagon_id INTEGER REFERENCES wagons(id),
    reason TEXT,
    replaced_by VARCHAR(255),
    replaced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default tenant (Öresundståg)
INSERT INTO tenants (tenant_id, name, primary_color, language)
VALUES ('default', 'Öresundståg', '#3B82F6', 'sv')
ON CONFLICT (tenant_id) DO NOTHING;

-- Insert default configuration for Öresundståg (5 wagons)
INSERT INTO train_configurations (tenant_id, wagon_count, wagon_types, custom_labels)
VALUES (
    'default',
    5,
    '["M43 Hytt", "M43 Salong", "T47 Salong", "M45 Salong", "M45 Hytt"]'::jsonb,
    '{
        "M43 Hytt": "Motorvagn 43 Hytt",
        "M43 Salong": "Motorvagn 43 Salong",
        "T47 Salong": "Trailvagn 47 Salong",
        "M45 Salong": "Motorvagn 45 Salong",
        "M45 Hytt": "Motorvagn 45 Hytt"
    }'::jsonb
)
ON CONFLICT (tenant_id) DO NOTHING;

-- Create indexes (if not exists)
CREATE INDEX IF NOT EXISTS idx_trains_tenant_id ON trains(tenant_id);
CREATE INDEX IF NOT EXISTS idx_aggregates_is_spare ON aggregates(is_spare);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aggregate_replacements_tenant_id ON aggregate_replacements(tenant_id);

-- Update existing trains to have tenant_id (if not already set)
UPDATE trains SET tenant_id = 'default' WHERE tenant_id IS NULL OR tenant_id = '';

-- Add comments
COMMENT ON TABLE tenants IS 'Multi-tenant configuration';
COMMENT ON TABLE train_configurations IS 'Flexible wagon configurations per tenant';
COMMENT ON TABLE audit_logs IS 'System audit trail';
COMMENT ON TABLE aggregate_replacements IS 'Aggregate swap history';

-- Grant permissions (if using specific DB user)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO techra_api_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO techra_api_user;

-- Success message
SELECT 'Multi-tenant schema (Phase 7 & 8) applied successfully! ✅' AS status;
