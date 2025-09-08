require("dotenv").config();

const { Client } = require("pg");
const { credentials } = require("./db");

async function getOrganizationId(dept) {
  const client = new Client(credentials);
  await client.connect();
  
  try {
    const query = `
      SELECT id FROM organization
      WHERE code ILIKE $1
      OR name ILIKE $1
      OR short_name ILIKE $1
      OR long_name ILIKE $1
      LIMIT 1
    `;
    const values = [`%${dept}%`];
    const res = await client.query(query, values);
    if (res.rows.length > 0) {
      return res.rows[0].id;
    } else {
      console.log('No matching department found, returning default id 128');
      return 128; // default to UN
    }
  } catch (error) {
    console.error('Error fetching or saving data:', error);
    return 128; // return default id in case of error
  } finally {
    await client.end();
  }
}

async function removeDuplicateJobVacancies() {
  console.log("===========================");
  console.log('Data cleaning started...');
  console.log("===========================");
  const client = new Client(credentials);
  await client.connect();

  try {
    const query = `
      DELETE FROM job_vacancies
      WHERE id IN (
        SELECT id FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY 
                job_id,
                language,
                category_code,
                job_title,
                job_code_title,
                job_description,
                job_family_code,
                job_level,
                duty_station,
                recruitment_type,
                start_date,
                end_date,
                dept,
                total_count,
                jn,
                jf,
                jc,
                jl,
                data_source,
                organization_id,
                apply_link
              ORDER BY id
            ) AS rn
          FROM job_vacancies
        ) t
        WHERE rn > 1
      );
    `;
    await client.query(query);
    console.log('Duplicate job vacancies removed successfully.');
    console.log("============================================");

  } catch (error) {
    console.error('Error removing duplicate job vacancies:', error);
  } finally {
    await client.end();
  }
}

/**
 * ETL Error Handling and Data Validation Utilities
 */

