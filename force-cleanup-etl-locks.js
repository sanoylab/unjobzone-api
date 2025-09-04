#!/usr/bin/env node

// Script to force cleanup stuck ETL locks for debugging purposes
require("dotenv").config();

const { forceCleanupAllRunningStatuses } = require("./src/etl/shared");

async function main() {
  console.log("🧹 Force cleaning all ETL locks...");
  
  try {
    const cleanedCount = await forceCleanupAllRunningStatuses();
    
    if (cleanedCount > 0) {
      console.log(`✅ Successfully cleaned ${cleanedCount} stuck ETL locks`);
    } else {
      console.log("✅ No stuck ETL locks found");
    }
    
    console.log("🚀 You can now run ETL processes normally");
  } catch (error) {
    console.error("❌ Error cleaning ETL locks:", error);
    process.exit(1);
  }
}

main();
