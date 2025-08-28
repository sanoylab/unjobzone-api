const e = require("express");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const FormData = require('form-data');
require("dotenv").config();
const { credentials } = require("./db");

const pool = new Pool(credentials);

// Function to upload image to LinkedIn and get asset ID
const uploadImageToLinkedIn = async (imagePath) => {
  const url = "https://api.linkedin.com/v2/assets?action=registerUpload";
  const payload = {
    registerUploadRequest: {
      recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
      owner: `urn:li:company:${process.env.LINKEDIN_ORGANIZATION_ID}`,
      serviceRelationships: [
        {
          relationshipType: "OWNER",
          identifier: "urn:li:userGeneratedContent"
        }
      ]
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error('LinkedIn API Error Details:', {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      error: errorData
    });
    throw new Error(`LinkedIn API error: ${errorData.message || response.statusText}`);
  }

  const uploadResponse = await response.json();
  const uploadUrl = uploadResponse.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
  const asset = uploadResponse.value.asset;

  // Upload the image to the provided URL
  const imageResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'image/jpeg'
    },
    body: fs.readFileSync(imagePath)
  });

  if (!imageResponse.ok) {
    const errorData = await imageResponse.json();
    console.error('LinkedIn Image Upload Error Details:', {
      status: imageResponse.status,
      statusText: imageResponse.statusText,
      headers: Object.fromEntries(imageResponse.headers),
      error: errorData
    });
    throw new Error(`LinkedIn Image Upload error: ${errorData.message || imageResponse.statusText}`);
  }

  return asset;
};

// Function to get a random image from the directory
const getRandomImage = () => {
  const imagesDir = path.join(__dirname, "post_images");
  
  // Check if directory exists
  if (!fs.existsSync(imagesDir)) {
    console.warn(`⚠️ Images directory not found: ${imagesDir}`);
    console.log(`🔄 Creating fallback image solution for deployment...`);
    
    // Return null to indicate no image should be used
    return null;
  }
  
  // Get all image files
  const images = fs.readdirSync(imagesDir).filter(file => 
    /\.(jpg|jpeg|png|gif)$/i.test(file)
  );
  
  if (images.length === 0) {
    console.warn('⚠️ No image files found in post_images directory');
    console.log('🔄 Proceeding without image for deployment compatibility...');
    
    // Return null to indicate no image should be used
    return null;
  }
  
  const randomImage = images[Math.floor(Math.random() * images.length)];
  const imagePath = path.join(imagesDir, randomImage);
  
  console.log(`📸 Selected random image: ${randomImage}`);
  return imagePath;
};

// Post job network jobs to LinkedIn
module.exports.postJobNetworkPostsToLinkedIn = async (jobNetwork) => {
  try {
    // Validate LinkedIn credentials first
    validateLinkedInCredentials();

    // Get job posts where jn matches the provided jobNetwork value and from different organizations
    const queryDistinct = `
      SELECT DISTINCT ON (organization_id)
        id, 
        job_id, 
        job_title,
        duty_station,
        job_level,
        apply_link,
        created,
        end_date,
        organization_id,
        jn
      FROM 
        public.job_vacancies
      WHERE 
        jn = $1
      ORDER BY organization_id, created DESC
      LIMIT 5
    `;

    const resultDistinct = await pool.query(queryDistinct, [jobNetwork]);
    let jobPosts = resultDistinct.rows;

    // If less than 5 records, fill in with jobs from any organization
    if (jobPosts.length < 5) {
      const remainingSlots = 5 - jobPosts.length;
      const queryFill = `
        SELECT 
          id, 
          job_id, 
          job_title,
          duty_station,
          job_level,
          apply_link,
          created,
          end_date,
          organization_id,
          jn
        FROM 
          public.job_vacancies
        WHERE 
          jn = $1
        ORDER BY created DESC
        LIMIT ${remainingSlots}
      `;

      const resultFill = await pool.query(queryFill, [jobNetwork]);
      jobPosts = jobPosts.concat(resultFill.rows);
    }

    if (!jobPosts.length) {
      console.log(`No job posts found for job network: ${jobNetwork}`);
      
      // Log no content status
      await logLinkedInStatus(`network_${jobNetwork.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, 'no_content', {
        jobsPosted: 0,
        errorMessage: 'No jobs found for this network'
      });
      
      return;
    }

    // Format message with emojis and proper spacing
    let message = `🌐 Job Opportunities in ${jobNetwork} Network:\n\n`;
    jobPosts.forEach(job => {
      message += `📌 ${job.job_title}\n`;
      message += `📍 ${job.duty_station}\n`;
      message += `🔗 Apply: https://www.unjobzone.com/job/${job.id}\n\n`;
    });
    message += "#UnitedNations #jobs #unjobs #careers #hiring #jobsearch #unjobzone #UN";

    // Get a random image from the directory (or null if not available)
    const imagePath = getRandomImage();
    let asset = null;
    
    // Only try to upload image if one is available
    if (imagePath) {
      try {
        asset = await uploadImageToLinkedIn(imagePath);
        console.log('✅ Image uploaded successfully for LinkedIn post');
      } catch (imageError) {
        console.warn('⚠️ Failed to upload image, proceeding with text-only post:', imageError.message);
        asset = null;
      }
    } else {
      console.log('📝 No image available, creating text-only LinkedIn post');
    }

    // Validate and format organization ID
    const organizationId = process.env.LINKEDIN_ORGANIZATION_ID?.toString().trim();
    if (!organizationId || isNaN(organizationId)) {
      throw new Error('Invalid LinkedIn Organization ID');
    }

    // Verify access token exists and isn't expired
    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN?.trim();
    if (!accessToken) {
      throw new Error('Missing or invalid LinkedIn access token');
    }

    // Create LinkedIn share with verified author URN
    const authorUrn = `urn:li:company:${organizationId}`;

    const url = "https://api.linkedin.com/v2/ugcPosts";
    
    // Create different payload based on whether we have an image or not
    const payload = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: {
            text: message
          },
          ...(asset ? {
            shareMediaCategory: "IMAGE",
            media: [
              {
                status: "READY",
                description: {
                  text: "Check out these amazing job opportunities!"
                },
                media: asset,
                title: {
                  text: "Job Opportunities"
                }
              }
            ]
          } : {
            shareMediaCategory: "NONE"
          })
        }
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('LinkedIn API Error Details:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        error: errorData
      });
      throw new Error(`LinkedIn API error: ${errorData.message || response.statusText}`);
    }

    const linkedinResponse = await response.json();
    console.log("Successfully posted to LinkedIn:", linkedinResponse);
    
    // Log success status
    await logLinkedInStatus(`network_${jobNetwork.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, 'success', {
      linkedinPostId: linkedinResponse.id,
      jobsPosted: jobPosts.length
    });
    
    // 🔥 AUTOMATICALLY POST TO FACEBOOK AFTER LINKEDIN SUCCESS
    try {
      console.log(`📘 Auto-posting ${jobNetwork} jobs to Facebook after LinkedIn success...`);
      const facebookResponse = await postJobNetworkPostsToFacebook(jobNetwork);
      console.log(`✅ Facebook auto-posting successful for ${jobNetwork}`);
      
      // Return both responses
      return {
        linkedin: linkedinResponse,
        facebook: facebookResponse,
        autoPosted: true
      };
    } catch (facebookError) {
      console.error(`⚠️ Facebook auto-posting failed for ${jobNetwork}:`, facebookError.message);
      
      // Return LinkedIn success with Facebook error
      return {
        linkedin: linkedinResponse,
        facebook: null,
        autoPosted: false,
        facebookError: facebookError.message
      };
    }

  } catch (error) {
    console.error(`Failed to post to LinkedIn for job network: ${jobNetwork}`, error);
    
    // Log failure status
    await logLinkedInStatus(`network_${jobNetwork.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, 'failed', {
      jobsPosted: 0,
      errorMessage: error.message
    });
    
    throw error;
  }
};