// Validate job data before database insertion
const validateJobData = (job, requiredFields = []) => {
  const errors = [];
  
  // Check for required fields
  requiredFields.forEach(field => {
    if (!job[field] || job[field] === undefined || job[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  });
  
  // Validate job_id (must be present and not empty)
  if (!job.job_id || job.job_id.toString().trim() === '') {
    errors.push('Invalid job_id: must be non-empty');
  }
  
  // Validate dates
  if (job.start_date && isNaN(new Date(job.start_date))) {
    errors.push('Invalid start_date format');
  }
  
  if (job.end_date && isNaN(new Date(job.end_date))) {
    errors.push('Invalid end_date format');
  }
  
  // Validate title length
  if (job.job_title && job.job_title.length > 500) {
    errors.push('Job title exceeds maximum length (500 characters)');
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors
  };
};

// Safe API call with retries and timeout
const safeApiCall = async (url, options = {}, retries = 3, timeout = 30000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return { success: true, data };
      
    } catch (error) {
      console.warn(`API call attempt ${attempt} failed for ${url}:`, error.message);
      
      if (attempt === retries) {
        return { 
          success: false, 
          error: `Failed after ${retries} attempts: ${error.message}` 
        };
      }
      
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
};

// ETL transaction wrapper with rollback capability
const executeETLWithTransaction = async (organizationName, etlFunction) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  let transaction;
  
  try {
    await client.connect();
    
    console.log(`🔄 Starting ETL for ${organizationName}...`);
    
    // Start transaction
    await client.query('BEGIN');
    transaction = true;
    
    // Store current data count for rollback reference
    const beforeCount = await client.query(
      'SELECT COUNT(*) as count FROM job_vacancies WHERE data_source = $1', 
      [organizationName.toLowerCase()]
    );
    
    console.log(`📊 ${organizationName}: Current jobs in DB: ${beforeCount.rows[0].count}`);
    
    // Execute the ETL function with the client
    const result = await etlFunction(client);
    
    if (result.success) {
      // Commit transaction
      await client.query('COMMIT');
      transaction = false;
      
      console.log(`✅ ${organizationName}: ETL completed successfully`);
      console.log(`📈 ${organizationName}: Processed ${result.processedCount} jobs, ${result.successCount} inserted, ${result.errorCount} errors`);
      
      // 🔄 Clear Redis cache after successful ETL to ensure fresh data
      try {
        const redisClient = require('../redisClient');
        const cacheKeys = await redisClient.keys('jobs:*');
        
        if (cacheKeys.length > 0) {
          await redisClient.del(cacheKeys);
          console.log(`🔄 ${organizationName}: Cleared ${cacheKeys.length} cached job entries from Redis`);
        }
      } catch (redisError) {
        console.warn(`⚠️  ${organizationName}: Could not clear Redis cache: ${redisError.message}`);
        // Don't fail the ETL if Redis clearing fails
      }
      
      return result;
    } else {
      throw new Error(result.error || 'ETL function returned failure');
    }
    
  } catch (error) {
    // Rollback transaction if it was started
    if (transaction) {
      try {
        await client.query('ROLLBACK');
        console.log(`🔄 ${organizationName}: Transaction rolled back due to error`);
      } catch (rollbackError) {
        console.error(`❌ ${organizationName}: Rollback failed:`, rollbackError);
      }
    }
    
    console.error(`❌ ${organizationName}: ETL failed:`, error.message);
    
    return {
      success: false,
      error: error.message,
      organizationName: organizationName
    };
  } finally {
    await client.end();
  }
};

// Process individual job with error handling
const processJobSafely = async (client, job, organizationName, processJobFunction) => {
  try {
    // Validate job data
    const validation = validateJobData(job, ['job_id', 'job_title']);
    
    if (!validation.isValid) {
      console.warn(`⚠️  ${organizationName}: Skipping invalid job - ${validation.errors.join(', ')}`);
      return { success: false, error: 'Validation failed', jobId: job.job_id || 'unknown' };
    }
    
    // Process the job
    const result = await processJobFunction(client, job);
    
    return { success: true, jobId: job.job_id };
    
  } catch (error) {
    console.warn(`⚠️  ${organizationName}: Failed to process job ${job.job_id || 'unknown'}:`, error.message);
    return { success: false, error: error.message, jobId: job.job_id || 'unknown' };
  }
};

// Check API health before starting ETL
const checkApiHealth = async (url, organizationName) => {
  console.log(`🔍 ${organizationName}: Checking API health...`);
  
  const healthCheck = await safeApiCall(url, {}, 1, 10000); // Single attempt with 10s timeout
  
  if (!healthCheck.success) {
    console.error(`❌ ${organizationName}: API health check failed - ${healthCheck.error}`);
    return false;
  }
  
  console.log(`✅ ${organizationName}: API is healthy`);
  return true;
};

// Smart upsert function to prevent duplicates during insertion
const upsertJobVacancy = async (client, jobData, organizationName) => {
  try {
    // Validate required fields
    const requiredFields = ['job_id', 'job_title', 'data_source'];
    const validation = validateJobData(jobData, requiredFields);
    if (!validation.isValid) {
      console.warn(`⚠️ ${organizationName}: Skipping invalid job - ${validation.errors.join(', ')}`);
      return { success: false, error: validation.errors.join(', ') };
    }

    // Use UPSERT with ON CONFLICT to prevent duplicates
    const upsertQuery = `
      INSERT INTO job_vacancies (
        job_id, language, category_code, job_title, job_code_title, job_description,
        job_family_code, job_level, duty_station, recruitment_type, start_date, end_date, 
        dept, total_count, jn, jf, jc, jl, created, data_source, organization_id, apply_link
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT (job_id, data_source, organization_id) 
      DO UPDATE SET
        language = EXCLUDED.language,
        category_code = EXCLUDED.category_code,
        job_title = EXCLUDED.job_title,
        job_code_title = EXCLUDED.job_code_title,
        job_description = EXCLUDED.job_description,
        job_family_code = EXCLUDED.job_family_code,
        job_level = EXCLUDED.job_level,
        duty_station = EXCLUDED.duty_station,
        recruitment_type = EXCLUDED.recruitment_type,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        dept = EXCLUDED.dept,
        total_count = EXCLUDED.total_count,
        jn = EXCLUDED.jn,
        jf = EXCLUDED.jf,
        jc = EXCLUDED.jc,
        jl = EXCLUDED.jl,
        apply_link = EXCLUDED.apply_link,
        created = NOW()
      RETURNING id, job_title, 
      CASE WHEN xmax = 0 THEN 'inserted' ELSE 'updated' END as action;
    `;

    const result = await client.query(upsertQuery, [
      jobData.job_id,
      jobData.language || 'EN',
      jobData.category_code || '',
      jobData.job_title,
      jobData.job_code_title || '',
      jobData.job_description || '',
      jobData.job_family_code || '',
      jobData.job_level || '',
      jobData.duty_station || '',
      jobData.recruitment_type || '',
      jobData.start_date,
      jobData.end_date,
      jobData.dept || '',
      jobData.total_count || null,
      jobData.jn || '',
      jobData.jf || '',
      jobData.jc || '',
      jobData.jl || '',
      new Date(),
      jobData.data_source,
      jobData.organization_id,
      jobData.apply_link || ''
    ]);

    return { 
      success: true, 
      jobTitle: result.rows[0].job_title,
      action: result.rows[0].action
    };

  } catch (error) {
    console.error(`❌ ${organizationName}: Database error for job "${jobData.job_title}":`, error.message);
    return { 
      success: false, 
      error: `Database error: ${error.message}`,
      jobTitle: jobData.job_title 
    };
  }
};

/**
 * ETL Status Tracking for Dashboard
 */

// Store ETL run status in database with enhanced tracking
const logETLStatus = async (organizationName, status, stats = {}) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Create table if it doesn't exist with enhanced fields
    await client.query(`
      CREATE TABLE IF NOT EXISTS etl_status (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'failed', 'starting', 'stopping', 'cancelled')),
        processed_count INTEGER DEFAULT 0 CHECK (processed_count >= 0),
        success_count INTEGER DEFAULT 0 CHECK (success_count >= 0),
        error_count INTEGER DEFAULT 0 CHECK (error_count >= 0),
        error_message TEXT,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        duration_seconds INTEGER CHECK (duration_seconds >= 0),
        jobs_in_db INTEGER DEFAULT 0 CHECK (jobs_in_db >= 0),
        current_step VARCHAR(100), -- Track current step of ETL process
        progress_percent INTEGER DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100),
        estimated_remaining_seconds INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        
        -- Enhanced constraints
        CONSTRAINT valid_counts CHECK (success_count + error_count <= processed_count),
        CONSTRAINT valid_time_range CHECK (end_time IS NULL OR end_time >= start_time)
      );
    `);

    // Add new columns if they don't exist (for existing databases)
    await client.query(`
      ALTER TABLE etl_status 
      ADD COLUMN IF NOT EXISTS current_step VARCHAR(100),
      ADD COLUMN IF NOT EXISTS progress_percent INTEGER DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100),
      ADD COLUMN IF NOT EXISTS estimated_remaining_seconds INTEGER;
    `);
    
    console.log(`📊 Logging ETL status for ${organizationName}: ${status}${stats.currentStep ? ` - ${stats.currentStep}` : ''}`);
    
    // Check if there's an existing 'running' record for this organization
    const checkQuery = `
      SELECT id FROM etl_status 
      WHERE organization_name = $1 
        AND status = 'running' 
        AND start_time > NOW() - INTERVAL '4 hours'
      ORDER BY start_time DESC 
      LIMIT 1;
    `;
    
    const checkResult = await client.query(checkQuery, [organizationName]);
    
    let result;
    
    if (checkResult.rows.length > 0 && (status === 'success' || status === 'failed')) {
      // Update existing 'running' record to completion status
      const updateQuery = `
        UPDATE etl_status 
        SET status = $1, processed_count = $2, success_count = $3, error_count = $4, 
            error_message = $5, end_time = $6, duration_seconds = $7, jobs_in_db = $8,
            current_step = $9, progress_percent = $10, estimated_remaining_seconds = $11
        WHERE id = $12
        RETURNING id;
      `;
      
      result = await client.query(updateQuery, [
        status,
        stats.processedCount || 0,
        stats.successCount || 0,
        stats.errorCount || 0,
        stats.errorMessage || null,
        stats.endTime || null,
        stats.durationSeconds || null,
        stats.jobsInDb || 0,
        stats.currentStep || null,
        status === 'success' ? 100 : (stats.progressPercent || 0),
        stats.estimatedRemainingSeconds || null,
        checkResult.rows[0].id
      ]);
      
      console.log(`📝 Updated existing ETL record for ${organizationName}: ${status}`);
    } else {
      // Insert new record for 'running' or when no existing record found
      const insertQuery = `
        INSERT INTO etl_status 
        (organization_name, status, processed_count, success_count, error_count, error_message, 
         start_time, end_time, duration_seconds, jobs_in_db, current_step, progress_percent, estimated_remaining_seconds)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id;
      `;
      
      result = await client.query(insertQuery, [
        organizationName,
        status,
        stats.processedCount || 0,
        stats.successCount || 0,
        stats.errorCount || 0,
        stats.errorMessage || null,
        stats.startTime || null,
        stats.endTime || null,
        stats.durationSeconds || null,
        stats.jobsInDb || 0,
        stats.currentStep || null,
        stats.progressPercent || 0,
        stats.estimatedRemainingSeconds || null
      ]);
      
      console.log(`📝 Created new ETL record for ${organizationName}: ${status}`);
    }
    
    return result.rows[0].id;
    
  } catch (error) {
    console.error(`Error logging ETL status for ${organizationName}:`, error);
    return null;
  } finally {
    await client.end();
  }
};

