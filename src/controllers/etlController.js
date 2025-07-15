const { Pool } = require("pg");
const { credentials } = require("../util/db");
const { getLatestETLStatus, getETLHistory } = require("../etl/shared");

const pool = new Pool(credentials);

// Helper function for consistent API responses
const sendResponse = (res, status, success, data = null, message = null, error = null) => {
  res.status(status).json({
    success,
    timestamp: new Date(),
    ...(message && { message }),
    ...(error && { error }),
    ...(data && { data })
  });
};

// Helper function for database error handling
const handleDatabaseError = (error, res, operation) => {
  console.error(`Database error during ${operation}:`, error);
  
  if (error.code === '23505') { // Unique violation
    return sendResponse(res, 409, false, null, 'Duplicate entry detected', 'DUPLICATE_ENTRY');
  }
  
  if (error.code === '23503') { // Foreign key violation
    return sendResponse(res, 400, false, null, 'Referenced record not found', 'FOREIGN_KEY_ERROR');
  }
  
  if (error.code === '23514') { // Check constraint violation
    return sendResponse(res, 400, false, null, 'Data validation failed', 'CONSTRAINT_VIOLATION');
  }
  
  return sendResponse(res, 500, false, null, `Error during ${operation}`, 'DATABASE_ERROR');
};

// Input validation functions
const validatePaginationParams = (page, size) => {
  const pageNum = parseInt(page) || 1;
  const sizeNum = parseInt(size) || 10;
  
  if (pageNum < 1 || pageNum > 1000) {
    throw new Error('Page must be between 1 and 1000');
  }
  
  if (sizeNum < 1 || sizeNum > 100) {
    throw new Error('Size must be between 1 and 100');
  }
  
  return { page: pageNum, size: sizeNum };
};

const validateDaysParam = (days) => {
  const daysNum = parseInt(days) || 7;
  
  if (daysNum < 1 || daysNum > 365) {
    throw new Error('Days must be between 1 and 365');
  }
  
  return daysNum;
};

// Get overall ETL dashboard data with optimized queries
module.exports.getDashboard = async (req, res) => {
  try {
    // Use the optimized database function
    const statsResult = await pool.query('SELECT * FROM get_etl_statistics($1)', [7]);
    const stats = statsResult.rows[0] || {
      total_organizations: 0,
      successful_orgs: 0,
      failed_orgs: 0,
      total_jobs: 0,
      avg_duration: 0,
      last_run_time: null
    };
    
    // Get latest status using the optimized view
    const latestResult = await pool.query(`
      SELECT * FROM latest_etl_status 
      ORDER BY organization_name;
    `);
    
    // Get recent activity with limit
    const recentResult = await pool.query(`
      SELECT organization_name, status, created_at, duration_seconds, jobs_in_db
      FROM etl_status 
      ORDER BY created_at DESC 
      LIMIT 10;
    `);
    
    const dashboardData = {
      organizations: latestResult.rows,
      statistics: {
        totalOrganizations: parseInt(stats.total_organizations) || 0,
        successfulOrgs: parseInt(stats.successful_orgs) || 0,
        failedOrgs: parseInt(stats.failed_orgs) || 0,
        totalJobs: parseInt(stats.total_jobs) || 0,
        avgDuration: parseFloat(stats.avg_duration) || 0,
        lastRunTime: stats.last_run_time
      },
      recentActivity: recentResult.rows
    };
    
    sendResponse(res, 200, true, dashboardData);
    
  } catch (error) {
    handleDatabaseError(error, res, 'dashboard data retrieval');
  }
};