// Post expiring soon jobs to LinkedIn
module.exports.postExpiringSoonJobPostsToLinkedIn = async () => {
  try {
    // Validate LinkedIn credentials first
    validateLinkedInCredentials();

    // Get job posts where end_date is today or tomorrow and from different organizations
    const queryDistinct = `
      SELECT DISTINCT ON (organization_id)
        id, 
        job_id, 
        job_title,
        duty_station,
        job_level,
        apply_link,
        created,
        end_date,
        organization_id
      FROM 
        public.job_vacancies
      WHERE 
        DATE(end_date) = CURRENT_DATE OR DATE(end_date) = CURRENT_DATE + INTERVAL '1 day'
      ORDER BY organization_id, created DESC
      LIMIT 5
    `;

    const resultDistinct = await pool.query(queryDistinct);
    let jobPosts = resultDistinct.rows;

    // If less than 5 records, fill in with jobs from any organization
    if (jobPosts.length < 5) {
      const remainingSlots = 5 - jobPosts.length;
      const queryFill = `
        SELECT 
          id, 
          job_id, 
          job_title,
          duty_station,
          job_level,
          apply_link,
          created,
          end_date,
          organization_id
        FROM 
          public.job_vacancies
        WHERE 
          DATE(end_date) = CURRENT_DATE OR DATE(end_date) = CURRENT_DATE + INTERVAL '1 day'
        ORDER BY created DESC
        LIMIT ${remainingSlots}
      `;

      const resultFill = await pool.query(queryFill);
      jobPosts = jobPosts.concat(resultFill.rows);
    }

    if (!jobPosts.length) {
      console.log("No job posts found to share");
      
      // Log no content status
      await logLinkedInStatus('expiring', 'no_content', {
        jobsPosted: 0,
        errorMessage: 'No jobs expiring today or tomorrow'
      });
      
      return;
    }

    // Format message with emojis and proper spacing
    let message = "⏳ Hurry up! These amazing job opportunities are about to expire soon:\n\n";
    jobPosts.forEach(job => {
      message += `🌟 **${job.job_title}**\n`;
      message += `📍 Location: ${job.duty_station}\n`;
      message += `🔗 [Apply Now](https://www.unjobzone.com/job/${job.id})\n\n`;
    });
    message += "Don't miss out on these incredible opportunities! 🚀\n\n";
    message += "#UnitedNations #jobs #unjobs #careers #hiring #jobsearch #unjobzone #UN";

    // Get a random image from the directory (or null if not available)
    const imagePath = getRandomImage();
    let asset = null;
    
    // Only try to upload image if one is available
    if (imagePath) {
      try {
        asset = await uploadImageToLinkedIn(imagePath);
        console.log('✅ Image uploaded successfully for LinkedIn post');
      } catch (imageError) {
        console.warn('⚠️ Failed to upload image, proceeding with text-only post:', imageError.message);
        asset = null;
      }
    } else {
      console.log('📝 No image available, creating text-only LinkedIn post');
    }

    // Validate and format organization ID
    const organizationId = process.env.LINKEDIN_ORGANIZATION_ID?.toString().trim();
    if (!organizationId || isNaN(organizationId)) {
      throw new Error('Invalid LinkedIn Organization ID');
    }

    // Verify access token exists and isn't expired
    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN?.trim();
    if (!accessToken) {
      throw new Error('Missing or invalid LinkedIn access token');
    }

    // Create LinkedIn share with verified author URN
    const authorUrn = `urn:li:company:${organizationId}`;

    const url = "https://api.linkedin.com/v2/ugcPosts";
    
    // Create different payload based on whether we have an image or not
    const payload = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: {
            text: message
          },
          ...(asset ? {
            shareMediaCategory: "IMAGE",
            media: [
              {
                status: "READY",
                description: {
                  text: "Check out these amazing job opportunities!"
                },
                media: asset,
                title: {
                  text: "Job Opportunities"
                }
              }
            ]
          } : {
            shareMediaCategory: "NONE"
          })
        }
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('LinkedIn API Error Details:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        error: errorData
      });
      throw new Error(`LinkedIn API error: ${errorData.message || response.statusText}`);
    }

    const linkedinResponse = await response.json();
    console.log("Successfully posted to LinkedIn:", linkedinResponse);
    
    // Log success status
    await logLinkedInStatus('expiring', 'success', {
      linkedinPostId: linkedinResponse.id,
      jobsPosted: jobPosts.length
    });
    
    // 🔥 AUTOMATICALLY POST TO FACEBOOK AFTER LINKEDIN SUCCESS
    try {
      console.log(`📘 Auto-posting expiring jobs to Facebook after LinkedIn success...`);
      const facebookResponse = await postExpiringSoonJobPostsToFacebook();
      console.log(`✅ Facebook auto-posting successful for expiring jobs`);
      
      // Return both responses
      return {
        linkedin: linkedinResponse,
        facebook: facebookResponse,
        autoPosted: true
      };
    } catch (facebookError) {
      console.error(`⚠️ Facebook auto-posting failed for expiring jobs:`, facebookError.message);
      
      // Return LinkedIn success with Facebook error
      return {
        linkedin: linkedinResponse,
        facebook: null,
        autoPosted: false,
        facebookError: facebookError.message
      };
    }

  } catch (error) {
    console.error("Failed to post to LinkedIn:", error);
    
    // Log failure status
    await logLinkedInStatus('expiring', 'failed', {
      jobsPosted: 0,
      errorMessage: error.message
    });
    
    throw error;
  }
};

