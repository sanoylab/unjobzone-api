// Manually run ReliefWeb ETL with status tracking
require("dotenv").config();

const {
  fetchAndProcessReliefwebJobVacancies,
} = require("./src/etl/etl-reliefweb");
const {
  acquireETLLock,
  releaseETLLock,
  logETLStatus,
  getJobCount,
} = require("./src/etl/shared");

const ORG_NAME = "RELIEFWEB";

async function runReliefwebETL() {
  console.log("🚀 Running ReliefWeb ETL...");
  const startTime = new Date();

  const lockResult = await acquireETLLock(ORG_NAME);
  if (!lockResult.acquired) {
    console.error(`⏳ Skipping ReliefWeb: ${lockResult.reason}`);
    await logETLStatus(ORG_NAME, "failed", {
      startTime,
      endTime: new Date(),
      durationSeconds: 0,
      errorMessage: lockResult.reason,
    });
    process.exit(1);
  }

  try {
    await logETLStatus(ORG_NAME, "running", {
      startTime,
      processedCount: 0,
      successCount: 0,
      errorCount: 0,
    });

    const result = await fetchAndProcessReliefwebJobVacancies();
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);
    const jobsInDb = await getJobCount(ORG_NAME);

    if (result.success) {
      await logETLStatus(ORG_NAME, "success", {
        startTime,
        endTime,
        durationSeconds,
        processedCount: result.processedCount || 0,
        successCount: result.successCount || 0,
        errorCount: result.errorCount || 0,
        jobsInDb,
      });
      console.log("✅ ReliefWeb ETL completed successfully!");
      console.log(
        `📊 Results: ${result.processedCount} processed, ${result.successCount} success, ${result.errorCount} errors`
      );
      process.exit(0);
    } else {
      await logETLStatus(ORG_NAME, "failed", {
        startTime,
        endTime,
        durationSeconds,
        processedCount: result.processedCount || 0,
        successCount: result.successCount || 0,
        errorCount: result.errorCount || 0,
        errorMessage: result.error,
        jobsInDb,
      });
      console.error("❌ ReliefWeb ETL failed:", result.error);
      process.exit(1);
    }
  } catch (error) {
    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);
    await logETLStatus(ORG_NAME, "failed", {
      startTime,
      endTime,
      durationSeconds,
      errorMessage: error.message,
    });
    console.error("❌ ReliefWeb ETL crashed:", error.message);
    process.exit(1);
  } finally {
    await releaseETLLock(ORG_NAME);
  }
}

runReliefwebETL();
