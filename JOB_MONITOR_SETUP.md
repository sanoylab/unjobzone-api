# ICAO Job Monitor Setup Guide

## Overview
The ICAO Job Monitor is a service that monitors the ICAO job postings page for updates and sends email notifications. It checks for changes every 10 minutes and sends daily summary emails.

## Features
- ✅ Monitors ICAO job postings every 10 minutes
- ✅ Sends instant email alerts when changes are detected
- ✅ Morning summary email at 8:00 AM
- ✅ Evening summary email at 6:00 PM
- ✅ Beautiful HTML email templates
- ✅ Change detection and job comparison
- ✅ Persistent data storage

## Email Configuration

### Step 1: Gmail App Password Setup
1. Go to your Google Account settings (https://myaccount.google.com/)
2. Select **Security**
3. Under "Signing in to Google," select **2-Step Verification** (must be enabled first)
4. At the bottom of the page, select **App passwords**
5. Enter a name for the app password (e.g., "Job Monitor")
6. Select **Generate**
7. Copy the 16-character password (this is your `MONITOR_EMAIL_PASS`)

### Step 2: Environment Variables
Add these variables to your `.env` file:

```bash
# ICAO Job Monitor Configuration
MONITOR_EMAIL_USER=your-gmail@gmail.com
MONITOR_EMAIL_PASS=your-16-character-app-password
MONITOR_RECIPIENT_EMAIL=recipient@example.com  # Optional, defaults to MONITOR_EMAIL_USER
```

## Running the Monitor

### Option 1: Integrated with Main App
The monitor automatically starts when you run the main application:
```bash
npm start
```

### Option 2: Standalone Monitor
Run only the job monitor:
```bash
node run-job-monitor.js
```

## Email Schedule
- **Every 10 minutes**: Check for updates and send alerts if changes detected
- **8:00 AM daily**: Morning summary with overnight changes
- **6:00 PM daily**: Evening summary with daily activity

## Monitored URL
https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs

## File Structure
- `src/job-monitor.js` - Main monitoring service
- `run-job-monitor.js` - Standalone runner script
- `src/job-monitor-data.json` - Persistent data storage (auto-created)

## Troubleshooting

### Common Issues
1. **Email not sending**: Check Gmail app password and 2FA settings
2. **No changes detected**: The service may need time to establish baseline data
3. **Permission errors**: Ensure the app has write permissions for data storage

### Logs
The monitor provides detailed console logging:
- 🔍 Checking for updates
- 📧 Email sent successfully
- 🚨 Changes detected
- ❌ Error messages

## Security Notes
- Uses Gmail App Passwords (more secure than regular passwords)
- Stores minimal data locally (job hashes and change logs)
- No sensitive job data is permanently stored
- Email credentials are only stored in environment variables

## Customization
You can modify the monitoring behavior by editing `src/job-monitor.js`:
- Change check frequency (currently every 10 minutes)
- Modify email templates
- Adjust change detection sensitivity
- Add additional notification channels
