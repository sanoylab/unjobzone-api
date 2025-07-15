#!/usr/bin/env node

/**
 * Manual Redis Cache Clearing Script
 * 
 * This script clears all job-related cache entries from Redis
 * to ensure users see the most up-to-date job data.
 * 
 * Usage:
 *   node src/etl/clear-cache.js
 */

require('dotenv').config();

async function clearJobCache() {
  console.log('🔄 ==========================================');
  console.log('🧹 Manual Redis Cache Clearing');
  console.log('============================================');
  
  try {
    const redisClient = require('../redisClient');
    
    console.log('🔍 Searching for job-related cache entries...');
    
    // Get all job-related cache keys
    const cacheKeys = await redisClient.keys('jobs:*');
    
    if (cacheKeys.length === 0) {
      console.log('✅ No job cache entries found - cache is already clean!');
      process.exit(0);
    }
    
    console.log(`📋 Found ${cacheKeys.length} cached job entries:`);
    cacheKeys.forEach(key => console.log(`   🔑 ${key}`));
    
    console.log('\n🗑️  Clearing cache entries...');
    
    // Delete all job-related cache keys
    const result = await redisClient.del(cacheKeys);
    
    console.log(`✅ Successfully cleared ${result} cache entries!`);
    console.log('🌟 Users will now see fresh job data from the database.');
    
    console.log('\n📊 Cache Status: CLEARED');
    console.log('🔄 Next API requests will fetch fresh data');
    console.log('============================================');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ ==========================================');
    console.error('💥 Cache Clearing Failed');
    console.error(`❌ Error: ${error.message}`);
    console.error('============================================');
    
    if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 Tip: Make sure Redis server is running');
    }
    
    process.exit(1);
  }
}

// Handle process interruption gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Script interrupted by user');
  process.exit(0);
});

// Run the script
if (require.main === module) {
  clearJobCache().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { clearJobCache }; 