// Update ETL progress during execution
const updateETLProgress = async (organizationName, progressPercent, currentStep, estimatedRemainingSeconds = null) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    console.log(`📈 ${organizationName}: ${Math.round(progressPercent)}% - ${currentStep}`);
    
    // Update the latest running entry for this organization
    const query = `
      UPDATE etl_status 
      SET 
        progress_percent = $1,
        current_step = $2,
        estimated_remaining_seconds = $3,
        created_at = NOW()
      WHERE organization_name = $4 
        AND status = 'running'
        AND id = (
          SELECT id FROM etl_status 
          WHERE organization_name = $4 AND status = 'running'
          ORDER BY created_at DESC 
          LIMIT 1
        )
      RETURNING id;
    `;
    
    const result = await client.query(query, [
      Math.round(progressPercent),
      currentStep,
      estimatedRemainingSeconds,
      organizationName
    ]);
    
    return result.rows.length > 0 ? result.rows[0].id : null;
    
  } catch (error) {
    console.error(`Error updating ETL progress for ${organizationName}:`, error);
    return null;
  } finally {
    await client.end();
  }
};

// Force cleanup ALL running statuses (use with caution - for debugging stuck ETL locks)
const forceCleanupAllRunningStatuses = async () => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Force cleanup ALL running statuses
    const forceQuery = `
      UPDATE etl_status 
      SET 
        status = 'failed',
        end_time = NOW(),
        error_message = 'Force-cancelled to resolve ETL lock conflict',
        duration_seconds = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
      WHERE 
        status = 'running'
      RETURNING organization_name, start_time;
    `;
    
    const result = await client.query(forceQuery);
    
    if (result.rows.length > 0) {
      console.log(`🧹 Force-cleaned ${result.rows.length} running statuses:`);
      result.rows.forEach(row => {
        console.log(`   - ${row.organization_name} (started: ${row.start_time})`);
      });
    }
    
    return result.rows.length;
    
  } catch (error) {
    console.error("Error force-cleaning running statuses:", error);
    return 0;
  } finally {
    await client.end();
  }
};

