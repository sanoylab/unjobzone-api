#!/usr/bin/env node

// Standalone Oracle HCM Job Monitor
// This script can be run independently or integrated into the main application

require('dotenv').config();
const JobMonitor = require('./src/job-monitor');

async function main() {
  console.log('🔍 Oracle HCM Job Monitor Starting...');
  console.log('📧 Target URL:', 'https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs');
  
  // Validate environment variables
  if (!process.env.MONITOR_EMAIL_USER || !process.env.MONITOR_EMAIL_PASS) {
    console.error('❌ Missing required environment variables:');
    console.error('   MONITOR_EMAIL_USER - Your Gmail address');
    console.error('   MONITOR_EMAIL_PASS - Your Gmail app password');
    console.error('   MONITOR_RECIPIENT_EMAIL - Email to receive notifications (optional, defaults to MONITOR_EMAIL_USER)');
    console.error('\n📝 Please add these to your .env file');
    process.exit(1);
  }
  
  console.log('📧 Email configured for:', process.env.MONITOR_EMAIL_USER);
  console.log('📬 Notifications will be sent to:', process.env.MONITOR_RECIPIENT_EMAIL || process.env.MONITOR_EMAIL_USER);
  
  try {
    const monitor = new JobMonitor();
    await monitor.initialize();
    monitor.startMonitoring();
    
    console.log('✅ Job monitor is now running!');
    console.log('🔄 Checking for updates every 10 minutes');
    console.log('🌅 Morning summary at 8:00 AM');
    console.log('🌆 Evening summary at 6:00 PM');
    console.log('\n💡 Press Ctrl+C to stop the monitor');
    
  } catch (error) {
    console.error('❌ Failed to start job monitor:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Job monitor shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Job monitor shutting down gracefully...');
  process.exit(0);
});

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = main;
