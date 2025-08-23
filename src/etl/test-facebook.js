#!/usr/bin/env node

const { testFacebookSetup, validateFacebookCredentials } = require('./social-media');

async function runFacebookTest() {
  console.log('🚀 Facebook ETL Diagnostic Test');
  console.log('====================================\n');
  
  try {
    await testFacebookSetup();
    
    console.log('\n🎉 SUCCESS! Facebook ETL is properly configured.');
    console.log('\n📝 Next Steps:');
    console.log('   • Your Facebook ETL should now work automatically');
    console.log('   • Check scheduled posts in your app logs');
    console.log('   • Use the API endpoints to manually trigger posts');
    console.log('   • Test posting with: POST /api/v1/etl/trigger-facebook-post');
    console.log('   • Test both platforms: POST /api/v1/etl/trigger-both-platforms-post');
    
  } catch (error) {
    console.log('\n❌ FAILED! Facebook ETL has configuration issues.');
    console.log('\n🔧 Troubleshooting Guide:');
    
    if (error.message.includes('Missing required Facebook credentials')) {
      console.log('\n📋 Missing Facebook Credentials:');
      console.log('   1. Go to https://developers.facebook.com/');
      console.log('   2. Create a Facebook App');
      console.log('   3. Create a Facebook Page for your business');
      console.log('   4. Get your credentials and add to .env:');
      console.log('');
      console.log('   FACEBOOK_APP_ID=your_app_id');
      console.log('   FACEBOOK_APP_SECRET=your_app_secret');
      console.log('   FACEBOOK_PAGE_ACCESS_TOKEN=your_page_access_token');
      console.log('   FACEBOOK_PAGE_ID=your_page_id');
      console.log('');
      console.log('   💡 Tip: Page Access Tokens don\'t expire and have posting permissions');
    }
    
    if (error.message.includes('images directory')) {
      console.log('\n📸 Missing Images Directory:');
      console.log('   1. Directory exists: src/etl/post_images/');
      console.log('   2. Add some .jpg, .png, or .gif images');
      console.log('   3. These will be used as Facebook post backgrounds');
    }
    
    if (error.message.includes('Database')) {
      console.log('\n🗄️  Database Connection Issue:');
      console.log('   1. Check your PostgreSQL connection');
      console.log('   2. Verify PGHOST, PGUSER, PGPASSWORD, etc.');
      console.log('   3. Ensure job_vacancies table exists');
    }
    
    if (error.message.includes('Facebook API test failed')) {
      console.log('\n🔗 Facebook API Connection Issue:');
      console.log('   1. Verify your Page Access Token is valid');
      console.log('   2. Check that your Page ID is correct');
      console.log('   3. Ensure your Facebook App is not restricted');
      console.log('   4. Test manually: https://graph.facebook.com/v18.0/YOUR_PAGE_ID?access_token=YOUR_TOKEN');
    }
    
    console.log(`\n💥 Error Details: ${error.message}`);
  }
  
  console.log('\n');
  process.exit(0);
}

// Run the test
if (require.main === module) {
  runFacebookTest();
}

module.exports = { runFacebookTest };
