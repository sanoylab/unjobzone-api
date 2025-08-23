# Facebook ETL Implementation Guide

## Overview

Successfully implemented Facebook page posting functionality that mirrors your existing LinkedIn ETL system. The key feature is **automatic dual-platform posting** - every time a job is posted to LinkedIn, it will automatically be posted to Facebook as well.

## 🎯 Key Features Implemented

### 1. **Automatic Dual-Platform Posting**
- ✅ Every LinkedIn post automatically triggers a Facebook post
- ✅ Same job data, optimized formatting for each platform
- ✅ Error handling - LinkedIn success even if Facebook fails
- ✅ Comprehensive logging for both platforms

### 2. **Manual Control Options**
- ✅ Post to Facebook only
- ✅ Post to LinkedIn only (existing)
- ✅ Post to both platforms simultaneously
- ✅ Test individual platform configurations

### 3. **Complete API Integration**
- ✅ Facebook Graph API v18.0 integration
- ✅ Image upload support for Facebook posts
- ✅ Page Access Token authentication
- ✅ Error handling and retry logic

### 4. **Database Tracking**
- ✅ Facebook posting status tracking
- ✅ Performance comparison between platforms
- ✅ Detailed statistics and reporting
- ✅ Error logging and debugging

## 📁 Files Modified/Created

### Created Files:
1. **`src/etl/test-facebook.js`** - Facebook configuration test script
2. **`FACEBOOK_ETL_IMPLEMENTATION.md`** - This documentation

### Modified Files:
1. **`src/etl/social-media.js`** - Added Facebook functions + auto-posting
2. **`src/controllers/etlController.js`** - Added Facebook controllers  
3. **`src/routers/etl.js`** - Added Facebook API routes
4. **`src/etl/database-schema.sql`** - Added Facebook tracking tables
5. **`package.json`** - Added form-data dependency

## 🚀 New API Endpoints

### Facebook-Only Endpoints:
```bash
# Test Facebook configuration
GET /api/v1/etl/test-facebook-etl

# Post to Facebook only
POST /api/v1/etl/trigger-facebook-post
{
  "type": "expiring",           # or "network"
  "jobNetwork": "IT"            # required for network type
}
```

### Dual-Platform Endpoints:
```bash
# Post to both LinkedIn and Facebook
POST /api/v1/etl/trigger-both-platforms-post
{
  "type": "network",
  "jobNetwork": "Political"
}
```

### Enhanced LinkedIn Endpoints:
```bash
# Now automatically posts to Facebook too!
POST /api/v1/etl/trigger-linkedin-post
{
  "type": "expiring"
}
```

## 🔧 Environment Variables Required

Add these to your `.env` file:

```env
# Facebook Configuration
FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret  
FACEBOOK_PAGE_ACCESS_TOKEN=your_page_access_token
FACEBOOK_PAGE_ID=your_facebook_page_id
```

## 🧪 Testing Your Setup

### 1. Test Facebook Configuration:
```bash
node src/etl/test-facebook.js
```

### 2. Test via API:
```bash
# Test Facebook setup
curl -X GET "http://localhost:3000/api/v1/etl/test-facebook-etl" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test Facebook posting  
curl -X POST "http://localhost:3000/api/v1/etl/trigger-facebook-post" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "expiring"}'

# Test dual platform posting
curl -X POST "http://localhost:3000/api/v1/etl/trigger-both-platforms-post" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "network", "jobNetwork": "IT"}'
```

## 🔄 How Auto-Posting Works

When you call the existing LinkedIn functions:

1. **LinkedIn Post Executes** → Posts job to LinkedIn
2. **LinkedIn Success** → Automatically triggers Facebook post
3. **Facebook Post Executes** → Posts same jobs to Facebook
4. **Return Combined Results** → Success/failure status for both platforms

### Example Response:
```json
{
  "success": true,
  "data": {
    "linkedin": {
      "id": "urn:li:share:123456789"
    },
    "facebook": {
      "id": "123456789_987654321"
    },
    "autoPosted": true
  }
}
```