// Clean up stale 'running' statuses (older than 2 hours)
const cleanupStaleRunningStatuses = async () => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Find stale running statuses (older than 2 hours without an end_time)
    const staleQuery = `
      UPDATE etl_status 
      SET 
        status = 'failed',
        end_time = NOW(),
        error_message = 'ETL process timed out or was interrupted',
        duration_seconds = EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER
      WHERE 
        status = 'running' 
        AND start_time < NOW() - INTERVAL '2 hours'
        AND end_time IS NULL
      RETURNING organization_name, start_time;
    `;
    
    const result = await client.query(staleQuery);
    
    if (result.rows.length > 0) {
      console.log(`🧹 Cleaned up ${result.rows.length} stale 'running' statuses:`);
      result.rows.forEach(row => {
        console.log(`   - ${row.organization_name} (started: ${row.start_time})`);
      });
    }
    
    return result.rows.length;
    
  } catch (error) {
    console.error('Error cleaning up stale running statuses:', error);
    return 0;
  } finally {
    await client.end();
  }
};

// ETL Mutex - Ensure only one organization runs ETL at a time
const acquireETLLock = async (organizationName) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Check if any other organization is currently running
    const runningQuery = `
      SELECT organization_name, start_time 
      FROM etl_status 
      WHERE status = 'running' 
        AND organization_name != $1
        AND start_time > NOW() - INTERVAL '4 hours'
      ORDER BY start_time DESC
      LIMIT 1;
    `;
    
    const runningResult = await client.query(runningQuery, [organizationName]);
    
    if (runningResult.rows.length > 0) {
      const runningOrg = runningResult.rows[0];
      const timeSinceStart = Math.round((new Date() - new Date(runningOrg.start_time)) / 1000 / 60);
      
      console.log(`⏳ ETL lock denied: ${runningOrg.organization_name} is currently running (started ${timeSinceStart} minutes ago)`);
      return { 
        acquired: false, 
        reason: `${runningOrg.organization_name} is currently running ETL`,
        runningSince: runningOrg.start_time
      };
    }
    
    // Check if this organization is already running
    const selfRunningQuery = `
      SELECT start_time 
      FROM etl_status 
      WHERE status = 'running' 
        AND organization_name = $1
        AND start_time > NOW() - INTERVAL '4 hours'
      ORDER BY start_time DESC
      LIMIT 1;
    `;
    
    const selfRunningResult = await client.query(selfRunningQuery, [organizationName]);
    
    if (selfRunningResult.rows.length > 0) {
      const timeSinceStart = Math.round((new Date() - new Date(selfRunningResult.rows[0].start_time)) / 1000 / 60);
      
      console.log(`⏳ ETL lock denied: ${organizationName} is already running (started ${timeSinceStart} minutes ago)`);
      return { 
        acquired: false, 
        reason: `${organizationName} is already running ETL`,
        runningSince: selfRunningResult.rows[0].start_time
      };
    }
    
    console.log(`🔒 ETL lock acquired for ${organizationName}`);
    return { acquired: true };
    
  } catch (error) {
    console.error(`Error acquiring ETL lock for ${organizationName}:`, error);
    return { 
      acquired: false, 
      reason: `Database error: ${error.message}` 
    };
  } finally {
    await client.end();
  }
};

// Release ETL lock (this happens automatically when status changes from 'running')
const releaseETLLock = async (organizationName) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Double-check: ensure any remaining 'running' status is cleaned up
    const cleanupQuery = `
      UPDATE etl_status 
      SET status = 'failed', end_time = NOW(), current_step = 'Force-cancelled after completion'
      WHERE organization_name = $1 
        AND status = 'running' 
        AND start_time > NOW() - INTERVAL '4 hours'
      RETURNING id;
    `;
    
    const result = await client.query(cleanupQuery, [organizationName]);
    
    if (result.rows.length > 0) {
      console.log(`🧹 Cleaned up ${result.rows.length} remaining 'running' status for ${organizationName}`);
    }
    
    console.log(`🔓 ETL lock released for ${organizationName}`);
    return true;
    
  } catch (error) {
    console.error(`Error releasing ETL lock for ${organizationName}:`, error);
    return false;
  } finally {
    await client.end();
  }
};

// Get current job count for organization
const getJobCount = async (organizationName) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    const result = await client.query(
      'SELECT COUNT(*) as count FROM job_vacancies WHERE data_source = $1',
      [organizationName.toLowerCase()]
    );
    return parseInt(result.rows[0].count);
  } catch (error) {
    console.error(`Error getting job count for ${organizationName}:`, error);
    return 0;
  } finally {
    await client.end();
  }
};

