// Manually run UNICEF ETL with enhanced status tracking
require("dotenv").config();

const { fetchAndProcessUnicefJobVacancies } = require("./src/etl/etl-unicef");
const { executeETLWithProgressTracking } = require("./src/etl/shared");

async function runUnicefETL() {
  console.log("🚀 Running UNICEF ETL with enhanced tracking...");
  
  try {
    // Use the enhanced ETL wrapper with progress tracking
    const result = await executeETLWithProgressTracking('UNICEF', async (progressTracker) => {
      return await fetchAndProcessUnicefJobVacancies();
    });
    
    if (result.success) {
      console.log("✅ UNICEF ETL completed successfully!");
      console.log(`📊 Results: ${result.processedCount} processed, ${result.successCount} success, ${result.errorCount} errors`);
    } else {
      console.error("❌ UNICEF ETL failed:", result.error);
    }
  } catch (error) {
    console.error("❌ UNICEF ETL failed:", error.message);
  }
}

runUnicefETL();