#!/bin/bash

# Render.com build script for ICAO Job Monitor

echo "🚀 Starting Render.com build process..."

# Install dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Try to install Chrome browsers for Puppeteer
echo "🌐 Installing Chrome for Puppeteer..."
npx puppeteer browsers install chrome || {
    echo "⚠️  Puppeteer Chrome install failed, will use system browser"
}

# Verify Chrome installation
echo "🔍 Verifying Chrome installation..."
if command -v google-chrome >/dev/null 2>&1; then
    echo "✅ Google Chrome found: $(google-chrome --version)"
elif command -v chromium >/dev/null 2>&1; then
    echo "✅ Chromium found: $(chromium --version)"
    export CHROME_BIN=/usr/bin/chromium
    export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
else
    echo "⚠️  No Chrome/Chromium found - will use fallback mode"
fi

# Test email configuration (if environment variables are available)
if [ -n "$MONITOR_EMAIL_USER" ] && [ -n "$MONITOR_EMAIL_PASS" ]; then
    echo "📧 Testing email configuration..."
    npm run test-job-monitor || echo "⚠️  Email test failed - check credentials"
else
    echo "⚠️  Email environment variables not set - skipping email test"
fi

echo "✅ Render.com build completed successfully!"
