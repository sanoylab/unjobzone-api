require("dotenv").config();

const { fetchAndProcessUnopsJobVacancies } = require("./src/etl/etl-unops");
const { executeETLWithProgressTracking } = require("./src/etl/shared");

async function runUnopsETL() {
  console.log("🚀 Starting UNOPS ETL with enhanced tracking...");
  
  try {
    // Use the enhanced ETL wrapper with progress tracking
    const result = await executeETLWithProgressTracking('UNOPS', async (progressTracker) => {
      return await fetchAndProcessUnopsJobVacancies();
    });
    
    if (result.success) {
      console.log("✅ UNOPS ETL completed successfully!");
      console.log(`📊 Results: ${result.processedCount} processed, ${result.successCount} success, ${result.errorCount} errors`);
    } else {
      console.error("❌ UNOPS ETL failed:", result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ UNOPS ETL failed:", error);
    process.exit(1);
  }
}

runUnopsETL();