// Utility function to validate LinkedIn credentials
const validateLinkedInCredentials = () => {
  const requiredEnvVars = [
    'LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET', 
    'LINKEDIN_ACCESS_TOKEN',
    'LINKEDIN_ORGANIZATION_ID'
  ];

  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missing.length) {
    console.error('❌ LinkedIn ETL Configuration Error:');
    console.error(`   Missing required environment variables: ${missing.join(', ')}`);
    console.error('');
    console.error('💡 To fix this:');
    console.error('   1. Create a LinkedIn Developer App at https://developer.linkedin.com/');
    console.error('   2. Get your Client ID, Client Secret, and Access Token');
    console.error('   3. Add these to your .env file:');
    console.error('      LINKEDIN_CLIENT_ID=your_client_id');
    console.error('      LINKEDIN_CLIENT_SECRET=your_client_secret');
    console.error('      LINKEDIN_ACCESS_TOKEN=your_access_token');
    console.error('      LINKEDIN_ORGANIZATION_ID=your_org_id');
    console.error('      LINKEDIN_REFRESH_TOKEN=your_refresh_token (optional)');
    throw new Error(`Missing required LinkedIn credentials: ${missing.join(', ')}`);
  }
  
  // Validate organization ID format
  const orgId = process.env.LINKEDIN_ORGANIZATION_ID;
  if (orgId && isNaN(orgId)) {
    console.warn('⚠️  LinkedIn Organization ID should be numeric');
  }
  
  console.log('✅ LinkedIn credentials validated successfully');
};

// Function to refresh LinkedIn access token
module.exports.refreshLinkedInToken = async () => {
  try {
    console.log('🔄 Attempting to refresh LinkedIn token...');
    
    // Check if refresh token exists
    if (!process.env.LINKEDIN_REFRESH_TOKEN) {
      throw new Error('Missing LinkedIn refresh token. Manual re-authentication required.');
    }

    const refreshUrl = 'https://www.linkedin.com/oauth/v2/accessToken';
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.LINKEDIN_REFRESH_TOKEN,
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET
    });

    const response = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('LinkedIn Token Refresh Error:', {
        status: response.status,
        statusText: response.statusText,
        error: errorData
      });
      throw new Error(`LinkedIn token refresh failed: ${errorData.error_description || response.statusText}`);
    }

    const tokenData = await response.json();
    
    // Note: In a production environment, you would save the new access token to your environment
    console.log('✅ LinkedIn token refreshed successfully');
    console.warn('⚠️  New access token received. Update your LINKEDIN_ACCESS_TOKEN environment variable:');
    console.log(`New Access Token: ${tokenData.access_token}`);
    
    // Temporarily update the process environment (only for this session)
    process.env.LINKEDIN_ACCESS_TOKEN = tokenData.access_token;
    
    return tokenData;

  } catch (error) {
    console.error('❌ Failed to refresh LinkedIn token:', error.message);
    console.warn('💡 Manual Steps Required:');
    console.warn('   1. Go to LinkedIn Developer Portal');
    console.warn('   2. Re-authenticate your application');
    console.warn('   3. Update LINKEDIN_ACCESS_TOKEN and LINKEDIN_REFRESH_TOKEN');
    throw error;
  }
};

