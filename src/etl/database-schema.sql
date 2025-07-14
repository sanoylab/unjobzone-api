-- ETL Monitoring Database Schema
-- Best practices: Indexes, constraints, and performance optimization

-- Create ETL status table with proper constraints
CREATE TABLE IF NOT EXISTS etl_status (
    id SERIAL PRIMARY KEY,
    organization_name VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    processed_count INTEGER DEFAULT 0 CHECK (processed_count >= 0),
    success_count INTEGER DEFAULT 0 CHECK (success_count >= 0),
    error_count INTEGER DEFAULT 0 CHECK (error_count >= 0),
    error_message TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    duration_seconds INTEGER CHECK (duration_seconds >= 0),
    jobs_in_db INTEGER DEFAULT 0 CHECK (jobs_in_db >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- Constraints
    CONSTRAINT valid_counts CHECK (success_count + error_count <= processed_count),
    CONSTRAINT valid_time_range CHECK (end_time IS NULL OR end_time >= start_time)
);

-- Performance indexes for ETL status queries
CREATE INDEX IF NOT EXISTS idx_etl_status_org_created 
    ON etl_status(organization_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_etl_status_created 
    ON etl_status(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_etl_status_org_status 
    ON etl_status(organization_name, status);

-- Composite index for dashboard queries
CREATE INDEX IF NOT EXISTS idx_etl_status_dashboard 
    ON etl_status(created_at DESC, organization_name, status) 
    INCLUDE (jobs_in_db, duration_seconds);

-- Add indexes to existing job_vacancies table for better performance
CREATE INDEX IF NOT EXISTS idx_job_vacancies_data_source 
    ON job_vacancies(data_source);

CREATE INDEX IF NOT EXISTS idx_job_vacancies_created 
    ON job_vacancies(created DESC);

CREATE INDEX IF NOT EXISTS idx_job_vacancies_org_id 
    ON job_vacancies(organization_id);

-- CRITICAL: Add unique constraint to prevent duplicate job vacancies
-- This ensures no duplicate jobs can be inserted during ETL processing
DO $$ 
BEGIN
    -- Check if constraint already exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'unique_job_vacancy'
    ) THEN
        -- Remove any existing duplicates before adding constraint
        DELETE FROM job_vacancies
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY job_id, data_source, organization_id 
                           ORDER BY created DESC
                       ) AS rn
                FROM job_vacancies
            ) t
            WHERE rn > 1
        );
        
        -- Add the unique constraint
        ALTER TABLE job_vacancies 
        ADD CONSTRAINT unique_job_vacancy 
        UNIQUE (job_id, data_source, organization_id);
        
        RAISE NOTICE 'Added unique constraint to prevent duplicate job vacancies';
    END IF;
END $$;

-- Create view for latest ETL status (used frequently)
CREATE OR REPLACE VIEW latest_etl_status AS
SELECT DISTINCT ON (organization_name) 
    organization_name,
    status,
    processed_count,
    success_count,
    error_count,
    error_message,
    start_time,
    end_time,
    duration_seconds,
    jobs_in_db,
    created_at
FROM etl_status 
ORDER BY organization_name, created_at DESC;

-- Create function for ETL statistics (performance optimization)
CREATE OR REPLACE FUNCTION get_etl_statistics(days_back INTEGER DEFAULT 7)
RETURNS TABLE (
    total_organizations INTEGER,
    successful_orgs INTEGER,
    failed_orgs INTEGER,
    total_jobs INTEGER,
    avg_duration NUMERIC,
    last_run_time TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(DISTINCT l.organization_name)::INTEGER as total_organizations,
        SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END)::INTEGER as successful_orgs,
        SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END)::INTEGER as failed_orgs,
        SUM(l.jobs_in_db)::INTEGER as total_jobs,
        AVG(l.duration_seconds)::NUMERIC as avg_duration,
        MAX(l.created_at) as last_run_time
    FROM latest_etl_status l
    WHERE l.created_at >= NOW() - INTERVAL '1 day' * days_back;
END;
$$ LANGUAGE plpgsql;

-- Create function for organization performance metrics
CREATE OR REPLACE FUNCTION get_org_performance(org_name VARCHAR DEFAULT NULL, days_back INTEGER DEFAULT 7)
RETURNS TABLE (
    organization_name VARCHAR,
    total_runs INTEGER,
    successful_runs INTEGER,
    success_rate NUMERIC,
    avg_jobs NUMERIC,
    avg_duration NUMERIC,
    last_run TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.organization_name,
        COUNT(*)::INTEGER as total_runs,
        SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END)::INTEGER as successful_runs,
        ROUND(
            (SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END)::NUMERIC / COUNT(*)) * 100, 
            2
        ) as success_rate,
        AVG(e.jobs_in_db)::NUMERIC as avg_jobs,
        AVG(e.duration_seconds)::NUMERIC as avg_duration,
        MAX(e.created_at) as last_run
    FROM etl_status e
    WHERE e.created_at >= NOW() - INTERVAL '1 day' * days_back
    AND (org_name IS NULL OR e.organization_name = org_name)
    GROUP BY e.organization_name
    ORDER BY success_rate DESC, avg_jobs DESC;
END;
$$ LANGUAGE plpgsql;

-- Create cleanup function for old ETL logs (data retention)
CREATE OR REPLACE FUNCTION cleanup_old_etl_logs(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM etl_status 
    WHERE created_at < NOW() - INTERVAL '1 day' * retention_days;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Grant appropriate permissions (adjust roles as needed)
-- GRANT SELECT ON latest_etl_status TO readonly_user;
-- GRANT EXECUTE ON FUNCTION get_etl_statistics TO readonly_user;
-- GRANT EXECUTE ON FUNCTION get_org_performance TO readonly_user; 