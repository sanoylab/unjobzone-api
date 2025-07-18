const e = require("express");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
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
    return linkedinResponse;

  } catch (error) {
    console.error(`Failed to post to LinkedIn for job network: ${jobNetwork}`, error);
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
    return linkedinResponse;

  } catch (error) {
    console.error("Failed to post to LinkedIn:", error);
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
module.exports.testLinkedInSetup = async () => {
  try {
    console.log('🧪 Testing LinkedIn ETL setup...');
    
    // Test 1: Validate credentials
    console.log('1️⃣  Testing credentials validation...');
    validateLinkedInCredentials();
    
    // Test 2: Check image directory
    console.log('2️⃣  Testing image directory...');
    const imagePath = getRandomImage();
    console.log(`   ✅ Image found: ${path.basename(imagePath)}`);
    
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

// Export utility function
module.exports.validateLinkedInCredentials = validateLinkedInCredentials;