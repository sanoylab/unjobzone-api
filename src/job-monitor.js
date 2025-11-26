// Job Monitor Service for ICAO Job Postings
// Monitors https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs
// Sends email notifications for updates, morning summaries, and evening summaries

const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');

class JobMonitor {
  constructor() {
    this.targetUrl = 'https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs';
    this.dataFile = path.join(__dirname, 'job-monitor-data.json');
    this.lastCheckData = null;
    this.dailyChanges = [];
    
    // Email configuration
    this.emailConfig = {
      service: 'gmail',
      auth: {
        user: process.env.MONITOR_EMAIL_USER, // Your Gmail address
        pass: process.env.MONITOR_EMAIL_PASS  // Your Gmail app password
      }
    };
    
    this.recipientEmail = process.env.MONITOR_RECIPIENT_EMAIL || process.env.MONITOR_EMAIL_USER;
    
    // Initialize transporter
    this.transporter = nodemailer.createTransport(this.emailConfig);
    
    console.log('🔍 Job Monitor initialized for ICAO jobs');
  }

  /**
   * Initialize the monitoring service by loading previous data
   */
  async initialize() {
    try {
      const data = await fs.readFile(this.dataFile, 'utf8');
      const parsedData = JSON.parse(data);
      this.lastCheckData = parsedData.lastCheckData;
      this.dailyChanges = parsedData.dailyChanges || [];
      console.log('📂 Loaded previous monitoring data');
    } catch (error) {
      console.log('📝 No previous data found, starting fresh');
      this.lastCheckData = null;
      this.dailyChanges = [];
    }
  }

  /**
   * Save current monitoring data to file
   */
  async saveData() {
    const data = {
      lastCheckData: this.lastCheckData,
      dailyChanges: this.dailyChanges,
      lastSaved: new Date().toISOString()
    };
    
    await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
  }

  /**
   * Fetch and parse job data from ICAO site using Puppeteer for JavaScript rendering
   */
  async fetchJobData() {
    let browser = null;
    
    try {
      console.log('🌐 Fetching job data from ICAO (with JavaScript rendering)...');
      
      // Launch Puppeteer browser
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
      
      const page = await browser.newPage();
      
      // Set user agent and viewport
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });
      
