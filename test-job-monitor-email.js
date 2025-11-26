#!/usr/bin/env node

// Test script for ICAO Job Monitor email functionality
// This script sends a test email to verify the configuration

require('dotenv').config();
const JobMonitor = require('./src/job-monitor');

async function testEmailConfiguration() {
  console.log('🧪 Testing ICAO Job Monitor Email Configuration...\n');
  
  // Check environment variables
  if (!process.env.MONITOR_EMAIL_USER || !process.env.MONITOR_EMAIL_PASS) {
    console.error('❌ Missing required environment variables:');
    console.error('   MONITOR_EMAIL_USER - Your Gmail address');
    console.error('   MONITOR_EMAIL_PASS - Your Gmail app password');
    console.error('\n📝 Please add these to your .env file');
    return false;
  }
  
  console.log('✅ Environment variables found:');
  console.log('   📧 Email User:', process.env.MONITOR_EMAIL_USER);
  console.log('   📬 Recipient:', process.env.MONITOR_RECIPIENT_EMAIL || process.env.MONITOR_EMAIL_USER);
  console.log('   🔑 Password:', '***' + process.env.MONITOR_EMAIL_PASS.slice(-4));
  
  try {
    const monitor = new JobMonitor();
    
    // Test email sending
    console.log('\n📤 Sending test email...');
    
    const testSubject = '🧪 ICAO Job Monitor - Test Email';
    const testHtmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8f9fa; padding: 20px; }
          .footer { background: #34495e; color: white; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; }
          .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 4px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🧪 Test Email Successful!</h1>
          <p>ICAO Job Monitor Configuration Test</p>
        </div>
        <div class="content">
          <div class="success">
            ✅ <strong>Email configuration is working correctly!</strong>
          </div>
          
          <h3>📋 Test Details:</h3>
          <ul>
            <li><strong>Timestamp:</strong> ${new Date().toLocaleString()}</li>
            <li><strong>From:</strong> ${process.env.MONITOR_EMAIL_USER}</li>
            <li><strong>To:</strong> ${process.env.MONITOR_RECIPIENT_EMAIL || process.env.MONITOR_EMAIL_USER}</li>
            <li><strong>Service:</strong> Gmail SMTP</li>
          </ul>
          
          <h3>🔍 What happens next:</h3>
          <ul>
            <li>The job monitor will check for updates every 10 minutes</li>
            <li>You'll receive a morning summary at 8:00 AM</li>
            <li>You'll receive an evening summary at 6:00 PM</li>
            <li>Instant alerts will be sent when job postings change</li>
          </ul>
          
          <p><strong>🔗 Monitored URL:</strong><br>
          <a href="https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs" style="color: #667eea;">ICAO Job Postings</a></p>
        </div>
        <div class="footer">
          <p>ICAO Job Monitor | Configuration Test</p>
        </div>
      </body>
      </html>
    `;
    
    const testTextContent = `
ICAO Job Monitor - Test Email

✅ Email configuration is working correctly!

Test Details:
- Timestamp: ${new Date().toLocaleString()}
- From: ${process.env.MONITOR_EMAIL_USER}
- To: ${process.env.MONITOR_RECIPIENT_EMAIL || process.env.MONITOR_EMAIL_USER}
- Service: Gmail SMTP

What happens next:
- The job monitor will check for updates every 10 minutes
- You'll receive a morning summary at 8:00 AM
- You'll receive an evening summary at 6:00 PM
- Instant alerts will be sent when job postings change

Monitored URL: https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs
    `;
    
    const emailSent = await monitor.sendEmail(testSubject, testHtmlContent, testTextContent);
    
    if (emailSent) {
      console.log('✅ Test email sent successfully!');
      console.log('📬 Check your inbox for the test email');
      console.log('\n🚀 Your ICAO Job Monitor is ready to use!');
      console.log('\nTo start monitoring:');
      console.log('  npm run job-monitor    # Run standalone monitor');
      console.log('  npm start              # Run with main app');
      return true;
    } else {
      console.log('❌ Failed to send test email');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error testing email configuration:', error.message);
    
    if (error.message.includes('Invalid login')) {
      console.error('\n💡 Troubleshooting tips:');
      console.error('   1. Make sure you\'re using a Gmail App Password, not your regular password');
      console.error('   2. Ensure 2-Factor Authentication is enabled on your Google account');
      console.error('   3. Generate a new App Password if needed');
    }
    
    return false;
  }
}

if (require.main === module) {
  testEmailConfiguration().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = testEmailConfiguration;
