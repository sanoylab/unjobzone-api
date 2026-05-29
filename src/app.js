// Load environment variables FIRST - before any other imports
require("dotenv").config();

// Import Sentry instrumentation AFTER dotenv
require("./instrument.js");

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const swaggerJsDoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const { options } = require("./util/swagger");

const { fetchAndProcessInspiraJobVacancies } = require("./etl/etl-inspira");
const { fetchAndProcessWfpJobVacancies } = require("./etl/etl-wfp");
const { fetchAndProcessUnhcrJobVacancies } = require("./etl/etl-unhcr");
const { fetchAndProcessImfJobVacancies } = require("./etl/etl-imf");
const { fetchAndProcessUndpJobVacancies } = require("./etl/etl-undp");
const { fetchAndProcessUnwomenJobVacancies } = require("./etl/etl-unwomen");
const { fetchAndProcessUnfpaJobVacancies } = require("./etl/etl-unfpa");
const { fetchAndProcessIomJobVacancies } = require("./etl/etl-iom");
const { fetchAndProcessIcaoJobVacancies } = require("./etl/etl-icao");
const { fetchAndProcessUnicefJobVacancies } = require("./etl/etl-unicef");
const { fetchAndProcessUnopsJobVacancies } = require("./etl/etl-unops");
const { fetchAndProcessUnescoJobVacancies } = require("./etl/etl-unesco");
const { fetchAndProcessReliefwebJobVacancies } = require("./etl/etl-reliefweb");
const { removeDuplicateJobVacancies } = require("./etl/shared");

// Import social media functions
const {
  postExpiringSoonJobPostsToLinkedIn,
  postJobNetworkPostsToLinkedIn,
  postJobNetworkPostsToFacebook,
  postExpiringSoonJobPostsToFacebook,
  refreshLinkedInToken
} = require("./etl/social-media");

// Import Job Monitor for ICAO jobs
const JobMonitor = require("./job-monitor");

const PORT = process.env.PORT || 3000;

const errors = require("./error-middleware");
const Sentry = require("@sentry/node");

const router = require("./routers/index");
const app = express();

// Skip Express's "X-Powered-By: Express" header — minor information leak
// and a tiny byte saving on every response.
app.disable("x-powered-by");

app.use(cors());
app.use(express.json());

// Debug route for testing Sentry
app.get("/debug-sentry", function mainHandler(req, res) {
  console.log("Debug Sentry - throwing test error");
  throw new Error("My first Sentry error!");
});

// Additional Sentry testing routes
app.get("/debug-sentry/async", async function asyncHandler(req, res) {
  console.log("Debug Sentry - async error");
  throw new Error("Async error test for Sentry!");
});

app.get("/debug-sentry/unhandled", function unhandledHandler(req, res) {
  console.log("Debug Sentry - unhandled promise rejection");
  Promise.reject(new Error("Unhandled promise rejection test!"));
  res.json({ message: "Unhandled promise rejection triggered" });
});