If Facebook fails but LinkedIn succeeds:
```json
{
  "success": true,
  "data": {
    "linkedin": {
      "id": "urn:li:share:123456789"
    },
    "facebook": null,
    "autoPosted": false,
    "facebookError": "Invalid access token"
  }
}
```

## 📊 Database Tracking

New tables and functions added:

### Tables:
- **`facebook_post_status`** - Tracks all Facebook posting attempts
- **`latest_facebook_status`** - View for latest status per post type

### Functions:
- **`get_facebook_statistics(days_back)`** - Facebook posting stats
- **`get_social_media_comparison(days_back)`** - LinkedIn vs Facebook performance

### Usage:
```sql
-- Get Facebook posting stats for last 7 days
SELECT * FROM get_facebook_statistics(7);

-- Compare LinkedIn vs Facebook performance  
SELECT * FROM get_social_media_comparison(7);

-- View latest Facebook posting status
SELECT * FROM latest_facebook_status;
```

## 🔍 Message Formatting

### LinkedIn Message Format:
```
🌐 Job Opportunities in IT Network:

📌 Senior Software Engineer
📍 New York, NY
🔗 Apply: https://www.unjobzone.com/job/123

#UnitedNations #jobs #unjobs #careers #hiring #jobsearch #unjobzone #UN
```

### Facebook Message Format:
```
🌐 New Job Opportunities in IT Network!

📌 Senior Software Engineer
📍 New York, NY
🔗 Apply: https://www.unjobzone.com/job/123

#UNJobs #ITJobs #InternationalCareers #Development #Humanitarian #UNJobZone
```

## 🚨 Error Handling

The system gracefully handles various error scenarios:

### Facebook API Errors:
- Invalid access token → Detailed error message
- Page permission issues → Clear troubleshooting steps
- Image upload failures → Falls back to text-only posts
- Rate limiting → Logs error, continues LinkedIn operation

### Automatic Fallbacks:
- LinkedIn succeeds, Facebook fails → LinkedIn post preserved
- Image upload fails → Text-only posting
- Missing credentials → Clear setup instructions
- Database errors → Operations continue, logging disabled

## 🎛️ Configuration Options

### Disable Auto-Posting (if needed):
If you want to disable automatic Facebook posting, you can modify the LinkedIn functions to skip the Facebook auto-posting section.

### Custom Message Templates:
Modify the message formatting in the Facebook posting functions to match your brand voice.

### Platform-Specific Images:
The system uses the same image pool for both platforms, but you can modify it to use platform-specific images.

## 📈 Monitoring & Analytics

### Real-time Monitoring:
```bash
# Check latest posting status
curl -X GET "http://localhost:3000/api/v1/etl/dashboard"
```

### Database Queries:
```sql
-- Recent Facebook posts
SELECT post_type, status, jobs_posted, created_at 
FROM facebook_post_status 
ORDER BY created_at DESC 
LIMIT 10;

-- Success rates by platform
SELECT * FROM get_social_media_comparison(30);
```

## 🎯 Next Steps

1. **Create Facebook Page** - Complete page setup when ready
2. **Update Environment Variables** - Add Facebook credentials to production
3. **Run Database Schema** - Execute the new schema updates
4. **Test Integration** - Run test scripts to verify functionality
5. **Monitor Performance** - Use dashboard and database functions to track success

## 🔗 Related Documentation

- [Facebook Developers](https://developers.facebook.com/)
- [Facebook Graph API](https://developers.facebook.com/docs/graph-api/)
- [LinkedIn ETL Documentation](src/etl/test-linkedin.js)

## 🎉 Implementation Complete!

Your LinkedIn ETL now automatically posts to Facebook every time it posts a job. The system maintains full backward compatibility while adding powerful dual-platform capabilities.

**Key Achievement: Every LinkedIn post now reaches both LinkedIn and Facebook audiences automatically!** 🚀