      // Navigate to the page
      console.log('📄 Loading page...');
      await page.goto(this.targetUrl, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
      
      // Wait for content to load - ICAO takes time to render
      console.log('⏳ Waiting for job content to load...');
      
      // Wait for potential job containers or loading indicators to disappear
      try {
        // Wait for either job results or "no jobs" message
        await page.waitForSelector([
          '[data-bind*="job"]',
          '.job-results',
          '.search-results',
          '.no-results',
          '.job-list',
          '.results-container',
          '.job-item',
          '.posting',
          '.opportunity'
        ].join(','), { timeout: 30000 });
      } catch (waitError) {
        console.log('⚠️  No specific job selectors found, continuing with page content...');
      }
      
      // Additional wait to ensure dynamic content is fully loaded
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Get page content after JavaScript execution
      const content = await page.content();
      const $ = cheerio.load(content);
      
      // Extract job information with improved selectors for ICAO
      const jobs = [];
      
      // ICAO specific selectors (based on typical Oracle HCM patterns)
      const oracleSelectors = [
        '[data-bind*="job"]',
        '[class*="job"]',
        '[id*="job"]',
        '.search-result',
        '.result-item',
        '.posting',
        '.opportunity',
        '.requisition',
        'article',
        '.card',
        '.list-item',
        '[role="listitem"]'
      ];
      
      let foundJobs = false;
      
      for (const selector of oracleSelectors) {
        const elements = $(selector);
        
        if (elements.length > 0) {
          console.log(`📋 Found ${elements.length} elements with selector: ${selector}`);
          
          elements.each((index, element) => {
            const $job = $(element);
            const text = $job.text().trim();
            
            // Skip if element is too small or doesn't contain job-like content
            if (text.length < 20) return;
            
            // Look for job-related keywords to validate this is actually a job posting
            const jobKeywords = ['position', 'job', 'career', 'vacancy', 'apply', 'requisition', 'posting'];
            const hasJobKeywords = jobKeywords.some(keyword => 
              text.toLowerCase().includes(keyword)
            );
            
            if (!hasJobKeywords) return;
            
            // Extract job details with flexible selectors
            const title = $job.find('h1, h2, h3, h4, .title, [class*="title"], [class*="job-title"], a').first().text().trim() || 
                         text.split('\n')[0].trim();
            
            const location = $job.find('.location, [class*="location"], [class*="city"]').first().text().trim();
            const department = $job.find('.department, [class*="department"], [class*="org"]').first().text().trim();
            const jobId = $job.find('[class*="id"], [class*="req"], [data-job-id]').first().text().trim();
            
            if (title && title.length > 3) {
              jobs.push({
                title: title.substring(0, 200), // Limit title length
                location: location.substring(0, 100),
                department: department.substring(0, 100),
                jobId: jobId.substring(0, 50),
                element: text.substring(0, 500), // Store sample text instead of HTML
                selector: selector
              });
              foundJobs = true;
            }
          });
          
          if (foundJobs) break; // Stop after finding jobs with first successful selector
        }
      }
      
      // If no structured jobs found, analyze page text for changes
      let pageText = $('body').text().replace(/\s+/g, ' ').trim();
      
      // Remove common dynamic elements that change frequently but aren't job-related
      pageText = pageText
        .replace(/\d{1,2}:\d{2}:\d{2}/g, '') // Remove timestamps
        .replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '') // Remove dates
        .replace(/loading|please wait|fetching/gi, '') // Remove loading text
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
      
      const pageHash = this.generateHash(pageText);
      
      console.log(`✅ Page analysis complete: ${jobs.length} jobs found, content length: ${pageText.length}`);
      
      if (jobs.length > 0) {
        console.log('📋 Sample jobs found:');
        jobs.slice(0, 3).forEach((job, i) => {
          console.log(`   ${i + 1}. ${job.title} ${job.location ? `(${job.location})` : ''}`);
        });
      }
      
