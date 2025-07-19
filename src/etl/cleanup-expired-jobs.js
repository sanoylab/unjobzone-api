#!/usr/bin/env node

/**
 * Database Cleanup Script (Expired Jobs + Duplicates)
 * 
 * This script removes:
 * 1. Job vacancies where the end_date (application deadline) has passed
 * 2. Duplicate job entries (keeps the most recent one)
 * 
 * Usage:
 *   node src/etl/cleanup-expired-jobs.js           # Run cleanup
 *   node src/etl/cleanup-expired-jobs.js --dry-run # Preview what would be deleted
 *   node src/etl/cleanup-expired-jobs.js --help    # Show help
 * 
 * Safety Features:
 *   - Dry run mode to preview changes
 *   - Detailed logging and statistics
 *   - Only removes jobs where end_date < NOW()
 *   - Removes duplicates but keeps the most recent copy
 *   - Preserves all active jobs (end_date >= today)
 */

require('dotenv').config();
const { cleanupExpiredAndDuplicateJobs, getJobsExpiringSoon } = require('./shared');

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || args.includes('-d');
const showHelp = args.includes('--help') || args.includes('-h');

function showHelpMessage() {
  console.log(`
🧹 Database Cleanup Script (Expired Jobs + Duplicates)
======================================================

This script cleans up the database by removing:
1. Job vacancies where the application deadline (end_date) has passed
2. Duplicate job entries (keeps the most recent copy)

Usage:
  node src/etl/cleanup-expired-jobs.js [options]

Options:
  --dry-run, -d    Preview what would be deleted without making changes
  --help, -h       Show this help message

Examples:
  node src/etl/cleanup-expired-jobs.js              # Clean up database
  node src/etl/cleanup-expired-jobs.js --dry-run    # Preview cleanup

Safety:
  ✅ Only removes jobs where end_date < current date
  ✅ Removes duplicates but keeps the most recent copy
  ✅ Never touches active job postings  
  ✅ Includes detailed logging and statistics
  ✅ Logs all activities to ETL monitoring table

The cleanup ensures database integrity by removing expired jobs and eliminating
duplicate entries that may have slipped through the ETL process.
`);
}

async function main() {
  try {
    // Show help if requested
    if (showHelp) {
      showHelpMessage();
      process.exit(0);
    }

    console.log('🧹 ==========================================');
    console.log('📅 Expired Job Cleanup Script');
    console.log('============================================');
    console.log(`📅 Current Date: ${new Date().toDateString()}`);
    console.log(`🔍 Mode: ${isDryRun ? 'DRY RUN (Preview Only)' : 'LIVE CLEANUP'}`);
    console.log('============================================\n');

    // First, show jobs that are expiring soon (helpful context)
    console.log('📊 Jobs Expiring in Next 7 Days:');
    const expiringSoon = await getJobsExpiringSoon(7);
    
    if (expiringSoon.totalExpiring > 0) {
      console.log(`⚠️  ${expiringSoon.totalExpiring} jobs expiring within 7 days:`);
      expiringSoon.organizationBreakdown.forEach(org => {
        console.log(`   📁 ${org.data_source.toUpperCase()}: ${org.expiring_count} jobs (next expires: ${new Date(org.soonest_expiry).toDateString()})`);
      });
    } else {
      console.log('✅ No jobs expiring in the next 7 days');
    }

    console.log('\n' + '='.repeat(50));

    // Run the cleanup
    const stats = await cleanupExpiredAndDuplicateJobs(null, isDryRun);

    // Show final summary
    console.log('\n📈 CLEANUP SUMMARY:');
    console.log('==================');
    console.log(`📊 Total Issues Found: ${stats.totalExpiredJobs + stats.totalDuplicateJobs}`);
    console.log(`   📅 Expired Jobs: ${stats.totalExpiredJobs}`);
    console.log(`   🔄 Duplicate Jobs: ${stats.totalDuplicateJobs}`);
    
    if (isDryRun) {
      console.log('🔍 DRY RUN - No changes made');
      console.log('💡 Run without --dry-run to actually clean up the database');
    } else {
      const totalDeleted = stats.deletedExpiredJobs + stats.deletedDuplicateJobs;
      console.log(`🗑️  Total Jobs Deleted: ${totalDeleted}`);
      console.log(`   📅 Expired: ${stats.deletedExpiredJobs}`);
      console.log(`   🔄 Duplicates: ${stats.deletedDuplicateJobs}`);
      console.log(`✅ Database cleaned successfully`);
    }
    
    console.log(`⏱️  Duration: ${stats.durationSeconds}s`);

    // Show organization breakdown if there were expired jobs
    if (stats.totalExpiredJobs > 0) {
      console.log('\n📁 Breakdown by Organization:');
      Object.entries(stats.organizationBreakdown).forEach(([org, info]) => {
        console.log(`   ${org.toUpperCase()}: ${info.count} expired jobs`);
      });
    }

    // Exit with appropriate code
    process.exit(stats.errorCount > 0 ? 1 : 0);

  } catch (error) {
    console.error('\n❌ SCRIPT FAILED:');
    console.error('==================');
    console.error('Error:', error.message);
    console.error('\nStack trace:', error.stack);
    
    process.exit(1);
  }
}

// Handle process interruption gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Script interrupted by user');
  console.log('✅ No database changes were made');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n⚠️  Script terminated');
  process.exit(0);
});

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { main }; 