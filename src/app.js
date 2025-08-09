// Import Sentry instrumentation FIRST - before any other imports
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
const { removeDuplicateJobVacancies } = require("./etl/shared");

// Import social media functions
const { 
  postExpiringSoonJobPostsToLinkedIn, 
  postJobNetworkPostsToLinkedIn, 
  refreshLinkedInToken 
} = require("./etl/social-media");

//const { generateJobRelatedBlogPost } = require("./util/etl-blog");
const { generateJobRelatedBlogPost } = require("./etl/etl-blog-deepseek");

require("dotenv").config();

const PORT = process.env.PORT;

const errors = require("./error-middleware");
const Sentry = require("@sentry/node");

const router = require("./routers/index");
const app = express();

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

app.listen(PORT, () => {
  console.log(`API Server is started on PORT: ${PORT}`);
  runEtl();
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
  const { logETLStatus, getJobCount } = require("./etl/shared");
  
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
    
    try {
      console.log(`\n🏢 Processing ${name}...`);
      
      // Log start status
      await logETLStatus(name, 'running', { 
        startTime,
        processedCount: 0,
        successCount: 0,
        errorCount: 0
      });
      
      // Call ETL function directly (they manage their own connections)
      // The transaction wrapper approach needs refactoring of individual ETL functions
      let result = { success: false, error: 'Unknown error' };
      
      try {
        await func();
        result = { 
          success: true, 
          processedCount: 0, // Individual functions don't return this yet
          successCount: 0,
          errorCount: 0
        };
      } catch (error) {
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
      }
      
    } catch (error) {
      const endTime = new Date();
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      const jobsInDb = await getJobCount(name);
      
      console.error(`❌ Critical error processing ${name}:`, error.message);
      etlResults.failed.push({ name, error: error.message });
      etlResults.totalErrors++;
      
      // Log critical failure
      await logETLStatus(name, 'failed', {
        startTime,
        endTime,
        durationSeconds,
        errorMessage: `Critical error: ${error.message}`,
        jobsInDb
      });
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

// LinkedIn Posting Schedule - Morning batch (runs after 6 AM ETL completes)
cron.schedule("0 7 * * *", async () => {
  console.log("Running postExpiringSoonJobPostsToLinkedIn...", new Date());
  try {
    await postExpiringSoonJobPostsToLinkedIn();
    console.log("Successfully posted expiring soon job posts to LinkedIn.");
  } catch (error) {
    console.error("Error posting expiring soon job posts to LinkedIn:", error);
  }
});

cron.schedule("0 8 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for IT...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Information and Telecommunication Technology");
    console.log("Successfully posted IT job posts to LinkedIn.");
  } catch (error) {
    console.error("Error posting IT job posts to LinkedIn:", error);
  }
});

cron.schedule("0 9 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Political/Peace/Humanitarian...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Political, Peace and Humanitarian");
    console.log("Successfully posted Political, Peace and Humanitarian job posts to LinkedIn.");
  } catch (error) {
    console.error("Error posting Political, Peace and Humanitarian job posts to LinkedIn:", error);
  }
});

// Additional LinkedIn Posting Schedule - Midday batch
cron.schedule("0 10 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Health/Project/Programme Management...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Health, Project Management, Programme Management");
    console.log("Successfully posted Health/Project/Programme Management job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Health, Project Management, Programme Management");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 11 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Economic, Social and Development...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Economic, Social and Development");
    console.log("Successfully posted Economic, Social and Development job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Economic, Social and Development");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 12 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Internal Security and Safety...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Internal Security and Safety");
    console.log("Successfully posted Internal Security and Safety job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Internal Security and Safety");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 13 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Communication...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Communication");
    console.log("Successfully posted Communication job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Communication");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 14 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Legal...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Legal");
    console.log("Successfully posted Legal job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Legal");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 15 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Public Information and Conference Management...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Public Information and Conference Management");
    console.log("Successfully posted Public Information and Conference Management job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Public Information and Conference Management");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 16 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Science...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Science");
    console.log("Successfully posted Science job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Science");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

// LinkedIn Posting Schedule - Evening batch (runs after 6 PM ETL completes)
cron.schedule("0 19 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Management and Administration...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Management and Administration");
    console.log("Successfully posted Management and Administration job posts to LinkedIn.");
  } catch (error) {
    if (error.message?.includes('EXPIRED_ACCESS_TOKEN')) {
      console.log('Attempting to refresh LinkedIn token and retry...');
      try {
        await refreshLinkedInToken();
        await postJobNetworkPostsToLinkedIn("Management and Administration");
        console.log("Successfully posted after token refresh");
      } catch (refreshError) {
        console.error("Failed even after token refresh:", refreshError);
      }
    } else {
      console.error("Error posting job posts to LinkedIn:", error);
    }
  }
});

cron.schedule("0 20 * * *", async () => {
  console.log("Running postJobNetworkPostsToLinkedIn for Logistics...", new Date());
  try {
    await postJobNetworkPostsToLinkedIn("Logistics, Transportation and Supply Chain");
    console.log("Successfully posted Logistics job posts to LinkedIn.");
  } catch (error) {
    console.error("Error posting Logistics job posts to LinkedIn:", error);
  }
});

// Weekly blog post generation (commented out as per original code)
// cron.schedule("0 0 * * 0", async () => {
//   await generateJobRelatedBlogPost();
// });