// Get latest ETL status for all organizations
const getLatestETLStatus = async () => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    const query = `
      WITH latest_runs AS (
        SELECT 
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
          created_at,
          ROW_NUMBER() OVER (PARTITION BY organization_name ORDER BY created_at DESC) as rn
        FROM etl_status
      )
      SELECT * FROM latest_runs WHERE rn = 1
      ORDER BY organization_name;
    `;
    
    const result = await client.query(query);
    return result.rows;
    
  } catch (error) {
    console.error('Error getting latest ETL status:', error);
    return [];
  } finally {
    await client.end();
  }
};

// Get ETL history for an organization
const getETLHistory = async (organizationName, limit = 10) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    const query = `
      SELECT * FROM etl_status 
      WHERE organization_name = $1 
      ORDER BY created_at DESC 
      LIMIT $2;
    `;
    
    const result = await client.query(query, [organizationName, limit]);
    return result.rows;
    
  } catch (error) {
    console.error(`Error getting ETL history for ${organizationName}:`, error);
    return [];
  } finally {
    await client.end();
  }
};

/**
 * Expired Job Cleanup - Remove jobs past their end_date
 */

// Cleanup expired jobs where end_date < NOW()
const cleanupExpiredAndDuplicateJobs = async (client = null, dryRun = false) => {
  let ownClient = false;
  
  // Use provided client or create new one
  if (!client) {
    client = new Client(credentials);
    await client.connect();
    ownClient = true;
  }

  console.log("\n🧹 ==========================================");
  console.log("📅 Expired Jobs & Duplicates Cleanup Started");
  console.log("============================================");

  const stats = {
    totalExpiredJobs: 0,
    totalDuplicateJobs: 0,
    deletedExpiredJobs: 0,
    deletedDuplicateJobs: 0,
    errorCount: 0,
    organizationBreakdown: {},
    startTime: new Date(),
    endTime: null,
    durationSeconds: 0
  };

  try {
    // Step 1: Check for duplicates (same-org and cross-org)
    console.log("🔍 Step 1: Checking for duplicate jobs...");
    console.log("   📋 Same-org logic: Same organization + title + start/end dates + location = duplicate");
    console.log("   📋 Cross-org logic: Same title + location + end date = duplicate (keep first posted)");
    
    // Check for same-organization duplicates (same title + dates + location within organization)
    const sameOrgQuery = `
      SELECT 
        data_source,
        COUNT(*) as duplicate_groups,
        SUM(duplicate_count - 1) as total_duplicates
      FROM (
        SELECT 
          data_source,
          job_title,
          start_date,
          end_date,
          duty_station,
          organization_id,
          COUNT(*) as duplicate_count
        FROM job_vacancies
        GROUP BY job_title, start_date, end_date, duty_station, data_source, organization_id
        HAVING COUNT(*) > 1
      ) duplicates
      GROUP BY data_source
      ORDER BY total_duplicates DESC
    `;
    
    // Check for cross-organization duplicates (same title + location + end_date)
    const crossOrgQuery = `
      SELECT 
        COUNT(*) as duplicate_groups,
        SUM(duplicate_count - 1) as total_duplicates
      FROM (
        SELECT 
          job_title,
          duty_station,
          end_date,
          COUNT(*) as duplicate_count
        FROM job_vacancies
        GROUP BY job_title, duty_station, end_date
        HAVING COUNT(*) > 1 AND COUNT(DISTINCT data_source) > 1
      ) duplicates
    `;
    
    const [sameOrgResult, crossOrgResult] = await Promise.all([
      client.query(sameOrgQuery),
      client.query(crossOrgQuery)
    ]);
    
    const sameOrgDuplicates = sameOrgResult.rows.reduce((sum, row) => sum + parseInt(row.total_duplicates), 0);
    const crossOrgDuplicates = parseInt(crossOrgResult.rows[0]?.total_duplicates || 0);
    
    stats.totalDuplicateJobs = sameOrgDuplicates + crossOrgDuplicates;
    
    if (stats.totalDuplicateJobs > 0) {
      console.log(`📊 Found ${stats.totalDuplicateJobs} duplicate jobs:`);
      
      if (sameOrgDuplicates > 0) {
        console.log(`   🏢 Same-organization duplicates: ${sameOrgDuplicates} jobs`);
        sameOrgResult.rows.forEach(row => {
          console.log(`   📁 ${row.data_source.toUpperCase()}: ${row.total_duplicates} duplicates in ${row.duplicate_groups} job groups`);
        });
      }
      
      if (crossOrgDuplicates > 0) {
        console.log(`   🌐 Cross-organization duplicates: ${crossOrgDuplicates} jobs`);
      }
      
      // Show examples of cross-org duplicates
      if (crossOrgDuplicates > 0) {
        const crossOrgExampleQuery = `
          SELECT 
            job_title,
            duty_station,
            end_date,
            COUNT(*) as duplicate_count,
            STRING_AGG(DISTINCT data_source, ', ') as organizations
          FROM job_vacancies
          GROUP BY job_title, duty_station, end_date
          HAVING COUNT(*) > 1 AND COUNT(DISTINCT data_source) > 1
          ORDER BY duplicate_count DESC
          LIMIT 3
        `;
        const crossOrgExampleResult = await client.query(crossOrgExampleQuery);
        console.log("   📝 Examples of cross-organization duplicates:");
        crossOrgExampleResult.rows.forEach(row => {
          const endDate = row.end_date ? row.end_date.toDateString() : 'No end date';
          console.log(`      🌐 "${row.job_title}" in ${row.duty_station} (ends: ${endDate})`);
          console.log(`         Posted by: ${row.organizations} (${row.duplicate_count} copies)`);
        });
      }
      
      // Show examples of same-org duplicates  
      if (sameOrgDuplicates > 0) {
        const sameOrgExampleQuery = `
          SELECT 
            job_title,
            start_date,
            end_date,
            duty_station,
            data_source,
            COUNT(*) as duplicate_count
          FROM job_vacancies
          GROUP BY job_title, start_date, end_date, duty_station, data_source, organization_id
          HAVING COUNT(*) > 1
          ORDER BY duplicate_count DESC
          LIMIT 2
        `;
        const sameOrgExampleResult = await client.query(sameOrgExampleQuery);
        if (sameOrgExampleResult.rows.length > 0) {
          console.log("   📝 Examples of same-organization duplicates:");
          sameOrgExampleResult.rows.forEach(row => {
            const startDate = row.start_date ? row.start_date.toDateString() : 'No start date';
            const endDate = row.end_date ? row.end_date.toDateString() : 'No end date';
            console.log(`      🔄 ${row.data_source}: "${row.job_title}" in ${row.duty_station} (${startDate} to ${endDate}) - ${row.duplicate_count} copies`);
          });
        }
      }
    } else {
      console.log("✅ No duplicate jobs found");
    }

    // Step 2: Check for expired jobs
    console.log("\n🔍 Step 2: Checking for expired jobs...");
    const expiredJobsQuery = `
      SELECT 
        data_source,
        COUNT(*) as expired_count,
        MIN(end_date) as oldest_expired,
        MAX(end_date) as newest_expired
      FROM job_vacancies 
      WHERE end_date < NOW()
      GROUP BY data_source
      ORDER BY expired_count DESC
    `;
    
    const expiredResult = await client.query(expiredJobsQuery);
    stats.organizationBreakdown = expiredResult.rows.reduce((acc, row) => {
      acc[row.data_source] = {
        expiredCount: parseInt(row.expired_count),
        oldestExpired: row.oldest_expired,
        newestExpired: row.newest_expired
      };
      return acc;
    }, {});

    // Calculate total expired jobs
    stats.totalExpiredJobs = expiredResult.rows.reduce((sum, row) => sum + parseInt(row.expired_count), 0);

    if (stats.totalExpiredJobs > 0) {
      console.log(`📊 Found ${stats.totalExpiredJobs} expired jobs across ${expiredResult.rows.length} organizations:`);
      expiredResult.rows.forEach(row => {
        console.log(`   📁 ${row.data_source.toUpperCase()}: ${row.expired_count} jobs (oldest: ${row.oldest_expired})`);
      });
    } else {
      console.log("✅ No expired jobs found");
    }
    
    if (stats.totalExpiredJobs === 0 && stats.totalDuplicateJobs === 0) {
      console.log("\n✅ Database is clean - no expired jobs or duplicates found!");
      stats.endTime = new Date();
      stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);
      return stats;
    }

    if (dryRun) {
      console.log("\n🔍 DRY RUN MODE - No jobs will be deleted");
      console.log(`   Would delete: ${stats.totalExpiredJobs} expired jobs + ${stats.totalDuplicateJobs} duplicates`);
      stats.endTime = new Date();
      stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);
      return stats;
    }

    console.log("\n🗑️  Starting cleanup process...");

    // Step 3: Remove duplicate jobs (keep the earliest posted)
    if (stats.totalDuplicateJobs > 0) {
      console.log("🗑️  Removing duplicate jobs...");
      
      let totalDeleted = 0;
      const deletedSamples = [];
      
      // First: Remove cross-organization duplicates (keep earliest posted)
      if (crossOrgDuplicates > 0) {
        console.log("   🌐 Removing cross-organization duplicates (keeping first posted)...");
        const deleteCrossOrgQuery = `
          DELETE FROM job_vacancies
          WHERE id IN (
            SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                         PARTITION BY job_title, duty_station, end_date
                         ORDER BY created ASC, id ASC
                     ) AS rn
              FROM job_vacancies
            ) t
            WHERE rn > 1
          )
          RETURNING data_source, job_id, job_title, duty_station, end_date, created
        `;
        
        const deleteCrossOrgResult = await client.query(deleteCrossOrgQuery);
        totalDeleted += deleteCrossOrgResult.rowCount;
        deletedSamples.push(...deleteCrossOrgResult.rows);
        
        console.log(`   ✅ Removed ${deleteCrossOrgResult.rowCount} cross-organization duplicates`);
      }
      
      // Second: Remove same-organization duplicates (keep most recent)
      if (sameOrgDuplicates > 0) {
        console.log("   🏢 Removing same-organization duplicates (keeping most recent)...");
        const deleteSameOrgQuery = `
          DELETE FROM job_vacancies
          WHERE id IN (
            SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                         PARTITION BY job_title, start_date, end_date, duty_station, data_source, organization_id 
                         ORDER BY created DESC, id DESC
                     ) AS rn
              FROM job_vacancies
            ) t
            WHERE rn > 1
          )
          RETURNING data_source, job_id, job_title, start_date, end_date, duty_station, created
        `;
        
        const deleteSameOrgResult = await client.query(deleteSameOrgQuery);
        totalDeleted += deleteSameOrgResult.rowCount;
        deletedSamples.push(...deleteSameOrgResult.rows);
        
        console.log(`   ✅ Removed ${deleteSameOrgResult.rowCount} same-organization duplicates`);
      }
      
      stats.deletedDuplicateJobs = totalDeleted;
      console.log(`✅ Total removed: ${totalDeleted} duplicate jobs`);
      
      if (deletedSamples.length > 0) {
        console.log("📝 Sample deleted duplicates:");
        deletedSamples.slice(0, 5).forEach(job => {
          const startDate = job.start_date ? job.start_date.toDateString() : 'No start date';
          const endDate = job.end_date ? job.end_date.toDateString() : 'No end date';
          console.log(`   🗑️  ${job.data_source.toUpperCase()}: "${job.job_title}" in ${job.duty_station} (${startDate} to ${endDate})`);
        });
        if (deletedSamples.length > 5) {
          console.log(`   ... and ${deletedSamples.length - 5} more duplicates`);
        }
      }
    }

    // Step 4: Remove expired jobs

    if (stats.totalExpiredJobs > 0) {
      console.log("🗑️  Removing expired jobs...");
      const deleteExpiredQuery = `
        DELETE FROM job_vacancies 
        WHERE end_date < NOW()
        RETURNING data_source, job_id, job_title, end_date
      `;

      const deleteExpiredResult = await client.query(deleteExpiredQuery);
      stats.deletedExpiredJobs = deleteExpiredResult.rowCount;
      
      console.log(`✅ Removed ${stats.deletedExpiredJobs} expired jobs`);
      
      // Log some examples of deleted jobs
      if (deleteExpiredResult.rows.length > 0) {
        console.log("📝 Sample deleted expired jobs:");
        deleteExpiredResult.rows.slice(0, 3).forEach(job => {
          console.log(`   🗑️  ${job.data_source.toUpperCase()}: "${job.job_title}" (expired: ${job.end_date.toDateString()})`);
        });
        
        if (deleteExpiredResult.rows.length > 3) {
          console.log(`   ... and ${deleteExpiredResult.rows.length - 3} more expired jobs`);
        }
      }
    }

    // 🔄 Clear Redis cache after cleanup
    const deletedJobsCount = stats.deletedExpiredJobs + stats.deletedDuplicateJobs;
    if (deletedJobsCount > 0) {
      try {
        const redisClient = require('../redisClient');
        
        // Get all job-related cache keys
        const cacheKeys = await redisClient.keys('jobs:*');
        
        if (cacheKeys.length > 0) {
          // Delete all job-related cache keys
          await redisClient.del(cacheKeys);
          console.log(`🔄 Cleared ${cacheKeys.length} cached job entries from Redis`);
        }
      } catch (redisError) {
        console.warn(`⚠️  Could not clear Redis cache: ${redisError.message}`);
        // Don't fail the cleanup if Redis clearing fails
      }
    }

    stats.endTime = new Date();
    stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);

    const totalDeleted = stats.deletedExpiredJobs + stats.deletedDuplicateJobs;
    const totalFound = stats.totalExpiredJobs + stats.totalDuplicateJobs;

    console.log("\n✅ ==========================================");
    console.log("📅 Database Cleanup Completed Successfully");
    console.log(`🗑️  Total Deleted: ${totalDeleted} jobs`);
    console.log(`   📅 Expired: ${stats.deletedExpiredJobs} jobs`);
    console.log(`   🔄 Duplicates: ${stats.deletedDuplicateJobs} jobs`);
    console.log(`⏱️  Duration: ${stats.durationSeconds}s`);
    console.log("============================================");

    // Log cleanup activity to ETL status table
    await logETLStatus('database_cleanup', 'success', {
      processedCount: totalFound,
      successCount: totalDeleted,
      errorCount: stats.errorCount,
      startTime: stats.startTime,
      endTime: stats.endTime,
      durationSeconds: stats.durationSeconds,
      jobsInDb: 0 // This represents jobs removed
    });

    return stats;

  } catch (error) {
    stats.errorCount++;
    stats.endTime = new Date();
    stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);

    console.error("❌ ==========================================");
    console.error("📅 Database Cleanup Failed");
    console.error(`❌ Error: ${error.message}`);
    console.error("=============================================");

    // Log failed cleanup
    const totalFound = stats.totalExpiredJobs + stats.totalDuplicateJobs;
    await logETLStatus('database_cleanup', 'failed', {
      processedCount: totalFound,
      successCount: 0,
      errorCount: stats.errorCount,
      errorMessage: error.message,
      startTime: stats.startTime,
      endTime: stats.endTime,
      durationSeconds: stats.durationSeconds
    });

    throw error;
  } finally {
    if (ownClient) {
      await client.end();
    }
  }
};

