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

// Store ETL run status in database
const logETLStatus = async (organizationName, status, stats = {}) => {
  const { Client } = require('pg');
  const { credentials } = require("./db");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Create table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS etl_status (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL, -- 'running', 'success', 'failed'
        processed_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        error_message TEXT,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        duration_seconds INTEGER,
        jobs_in_db INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    // Insert or update status
    const query = `
      INSERT INTO etl_status 
      (organization_name, status, processed_count, success_count, error_count, error_message, 
       start_time, end_time, duration_seconds, jobs_in_db)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id;
    `;
    
    const result = await client.query(query, [
      organizationName,
      status,
      stats.processedCount || 0,
      stats.successCount || 0,
      stats.errorCount || 0,
      stats.errorMessage || null,
      stats.startTime || null,
      stats.endTime || null,
      stats.durationSeconds || null,
      stats.jobsInDb || 0
    ]);
    
    return result.rows[0].id;
    
  } catch (error) {
    console.error(`Error logging ETL status for ${organizationName}:`, error);
    return null;
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
const cleanupExpiredJobs = async (client = null, dryRun = false) => {
  let ownClient = false;
  
  // Use provided client or create new one
  if (!client) {
    client = new Client(credentials);
    await client.connect();
    ownClient = true;
  }

  console.log("\n🧹 ==========================================");
  console.log("📅 Expired Job Cleanup Started");
  console.log("============================================");

  const stats = {
    totalExpiredJobs: 0,
    deletedJobs: 0,
    errorCount: 0,
    organizationBreakdown: {},
    startTime: new Date(),
    endTime: null,
    durationSeconds: 0
  };

  try {
    // First, get a count and breakdown of expired jobs
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
        count: parseInt(row.expired_count),
        oldestExpired: row.oldest_expired,
        newestExpired: row.newest_expired
      };
      return acc;
    }, {});

    // Calculate total expired jobs
    stats.totalExpiredJobs = expiredResult.rows.reduce((sum, row) => sum + parseInt(row.expired_count), 0);

    console.log(`📊 Found ${stats.totalExpiredJobs} expired jobs across ${expiredResult.rows.length} organizations:`);
    
    if (stats.totalExpiredJobs === 0) {
      console.log("✅ No expired jobs found - database is clean!");
      stats.endTime = new Date();
      stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);
      return stats;
    }

    // Show breakdown by organization
    expiredResult.rows.forEach(row => {
      console.log(`   📁 ${row.data_source.toUpperCase()}: ${row.expired_count} jobs (oldest: ${row.oldest_expired})`);
    });

    if (dryRun) {
      console.log("\n🔍 DRY RUN MODE - No jobs will be deleted");
      stats.endTime = new Date();
      stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);
      return stats;
    }

    console.log("\n🗑️  Starting deletion of expired jobs...");

    // Delete expired jobs with proper error handling
    const deleteQuery = `
      DELETE FROM job_vacancies 
      WHERE end_date < NOW()
      RETURNING data_source, job_id, job_title, end_date
    `;

    const deleteResult = await client.query(deleteQuery);
    stats.deletedJobs = deleteResult.rowCount;

    // 🔄 Clear Redis cache after deleting expired jobs
    if (stats.deletedJobs > 0) {
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

    // Log some examples of deleted jobs
    if (deleteResult.rows.length > 0) {
      console.log("\n📝 Sample deleted jobs:");
      deleteResult.rows.slice(0, 5).forEach(job => {
        console.log(`   🗑️  ${job.data_source.toUpperCase()}: "${job.job_title}" (expired: ${job.end_date.toDateString()})`);
      });
      
      if (deleteResult.rows.length > 5) {
        console.log(`   ... and ${deleteResult.rows.length - 5} more jobs`);
      }
    }

    stats.endTime = new Date();
    stats.durationSeconds = Math.round((stats.endTime - stats.startTime) / 1000);

    console.log("\n✅ =========================================");
    console.log("📅 Expired Job Cleanup Completed Successfully");
    console.log(`🗑️  Deleted: ${stats.deletedJobs} expired jobs`);
    console.log(`⏱️  Duration: ${stats.durationSeconds}s`);
    console.log("=============================================");

    // Log cleanup activity to ETL status table
    await logETLStatus('expired_cleanup', 'success', {
      processedCount: stats.totalExpiredJobs,
      successCount: stats.deletedJobs,
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
    console.error("📅 Expired Job Cleanup Failed");
    console.error(`❌ Error: ${error.message}`);
    console.error("=============================================");

    // Log failed cleanup
    await logETLStatus('expired_cleanup', 'failed', {
      processedCount: stats.totalExpiredJobs,
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

module.exports = {
  getOrganizationId,
  removeDuplicateJobVacancies,
  validateJobData,
  safeApiCall,
  executeETLWithTransaction,
  processJobSafely,
  checkApiHealth,
  upsertJobVacancy,
  logETLStatus,
  getJobCount,
  getLatestETLStatus,
  getETLHistory,
  cleanupExpiredJobs,
  getJobsExpiringSoon,
};