#!/bin/bash

# Script to install Chrome for Puppeteer in deployment environments

echo "🔧 Installing Chrome for Puppeteer..."

# Check if we're in a Docker environment
if [ -f /.dockerenv ]; then
    echo "📦 Docker environment detected"
    
    # Update package list
    apt-get update
    
    # Install Chrome dependencies
    apt-get install -y \
        wget \
        gnupg \
        ca-certificates \
        apt-transport-https \
        fonts-liberation \
        libappindicator3-1 \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libxss1 \
        libxtst6 \
        lsb-release \
        xdg-utils
    
    # Add Google Chrome repository
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list
    
    # Install Chrome
    apt-get update
    apt-get install -y google-chrome-stable
    
    # Clean up
    rm -rf /var/lib/apt/lists/*
    
    echo "✅ Chrome installed successfully"
else
    echo "🖥️  Non-Docker environment detected"
fi

# Install Puppeteer browsers
echo "🎭 Installing Puppeteer browsers..."
npx puppeteer browsers install chrome

# Verify installation
echo "🔍 Verifying Chrome installation..."
if command -v google-chrome >/dev/null 2>&1; then
    echo "✅ Chrome binary found: $(which google-chrome)"
    google-chrome --version
else
    echo "⚠️  Chrome binary not found in PATH"
fi

# Check Puppeteer cache
echo "📂 Checking Puppeteer cache..."
if [ -d "$HOME/.cache/puppeteer" ]; then
    echo "✅ Puppeteer cache found: $HOME/.cache/puppeteer"
    ls -la "$HOME/.cache/puppeteer"
else
    echo "⚠️  Puppeteer cache not found"
fi

echo "🎉 Chrome installation script completed!"
