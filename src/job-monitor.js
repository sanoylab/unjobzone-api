const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');

class JobMonitor {
  constructor() {
    this.targetUrl = 'https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/jobs';
    this.dataFile = path.join(__dirname, 'job-monitor-data.json');
    this.lastCheckData = null;
    this.dailyChanges = [];
    this.emailTransporter = null;
  }

  /**
   * Initialize the monitor - load previous data and setup email
   */
  async initialize() {
    console.log('🔧 Initializing ICAO Job Monitor...');
    
    // Setup email transporter
    this.emailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MONITOR_EMAIL_USER,
        pass: process.env.MONITOR_EMAIL_PASS
      }
    });
    
    // Load previous data if exists
    try {
      const data = await fs.readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(data);
      this.lastCheckData = parsed.lastCheckData || null;
      this.dailyChanges = parsed.dailyChanges || [];
      console.log('✅ Loaded previous monitoring data');
    } catch (error) {
      console.log('ℹ️  No previous data found, starting fresh');
      this.lastCheckData = null;
      this.dailyChanges = [];
    }
  }

  /**
   * Save monitoring data to file
   */
  async saveData() {
    const data = {
      lastCheckData: this.lastCheckData,
      dailyChanges: this.dailyChanges,
      lastSaved: new Date().toISOString()
    };
    
    try {
      await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Error saving data:', error.message);
    }
  }

  /**
   * Fetch job data from ICAO website
   */
  async fetchJobData() {
    let browser = null;
    
    try {
      // Try Puppeteer first
      console.log('🌐 Fetching ICAO job data with Puppeteer...');
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      
      const page = await browser.newPage();
      await page.goto(this.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Wait for job list to load
      await page.waitForSelector('[data-automation-id="jobTitle"], .job-item, .jobTitle', { timeout: 10000 });
      
      const content = await page.content();
      const $ = cheerio.load(content);
      
      const jobs = [];
      $('[data-automation-id="jobTitle"], .job-item, .jobTitle').each((i, elem) => {
        const title = $(elem).text().trim();
        if (title) {
          jobs.push({ title, id: crypto.createHash('md5').update(title).digest('hex') });
        }
      });
      
      const pageHash = crypto.createHash('md5').update(content).digest('hex');
      
      await browser.close();
      
      console.log(`✅ Puppeteer scraping complete: Found ${jobs.length} jobs`);
      
      return {
        jobs,
        totalJobs: jobs.length,
        pageHash,
        pageText: content.substring(0, 500),
        timestamp: new Date().toISOString()
      };
      
    } catch (puppeteerError) {
      console.warn('⚠️  Puppeteer failed, trying fallback method:', puppeteerError.message);
      
      if (browser) {
        try { await browser.close(); } catch (e) { }
      }
      
      // Fallback to axios + cheerio
      try {
        console.log('🌐 Fetching with fallback method (axios)...');
        const response = await axios.get(this.targetUrl, { timeout: 30000 });
        const $ = cheerio.load(response.data);
        
        // Extract job indicators or content
        const contentIndicators = $('script, [data-automation-id]').text();
        const pageHash = crypto.createHash('md5').update(contentIndicators || response.data).digest('hex');
        
        console.log(`✅ Fallback scraping complete: content indicators length: ${contentIndicators.length}`);
        
        return {
          jobs: [],
          totalJobs: 0,
          pageHash,
          pageText: contentIndicators.substring(0, 500) || response.data.substring(0, 500),
          timestamp: new Date().toISOString(),
          isFallback: true
        };
        
      } catch (fallbackError) {
        console.error('❌ Fallback method also failed:', fallbackError.message);
        throw new Error('Both Puppeteer and fallback methods failed');
      }
    }
  }

  /**
   * Check for updates and send notifications
   */
  async checkForUpdates() {
    try {
      console.log('🔍 Checking for ICAO job updates...');
      
      const currentData = await this.fetchJobData();
      
      // First run - just store data
      if (!this.lastCheckData) {
        console.log('ℹ️  First run - establishing baseline');
        this.lastCheckData = currentData;
        this.dailyChanges.push({
          timestamp: new Date().toISOString(),
          changes: [`Initial scan found ${currentData.totalJobs} job postings`],
          isFirstRun: true
        });
        await this.saveData();
        return;
      }
      
      // Check for changes
      const changes = [];
      
      if (currentData.pageHash !== this.lastCheckData.pageHash) {
        if (currentData.totalJobs !== this.lastCheckData.totalJobs) {
          const diff = currentData.totalJobs - this.lastCheckData.totalJobs;
          if (diff > 0) {
            changes.push(`📈 ${diff} new job(s) added`);
          } else {
            changes.push(`📉 ${Math.abs(diff)} job(s) removed`);
          }
        } else {
          changes.push('🔄 ICAO careers page updated - content structure changed');
        }
      }
      
      if (changes.length > 0) {
        console.log(`🚨 Changes detected: ${changes.length} change(s)`);
        
        // Record changes
        this.dailyChanges.push({
          timestamp: new Date().toISOString(),
          changes
        });
        
        // Send notification
        const subject = `🚨 ICAO Job Update - ${changes.length} Change(s) Detected`;
        const htmlContent = this.generateEmailHTML('alert', {
          changes,
          totalJobs: currentData.totalJobs,
          previousTotal: this.lastCheckData.totalJobs
        });
        const textContent = `ICAO Job Alert!\n\nChanges detected:\n${changes.map(c => `• ${c}`).join('\n')}\n\nCurrent jobs: ${currentData.totalJobs}\nPrevious: ${this.lastCheckData.totalJobs}\n\nView jobs: ${this.targetUrl}`;
        
        await this.sendEmail(subject, htmlContent, textContent);
        
        // Update stored data
        this.lastCheckData = currentData;
        await this.saveData();
        
      } else {
        console.log('✅ No changes detected');
      }
      
    } catch (error) {
      console.error('❌ Error checking for updates:', error.message);
    }
  }

  /**
   * Send email notification
   */
  async sendEmail(subject, htmlContent, textContent) {
    try {
      const recipient = process.env.MONITOR_RECIPIENT_EMAIL || process.env.MONITOR_EMAIL_USER;
      
      const mailOptions = {
        from: process.env.MONITOR_EMAIL_USER,
        to: recipient,
        subject,
        html: htmlContent,
        text: textContent
      };
      
      await this.emailTransporter.sendMail(mailOptions);
      console.log('📧 Email sent successfully');
      return true;
      
    } catch (error) {
      console.error('❌ Error sending email:', error.message);
      return false;
    }
  }

  /**
   * Generate HTML email content
   */
  generateEmailHTML(type, data) {
    const baseStyle = `
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f8f9fa; padding: 20px; }
        .footer { background: #34495e; color: white; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; }
        .alert { background: #fff3cd; border: 1px solid #ffc107; color: #856404; padding: 15px; border-radius: 4px; margin: 15px 0; }
        .change-item { padding: 10px; margin: 5px 0; background: white; border-left: 3px solid #667eea; }
      </style>
    `;
    
    if (type === 'alert') {
      return `
        <!DOCTYPE html>
        <html>
        <head>${baseStyle}</head>
        <body>
          <div class="header">
            <h1>🚨 ICAO Job Alert</h1>
            <p>Changes Detected</p>
          </div>
          <div class="content">
            <div class="alert">
              <strong>${data.changes.length} change(s) detected</strong>
            </div>
            <h3>📋 Changes:</h3>
            ${data.changes.map(c => `<div class="change-item">${c}</div>`).join('')}
            <p><strong>Current Jobs:</strong> ${data.totalJobs}<br>
            <strong>Previous:</strong> ${data.previousTotal}</p>
            <p><a href="${this.targetUrl}" style="color: #667eea;">View ICAO Jobs</a></p>
          </div>
          <div class="footer">
            <p>ICAO Job Monitor</p>
          </div>
        </body>
        </html>
      `;
    } else if (type === 'morning') {
      return `
        <!DOCTYPE html>
        <html>
        <head>${baseStyle}</head>
        <body>
          <div class="header">
            <h1>🌅 Morning Summary</h1>
            <p>ICAO Job Postings</p>
          </div>
          <div class="content">
            <h3>📊 Summary:</h3>
            <p><strong>Total Jobs:</strong> ${data.totalJobs}</p>
            <p><strong>Changes since yesterday:</strong> ${data.yesterdayChanges?.length || 0}</p>
            <p><a href="${this.targetUrl}" style="color: #667eea;">View ICAO Jobs</a></p>
          </div>
          <div class="footer">
            <p>ICAO Job Monitor</p>
          </div>
        </body>
        </html>
      `;
    } else if (type === 'evening') {
      return `
        <!DOCTYPE html>
        <html>
        <head>${baseStyle}</head>
        <body>
          <div class="header">
            <h1>🌆 Evening Summary</h1>
            <p>ICAO Job Postings</p>
          </div>
          <div class="content">
            <h3>📊 Today's Summary:</h3>
            <p><strong>Total Jobs:</strong> ${data.totalJobs}</p>
            <p><strong>Changes today:</strong> ${data.totalChangesToday || 0}</p>
            <p><a href="${this.targetUrl}" style="color: #667eea;">View ICAO Jobs</a></p>
          </div>
          <div class="footer">
            <p>ICAO Job Monitor</p>
          </div>
        </body>
        </html>
      `;
    }
    
    return '<html><body>ICAO Job Monitor</body></html>';
  }

  /*
    The following functions are updated to respect environment variables that
    allow disabling morning/evening summary emails without removing the monitor.
    Replaced implementations: sendMorningSummary, sendEveningSummary, startMonitoring
  */

  /**
   * Send morning summary email
   */
  async sendMorningSummary() {
    // Respect runtime settings to disable summaries
    const globalDisabled = process.env.MONITOR_DISABLE_SUMMARIES === 'true';
    const morningDisabled = process.env.MONITOR_DISABLE_MORNING_SUMMARY === 'true';
    if (globalDisabled || morningDisabled) {
      console.log('ℹ️  Morning summary suppressed by environment variable (MONITOR_DISABLE_SUMMARIES / MONITOR_DISABLE_MORNING_SUMMARY)');
      return;
    }

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
    // Respect runtime settings to disable summaries
    const globalDisabled = process.env.MONITOR_DISABLE_SUMMARIES === 'true';
    const eveningDisabled = process.env.MONITOR_DISABLE_EVENING_SUMMARY === 'true';
    if (globalDisabled || eveningDisabled) {
      console.log('ℹ️  Evening summary suppressed by environment variable (MONITOR_DISABLE_SUMMARIES / MONITOR_DISABLE_EVENING_SUMMARY)');
      return;
    }

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

    // Decide whether summaries are disabled via env vars
    const globalDisabled = process.env.MONITOR_DISABLE_SUMMARIES === 'true';
    const morningDisabled = process.env.MONITOR_DISABLE_MORNING_SUMMARY === 'true';
    const eveningDisabled = process.env.MONITOR_DISABLE_EVENING_SUMMARY === 'true';

    // Morning summary at 8:00 AM (only if not disabled)
    if (!globalDisabled && !morningDisabled) {
      cron.schedule('0 8 * * *', () => {
        this.sendMorningSummary();
      });
    } else {
      console.log('ℹ️  Morning summary cron not scheduled (disabled via environment variable)');
    }
    
    // Evening summary at 6:00 PM (only if not disabled)
    if (!globalDisabled && !eveningDisabled) {
      cron.schedule('0 18 * * *', () => {
        this.sendEveningSummary();
      });
    } else {
      console.log('ℹ️  Evening summary cron not scheduled (disabled via environment variable)');
    }
    
    console.log('⏰ Scheduled jobs:');
    console.log('  - Update checks: Every 10 minutes');
    if (!globalDisabled && !morningDisabled) console.log('  - Morning summary: 8:00 AM daily');
    if (!globalDisabled && !eveningDisabled) console.log('  - Evening summary: 6:00 PM daily');
    
    // Run initial check
    setTimeout(() => {
      this.checkForUpdates();
    }, 5000); // Wait 5 seconds after startup
  }
}

module.exports = JobMonitor;
