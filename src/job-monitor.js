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
