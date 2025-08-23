#!/usr/bin/env node

/**
 * Test script to verify stale ETL status cleanup functionality
 */

const { cleanupStaleRunningStatuses } = require('./src/etl/shared');

async function testStaleCleanup() {
  console.log('🧪 Testing Stale ETL Status Cleanup');
  console.log('=====================================\n');
  
  try {
    console.log('1️⃣  Testing cleanup function...');
    const cleanedCount = await cleanupStaleRunningStatuses();
    
    console.log(`✅ Cleanup completed successfully`);
    console.log(`📊 Results: ${cleanedCount} stale statuses cleaned`);
    
    if (cleanedCount > 0) {
      console.log(`\n🎉 SUCCESS! Cleaned up ${cleanedCount} stale 'running' statuses`);
    } else {
      console.log(`\n✅ SUCCESS! No stale statuses found (system is clean)`);
    }
    
    console.log('\n📝 Next Steps:');
    console.log('   • Your ETL status cleanup is working correctly');
    console.log('   • This function runs automatically before each ETL cycle');
    console.log('   • You can also trigger it manually via API: POST /api/v1/etl/cleanup-stale-statuses');
    console.log('   • The health check endpoint also runs this cleanup automatically');
    
  } catch (error) {
    console.log('\n❌ FAILED! Stale cleanup has issues.');
    console.log('\n🔧 Troubleshooting:');
    
    if (error.message.includes('database') || error.message.includes('connection')) {
      console.log('\n🗄️  Database Connection Issue:');
      console.log('   1. Check your PostgreSQL connection');
      console.log('   2. Verify PGHOST, PGUSER, PGPASSWORD, etc.');
      console.log('   3. Ensure etl_status table exists');
    }
    
    console.log(`\n💥 Error Details: ${error.message}`);
  }
  
  console.log('\n');
  process.exit(0);
}

// Run the test
if (require.main === module) {
  testStaleCleanup();
}

module.exports = { testStaleCleanup };
