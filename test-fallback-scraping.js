#!/usr/bin/env node

// Test script to verify fallback scraping works when Puppeteer fails

require('dotenv').config();
const JobMonitor = require('./src/job-monitor');

async function testFallbackScraping() {
  console.log('🧪 Testing Fallback Scraping (without Puppeteer)...\n');
  
  try {
    const monitor = new JobMonitor();
    await monitor.initialize();
    
    console.log('🚀 Testing fallback axios method directly...');
    const startTime = Date.now();
    
    // Test the fallback method directly
    const jobData = await monitor.fetchJobDataWithAxios();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️  Fallback fetch completed in ${duration} seconds\n`);
    
    console.log('📊 Fallback Results Summary:');
    console.log(`   🎯 Method: ${jobData.method}`);
    console.log(`   📋 Jobs found: ${jobData.totalJobs} (expected 0 for fallback)`);
    console.log(`   📏 Content length: ${jobData.pageText.length}`);
    console.log(`   🔢 Page hash: ${jobData.pageHash}`);
    console.log(`   ⏰ Timestamp: ${jobData.timestamp}`);
    
    console.log('\n📄 Page Content Sample (first 300 chars):');
    console.log(jobData.pageText.substring(0, 300) + '...');
    
    // Test change detection with fallback
    console.log('\n🔍 Testing Change Detection with Fallback...');
    
    const secondJobData = await monitor.fetchJobDataWithAxios();
    const changeDetection = monitor.detectChanges(secondJobData);
    
    console.log('📈 Change Detection Results:');
    console.log(`   🔄 Has changes: ${changeDetection.hasChanges}`);
    console.log(`   🆕 Is first run: ${changeDetection.isFirstRun}`);
    console.log(`   📝 Changes: ${changeDetection.changes.length}`);
    
    if (changeDetection.changes.length > 0) {
      changeDetection.changes.forEach(change => {
        console.log(`      • ${change}`);
      });
    }
    
    console.log('\n✅ Fallback scraping test completed successfully!');
    console.log('💡 This method will be used automatically when Puppeteer fails in deployment');
    
    return {
      success: true,
      method: jobData.method,
      contentLength: jobData.pageText.length,
      duration: duration,
      hasChanges: changeDetection.hasChanges
    };
    
  } catch (error) {
    console.error('❌ Fallback test failed:', error.message);
    console.error('Stack trace:', error.stack);
    
    return {
      success: false,
      error: error.message
    };
  }
}

if (require.main === module) {
  testFallbackScraping().then(result => {
    console.log('\n📋 Fallback Test Summary:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });
}

module.exports = testFallbackScraping;
