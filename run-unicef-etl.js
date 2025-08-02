// Manually run UNICEF ETL to update jobs with new formatting
require("dotenv").config();

const { fetchAndProcessUnicefJobVacancies } = require("./src/etl/etl-unicef");

async function runUnicefETL() {
  console.log("🚀 Running UNICEF ETL to update job formatting...");
  
  try {
    await fetchAndProcessUnicefJobVacancies();
    console.log("✅ UNICEF ETL completed successfully!");
  } catch (error) {
    console.error("❌ UNICEF ETL failed:", error.message);
  }
}

runUnicefETL();