// Test function to verify LinkedIn ETL setup
// Function to log LinkedIn posting status
const logLinkedInStatus = async (postType, status, stats = {}) => {
  try {
    // Create table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS linkedin_post_status (
        id SERIAL PRIMARY KEY,
        post_type VARCHAR(50) NOT NULL, -- 'expiring', 'network_it', 'network_political', etc.
        status VARCHAR(20) NOT NULL, -- 'success', 'failed', 'no_content'
        linkedin_post_id VARCHAR(255), -- The actual LinkedIn post ID
        jobs_posted INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    // Insert status
    const query = `
      INSERT INTO linkedin_post_status 
      (post_type, status, linkedin_post_id, jobs_posted, error_message)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `;
    
    const result = await pool.query(query, [
      postType,
      status,
      stats.linkedinPostId || null,
      stats.jobsPosted || 0,
      stats.errorMessage || null
    ]);
    
    return result.rows[0].id;
    
  } catch (error) {
    console.error(`Error logging LinkedIn status for ${postType}:`, error);
    return null;
  }
};

// Function to get latest LinkedIn posting status
const getLatestLinkedInStatus = async () => {
  try {
    const query = `
      SELECT 
        post_type,
        status,
        linkedin_post_id,
        jobs_posted,
        error_message,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY post_type ORDER BY created_at DESC) as rn
      FROM linkedin_post_status
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY post_type, created_at DESC
    `;
    
    const result = await pool.query(query);
    
    // Get only the latest status for each post type
    const latestStatuses = result.rows.filter(row => row.rn === 1);
    
    return latestStatuses;
    
  } catch (error) {
    console.error('Error getting latest LinkedIn status:', error);
    return [];
  }
};

module.exports.testLinkedInSetup = async () => {
  try {
    console.log('🧪 Testing LinkedIn ETL setup...');
    
    // Test 1: Validate credentials
    console.log('1️⃣  Testing credentials validation...');
    validateLinkedInCredentials();
    
    // Test 2: Check image directory
    console.log('2️⃣  Testing image directory...');
    const imagePath = getRandomImage();
    if (imagePath) {
      console.log(`   ✅ Image found: ${path.basename(imagePath)}`);
    } else {
      console.log(`   ⚠️  No images found, will use text-only posts`);
    }
    
    // Test 3: Test database connection
    console.log('3️⃣  Testing database connection...');
    const testQuery = 'SELECT COUNT(*) as count FROM job_vacancies LIMIT 1';
    const result = await pool.query(testQuery);
    console.log(`   ✅ Database connected. Total jobs: ${result.rows[0].count}`);
    
    // Test 4: Check LinkedIn API access (just validate token format)
    console.log('4️⃣  Testing LinkedIn API access...');
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    if (!token || token.length < 50) {
      throw new Error('LinkedIn access token appears to be invalid (too short)');
    }
    console.log(`   ✅ Access token format looks valid (${token.length} characters)`);
    
    console.log('');
    console.log('🎉 LinkedIn ETL setup test completed successfully!');
    console.log('💡 You can now run LinkedIn posting functions.');
    
    return { success: true, message: 'All tests passed' };
    
  } catch (error) {
    console.error('❌ LinkedIn ETL setup test failed:', error.message);
    throw error;
  }
};

module.exports.logLinkedInStatus = logLinkedInStatus;
module.exports.getLatestLinkedInStatus = getLatestLinkedInStatus;

// Export utility function
module.exports.validateLinkedInCredentials = validateLinkedInCredentials;

// =====================================================
// FACEBOOK POSTING FUNCTIONALITY
// =====================================================

// Function to upload image to Facebook and get photo ID
const uploadImageToFacebook = async (imagePath) => {
  try {
    console.log(`📸 Uploading image to Facebook: ${path.basename(imagePath)}`);
    
    // First, upload the image to get a photo ID
    const formData = new FormData();
    formData.append('source', fs.createReadStream(imagePath));
    formData.append('access_token', process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
    
    const uploadUrl = `https://graph.facebook.com/v18.0/${process.env.FACEBOOK_PAGE_ID}/photos`;
    
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Facebook image upload error:', errorData);
      throw new Error(`Facebook image upload failed: ${errorData.error?.message || response.statusText}`);
    }
    
    const result = await response.json();
    console.log(`✅ Image uploaded successfully: ${result.id}`);
    return result.id;
    
  } catch (error) {
    console.error('Error uploading image to Facebook:', error);
    return null;
  }
};

// Utility function to validate Facebook credentials
const validateFacebookCredentials = () => {
  const requiredEnvVars = [
    'FACEBOOK_APP_ID',
    'FACEBOOK_APP_SECRET', 
    'FACEBOOK_PAGE_ACCESS_TOKEN',
    'FACEBOOK_PAGE_ID'
  ];

  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missing.length) {
    console.error('❌ Facebook ETL Configuration Error:');
    console.error(`   Missing required environment variables: ${missing.join(', ')}`);
    console.error('');
    console.error('💡 To fix this:');
    console.error('   1. Create a Facebook Developer App at https://developers.facebook.com/');
    console.error('   2. Create a Facebook Page for your business');
    console.error('   3. Get your Page Access Token and Page ID');
    console.error('   4. Add these to your .env file:');
    console.error('      FACEBOOK_APP_ID=your_app_id');
    console.error('      FACEBOOK_APP_SECRET=your_app_secret');
    console.error('      FACEBOOK_PAGE_ACCESS_TOKEN=your_page_access_token');
    console.error('      FACEBOOK_PAGE_ID=your_page_id');
    throw new Error(`Missing required Facebook credentials: ${missing.join(', ')}`);
  }
  
  console.log('✅ Facebook credentials validated successfully');
};