app.get("/debug-sentry/test", function testHandler(req, res) {
  const Sentry = require("@sentry/node");
  
  // Test different error types
  try {
    Sentry.addBreadcrumb({
      message: 'Sentry test breadcrumb',
      level: 'info',
    });

    Sentry.captureMessage('Test message from Sentry', 'info');
    
    res.json({ 
      message: "Sentry test completed successfully",
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
});

app.use("/api/v1", router);

const swaggerSpec = swaggerJsDoc(options);
app.use("/api/v1", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// The Sentry error handler must be before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

app.use(errors.notFound);
app.use(errors.errorHandler);

// Idempotent startup migrations — make sure schema columns and indexes
// the controllers rely on actually exist on the live DB. These statements
// are no-ops when already applied (`IF NOT EXISTS` for indexes and ALTERs).
// Run on every boot before runEtl() / before traffic starts hitting the
// API.
async function ensureSchema() {
  const { pool } = require("./util/db");
  // Each statement runs independently so one failure doesn't skip the rest.
  const statements = [
    // — Missing column from src/etl/database-schema.sql that never got applied.
    `ALTER TABLE job_vacancies ADD COLUMN IF NOT EXISTS source_logo_url TEXT;`,

    // — Indexes that match the controllers' query patterns. Without these,
    //   every getAll / getFilteredJobs does a full table scan + sort. With
    //   the table at ~1700 rows this isn't catastrophic, but it gets worse
    //   linearly as the table grows.
    `CREATE INDEX IF NOT EXISTS idx_job_vacancies_end_date ON job_vacancies (end_date);`,
    `CREATE INDEX IF NOT EXISTS idx_job_vacancies_dept ON job_vacancies (dept);`,
    `CREATE INDEX IF NOT EXISTS idx_job_vacancies_duty_station ON job_vacancies (duty_station);`,
    `CREATE INDEX IF NOT EXISTS idx_job_vacancies_jn ON job_vacancies (jn);`,
    `CREATE INDEX IF NOT EXISTS idx_job_vacancies_jf ON job_vacancies (jf);`,

    // — GIN index on the full-text-search column used by getFilteredJobs.
    //   Without it `to_tsvector('english', job_title) @@ to_tsquery(...)`
    //   has to re-compute the tsvector for every row on every query.
    `CREATE INDEX IF NOT EXISTS idx_job_vacancies_job_title_tsv
       ON job_vacancies USING GIN (to_tsvector('english', job_title));`,

    // — Refresh planner stats so the new indexes are immediately considered
    //   on the first query. Auto-ANALYZE would catch up eventually but
    //   right after CREATE INDEX is the moment we want the planner to know.
    `ANALYZE job_vacancies;`,
  ];

  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error("⚠️ Schema migration step failed:", err.message);
    }
  }
  console.log("✅ Schema migrations applied (columns + indexes)");
}

app.listen(PORT, async () => {
  console.log(`API Server is started on PORT: ${PORT}`);
  await ensureSchema();
  runEtl();
  
  // Initialize ICAO Job Monitor if email credentials are provided
  /*
  if (process.env.MONITOR_EMAIL_USER && process.env.MONITOR_EMAIL_PASS) {
    try {
      console.log('🔍 Initializing ICAO Job Monitor...');
      const jobMonitor = new JobMonitor();
      await jobMonitor.initialize();
      jobMonitor.startMonitoring();
      console.log('✅ ICAO Job Monitor started successfully');
    } catch (error) {
      console.error('❌ Failed to start ICAO Job Monitor:', error.message);
    }
  } else {
    console.log('ℹ️  ICAO Job Monitor disabled - missing email credentials');
    console.log('   Add MONITOR_EMAIL_USER and MONITOR_EMAIL_PASS to .env to enable');
  }
  */
});

const runEtl = async () => {
  console.log("🚀 Starting complete ETL process...", new Date());
  
  const etlResults = {
    successful: [],
    failed: [],
    totalProcessed: 0,
    totalErrors: 0
  };
  
  // Import the ETL utilities
  const { logETLStatus, getJobCount, cleanupStaleRunningStatuses, acquireETLLock, releaseETLLock } = require("./etl/shared");
  
  // 🧹 Clean up any stale 'running' statuses before starting new ETL
  try {
    console.log("🧹 Cleaning up stale 'running' statuses...");
    const cleanedCount = await cleanupStaleRunningStatuses();
    if (cleanedCount > 0) {
      console.log(`✅ Cleaned up ${cleanedCount} stale 'running' statuses`);
    } else {
      console.log("✅ No stale 'running' statuses found");
    }
  } catch (cleanupError) {
    console.warn("⚠️ Failed to cleanup stale statuses:", cleanupError.message);
  }

  // Define ETL functions with their organization names
  const etlJobs = [
    { name: 'IMF', func: fetchAndProcessImfJobVacancies },
    { name: 'UNHCR', func: fetchAndProcessUnhcrJobVacancies },
    { name: 'WFP', func: fetchAndProcessWfpJobVacancies },
    { name: 'INSPIRA', func: fetchAndProcessInspiraJobVacancies },
    { name: 'UNDP', func: fetchAndProcessUndpJobVacancies },
    { name: 'UNWOMEN', func: fetchAndProcessUnwomenJobVacancies },
    { name: 'ICAO', func: fetchAndProcessIcaoJobVacancies },
    { name: 'UNFPA', func: fetchAndProcessUnfpaJobVacancies },
    { name: 'IOM', func: fetchAndProcessIomJobVacancies },
    { name: 'UNICEF', func: fetchAndProcessUnicefJobVacancies },
    { name: 'UNOPS', func: fetchAndProcessUnopsJobVacancies },
    { name: 'UNESCO', func: fetchAndProcessUnescoJobVacancies }
  ];
  
  // Process each organization with robust error handling
  for (const { name, func } of etlJobs) {
    const startTime = new Date();
    let statusLogged = false;
    
    try {
      console.log(`\n🏢 Processing ${name}...`);
      
      // Acquire ETL lock to ensure only one organization runs at a time
      const lockResult = await acquireETLLock(name);
      if (!lockResult.acquired) {
        console.log(`⏳ Skipping ${name}: ${lockResult.reason}`);
        etlResults.failed.push({ name, error: lockResult.reason });
        continue;
      }
      
      // Log start status
      await logETLStatus(name, 'running', { 
        startTime,
        processedCount: 0,
        successCount: 0,
        errorCount: 0
      });
      
      // Call ETL function directly (they now return proper status)
      let result = { success: false, error: 'Unknown error' };
      
      try {
        result = await func();
        
        // Ensure result has required properties
        if (!result || typeof result !== 'object') {
          console.warn(`⚠️ ${name} ETL function returned invalid result format, treating as success`);
          result = { 
            success: true, 
            processedCount: 0,
            successCount: 0,
            errorCount: 0
          };
        }
        
        // Provide defaults for missing properties
        result.processedCount = result.processedCount || 0;
        result.successCount = result.successCount || 0;
        result.errorCount = result.errorCount || 0;
        
        if (result.success) {
          console.log(`✅ ${name} ETL completed: ${result.successCount} jobs saved, ${result.errorCount} errors`);
        } else {
          console.error(`❌ ${name} ETL failed: ${result.error}`);
        }
        
      } catch (error) {
        console.error(`❌ ${name} ETL function threw unhandled error:`, error.message);
        result = {
          success: false,
          error: error.message,
          processedCount: 0,
          successCount: 0,
          errorCount: 1
        };
      }
      
      const endTime = new Date();
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      const jobsInDb = await getJobCount(name);
      
      if (result.success) {
        etlResults.successful.push(name);
        etlResults.totalProcessed += result.processedCount || 0;
        
        // Log success status
        await logETLStatus(name, 'success', {
          startTime,
          endTime,
          durationSeconds,
          processedCount: result.processedCount || 0,
          successCount: result.successCount || 0,
          errorCount: result.errorCount || 0,
          jobsInDb
        });
        statusLogged = true;
        
        // Release ETL lock
        await releaseETLLock(name);
        
        // 🔄 Clear Redis cache after successful ETL
        try {
          const redisClient = require('./redisClient');
          const cacheKeys = await redisClient.keys('jobs:*');
          
          if (cacheKeys.length > 0) {
            await redisClient.del(cacheKeys);
            console.log(`🔄 ${name}: Cleared ${cacheKeys.length} cached job entries from Redis`);
          }
        } catch (redisError) {
          console.warn(`⚠️  ${name}: Could not clear Redis cache: ${redisError.message}`);
        }
        
        // 🧹 Database cleanup after each organization's ETL
        console.log(`🧹 ${name}: Running database cleanup (expired jobs + duplicates)...`);
        try {
          const { cleanupExpiredAndDuplicateJobs } = require("./etl/shared");
          const cleanupStats = await cleanupExpiredAndDuplicateJobs();
          
          if (cleanupStats.deletedJobs > 0 || cleanupStats.deletedExpiredJobs > 0 || cleanupStats.deletedDuplicateJobs > 0) {
            const totalDeleted = (cleanupStats.deletedJobs || 0) + (cleanupStats.deletedExpiredJobs || 0) + (cleanupStats.deletedDuplicateJobs || 0);
            console.log(`🗑️  ${name}: Cleanup completed - ${totalDeleted} jobs removed (${cleanupStats.deletedExpiredJobs || 0} expired, ${cleanupStats.deletedDuplicateJobs || 0} duplicates)`);
          } else {
            console.log(`✅ ${name}: Database is clean - no expired or duplicate jobs found`);
          }
          
        } catch (cleanupError) {
          console.warn(`⚠️  ${name}: Database cleanup failed: ${cleanupError.message}`);
          // Don't fail the entire ETL process if cleanup fails
        }
        
      } else {
        etlResults.failed.push({ name, error: result.error });
        etlResults.totalErrors++;
        
        // Log failure status
        await logETLStatus(name, 'failed', {
          startTime,
          endTime,
          durationSeconds,
          processedCount: result.processedCount || 0,
          successCount: result.successCount || 0,
          errorCount: result.errorCount || 0,
          errorMessage: result.error,
          jobsInDb
        });
        statusLogged = true;
        
        // Release ETL lock
        await releaseETLLock(name);
      }
      
    } catch (error) {
      const endTime = new Date();
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      
      console.error(`❌ Critical error processing ${name}:`, error.message);
      etlResults.failed.push({ name, error: error.message });
      etlResults.totalErrors++;
      
      // Ensure status is logged even if there was a critical error
      if (!statusLogged) {
        try {
          const jobsInDb = await getJobCount(name);
          
                     // Log critical failure
           await logETLStatus(name, 'failed', {
             startTime,
             endTime,
             durationSeconds,
             errorMessage: `Critical error: ${error.message}`,
             jobsInDb
           });
           
           // Release ETL lock on critical failure
           await releaseETLLock(name);
         } catch (statusError) {
           console.error(`❌ Failed to log status for ${name}:`, statusError.message);
           // Still try to release lock even if status logging failed
           try {
             await releaseETLLock(name);
           } catch (lockError) {
             console.error(`❌ Failed to release lock for ${name}:`, lockError.message);
           }
         }
       }
    }
  }
  
  // 🧹 Final Database Cleanup - Safety check after all organizations complete
  // This is a final safety net to catch anything that might have been missed
  console.log("\n🧹 Running final database cleanup (safety check)...");
  try {
    const { cleanupExpiredAndDuplicateJobs } = require("./etl/shared");
    const finalCleanupStats = await cleanupExpiredAndDuplicateJobs();
    
    // Add final cleanup results to ETL results
    etlResults.finalCleanup = {
      totalExpiredJobs: finalCleanupStats.totalExpiredJobs,
      totalDuplicateJobs: finalCleanupStats.totalDuplicateJobs,
      deletedExpiredJobs: finalCleanupStats.deletedExpiredJobs || 0,
      deletedDuplicateJobs: finalCleanupStats.deletedDuplicateJobs || 0,
      errorCount: finalCleanupStats.errorCount || 0,
      durationSeconds: finalCleanupStats.durationSeconds || 0
    };
    
    const totalFinalDeleted = (finalCleanupStats.deletedExpiredJobs || 0) + (finalCleanupStats.deletedDuplicateJobs || 0);
    
    if (totalFinalDeleted > 0) {
      console.log(`🗑️  Final cleanup completed: ${totalFinalDeleted} jobs removed (${finalCleanupStats.deletedExpiredJobs || 0} expired, ${finalCleanupStats.deletedDuplicateJobs || 0} duplicates)`);
    } else {
      console.log("✅ Final cleanup: Database is clean - no additional expired or duplicate jobs found!");
    }
    
  } catch (cleanupError) {
    console.error("❌ Final database cleanup failed:", cleanupError.message);
    etlResults.finalCleanup = { error: cleanupError.message };
  }
  
  // ETL Summary Report
  console.log("\n" + "=".repeat(50));
  console.log("📋 ETL PROCESS SUMMARY");
  console.log("=".repeat(50));
  console.log(`✅ Successful: ${etlResults.successful.length} organizations`);
  etlResults.successful.forEach(org => console.log(`   ✓ ${org}`));
  
  if (etlResults.failed.length > 0) {
    console.log(`❌ Failed: ${etlResults.failed.length} organizations`);
    etlResults.failed.forEach(({ name, error }) => console.log(`   ✗ ${name}: ${error}`));
  }
  
  console.log(`📊 Total Organizations Processed: ${etlJobs.length}`);
  
  // Include cleanup summary
  console.log(`🧹 Database Cleanup Summary:`);
  console.log(`   • Per-Organization Cleanup: Ran after each successful ETL`);
  
  if (etlResults.finalCleanup && !etlResults.finalCleanup.error) {
    const totalFinalDeleted = (etlResults.finalCleanup.deletedExpiredJobs || 0) + (etlResults.finalCleanup.deletedDuplicateJobs || 0);
    if (totalFinalDeleted > 0) {
      console.log(`   • Final Safety Check: ${totalFinalDeleted} additional jobs removed (${etlResults.finalCleanup.deletedExpiredJobs || 0} expired, ${etlResults.finalCleanup.deletedDuplicateJobs || 0} duplicates)`);
    } else {
      console.log(`   • Final Safety Check: No additional cleanup needed - database was already clean`);
    }
  } else if (etlResults.finalCleanup?.error) {
    console.log(`   ❌ Final Safety Check: Failed - ${etlResults.finalCleanup.error}`);
  }
  
  console.log(`⏰ ETL Process Completed: ${new Date()}`);
  console.log("=".repeat(50));
  
  // Return summary for potential monitoring/alerting
  return etlResults;
};

// ETL Schedule: Run twice daily for optimal data freshness
// 6:00 AM - Morning run to catch overnight updates
cron.schedule("0 6 * * *", async() => {
  console.log("Running morning ETL process...", new Date());
  await runEtl();
});

// 6:00 PM - Evening run to catch business day updates
cron.schedule("0 18 * * *", async() => {
  console.log("Running evening ETL process...", new Date());
  await runEtl();
});

// 5:00 AM - Daily ReliefWeb ingestion (standalone, NOT inside runEtl())
cron.schedule("0 5 * * *", async () => {
  await runReliefwebEtl();
});

const runReliefwebEtl = async () => {
  const ORG = "RELIEFWEB";
  const startTime = new Date();
  console.log("\n🌐 ==========================================");
  console.log("🌐 Running ReliefWeb daily ETL...", startTime);
  console.log("============================================");

  const {
    acquireETLLock,
    releaseETLLock,
    logETLStatus,
    getJobCount,
    cleanupExpiredAndDuplicateJobs,
  } = require("./etl/shared");

  const lockResult = await acquireETLLock(ORG);
  if (!lockResult.acquired) {
    console.log(`⏳ Skipping ReliefWeb: ${lockResult.reason}`);
    await logETLStatus(ORG, "failed", {
      startTime,
      endTime: new Date(),
      durationSeconds: 0,
      errorMessage: lockResult.reason,
    });
    return;
  }

  try {
    await logETLStatus(ORG, "running", {
      startTime,
      processedCount: 0,
      successCount: 0,
      errorCount: 0,
    });

    const result = await fetchAndProcessReliefwebJobVacancies();
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);
    const jobsInDb = await getJobCount(ORG);

    if (result.success) {
      await logETLStatus(ORG, "success", {
        startTime,
        endTime,
        durationSeconds,
        processedCount: result.processedCount || 0,
        successCount: result.successCount || 0,
        errorCount: result.errorCount || 0,
        jobsInDb,
      });
      console.log(
        `✅ ReliefWeb ETL completed: ${result.successCount} jobs upserted, ${result.errorCount} errors`
      );

      try {
        const redisClient = require("./redisClient");
        const cacheKeys = await redisClient.keys("jobs:*");
        if (cacheKeys.length > 0) {
          await redisClient.del(cacheKeys);
          console.log(
            `🔄 ReliefWeb: Cleared ${cacheKeys.length} cached job entries from Redis`
          );
        }
      } catch (redisError) {
        console.warn(
          `⚠️  ReliefWeb: Could not clear Redis cache: ${redisError.message}`
        );
      }

      try {
        await cleanupExpiredAndDuplicateJobs();
      } catch (cleanupError) {
        console.warn(
          `⚠️  ReliefWeb: Database cleanup failed: ${cleanupError.message}`
        );
      }
    } else {
      await logETLStatus(ORG, "failed", {
        startTime,
        endTime,
        durationSeconds,
        processedCount: result.processedCount || 0,
        successCount: result.successCount || 0,
        errorCount: result.errorCount || 0,
        errorMessage: result.error,
        jobsInDb,
      });
      console.error(`❌ ReliefWeb ETL failed: ${result.error}`);
    }
  } catch (error) {
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);
    await logETLStatus(ORG, "failed", {
      startTime,
      endTime,
      durationSeconds,
      errorMessage: `Critical error: ${error.message}`,
    });
    console.error(`❌ ReliefWeb ETL crashed: ${error.message}`);
  } finally {
    await releaseETLLock(ORG);
  }
};