// Backward compatibility wrapper for the old function name
const cleanupExpiredJobs = async (client = null, dryRun = false) => {
  return await cleanupExpiredAndDuplicateJobs(client, dryRun);
};

// Get statistics about jobs approaching expiration (within next N days)
const getJobsExpiringSoon = async (daysAhead = 7) => {
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    const query = `
      SELECT 
        data_source,
        COUNT(*) as expiring_count,
        MIN(end_date) as soonest_expiry,
        MAX(end_date) as latest_expiry
      FROM job_vacancies 
      WHERE end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${daysAhead} days'
      GROUP BY data_source
      ORDER BY expiring_count DESC
    `;
    
    const result = await client.query(query);
    const totalExpiring = result.rows.reduce((sum, row) => sum + parseInt(row.expiring_count), 0);
    
    return {
      totalExpiring,
      daysAhead,
      organizationBreakdown: result.rows
    };
    
  } catch (error) {
    console.error('Error getting jobs expiring soon:', error);
    return { totalExpiring: 0, daysAhead, organizationBreakdown: [] };
  } finally {
    await client.end();
  }
};

// Enhanced ETL execution wrapper with progress tracking
const executeETLWithProgressTracking = async (organizationName, etlFunction) => {
  const startTime = new Date();
  
  try {
    // Check and acquire ETL lock
    const lockResult = await acquireETLLock(organizationName);
    if (!lockResult.acquired) {
      console.log(`⏳ ${organizationName}: ETL lock denied - ${lockResult.reason}`);
      return {
        success: false,
        error: `ETL already running: ${lockResult.reason}`,
        organizationName: organizationName
      };
    }

    console.log(`🚀 Starting enhanced ETL for ${organizationName}...`);
    
    // Log starting status
    await logETLStatus(organizationName, 'starting', {
      startTime: startTime,
      currentStep: 'Initializing ETL process...',
      progressPercent: 0
    });

    // Update to running status
    await logETLStatus(organizationName, 'running', {
      startTime: startTime,
      currentStep: 'Starting data collection...',
      progressPercent: 5
    });

    // Execute the ETL function with progress updates
    const result = await etlFunction({
      updateProgress: async (percent, step, estimatedRemaining = null) => {
        await updateETLProgress(organizationName, percent, step, estimatedRemaining);
      },
      organizationName: organizationName
    });

    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    if (result.success) {
      // Log success status
      await logETLStatus(organizationName, 'success', {
        startTime: startTime,
        endTime: endTime,
        durationSeconds: durationSeconds,
        processedCount: result.processedCount || 0,
        successCount: result.successCount || 0,
        errorCount: result.errorCount || 0,
        jobsInDb: result.jobsInDb || 0,
        currentStep: 'ETL completed successfully',
        progressPercent: 100
      });

      console.log(`✅ ${organizationName}: Enhanced ETL completed successfully in ${durationSeconds}s`);
      console.log(`📈 ${organizationName}: Processed ${result.processedCount} jobs, ${result.successCount} inserted, ${result.errorCount} errors`);
      
      return result;
    } else {
      throw new Error(result.error || 'ETL function returned failure');
    }
    
  } catch (error) {
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);
    
    // Log failed status
    await logETLStatus(organizationName, 'failed', {
      startTime: startTime,
      endTime: endTime,
      durationSeconds: durationSeconds,
      errorMessage: error.message,
      currentStep: 'ETL process failed',
      progressPercent: 0
    });
    
    console.error(`❌ ${organizationName}: Enhanced ETL failed after ${durationSeconds}s:`, error.message);
    
    return {
      success: false,
      error: error.message,
      organizationName: organizationName
    };
  } finally {
    await releaseETLLock(organizationName);
  }
};

// Puppeteer configuration for Docker-friendly browser launching
const getPuppeteerConfig = () => {
  const config = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080'
    ]
  };

  // If running in Docker, try to use the installed Chrome
  if (process.env.DOCKER_ENV || process.env.NODE_ENV === 'production') {
    try {
      // Try to use system Chrome first (installed via apt)
      config.executablePath = '/usr/bin/google-chrome-stable';
    } catch (error) {
      console.log('⚠️ System Chrome not found, falling back to bundled Chromium');
      // Puppeteer will use its bundled Chromium
    }
  }

  return config;
};

module.exports = {
  getOrganizationId,
  removeDuplicateJobVacancies,
  validateJobData,
  safeApiCall,
  executeETLWithTransaction,
  executeETLWithProgressTracking,
  processJobSafely,
  checkApiHealth,
  upsertJobVacancy,
  logETLStatus,
  updateETLProgress,
  getJobCount,
  getLatestETLStatus,
  getETLHistory,
  cleanupExpiredJobs,
  cleanupExpiredAndDuplicateJobs,
  getJobsExpiringSoon,
  cleanupStaleRunningStatuses,
  forceCleanupAllRunningStatuses,
  acquireETLLock,
  releaseETLLock,
  getPuppeteerConfig,
};