// Get status for all organizations with pagination
module.exports.getAllStatus = async (req, res) => {
  try {
    const { page, size } = validatePaginationParams(req.query.page, req.query.size);
    const offset = (page - 1) * size;
    
    const query = `
      SELECT * FROM latest_etl_status 
      ORDER BY organization_name
      LIMIT $1 OFFSET $2;
    `;
    
    const countQuery = `
      SELECT COUNT(*) as total FROM latest_etl_status;
    `;
    
    const [statusResult, countResult] = await Promise.all([
      pool.query(query, [size, offset]),
      pool.query(countQuery)
    ]);
    
    const totalRecords = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalRecords / size);
    
    sendResponse(res, 200, true, {
      organizations: statusResult.rows,
      pagination: {
        page,
        size,
        totalRecords,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
    
  } catch (error) {
    if (error.message.includes('must be between')) {
      return sendResponse(res, 400, false, null, error.message, 'VALIDATION_ERROR');
    }
    handleDatabaseError(error, res, 'status retrieval');
  }
};

// Get history for a specific organization with validation
module.exports.getOrganizationHistory = async (req, res) => {
  try {
    const { organizationName } = req.params;
    const { page, size } = validatePaginationParams(req.query.page, req.query.size);
    const offset = (page - 1) * size;
    
    // Validate organization name
    if (!organizationName || organizationName.length > 50) {
      return sendResponse(res, 400, false, null, 'Invalid organization name', 'INVALID_ORG_NAME');
    }
    
    const orgNameUpper = organizationName.toUpperCase();
    
    const query = `
      SELECT * FROM etl_status 
      WHERE organization_name = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3;
    `;
    
    const countQuery = `
      SELECT COUNT(*) as total FROM etl_status 
      WHERE organization_name = $1;
    `;
    
    const [historyResult, countResult] = await Promise.all([
      pool.query(query, [orgNameUpper, size, offset]),
      pool.query(countQuery, [orgNameUpper])
    ]);
    
    const totalRecords = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalRecords / size);
    
    if (historyResult.rows.length === 0 && page === 1) {
      return sendResponse(res, 404, false, null, 'Organization not found or no history available', 'ORG_NOT_FOUND');
    }
    
    sendResponse(res, 200, true, {
      organization: orgNameUpper,
      history: historyResult.rows,
      pagination: {
        page,
        size,
        totalRecords,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
    
  } catch (error) {
    if (error.message.includes('must be between')) {
      return sendResponse(res, 400, false, null, error.message, 'VALIDATION_ERROR');
    }
    handleDatabaseError(error, res, 'organization history retrieval');
  }
};

// Get ETL statistics and analytics with performance optimization
module.exports.getStatistics = async (req, res) => {
  try {
    const days = validateDaysParam(req.query.days);
    
    // Use optimized database function
    const [dailyStatsResult, orgStatsResult] = await Promise.all([
      pool.query(`
        WITH daily_stats AS (
          SELECT 
            DATE(created_at) as run_date,
            COUNT(DISTINCT organization_name) as organizations_run,
            COUNT(*) as total_runs,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_runs,
            AVG(jobs_in_db) as avg_jobs_per_org,
            AVG(duration_seconds) as avg_duration
          FROM etl_status 
          WHERE created_at >= NOW() - INTERVAL '1 day' * $1
          GROUP BY DATE(created_at)
        )
        SELECT * FROM daily_stats
        ORDER BY run_date DESC;
      `, [days]),
      
      pool.query('SELECT * FROM get_org_performance(NULL, $1)', [days])
    ]);
    
    sendResponse(res, 200, true, {
      dailyStats: dailyStatsResult.rows,
      organizationStats: orgStatsResult.rows,
      period: `${days} days`,
      generatedAt: new Date()
    });
    
  } catch (error) {
    if (error.message.includes('must be between')) {
      return sendResponse(res, 400, false, null, error.message, 'VALIDATION_ERROR');
    }
    handleDatabaseError(error, res, 'statistics retrieval');
  }
};

// Get health check for ETL system with detailed organization status
module.exports.getHealthCheck = async (req, res) => {
  try {
    // Get summary statistics
    const summaryQuery = `
      SELECT 
        COUNT(*) as total_organizations,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as recent_runs,
        COUNT(CASE WHEN status = 'running' THEN 1 END) as currently_running,
        MAX(created_at) as last_activity
      FROM latest_etl_status;
    `;
    
    // Get detailed organization status including duration and job counts
    const organizationsQuery = `
      SELECT 
        organization_name,
        status,
        start_time,
        end_time,
        duration_seconds,
        jobs_in_db,
        processed_count,
        success_count,
        error_count,
        error_message,
        created_at,
        CASE 
          WHEN created_at >= NOW() - INTERVAL '6 hours' THEN 'recent'
          WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 'today'
          ELSE 'older'
        END as recency
      FROM latest_etl_status
      ORDER BY organization_name;
    `;
    
    const [summaryResult, orgsResult] = await Promise.all([
      pool.query(summaryQuery),
      pool.query(organizationsQuery)
    ]);
    
    const health = summaryResult.rows[0];
    const organizations = orgsResult.rows;
    
    // Calculate statistics
    const stats = {
      totalOrganizations: parseInt(health.total_organizations) || 0,
      recentRuns: parseInt(health.recent_runs) || 0,
      currentlyRunning: parseInt(health.currently_running) || 0,
      successfulOrgs: organizations.filter(org => org.status === 'success').length,
      failedOrgs: organizations.filter(org => org.status === 'failed').length,
      idleOrgs: organizations.filter(org => org.status !== 'running' && org.status !== 'success' && org.status !== 'failed').length,
      totalJobs: organizations.reduce((sum, org) => sum + (parseInt(org.jobs_in_db) || 0), 0),
      avgDuration: organizations.length > 0 ? 
        Math.round(organizations.reduce((sum, org) => sum + (org.duration_seconds || 0), 0) / organizations.length) : 0
    };
    
    const isHealthy = stats.totalOrganizations > 0 && stats.recentRuns > 0;
    const systemStatus = isHealthy ? 'healthy' : 'degraded';
    
    // Format organizations data for dashboard
    const formattedOrgs = organizations.map(org => ({
      name: org.organization_name,
      status: org.status || 'idle',
      lastRun: org.created_at ? formatLastRun(org.created_at) : 'Never',
      jobsProcessed: parseInt(org.jobs_in_db) || 0,
      duration: org.duration_seconds || null,
      processedCount: parseInt(org.processed_count) || 0,
      successCount: parseInt(org.success_count) || 0,
      errorCount: parseInt(org.error_count) || 0,
      errorMessage: org.error_message,
      recency: org.recency,
      startTime: org.start_time,
      endTime: org.end_time
    }));
    
    sendResponse(res, isHealthy ? 200 : 503, true, {
      status: systemStatus,
      statistics: stats,
      organizations: formattedOrgs,
      systemHealth: {
        status: systemStatus,
        uptime: Math.round(process.uptime()),
        lastActivity: health.last_activity,
        timestamp: new Date()
      }
    });
    
  } catch (error) {
    console.error('Health check error:', error);
    handleDatabaseError(error, res, 'health check');
  }
};

// Helper function to format last run time
function formatLastRun(timestamp) {
  if (!timestamp) return 'Never';
  
  const now = new Date();
  const lastRun = new Date(timestamp);
  const diffMs = now - lastRun;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 7) return `${diffDays} days ago`;
  
  return lastRun.toLocaleDateString();
}

// Trigger manual ETL run (placeholder for future implementation)
module.exports.triggerETL = async (req, res) => {
  try {
    const { organizationName } = req.body;
    
    // Validate input
    if (organizationName && (typeof organizationName !== 'string' || organizationName.length > 50)) {
      return sendResponse(res, 400, false, null, 'Invalid organization name', 'INVALID_INPUT');
    }
    
    // Log the trigger request
    console.log(`ETL trigger requested by user ${req.user?.id || 'anonymous'} for ${organizationName || 'all organizations'}`);
    
    if (organizationName) {
      sendResponse(res, 202, true, null, `ETL trigger queued for ${organizationName}`, null);
    } else {
      sendResponse(res, 202, true, null, "Full ETL trigger queued", null);
    }
    
  } catch (error) {
    sendResponse(res, 500, false, null, 'Error processing ETL trigger request', 'TRIGGER_ERROR');
  }
};

// Clear Redis cache for job data
module.exports.clearCache = async (req, res) => {
  try {
    console.log(`Cache clear requested by user ${req.user?.id || 'anonymous'}`);
    
    const redisClient = require('../redisClient');
    
    // Get all job-related cache keys
    const cacheKeys = await redisClient.keys('jobs:*');
    
    if (cacheKeys.length === 0) {
      return sendResponse(res, 200, true, { 
        clearedKeys: 0, 
        message: 'No cached entries found' 
      }, 'Cache is already clean');
    }
    
    // Delete all job-related cache keys
    const clearedCount = await redisClient.del(cacheKeys);
    
    console.log(`✅ Cleared ${clearedCount} job cache entries`);
    
    sendResponse(res, 200, true, { 
      clearedKeys: clearedCount,
      keys: cacheKeys,
      message: 'Cache cleared successfully'
    }, `Cleared ${clearedCount} cached job entries`);
    
  } catch (error) {
    console.error('Error clearing cache:', error);
    
    if (error.message.includes('ECONNREFUSED')) {
      return sendResponse(res, 503, false, null, 'Redis server unavailable', 'REDIS_ERROR');
    }
    
    sendResponse(res, 500, false, null, 'Error clearing cache', 'CACHE_CLEAR_ERROR');
  }
};

// Fix database schema issues (latest_etl_status view)
const fixDatabaseSchema = async (req, res) => {
  try {
    console.log('🔧 Attempting to fix database schema...');
    
    // Check if etl_status table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'etl_status'
      );
    `);
    
    let tablesCreated = 0;
    let viewsCreated = 0;
    
    if (!tableCheck.rows[0].exists) {
      console.log("⚠️  etl_status table doesn't exist. Creating it...");
      
      // Create the etl_status table
      await pool.query(`
        CREATE TABLE etl_status (
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
      `);
      
      tablesCreated++;
      console.log("✅ Created etl_status table");
      
      // After creating the table, create the view
      await pool.query(`
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
      `);
      
      viewsCreated++;
      console.log("✅ Created latest_etl_status view");
    } else {
      console.log("✅ etl_status table exists");
      
      // Table exists, just create/replace the view
      await pool.query(`
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
      `);
      
      viewsCreated++;
      console.log("✅ Created/updated latest_etl_status view");
    }
    
    // Create performance indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_etl_status_org_created 
      ON etl_status(organization_name, created_at DESC);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_etl_status_created 
      ON etl_status(created_at DESC);
    `);
    
    // Test the view
    const testResult = await pool.query("SELECT COUNT(*) FROM latest_etl_status");
    const recordCount = parseInt(testResult.rows[0].count);
    
    console.log("🎉 Database schema fix completed successfully!");
    
    sendResponse(res, 200, true, {
      tablesCreated,
      viewsCreated,
      recordCount,
      message: 'Database schema fix completed'
    }, 'Database schema has been fixed successfully');
    
  } catch (error) {
    console.error('❌ Error fixing database schema:', error);
    sendResponse(res, 500, false, null, 'Error fixing database schema', error.message);
  }
};

module.exports.fixDatabaseSchema = fixDatabaseSchema;

// LinkedIn ETL Testing and Manual Triggers
const testLinkedInETL = async (req, res) => {
  try {
    console.log('🔧 Testing LinkedIn ETL setup...');
    
    const { testLinkedInSetup } = require('../etl/social-media');
    const result = await testLinkedInSetup();
    
    sendResponse(res, 200, true, result, 'LinkedIn ETL test completed successfully');
    
  } catch (error) {
    console.error('❌ LinkedIn ETL test failed:', error);
    sendResponse(res, 500, false, null, 'LinkedIn ETL test failed', error.message);
  }
};

// Manual LinkedIn Post Trigger
const triggerLinkedInPost = async (req, res) => {
  try {
    const { type, jobNetwork } = req.body;
    
    console.log(`🚀 Manually triggering LinkedIn post - Type: ${type}, Network: ${jobNetwork || 'N/A'}`);
    
    const { 
      postExpiringSoonJobPostsToLinkedIn, 
      postJobNetworkPostsToLinkedIn 
    } = require('../etl/social-media');
    
    let result;
    
    if (type === 'expiring') {
      result = await postExpiringSoonJobPostsToLinkedIn();
    } else if (type === 'network' && jobNetwork) {
      result = await postJobNetworkPostsToLinkedIn(jobNetwork);
    } else {
      return sendResponse(res, 400, false, null, 'Invalid request. Use type: "expiring" or "network" with jobNetwork');
    }
    
    sendResponse(res, 200, true, { 
      linkedinResponse: result,
      message: 'LinkedIn post triggered successfully'
    }, 'LinkedIn post completed successfully');
    
  } catch (error) {
    console.error('❌ Manual LinkedIn post failed:', error);
    sendResponse(res, 500, false, null, 'LinkedIn post failed', error.message);
  }
};

module.exports.testLinkedInETL = testLinkedInETL;
module.exports.triggerLinkedInPost = triggerLinkedInPost; 