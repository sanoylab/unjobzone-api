#!/usr/bin/env node

// Test script to verify Puppeteer-based ICAO job scraping

require('dotenv').config();
const JobMonitor = require('./src/job-monitor');

async function testPuppeteerScraping() {
  console.log('🧪 Testing Puppeteer-based ICAO Job Scraping...\n');
  
  try {
    const monitor = new JobMonitor();
    await monitor.initialize();
    
    console.log('🚀 Starting job data fetch with Puppeteer...');
    const startTime = Date.now();
    
    const jobData = await monitor.fetchJobData();
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️  Fetch completed in ${duration} seconds\n`);
    
    console.log('📊 Results Summary:');
    console.log(`   🎯 Method: ${jobData.method}`);
    console.log(`   📋 Jobs found: ${jobData.totalJobs}`);
    console.log(`   📏 Content length: ${jobData.pageText.length}`);
    console.log(`   🔢 Page hash: ${jobData.pageHash}`);
    console.log(`   ⏰ Timestamp: ${jobData.timestamp}`);
    
    if (jobData.totalJobs > 0) {
      console.log('\n💼 Job Details:');
      jobData.jobs.forEach((job, i) => {
        console.log(`   ${i + 1}. ${job.title}`);
        if (job.location) console.log(`      📍 Location: ${job.location}`);
        if (job.department) console.log(`      🏢 Department: ${job.department}`);
        if (job.jobId) console.log(`      🆔 Job ID: ${job.jobId}`);
        console.log(`      🔍 Found with: ${job.selector}`);
        console.log('');
      });
    } else {
      console.log('\n📄 Page Content Sample (first 500 chars):');
      console.log(jobData.pageText.substring(0, 500) + '...');
    }
    
    // Test change detection
    console.log('\n🔍 Testing Change Detection...');
    
    // Simulate a second fetch to test change detection
    console.log('🔄 Simulating second fetch for change detection...');
    const secondJobData = await monitor.fetchJobData();
    
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
    
    console.log('\n✅ Puppeteer scraping test completed successfully!');
    
    return {
      success: true,
      jobsFound: jobData.totalJobs,
      contentLength: jobData.pageText.length,
      duration: duration,
      hasChanges: changeDetection.hasChanges
    };
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    
    return {
      success: false,
      error: error.message
    };
  }
}

if (require.main === module) {
  testPuppeteerScraping().then(result => {
    console.log('\n📋 Test Summary:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });
}

module.exports = testPuppeteerScraping;