      return {
        jobs,
        pageHash,
        pageText: pageText.substring(0, 2000), // Store more text for comparison
        timestamp: new Date().toISOString(),
        totalJobs: jobs.length,
        method: 'puppeteer'
      };

    } catch (error) {
      console.error('❌ Error fetching job data:', error.message);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Generate a simple hash for content comparison
   */
  generateHash(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Compare current data with previous data to detect changes
   */
  detectChanges(currentData) {
    if (!this.lastCheckData) {
      return {
        hasChanges: true,
        isFirstRun: true,
        changes: [`Initial scan found ${currentData.totalJobs} job postings`]
      };
    }

    const changes = [];
    let hasChanges = false;

    // Check if page hash changed
    if (currentData.pageHash !== this.lastCheckData.pageHash) {
      hasChanges = true;
      
      // Check job count changes
      const jobCountDiff = currentData.totalJobs - this.lastCheckData.totalJobs;
      if (jobCountDiff > 0) {
        changes.push(`🆕 ${jobCountDiff} new job posting(s) detected`);
      } else if (jobCountDiff < 0) {
        changes.push(`📉 ${Math.abs(jobCountDiff)} job posting(s) removed`);
      } else {
        changes.push(`🔄 Job postings updated (same count: ${currentData.totalJobs})`);
      }

      // Try to identify specific job changes
      if (currentData.jobs.length > 0 && this.lastCheckData.jobs.length > 0) {
        const currentTitles = new Set(currentData.jobs.map(job => job.title));
        const previousTitles = new Set(this.lastCheckData.jobs.map(job => job.title));
        
        // New jobs
        const newJobs = currentData.jobs.filter(job => !previousTitles.has(job.title));
        newJobs.forEach(job => {
          changes.push(`➕ New job: "${job.title}" ${job.location ? `in ${job.location}` : ''}`);
        });
        
        // Removed jobs
        const removedJobs = this.lastCheckData.jobs.filter(job => !currentTitles.has(job.title));
        removedJobs.forEach(job => {
          changes.push(`➖ Removed job: "${job.title}"`);
        });
      }
    }

    return { hasChanges, isFirstRun: false, changes };
  }

  /**
   * Send email notification
   */
  async sendEmail(subject, htmlContent, textContent) {
    try {
      const mailOptions = {
        from: this.emailConfig.auth.user,
        to: this.recipientEmail,
        subject: subject,
        html: htmlContent,
        text: textContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('📧 Email sent successfully:', result.messageId);
      return true;
    } catch (error) {
      console.error('❌ Failed to send email:', error.message);
      return false;
    }
  }

  /**
   * Generate HTML email template
   */
  generateEmailHTML(type, data) {
    const baseStyles = `
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f8f9fa; padding: 20px; }
        .job-item { background: white; margin: 10px 0; padding: 15px; border-radius: 6px; border-left: 4px solid #667eea; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .job-title { font-weight: bold; color: #2c3e50; margin-bottom: 5px; }
        .job-meta { color: #7f8c8d; font-size: 0.9em; }
        .change-item { background: white; margin: 8px 0; padding: 12px; border-radius: 4px; border-left: 3px solid #27ae60; }
        .footer { background: #34495e; color: white; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; font-size: 0.9em; }
        .timestamp { color: #95a5a6; font-size: 0.8em; }
        .stats { background: white; padding: 15px; margin: 15px 0; border-radius: 6px; text-align: center; }
        .stat-number { font-size: 2em; font-weight: bold; color: #667eea; }
      </style>
    `;

    if (type === 'update') {
      return `
        <!DOCTYPE html>
        <html>
        <head>${baseStyles}</head>
        <body>
          <div class="header">
            <h1>🚨 Job Alert: ICAO Update Detected!</h1>
            <p>Changes detected on the job postings page</p>
          </div>
          <div class="content">
            <div class="stats">
              <div class="stat-number">${data.changes.length}</div>
              <div>Changes Detected</div>
            </div>
            
            <h3>📋 Change Summary:</h3>
            ${data.changes.map(change => `<div class="change-item">${change}</div>`).join('')}
            
            ${data.currentData.jobs.length > 0 ? `
              <h3>💼 Current Job Postings (${data.currentData.totalJobs}):</h3>
              ${data.currentData.jobs.slice(0, 10).map(job => `
                <div class="job-item">
                  <div class="job-title">${job.title}</div>
                  <div class="job-meta">
                    ${job.location ? `📍 ${job.location}` : ''}
                    ${job.department ? `🏢 ${job.department}` : ''}
                    ${job.jobId ? `🆔 ${job.jobId}` : ''}
                  </div>
                </div>
              `).join('')}
              ${data.currentData.jobs.length > 10 ? `<p><em>... and ${data.currentData.jobs.length - 10} more jobs</em></p>` : ''}
            ` : ''}
            
            <p><strong>🔗 <a href="${this.targetUrl}" style="color: #667eea;">View All Jobs on ICAO</a></strong></p>
          </div>
          <div class="footer">
            <p>ICAO Job Monitor | <span class="timestamp">${new Date().toLocaleString()}</span></p>
          </div>
        </body>
        </html>
      `;
    }

    if (type === 'morning') {
      return `
        <!DOCTYPE html>
        <html>
        <head>${baseStyles}</head>
        <body>
          <div class="header">
            <h1>🌅 Good Morning! ICAO Job Update</h1>
            <p>Your daily morning job monitoring report</p>
          </div>
          <div class="content">
            <div class="stats">
              <div class="stat-number">${data.totalJobs}</div>
              <div>Total Job Postings</div>
            </div>
            
            ${data.yesterdayChanges.length > 0 ? `
              <h3>📈 Changes Since Yesterday:</h3>
              ${data.yesterdayChanges.map(change => `<div class="change-item">${change}</div>`).join('')}
            ` : '<p>✅ No changes detected since yesterday.</p>'}
            
            ${data.jobs.length > 0 ? `
              <h3>💼 Current Job Postings:</h3>
              ${data.jobs.slice(0, 5).map(job => `
                <div class="job-item">
                  <div class="job-title">${job.title}</div>
                  <div class="job-meta">
                    ${job.location ? `📍 ${job.location}` : ''}
                    ${job.department ? `🏢 ${job.department}` : ''}
                  </div>
                </div>
              `).join('')}
              ${data.jobs.length > 5 ? `<p><em>... and ${data.jobs.length - 5} more jobs</em></p>` : ''}
            ` : '<p>No specific job details available.</p>'}
            
            <p><strong>🔗 <a href="${this.targetUrl}" style="color: #667eea;">View All Jobs on ICAO</a></strong></p>
          </div>
          <div class="footer">
            <p>ICAO Job Monitor | <span class="timestamp">${new Date().toLocaleString()}</span></p>
            <p>Next update check in 10 minutes</p>
          </div>
        </body>
        </html>
      `;
    }

    if (type === 'evening') {
      return `
        <!DOCTYPE html>
        <html>
        <head>${baseStyles}</head>
        <body>
          <div class="header">
            <h1>🌆 Evening Summary: ICAO Jobs</h1>
            <p>Your daily evening job monitoring summary</p>
          </div>
          <div class="content">
            <div class="stats">
              <div class="stat-number">${data.totalChangesToday}</div>
              <div>Changes Today</div>
            </div>
            
            ${data.todayChanges.length > 0 ? `
              <h3>📊 Today's Activity Summary:</h3>
              ${data.todayChanges.map(change => `<div class="change-item">${change}</div>`).join('')}
            ` : '<p>✅ No changes detected today.</p>'}
            
            <div class="stats">
              <div class="stat-number">${data.totalJobs}</div>
              <div>Current Total Jobs</div>
            </div>
            
            ${data.jobs.length > 0 ? `
              <h3>💼 Latest Job Postings:</h3>
              ${data.jobs.slice(0, 8).map(job => `
                <div class="job-item">
                  <div class="job-title">${job.title}</div>
                  <div class="job-meta">
                    ${job.location ? `📍 ${job.location}` : ''}
                    ${job.department ? `🏢 ${job.department}` : ''}
                  </div>
                </div>
              `).join('')}
              ${data.jobs.length > 8 ? `<p><em>... and ${data.jobs.length - 8} more jobs</em></p>` : ''}
            ` : '<p>No specific job details available.</p>'}
            
            <p><strong>🔗 <a href="${this.targetUrl}" style="color: #667eea;">View All Jobs on ICAO</a></strong></p>
          </div>
          <div class="footer">
            <p>ICAO Job Monitor | <span class="timestamp">${new Date().toLocaleString()}</span></p>
            <p>Monitoring will continue overnight. Next morning summary at 8:00 AM</p>
          </div>
        </body>
        </html>
      `;
    }
  }

  /**
   * Main monitoring function - checks for updates
   */
  async checkForUpdates() {
    try {
      console.log('🔍 Checking for job updates...');
      
      const currentData = await this.fetchJobData();
      const changeDetection = this.detectChanges(currentData);
      
      if (changeDetection.hasChanges) {
        console.log('🚨 Changes detected!');
        console.log('Changes:', changeDetection.changes);
        
        // Add to daily changes log
        const changeEntry = {
          timestamp: new Date().toISOString(),
          changes: changeDetection.changes,
          isFirstRun: changeDetection.isFirstRun
        };
        this.dailyChanges.push(changeEntry);
        
        // Send update email (unless it's the first run)
        if (!changeDetection.isFirstRun) {
          const subject = `🚨 ICAO Job Update - ${changeDetection.changes.length} Change(s) Detected`;
          const htmlContent = this.generateEmailHTML('update', {
            changes: changeDetection.changes,
            currentData
          });
          const textContent = `Job Update Alert!\n\nChanges detected:\n${changeDetection.changes.join('\n')}\n\nView jobs: ${this.targetUrl}`;
          
          await this.sendEmail(subject, htmlContent, textContent);
        }
      } else {
        console.log('✅ No changes detected');
      }
      
      // Update stored data
      this.lastCheckData = currentData;
      await this.saveData();
      
    } catch (error) {
      console.error('❌ Error during update check:', error.message);
    }
  }

  /**
   * Send morning summary email
   */
  async sendMorningSummary() {
    try {
      console.log('🌅 Sending morning summary...');
      
      const currentData = await this.fetchJobData();
      
      // Get yesterday's changes
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayChanges = this.dailyChanges
        .filter(entry => new Date(entry.timestamp) >= yesterday)
        .flatMap(entry => entry.changes);
      
      const subject = `🌅 Morning Update: ICAO Jobs (${currentData.totalJobs} postings)`;
      const htmlContent = this.generateEmailHTML('morning', {
        totalJobs: currentData.totalJobs,
        jobs: currentData.jobs,
        yesterdayChanges
      });
      const textContent = `Good Morning!\n\nICAO Job Summary:\n- Total Jobs: ${currentData.totalJobs}\n- Changes since yesterday: ${yesterdayChanges.length}\n\nView jobs: ${this.targetUrl}`;
      
      await this.sendEmail(subject, htmlContent, textContent);
      
      // Update stored data
      this.lastCheckData = currentData;
      await this.saveData();
      
    } catch (error) {
      console.error('❌ Error sending morning summary:', error.message);
    }
  }

  /**
   * Send evening summary email
   */
  async sendEveningSummary() {
    try {
      console.log('🌆 Sending evening summary...');
      
      const currentData = await this.fetchJobData();
      
      // Get today's changes
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayChanges = this.dailyChanges
        .filter(entry => new Date(entry.timestamp) >= today)
        .flatMap(entry => entry.changes);
      
      const subject = `🌆 Evening Summary: ICAO Jobs (${todayChanges.length} changes today)`;
      const htmlContent = this.generateEmailHTML('evening', {
        totalJobs: currentData.totalJobs,
        jobs: currentData.jobs,
        todayChanges,
        totalChangesToday: todayChanges.length
      });
      const textContent = `Evening Summary!\n\nICAO Job Summary:\n- Total Jobs: ${currentData.totalJobs}\n- Changes today: ${todayChanges.length}\n\nView jobs: ${this.targetUrl}`;
      
      await this.sendEmail(subject, htmlContent, textContent);
      
      // Clear daily changes for tomorrow
      this.dailyChanges = [];
      
      // Update stored data
      this.lastCheckData = currentData;
      await this.saveData();
      
    } catch (error) {
      console.error('❌ Error sending evening summary:', error.message);
    }
  }

  /**
   * Start the monitoring service with cron jobs
   */
  startMonitoring() {
    console.log('🚀 Starting ICAO job monitoring service...');
    
    // Check for updates every 10 minutes
    cron.schedule('*/10 * * * *', () => {
      this.checkForUpdates();
    });
    
    // Morning summary at 8:00 AM
    cron.schedule('0 8 * * *', () => {
      this.sendMorningSummary();
    });
    
    // Evening summary at 6:00 PM
    cron.schedule('0 18 * * *', () => {
      this.sendEveningSummary();
    });
    
    console.log('⏰ Scheduled jobs:');
    console.log('  - Update checks: Every 10 minutes');
    console.log('  - Morning summary: 8:00 AM daily');
    console.log('  - Evening summary: 6:00 PM daily');
    
    // Run initial check
    setTimeout(() => {
      this.checkForUpdates();
    }, 5000); // Wait 5 seconds after startup
  }
}

module.exports = JobMonitor;