// Returns true if the error indicates an expired/invalid LinkedIn access token
const isLinkedInTokenExpired = (error) => {
  const msg = error.message || '';
  return msg.includes('expired') || msg.includes('EXPIRED_ACCESS_TOKEN') || msg.includes('invalid_token');
};

// Helper: post a job network to LinkedIn (with token-refresh retry if refresh token exists)
// then post to Facebook independently if LinkedIn failed or its auto-post to Facebook failed.
const postNetworkJobsToAllPlatforms = async (jobNetwork) => {
  let facebookPostedViaLinkedIn = false;

  try {
    const result = await postJobNetworkPostsToLinkedIn(jobNetwork);
    facebookPostedViaLinkedIn = !!(result && result.autoPosted);
    console.log(`✅ LinkedIn posted for: ${jobNetwork}`);
  } catch (error) {
    if (isLinkedInTokenExpired(error) && process.env.LINKEDIN_REFRESH_TOKEN) {
      console.log('LinkedIn token expired - attempting refresh and retry...');
      try {
        await refreshLinkedInToken();
        const retryResult = await postJobNetworkPostsToLinkedIn(jobNetwork);
        facebookPostedViaLinkedIn = !!(retryResult && retryResult.autoPosted);
        console.log(`✅ LinkedIn posted for: ${jobNetwork} (after token refresh)`);
      } catch (refreshError) {
        console.error(`LinkedIn failed even after token refresh for ${jobNetwork}:`, refreshError.message);
      }
    } else if (isLinkedInTokenExpired(error)) {
      console.error(`LinkedIn token expired for ${jobNetwork} - update LINKEDIN_ACCESS_TOKEN in env vars`);
    } else {
      console.error(`LinkedIn error for ${jobNetwork}:`, error.message);
    }
  }

  // Post to Facebook independently if it wasn't already posted via LinkedIn
  if (!facebookPostedViaLinkedIn) {
    try {
      await postJobNetworkPostsToFacebook(jobNetwork);
      console.log(`✅ Facebook posted independently for: ${jobNetwork}`);
    } catch (fbError) {
      console.error(`Facebook error for ${jobNetwork}:`, fbError.message);
    }
  }
};

