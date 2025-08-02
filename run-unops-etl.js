require("dotenv").config();

const { fetchAndProcessUnopsJobVacancies } = require("./src/etl/etl-unops");

async function runUnopsETL() {
  console.log("🚀 Starting UNOPS ETL test run...");
  
  try {
    await fetchAndProcessUnopsJobVacancies();
    console.log("✅ UNOPS ETL completed successfully!");
  } catch (error) {
    console.error("❌ UNOPS ETL failed:", error);
    process.exit(1);
  }
}

runUnopsETL();