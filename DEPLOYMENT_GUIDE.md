# ICAO Job Monitor - Deployment Guide

## 🚀 Deployment Solutions for Chrome/Puppeteer Issues

The ICAO Job Monitor uses Puppeteer to scrape JavaScript-heavy pages, but deployment environments often lack Chrome. This guide provides multiple solutions.

## 🔧 Solution 1: Updated Dockerfile (Recommended)

The updated `Dockerfile` now includes:

### Enhanced Chrome Installation
```dockerfile
# Install Chrome and all dependencies
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates apt-transport-https \
    fonts-liberation libappindicator3-1 libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libxss1 \
    libxtst6 lsb-release xdg-utils \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install Puppeteer browsers
RUN npx puppeteer browsers install chrome
```

### Build and Deploy
```bash
# Build the Docker image
docker build -t icao-job-monitor .

# Run with environment variables
docker run -d \
  -e MONITOR_EMAIL_USER=your-email@gmail.com \
  -e MONITOR_EMAIL_PASS=your-app-password \
  -e MONITOR_RECIPIENT_EMAIL=recipient@example.com \
  -p 3000:3000 \
  icao-job-monitor
```

## 🔧 Solution 2: Manual Chrome Installation

If you're deploying to a server without Docker:

### Install Chrome
```bash
# Run the installation script
npm run install-chrome

# Or manually:
./install-chrome.sh
```

### Install Puppeteer Browsers
```bash
# This happens automatically after npm install
npx puppeteer browsers install chrome
```

## 🔧 Solution 3: Environment Variables

Set these environment variables in your deployment:

```bash
# Point to system Chrome if available
export CHROME_BIN=/usr/bin/google-chrome

# Or for Chromium
export CHROME_BIN=/usr/bin/chromium-browser

# Puppeteer cache path
export PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
```

## 🔧 Solution 4: Platform-Specific Deployments

### Heroku
Add this to your `package.json`:
```json
{
  "scripts": {
    "postinstall": "npx puppeteer browsers install chrome"
  }
}
```

Add the Heroku Chrome buildpack:
```bash
heroku buildpacks:add jontewks/puppeteer
```

### Railway/Render
These platforms usually support the updated Dockerfile automatically.

### AWS Lambda
Use the `chrome-aws-lambda` package instead of regular Puppeteer.

## 🛡️ Fallback System

The job monitor now includes an **automatic fallback system**:

### How it Works
1. **Primary**: Tries Puppeteer with Chrome for full JavaScript rendering
2. **Fallback**: If Puppeteer fails, uses basic HTTP scraping with axios
3. **Notifications**: Still sends emails even with fallback method

### Fallback Limitations
- ⚠️ Cannot extract individual job details (JavaScript required)
- ✅ Can still detect page changes for notifications
- ✅ Emails will indicate "content updated" rather than specific jobs

### Testing Fallback
```bash
# Test fallback method
node test-fallback-scraping.js
```

## 📧 Email Notifications

Even with fallback mode, you'll still receive:
- ✅ **Change detection emails** when the page content changes
- ✅ **Morning summaries** at 8:00 AM
- ✅ **Evening summaries** at 6:00 PM
- ⚠️ **Limited job details** (fallback mode only detects changes, not specific jobs)

## 🔍 Troubleshooting

### Check Chrome Installation
```bash
# Verify Chrome is installed
which google-chrome
google-chrome --version

# Check Puppeteer cache
ls -la ~/.cache/puppeteer
```

### Check Logs
Look for these log messages:
- ✅ `🌐 Fetching job data from ICAO (with JavaScript rendering)...` - Puppeteer working
- ⚠️ `🌐 Fetching job data from ICAO (fallback HTTP method)...` - Using fallback
- ❌ `❌ Error fetching job data: Could not find Chrome` - Chrome not installed

### Manual Chrome Installation (Ubuntu/Debian)
```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google.list
sudo apt-get update
sudo apt-get install google-chrome-stable
npx puppeteer browsers install chrome
```

## 🎯 Deployment Checklist

- [ ] Updated Dockerfile with Chrome dependencies
- [ ] Environment variables set (email credentials)
- [ ] Chrome installation verified
- [ ] Puppeteer browsers installed
- [ ] Fallback system tested
- [ ] Email notifications tested

## 🚀 Quick Deploy Commands

```bash
# Build and test locally
docker build -t icao-job-monitor .
docker run -e MONITOR_EMAIL_USER=your@email.com -e MONITOR_EMAIL_PASS=your-password -p 3000:3000 icao-job-monitor

# Test email functionality
npm run test-job-monitor

# Test fallback system
node test-fallback-scraping.js
```

Your ICAO Job Monitor will now work reliably in any deployment environment! 🎉