// Helper: post expiring-soon jobs to both platforms independently
const postExpiringSoonJobsToAllPlatforms = async () => {
  let facebookPostedViaLinkedIn = false;

  try {
    const result = await postExpiringSoonJobPostsToLinkedIn();
    facebookPostedViaLinkedIn = !!(result && result.autoPosted);
    console.log('✅ LinkedIn posted expiring-soon jobs');
  } catch (error) {
    if (isLinkedInTokenExpired(error)) {
      console.error('LinkedIn token expired for expiring jobs - update LINKEDIN_ACCESS_TOKEN in env vars');
    } else {
      console.error('LinkedIn error for expiring-soon jobs:', error.message);
    }
  }

  if (!facebookPostedViaLinkedIn) {
    try {
      await postExpiringSoonJobPostsToFacebook();
      console.log('✅ Facebook posted expiring-soon jobs independently');
    } catch (fbError) {
      console.error('Facebook error for expiring-soon jobs:', fbError.message);
    }
  }
};

// Social Media Posting Schedule (LinkedIn + Facebook) - Morning batch
cron.schedule("0 7 * * *", async () => {
  console.log("Posting expiring-soon jobs to all platforms...", new Date());
  await postExpiringSoonJobsToAllPlatforms();
});

cron.schedule("0 8 * * *", async () => {
  console.log("Posting IT jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Information and Telecommunication Technology");
});