// Function to log Facebook posting status
const logFacebookStatus = async (postType, status, stats = {}) => {
  try {
    // Create table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facebook_post_status (
        id SERIAL PRIMARY KEY,
        post_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL,
        facebook_post_id VARCHAR(100),
        jobs_posted INTEGER DEFAULT 0,
        error_message TEXT,
        stats JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Insert status log
    await pool.query(`
      INSERT INTO facebook_post_status (post_type, status, facebook_post_id, jobs_posted, error_message, stats)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      postType,
      status,
      stats.facebookPostId || null,
      stats.jobsPosted || 0,
      stats.errorMessage || null,
      JSON.stringify(stats)
    ]);

    console.log(`📊 Facebook status logged: ${postType} - ${status}`);
  } catch (error) {
    console.error('Error logging Facebook status:', error);
  }
};

// Post job network jobs to Facebook
const postJobNetworkPostsToFacebook = async (jobNetwork) => {
  try {
    // Validate Facebook credentials first
    validateFacebookCredentials();

    // Get job posts (same query as LinkedIn)
    const queryDistinct = `
      SELECT DISTINCT ON (organization_id)
        id, 
        job_id, 
        job_title,
        duty_station,
        job_level,
        apply_link,
        created,
        end_date,
        organization_id,
        jn
      FROM 
        public.job_vacancies
      WHERE 
        jn = $1
      ORDER BY organization_id, created DESC
      LIMIT 5
    `;

    const resultDistinct = await pool.query(queryDistinct, [jobNetwork]);
    let jobPosts = resultDistinct.rows;

    // If less than 5 records, fill in with jobs from any organization
    if (jobPosts.length < 5) {
      const remainingSlots = 5 - jobPosts.length;
      const queryFill = `
        SELECT 
          id, 
          job_id, 
          job_title,
          duty_station,
          job_level,
          apply_link,
          created,
          end_date,
          organization_id,
          jn
        FROM 
          public.job_vacancies
        WHERE 
          jn = $1
        ORDER BY created DESC
        LIMIT ${remainingSlots}
      `;

      const resultFill = await pool.query(queryFill, [jobNetwork]);
      jobPosts = jobPosts.concat(resultFill.rows);
    }

    if (!jobPosts.length) {
      console.log(`No job posts found for job network: ${jobNetwork}`);
      
      await logFacebookStatus(`network_${jobNetwork.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, 'no_content', {
        jobsPosted: 0,
        errorMessage: 'No jobs found for this network'
      });
      
      return;
    }

    // Create engaging and varied Facebook message templates
    const formatBeautifulFacebookMessage = (jobs, network) => {
      const networkEmojis = {
        'IT': '💻',
        'Finance': '💰',
        'HR': '👥',
        'Legal': '⚖️',
        'Communications': '📢',
        'Operations': '⚙️',
        'Programme': '🌍',
        'Management': '👔',
        'Administration': '📋',
        'Security': '🛡️',
        'Logistics': '📦'
      };
      
      const networkEmoji = networkEmojis[network] || '🌟';
      
      // Multiple template variations for variety
      const templates = [
        // Template 1: Professional & Clean
        () => {
          let message = `${networkEmoji} NEW ${network.toUpperCase()} OPPORTUNITIES ${networkEmoji}\n\n`;
          message += `🌍 Ready to make a global impact? Join the United Nations team!\n\n`;
          
          jobs.forEach((job, index) => {
            const emoji = ['🎯', '⭐', '💡', '🌟', '✨'][index] || '📌';
            message += `${emoji} ${job.job_title}\n`;
            message += `📍 ${job.duty_station || 'Multiple Locations'}`;
            if (job.job_level) message += ` • ${job.job_level}`;
            if (job.end_date) {
              const deadline = new Date(job.end_date).toLocaleDateString('en-US', { 
                month: 'short', day: 'numeric' 
              });
              message += ` • Deadline: ${deadline}`;
            }
            message += `\n🔗 Apply: unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        },
        
        // Template 2: Impact-Focused
        () => {
          let message = `🚀 CHANGE THE WORLD WITH YOUR CAREER 🚀\n\n`;
          message += `${networkEmoji} Amazing ${network} opportunities just dropped at the UN!\n\n`;
          message += `💫 Why these roles matter:\n• Shape global policies\n• Support humanitarian missions\n• Drive sustainable development\n\n`;
          
          jobs.forEach((job, index) => {
            message += `${index + 1}️⃣ ${job.job_title}\n`;
            message += `   📍 ${job.duty_station || 'Global'}`;
            if (job.job_level) message += ` | ${job.job_level}`;
            message += `\n   👆 unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        },
        
        // Template 3: Urgent & Engaging
        () => {
          const urgencyWords = ['BREAKING', 'URGENT', 'HOT', 'FRESH', 'NEW'];
          const urgency = urgencyWords[Math.floor(Math.random() * urgencyWords.length)];
          
          let message = `🔥 ${urgency}: ${network.toUpperCase()} JOBS ALERT! 🔥\n\n`;
          message += `The UN is hiring NOW! Don't miss these incredible opportunities to:\n`;
          message += `✅ Work with world leaders\n✅ Travel globally\n✅ Make real impact\n\n`;
          
          jobs.forEach((job, index) => {
            const bullets = ['🔸', '🔹', '🔸', '🔹', '🔸'][index] || '🔸';
            message += `${bullets} ${job.job_title}\n`;
            message += `   Location: ${job.duty_station || 'Various'}`;
            if (job.end_date) {
              const deadline = new Date(job.end_date).toLocaleDateString('en-US', { 
                month: 'short', day: 'numeric' 
              });
              message += ` | Closes ${deadline}`;
            }
            message += `\n   Apply → unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        },
        
        // Template 4: Story-Driven
        () => {
          let message = `💭 Imagine working where your decisions impact millions...\n\n`;
          message += `${networkEmoji} That's reality at the UN! Check out these ${network} roles:\n\n`;
          
          jobs.forEach((job, index) => {
            const stories = [
              'Transform communities',
              'Build lasting peace', 
              'Champion human rights',
              'Fight global poverty',
              'Protect our planet'
            ];
            const story = stories[index] || 'Create positive change';
            
            message += `🌟 ${job.job_title}\n`;
            message += `💡 ${story} from ${job.duty_station || 'around the world'}`;
            if (job.job_level) message += ` (${job.job_level})`;
            message += `\n🎯 Start here: unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        }
      ];
      
      // Randomly select a template for variety
      const selectedTemplate = templates[Math.floor(Math.random() * templates.length)];
      let message = selectedTemplate();
      
      // Add call-to-action and social proof
      const ctas = [
        '🚀 Ready to change the world? Apply today!',
        '💫 Your global career starts here!',
        '🌍 Join thousands making a difference!',
        '✨ Be part of something bigger!',
        '🎯 Your impact starts with one application!'
      ];
      
      const selectedCta = ctas[Math.floor(Math.random() * ctas.length)];
      message += `${selectedCta}\n\n`;
      
      message += `📲 Follow @unjobzone for daily opportunities\n`;
      message += `🌐 More jobs: unjobzone.com\n\n`;
      
      // Dynamic hashtags based on content
      const baseHashtags = ['#UNJobs', '#UnitedNations', '#GlobalCareers', '#UNJobZone'];
      const networkHashtags = [`#${network.replace(/\s+/g, '')}Jobs`, `#${network}Careers`];
      const impactHashtags = ['#MakeADifference', '#GlobalImpact', '#HumanitarianWork'];
      const careerHashtags = ['#InternationalCareers', '#CareerOpportunity', '#DreamJob'];
      
      // Randomly mix hashtags for variety
      const allHashtags = [...baseHashtags, ...networkHashtags, ...impactHashtags, ...careerHashtags];
      const shuffledHashtags = allHashtags.sort(() => Math.random() - 0.5).slice(0, 10);
      
      message += shuffledHashtags.join(' ');
      
      return message;
    };

    const message = formatBeautifulFacebookMessage(jobPosts, jobNetwork);

    // Try to get a random image
    const imagePath = getRandomImage();
    if (imagePath) {
      console.log(`📸 Selected random image for Facebook post: ${path.basename(imagePath)}`);
    } else {
      console.log('📝 No image available, creating text-only Facebook post');
    }

    // Post to Facebook with image
    let response;
    
    // Debug environment variables in production
    console.log(`🔍 DEBUG - Facebook Page ID: "${process.env.FACEBOOK_PAGE_ID}" (type: ${typeof process.env.FACEBOOK_PAGE_ID}, length: ${process.env.FACEBOOK_PAGE_ID ? process.env.FACEBOOK_PAGE_ID.length : 'N/A'})`);
    
    // Use feed endpoint for all posts (photos endpoint has technical issues)
    console.log(`📝 Posting to Facebook feed${imagePath ? ' (with image note)' : ''}`);
    const url = `https://graph.facebook.com/v18.0/${process.env.FACEBOOK_PAGE_ID}/feed`;
    
    // If we have an image, mention it in the message
    let finalMessage = message;
    if (imagePath) {
      finalMessage += `\n\n📸 Image: ${path.basename(imagePath)}`;
      console.log(`📸 Including image reference: ${path.basename(imagePath)}`);
    }
    
    const payload = {
      message: finalMessage,
      access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN
    };

    response = await fetch(url, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Facebook API Error Details:', errorData);
      throw new Error(`Facebook API error: ${errorData.error?.message || response.statusText}`);
    }

    const facebookResponse = await response.json();
    console.log("Successfully posted to Facebook:", facebookResponse);
    
    // Log success status
    await logFacebookStatus(`network_${jobNetwork.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, 'success', {
      facebookPostId: facebookResponse.id,
      jobsPosted: jobPosts.length
    });
    
    return facebookResponse;

  } catch (error) {
    console.error(`Failed to post to Facebook for job network: ${jobNetwork}`, error);
    
    await logFacebookStatus(`network_${jobNetwork.toLowerCase().replace(/[^a-z0-9]/g, '_')}`, 'failed', {
      jobsPosted: 0,
      errorMessage: error.message
    });
    
    throw error;
  }
};

// Post expiring soon jobs to Facebook
const postExpiringSoonJobPostsToFacebook = async () => {
  try {
    validateFacebookCredentials();

    // Get expiring jobs (same query as LinkedIn)
    const queryDistinct = `
      SELECT DISTINCT ON (organization_id)
        id, 
        job_id, 
        job_title,
        duty_station,
        job_level,
        apply_link,
        created,
        end_date,
        organization_id
      FROM 
        public.job_vacancies
      WHERE 
        DATE(end_date) = CURRENT_DATE OR DATE(end_date) = CURRENT_DATE + INTERVAL '1 day'
      ORDER BY organization_id, created DESC
      LIMIT 5
    `;

    const resultDistinct = await pool.query(queryDistinct);
    let jobPosts = resultDistinct.rows;

    if (jobPosts.length < 5) {
      const remainingSlots = 5 - jobPosts.length;
      const queryFill = `
        SELECT 
          id, 
          job_id, 
          job_title,
          duty_station,
          job_level,
          apply_link,
          created,
          end_date,
          organization_id
        FROM 
          public.job_vacancies
        WHERE 
          DATE(end_date) = CURRENT_DATE OR DATE(end_date) = CURRENT_DATE + INTERVAL '1 day'
        ORDER BY created DESC
        LIMIT ${remainingSlots}
      `;

      const resultFill = await pool.query(queryFill);
      jobPosts = jobPosts.concat(resultFill.rows);
    }

    if (!jobPosts.length) {
      console.log("No expiring job posts found to share on Facebook");
      
      await logFacebookStatus('expiring', 'no_content', {
        jobsPosted: 0,
        errorMessage: 'No jobs expiring today or tomorrow'
      });
      
      return;
    }

    // Create beautiful and urgent message for expiring jobs - mobile optimized
    const formatBeautifulExpiringMessage = (jobs) => {
      const urgencyTemplates = [
        // Template 1: High Urgency
        () => {
          let message = `🚨 DEADLINE ALERT! Last chance to apply! 🚨\n\n`;
          message += `These UN opportunities are closing VERY soon:\n\n`;
          
          jobs.forEach((job, index) => {
            const endDate = new Date(job.end_date);
            const today = new Date();
            const isToday = endDate.toDateString() === today.toDateString();
            const isTomorrow = endDate.toDateString() === new Date(today.getTime() + 24*60*60*1000).toDateString();
            
            let urgencyText = '';
            if (isToday) {
              urgencyText = '🔥 CLOSES TODAY!';
            } else if (isTomorrow) {
              urgencyText = '⚡ CLOSES TOMORROW!';
            } else {
              urgencyText = `⏰ Closes ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
            }
            
            message += `${index + 1}️⃣ ${job.job_title}\n`;
            message += `📍 ${job.duty_station || 'Global'}`;
            if (job.job_level) message += ` • ${job.job_level}`;
            message += `\n${urgencyText}\n`;
            message += `👆 Apply: unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        },
        
        // Template 2: Countdown Style
        () => {
          let message = `⏰ COUNTDOWN: Final hours to apply! ⏰\n\n`;
          
          jobs.forEach((job, index) => {
            const endDate = new Date(job.end_date);
            const today = new Date();
            const daysLeft = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
            
            let countdownEmoji = '';
            if (daysLeft <= 0) countdownEmoji = '🚨';
            else if (daysLeft === 1) countdownEmoji = '⚡';
            else if (daysLeft <= 3) countdownEmoji = '🔥';
            else countdownEmoji = '⏰';
            
            message += `${countdownEmoji} ${job.job_title}\n`;
            message += `📍 ${job.duty_station || 'Various locations'}`;
            if (job.job_level) message += ` | ${job.job_level}`;
            
            if (daysLeft <= 0) {
              message += `\n🚨 DEADLINE PASSED - Check if still accepting!\n`;
            } else if (daysLeft === 1) {
              message += `\n⚡ LAST DAY TO APPLY!\n`;
            } else {
              message += `\n⏰ ${daysLeft} days left\n`;
            }
            
            message += `🔗 unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        },
        
        // Template 3: Opportunity Focus
        () => {
          let message = `💫 Don't let these slip away! 💫\n\n`;
          message += `Amazing UN careers closing soon:\n\n`;
          
          jobs.forEach((job, index) => {
            const motivations = [
              'Change the world',
              'Make global impact',
              'Lead humanitarian efforts',
              'Shape policy',
              'Build peace'
            ];
            const motivation = motivations[index] || 'Create change';
            
            message += `🎯 ${job.job_title}\n`;
            message += `💡 ${motivation} from ${job.duty_station || 'anywhere'}\n`;
            
            const endDate = new Date(job.end_date);
            const deadline = endDate.toLocaleDateString('en-US', { 
              month: 'short', 
              day: 'numeric',
              year: 'numeric'
            });
            message += `⌛ Deadline: ${deadline}\n`;
            message += `✨ Apply: unjobzone.com/job/${job.id}\n\n`;
          });
          return message;
        }
      ];
      
      // Select random template for variety
      const selectedTemplate = urgencyTemplates[Math.floor(Math.random() * urgencyTemplates.length)];
      let message = selectedTemplate();
      
      message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      message += `💡 Pro Tip: Application deadlines are FIRM!\n`;
      message += `⚡ Submit your application TODAY to secure your chance!\n\n`;
      
      message += `🌟 Why UN Careers?\n`;
      message += `✅ Make a global impact\n`;
      message += `✅ Work for world peace and development\n`;
      message += `✅ Competitive international packages\n`;
      message += `✅ Career growth opportunities\n\n`;
      
      message += `🎯 Ready to change the world? Apply NOW before it's too late!\n`;
      message += `📱 Visit: www.unjobzone.com\n\n`;
      
      // Enhanced hashtags for urgency
      const hashtags = [
        '#UNJobs',
        '#JobDeadline',
        '#LastChance',
        '#ApplyNow',
        '#UrgentOpportunity',
        '#InternationalCareers',
        '#UnitedNations',
        '#FinalCall',
        '#CareerOpportunity',
        '#DontMissOut',
        '#UNJobZone',
        '#ClosingSoon'
      ];
      
      message += hashtags.join(' ');
      
      return message;
    };

    const message = formatBeautifulExpiringMessage(jobPosts);

    // Try to get a random image
    const imagePath = getRandomImage();
    if (imagePath) {
      console.log(`📸 Selected random image for expiring jobs Facebook post: ${path.basename(imagePath)}`);
    } else {
      console.log('📝 No image available, creating text-only Facebook post for expiring jobs');
    }

    // Post to Facebook with image
    let response;
    
    // Debug environment variables in production
    console.log(`🔍 DEBUG (Expiring) - Facebook Page ID: "${process.env.FACEBOOK_PAGE_ID}" (type: ${typeof process.env.FACEBOOK_PAGE_ID}, length: ${process.env.FACEBOOK_PAGE_ID ? process.env.FACEBOOK_PAGE_ID.length : 'N/A'})`);
    
    // Use feed endpoint for all posts (photos endpoint has technical issues)
    console.log(`📝 Posting expiring jobs to Facebook feed${imagePath ? ' (with image note)' : ''}`);
    const url = `https://graph.facebook.com/v18.0/${process.env.FACEBOOK_PAGE_ID}/feed`;
    
    // If we have an image, mention it in the message
    let finalMessage = message;
    if (imagePath) {
      finalMessage += `\n\n📸 Image: ${path.basename(imagePath)}`;
      console.log(`📸 Including image reference: ${path.basename(imagePath)}`);
    }
    
    const payload = {
      message: finalMessage,
      access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN
    };

    response = await fetch(url, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Facebook API Error Details:', errorData);
      throw new Error(`Facebook API error: ${errorData.error?.message || response.statusText}`);
    }

    const facebookResponse = await response.json();
    console.log("Successfully posted to Facebook:", facebookResponse);
    
    await logFacebookStatus('expiring', 'success', {
      facebookPostId: facebookResponse.id,
      jobsPosted: jobPosts.length
    });
    
    return facebookResponse;

  } catch (error) {
    console.error("Failed to post to Facebook:", error);
    
    await logFacebookStatus('expiring', 'failed', {
      jobsPosted: 0,
      errorMessage: error.message
    });
    
    throw error;
  }
};

// Combined function to post to both LinkedIn and Facebook
const postJobNetworkPostsToBothPlatforms = async (jobNetwork) => {
  const results = {
    linkedin: null,
    facebook: null,
    errors: []
  };

  // Post to LinkedIn first
  try {
    console.log(`🔗 Posting ${jobNetwork} jobs to LinkedIn...`);
    results.linkedin = await module.exports.postJobNetworkPostsToLinkedIn(jobNetwork);
    console.log(`✅ LinkedIn posting successful for ${jobNetwork}`);
  } catch (linkedinError) {
    console.error(`❌ LinkedIn posting failed for ${jobNetwork}:`, linkedinError.message);
    results.errors.push(`LinkedIn: ${linkedinError.message}`);
  }

  // Post to Facebook
  try {
    console.log(`📘 Posting ${jobNetwork} jobs to Facebook...`);
    results.facebook = await postJobNetworkPostsToFacebook(jobNetwork);
    console.log(`✅ Facebook posting successful for ${jobNetwork}`);
  } catch (facebookError) {
    console.error(`❌ Facebook posting failed for ${jobNetwork}:`, facebookError.message);
    results.errors.push(`Facebook: ${facebookError.message}`);
  }

  return results;
};

// Combined function to post expiring jobs to both platforms
const postExpiringSoonJobsToBothPlatforms = async () => {
  const results = {
    linkedin: null,
    facebook: null,
    errors: []
  };

  // Post to LinkedIn first
  try {
    console.log(`🔗 Posting expiring jobs to LinkedIn...`);
    results.linkedin = await module.exports.postExpiringSoonJobPostsToLinkedIn();
    console.log(`✅ LinkedIn posting successful for expiring jobs`);
  } catch (linkedinError) {
    console.error(`❌ LinkedIn posting failed for expiring jobs:`, linkedinError.message);
    results.errors.push(`LinkedIn: ${linkedinError.message}`);
  }

  // Post to Facebook
  try {
    console.log(`📘 Posting expiring jobs to Facebook...`);
    results.facebook = await postExpiringSoonJobPostsToFacebook();
    console.log(`✅ Facebook posting successful for expiring jobs`);
  } catch (facebookError) {
    console.error(`❌ Facebook posting failed for expiring jobs:`, facebookError.message);
    results.errors.push(`Facebook: ${facebookError.message}`);
  }

  return results;
};

// Test function for Facebook setup
const testFacebookSetup = async () => {
  try {
    console.log('🧪 Testing Facebook ETL setup...');
    
    // Test 1: Validate credentials
    console.log('1️⃣  Testing credentials validation...');
    validateFacebookCredentials();
    
    // Test 2: Check image directory (reuse existing function)
    console.log('2️⃣  Testing image directory...');
    const imagePath = getRandomImage();
    if (imagePath) {
      console.log(`   ✅ Image found: ${path.basename(imagePath)}`);
    } else {
      console.log(`   ⚠️  No images found, will use text-only posts`);
    }
    
    // Test 3: Test database connection
    console.log('3️⃣  Testing database connection...');
    await pool.query('SELECT COUNT(*) FROM job_vacancies LIMIT 1');
    console.log('   ✅ Database connection successful');
    
    // Test 4: Test Facebook API connection
    console.log('4️⃣  Testing Facebook API connection...');
    const testUrl = `https://graph.facebook.com/v18.0/${process.env.FACEBOOK_PAGE_ID}?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}&fields=id,name`;
    const testResponse = await fetch(testUrl);
    
    if (!testResponse.ok) {
      const errorData = await testResponse.json();
      throw new Error(`Facebook API test failed: ${errorData.error?.message}`);
    }
    
    const pageData = await testResponse.json();
    console.log(`   ✅ Facebook API connection successful - Page: ${pageData.name}`);
    
    console.log('\n🎉 All Facebook ETL tests passed!');
    
  } catch (error) {
    console.error('❌ Facebook ETL setup test failed:', error.message);
    throw error;
  }
};

// Export Facebook functions
module.exports.postJobNetworkPostsToFacebook = postJobNetworkPostsToFacebook;
module.exports.postExpiringSoonJobPostsToFacebook = postExpiringSoonJobPostsToFacebook;
module.exports.postJobNetworkPostsToBothPlatforms = postJobNetworkPostsToBothPlatforms;
module.exports.postExpiringSoonJobsToBothPlatforms = postExpiringSoonJobsToBothPlatforms;
module.exports.testFacebookSetup = testFacebookSetup;
module.exports.validateFacebookCredentials = validateFacebookCredentials;
module.exports.logFacebookStatus = logFacebookStatus;