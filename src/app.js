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

const router = require("./routers/index");
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/v1", router);



const swaggerSpec = swaggerJsDoc(options);

app.use("/api/v1", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

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
  
  // Import the new error handling utilities
  const { executeETLWithTransaction, logETLStatus, getJobCount } = require("./etl/shared");
  
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
    { name: 'IOM', func: fetchAndProcessIomJobVacancies }
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
      
      // Note: This creates a wrapper that maintains existing function signatures
      // while adding transaction support
      const result = await executeETLWithTransaction(name, async (client) => {
        // Call the existing ETL function
        // We'll need to modify individual functions to return success/error info
        await func();
        return { 
          success: true, 
          processedCount: 0, // Will be updated when we refactor individual functions
          successCount: 0,
          errorCount: 0
        };
      });
      
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
  
  // NOTE: Duplicate removal is no longer needed!
  // The new UPSERT approach prevents duplicates from being inserted in the first place
  console.log("\n✨ Using UPSERT approach - no duplicate cleanup needed!");
  
  // 🧹 Expired Job Cleanup - Run after all organizations complete
  console.log("\n🧹 Running expired job cleanup...");
  try {
    const { cleanupExpiredJobs } = require("./etl/shared");
    const cleanupStats = await cleanupExpiredJobs();
    
    // Add cleanup results to ETL results
    etlResults.expiredCleanup = {
      totalExpiredJobs: cleanupStats.totalExpiredJobs,
      deletedJobs: cleanupStats.deletedJobs,
      errorCount: cleanupStats.errorCount,
      durationSeconds: cleanupStats.durationSeconds
    };
    
    if (cleanupStats.deletedJobs > 0) {
      console.log(`🗑️  Cleanup completed: ${cleanupStats.deletedJobs} expired jobs removed`);
    } else {
      console.log("✅ No expired jobs found - database is clean!");
    }
    
  } catch (cleanupError) {
    console.error("❌ Expired job cleanup failed:", cleanupError.message);
    etlResults.expiredCleanup = { error: cleanupError.message };
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
  if (etlResults.expiredCleanup && !etlResults.expiredCleanup.error) {
    console.log(`🧹 Expired Jobs Cleanup: ${etlResults.expiredCleanup.deletedJobs || 0} jobs removed`);
  } else if (etlResults.expiredCleanup?.error) {
    console.log(`❌ Expired Jobs Cleanup: Failed - ${etlResults.expiredCleanup.error}`);
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