cron.schedule("0 9 * * *", async () => {
  console.log("Posting Political/Peace/Humanitarian jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Political, Peace and Humanitarian");
});

// Social Media Posting Schedule - Midday batch
cron.schedule("0 10 * * *", async () => {
  console.log("Posting Health/Project/Programme Management jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Health, Project Management, Programme Management");
});

cron.schedule("0 11 * * *", async () => {
  console.log("Posting Economic/Social/Development jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Economic, Social and Development");
});

cron.schedule("0 12 * * *", async () => {
  console.log("Posting Internal Security and Safety jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Internal Security and Safety");
});

cron.schedule("0 13 * * *", async () => {
  console.log("Posting Communication jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Communication");
});

cron.schedule("0 14 * * *", async () => {
  console.log("Posting Legal jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Legal");
});

cron.schedule("0 15 * * *", async () => {
  console.log("Posting Public Information/Conference Management jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Public Information and Conference Management");
});

cron.schedule("0 16 * * *", async () => {
  console.log("Posting Science jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Science");
});

// Social Media Posting Schedule - Evening batch
cron.schedule("0 19 * * *", async () => {
  console.log("Posting Management and Administration jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Management and Administration");
});

cron.schedule("0 20 * * *", async () => {
  console.log("Posting Logistics jobs to all platforms...", new Date());
  await postNetworkJobsToAllPlatforms("Logistics, Transportation and Supply Chain");
});

