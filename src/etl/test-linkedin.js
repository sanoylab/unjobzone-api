#!/usr/bin/env node

const { testLinkedInSetup, validateLinkedInCredentials } = require('./social-media');

async function runLinkedInTest() {
  console.log('🚀 LinkedIn ETL Diagnostic Test');
  console.log('=====================================\n');
  
  try {
    await testLinkedInSetup();
    
    console.log('\n🎉 SUCCESS! LinkedIn ETL is properly configured.');
    console.log('\n📝 Next Steps:');
    console.log('   • Your LinkedIn ETL should now work automatically');
    console.log('   • Check scheduled posts in your app logs');
    console.log('   • Use the API endpoints to manually trigger posts');
    
  } catch (error) {
    console.log('\n❌ FAILED! LinkedIn ETL has configuration issues.');
    console.log('\n🔧 Troubleshooting Guide:');
    
    if (error.message.includes('Missing required LinkedIn credentials')) {
      console.log('\n📋 Missing LinkedIn Credentials:');
      console.log('   1. Go to https://developer.linkedin.com/');
      console.log('   2. Create a LinkedIn App');
      console.log('   3. Get your credentials and add to .env:');
      console.log('');
      console.log('   LINKEDIN_CLIENT_ID=your_client_id');
      console.log('   LINKEDIN_CLIENT_SECRET=your_client_secret'); 
      console.log('   LINKEDIN_ACCESS_TOKEN=your_access_token');
      console.log('   LINKEDIN_ORGANIZATION_ID=your_organization_id');
      console.log('   LINKEDIN_REFRESH_TOKEN=your_refresh_token');
    }
    
    if (error.message.includes('images directory')) {
      console.log('\n📸 Missing Images Directory:');
      console.log('   1. Create directory: src/etl/post_images/');
      console.log('   2. Add some .jpg, .png, or .gif images');
      console.log('   3. These will be used as LinkedIn post backgrounds');
    }
    
    if (error.message.includes('Database')) {
      console.log('\n🗄️  Database Connection Issue:');
      console.log('   1. Check your PostgreSQL connection');
      console.log('   2. Verify PGHOST, PGUSER, PGPASSWORD, etc.');
      console.log('   3. Ensure job_vacancies table exists');
    }
    
    console.log(`\n💥 Error Details: ${error.message}`);
  }
  
  console.log('\n');
  process.exit(0);
}

// Run the test
if (require.main === module) {
  runLinkedInTest();
}

module.exports = { runLinkedInTest }; 