// Weekly blog post generation (commented out as per original code)
// cron.schedule("0 0 * * 0", async () => {
//   await generateJobRelatedBlogPost();
// });

// — Render keep-warm + Redis cache pre-warm —
// Two purposes, one cron:
//   1. Reset Render's 15-min idle-shutdown timer so first-time visitors
//      don't pay the ~30 s cold-start.
//   2. Hit the endpoints the SPA actually loads on every page, so the
//      Redis cache entries those handlers populate stay warm. The
//      controllers cache responses with TTLs of 5–60 min — without
//      something repeatedly touching them, every TTL boundary turns
//      the next user into a cache-miss casualty. Running every 10 min
//      keeps every entry under any of those TTLs continuously hot.
//
// SELF_URL preference order:
//   1. RENDER_EXTERNAL_URL — set automatically by Render on every deploy
//   2. Hardcoded production URL — used if anyone runs this elsewhere
//   3. Skip — local dev, no public URL, no need to keep-warm
if (process.env.NODE_ENV !== "test") {
  const axios = require("axios");
  const SELF_URL =
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://unjobzone-api.onrender.com"
      : null);

  // Endpoints the SPA hits on a typical home → jobs → org → blog flow.
  // Order matters only for log readability; they fan out in parallel.
  const WARM_PATHS = [
    "/api/v1",                                       // dyno keepalive
    "/api/v1/jobs?page=1&size=6",                    // home featured strip
    "/api/v1/jobs?page=1&size=500",                  // /jobs list page
    "/api/v1/jobs/categories/list",
    "/api/v1/jobs/categories/job_function/list",
    "/api/v1/jobs/organizations/list",
    "/api/v1/jobs/organizations/logo/list",
    "/api/v1/jobs/duty_station/list",
    "/api/v1/organizations?page=1&size=100",
    "/api/v1/blogs?page=1&size=100",
    "/api/v1/blogs?page=1&size=50",
    "/api/v1/blogs/featured/list",
  ];

  if (SELF_URL) {
    const token = process.env.ACCESS_TOKEN_SECRET;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const warm = async () => {
      const results = await Promise.allSettled(
        WARM_PATHS.map((p) =>
          axios.get(`${SELF_URL}${p}`, { headers, timeout: 15_000 })
        )
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      console.log(`[keep-warm] ${ok}/${results.length} cached${fail ? ` (${fail} failed)` : ""}`);
    };

    cron.schedule("*/10 * * * *", warm);
    console.log(`⏰ Keep-warm + cache pre-warm registered (every 10 min, ${WARM_PATHS.length} paths)`);
  }
}
