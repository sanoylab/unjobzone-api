require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const baseUrl = 'https://jobs.unicef.org';
const listingUrl = 'https://jobs.unicef.org/en-us/listing/';

// Helper function to add delay between requests (rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Extract job ID from UNICEF job URL
const extractJobId = (jobUrl) => {
  const match = jobUrl.match(/\/job\/(\d+)\//);
  return match ? match[1] : null;
};

// Parse deadline date from UNICEF format
const parseDeadline = (deadlineText) => {
  if (!deadlineText) return null;
  
  try {
    // UNICEF uses format like "7 Aug 2025 11:55 PM"
    const cleanText = deadlineText.replace(/Deadline:\s*/, '').trim();
    const date = new Date(cleanText);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.warn(`Failed to parse deadline: ${deadlineText}`);
    return null;
  }
};

// Scrape job listings from the main UNICEF jobs page using Puppeteer
const scrapeJobListings = async () => {
  console.log("🔍 Scraping UNICEF job listings with Puppeteer...");
  
  let browser = null;
  try {
    // Launch Puppeteer with minimal configuration
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set user agent to appear more like a real browser
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    console.log("🌐 Navigating to UNICEF jobs page...");
    
    // Navigate to the page and wait for network to be idle
    await page.goto(listingUrl, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    // Wait for potential JavaScript challenges to complete
    console.log("⏳ Waiting for page to fully load...");
    await delay(5000); // Give AWS WAF time to resolve
    
    // Try to wait for job listings to appear
    try {
      await page.waitForSelector('article, .job-card, .vacancy-item, a[href*="/job/"]', { timeout: 15000 });
      console.log("✅ Job listings found on page");
    } catch (waitError) {
      console.log("⚠️ No specific job selectors found, proceeding with page content...");
    }
    
    // Handle pagination - click "More Jobs" button repeatedly to load all jobs
    let loadedAllJobs = false;
    let clickAttempts = 0;
    const maxClickAttempts = 10; // Prevent infinite loops
    
    while (!loadedAllJobs && clickAttempts < maxClickAttempts) {
      try {
        // Look for "More Jobs" button or pagination buttons using multiple strategies
        let moreJobsButton = null;
        
        // Strategy 1: Try common button selectors
        const buttonSelectors = [
          '.load-more',
          '.pagination-next', 
          '[data-automation-id="loadMoreJobs"]',
          'button[class*="load"]',
          'button[class*="more"]',
          'button[class*="show-more"]',
          '.show-more',
          '.load-more-jobs',
          '[class*="load-more"]'
        ];
        
        for (const selector of buttonSelectors) {
          moreJobsButton = await page.$(selector);
          if (moreJobsButton) {
            console.log(`📍 Found pagination button with selector: ${selector}`);
            break;
          }
        }
        
        // Strategy 2: Look for buttons containing "More" text
        if (!moreJobsButton) {
          const buttonElement = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], .btn, [class*="button"]'));
            const moreButton = buttons.find(button => {
              const text = button.textContent.toLowerCase();
              return text.includes('more') || text.includes('load') || text.includes('show') || 
                     text.includes('next') || text.includes('additional');
            });
            return moreButton ? moreButton.outerHTML : null;
          });
          
          if (buttonElement) {
            console.log(`📍 Found pagination button by text content: ${buttonElement.substring(0, 100)}...`);
            // Try to click using evaluate instead of ElementHandle
            const clicked = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], .btn, [class*="button"]'));
              const moreButton = buttons.find(button => {
                const text = button.textContent.toLowerCase();
                return text.includes('more') || text.includes('load') || text.includes('show') || 
                       text.includes('next') || text.includes('additional');
              });
              if (moreButton) {
                moreButton.click();
                return true;
              }
              return false;
            });
            
            if (clicked) {
              moreJobsButton = true; // Flag to indicate we clicked
            }
          }
        }
        
        if (moreJobsButton) {
          console.log(`🔄 Attempting to click pagination button (attempt ${clickAttempts + 1})...`);
          
          // Get current job count before clicking
          const currentJobs = await page.$$('a[href*="/job/"]');
          const beforeCount = currentJobs.length;
          
          // Click the button (either ElementHandle or evaluate method)
          if (moreJobsButton === true) {
            // Already clicked using evaluate method, just wait
            console.log("✅ Button clicked using evaluate method");
          } else {
            // Click using ElementHandle
            await moreJobsButton.click();
            console.log("✅ Button clicked using ElementHandle");
          }
          
          // Wait for new content to load
          await delay(5000); // Increased wait time for dynamic loading
          
          // Check if new jobs were loaded
          const newJobs = await page.$$('a[href*="/job/"]');
          const afterCount = newJobs.length;
          
          console.log(`📊 Jobs before: ${beforeCount}, after: ${afterCount}`);
          
          if (afterCount > beforeCount) {
            console.log(`✅ Loaded ${afterCount - beforeCount} more jobs`);
            clickAttempts++;
          } else {
            console.log("✅ No more jobs to load, pagination complete");
            loadedAllJobs = true;
          }
        } else {
          console.log("✅ No more pagination buttons found");
          loadedAllJobs = true;
        }
      } catch (paginationError) {
        console.log("⚠️ Pagination error:", paginationError.message);
        loadedAllJobs = true;
      }
    }
    
    if (clickAttempts >= maxClickAttempts) {
      console.log("⚠️ Reached maximum click attempts, stopping pagination");
    }
    
    // Get the final page content after all pagination
    const html = await page.content();
    console.log(`📄 Final page content length: ${html.length} characters`);
    
    // Check if we still have AWS WAF challenge
    if (html.includes('awswaf') || html.includes('challenge')) {
      console.log("⚠️ Still encountering AWS WAF challenge, but proceeding...");
    }
    
    const $ = cheerio.load(html);
    const jobs = [];
    
    // Strategy 1: Look for all job links first (most comprehensive)
    console.log("🔍 Strategy 1: Looking for all job links...");
    $('a[href*="/job/"]').each((index, element) => {
      const $element = $(element);
      const href = $element.attr('href');
      
      if (href && href.includes('/job/')) {
        let jobUrl = href;
        if (jobUrl.startsWith('/')) {
          jobUrl = baseUrl + jobUrl;
        }
        
        const title = $element.text().trim();
        if (title && title.length > 5 && title.length < 200) {
          const existingJob = jobs.find(job => job.url === jobUrl);
          if (!existingJob) {
            jobs.push({
              url: jobUrl,
              title: title,
              location: '',
              deadline: '',
              contractType: ''
            });
          }
        }
      }
    });
    
    console.log(`🔍 Found ${jobs.length} jobs using direct link search`);
    
    // Strategy 2: Look for job listings in structured containers if we haven't found many
    if (jobs.length < 10) {
      console.log("🔍 Strategy 2: Looking for structured job containers...");
      const containerSelectors = [
        'article',
        '.job-card',
        '.vacancy-item', 
        '.job-listing',
        '.job-item',
        '[data-job-id]',
        'div[class*="job"]',
        'li[class*="job"]',
        '.listing-item',
        '.vacancy'
      ];
      
      for (const selector of containerSelectors) {
        const elements = $(selector);
        console.log(`🔍 Found ${elements.length} elements with selector: ${selector}`);
        
        if (elements.length > 0) {
          elements.each((index, element) => {
            const $element = $(element);
            
            // Look for job links within this container
            const links = $element.find('a[href*="/job/"]');
            links.each((linkIndex, linkElement) => {
              const $link = $(linkElement);
              const href = $link.attr('href');
              
              if (href && href.includes('/job/')) {
                let jobUrl = href;
                if (jobUrl.startsWith('/')) {
                  jobUrl = baseUrl + jobUrl;
                }
                
                // Try to extract better information from the container
                const title = $link.text().trim() || 
                             $element.find('h1, h2, h3, h4, .job-title, .title').first().text().trim() ||
                             $element.text().split('\n')[0].trim();
                
                const location = $element.find('.location, .duty-station, [class*="location"]').first().text().trim();
                const deadline = $element.find('.deadline, [class*="deadline"]').first().text().trim();
                const contractType = $element.find('.contract-type, [class*="contract"]').first().text().trim();
                
                if (title && title.length > 5 && title.length < 200) {
                  const existingJob = jobs.find(job => job.url === jobUrl);
                  if (!existingJob) {
                    jobs.push({
                      url: jobUrl,
                      title: title,
                      location: location,
                      deadline: deadline,
                      contractType: contractType
                    });
                  }
                }
              }
            });
          });
        }
      }
    }
    
    // Strategy 3: Final fallback - broad search if still no jobs found
    if (jobs.length === 0) {
      console.log("🔍 Strategy 3: No jobs found yet, trying broadest search...");
      $('a').each((index, element) => {
        const $element = $(element);
        const href = $element.attr('href');
        
        if (href && href.includes('/job/')) {
          console.log(`🔗 Found job link: ${href}`);
          
          let jobUrl = href;
          if (jobUrl.startsWith('/')) {
            jobUrl = baseUrl + jobUrl;
          }
          
          const title = $element.text().trim();
          if (title && title.length > 5 && title.length < 200) {
            const existingJob = jobs.find(job => job.url === jobUrl);
            if (!existingJob) {
              jobs.push({
                url: jobUrl,
                title: title,
                location: '',
                deadline: '',
                contractType: ''
              });
            }
          }
        }
      });
    }
    
    // If still no jobs, log page structure for debugging
    if (jobs.length === 0) {
      console.log("⚠️ No jobs found. Page structure analysis:");
      console.log(`- Total links: ${$('a').length}`);
      console.log(`- Links with href: ${$('a[href]').length}`);
      console.log(`- Articles: ${$('article').length}`);
      console.log(`- Divs: ${$('div').length}`);
      
      // Log first few links for debugging
      $('a[href]').slice(0, 10).each((i, el) => {
        console.log(`Link ${i + 1}: ${$(el).attr('href')} - "${$(el).text().trim().substring(0, 50)}"`);
      });
    }
    
    console.log(`✅ Found ${jobs.length} job listings`);
    return jobs;
    
  } catch (error) {
    console.error('❌ Error scraping job listings:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

// Scrape detailed job information from individual job page using Puppeteer
const scrapeJobDetail = async (jobUrl, basicInfo = {}) => {
  let browser = null;
  try {
    await delay(1000); // 1 second delay to be respectful
    
    // Launch Puppeteer for individual job page
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    console.log(`🔍 Fetching job details from: ${jobUrl}`);
    
    // Navigate to the job page
    await page.goto(jobUrl, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    // Wait for potential AWS WAF challenge to resolve
    await delay(3000);
    
    // Wait for the job content to load
    try {
      await page.waitForSelector('main, .job-detail, .job-content, .posting', { timeout: 10000 });
    } catch (waitError) {
      console.log("⚠️ Job content selectors not found, proceeding with full page...");
    }
    
    // Get the page content
    const html = await page.content();
    
    // Check if we hit AWS WAF challenge
    if (html.includes('awswaf') || html.includes('challenge')) {
      console.log("⚠️ AWS WAF challenge detected on job detail page, waiting longer...");
      await delay(5000);
      // Try to get content again
      const retryHtml = await page.content();
      if (!retryHtml.includes('awswaf')) {
        console.log("✅ AWS WAF challenge resolved");
      }
    }
    
    const $ = cheerio.load(html);
    
    // Extract job details with improved selectors for UNICEF pages
    const extractText = (selectors) => {
      for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text && text.length > 0) return text;
      }
      return '';
    };
    
    // Get the main content - try to find the actual job posting content
    let jobContent = '';
    
    // Strategy 1: Try to get the main job content area
    const mainContentSelectors = [
      'main',
      '.job-detail-content',
      '.job-content',
      '.posting-content',
      '.vacancy-content',
      '[role="main"]',
      '.content-area',
      '.job-posting'
    ];
    
    for (const selector of mainContentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        // Remove navigation, header, footer elements
        element.find('nav, header, footer, .navigation, .breadcrumb, .sidebar').remove();
        jobContent = element.text().trim();
        if (jobContent.length > 500) { // Reasonable job description length
          break;
        }
      }
    }
    
    // Strategy 2: If main content is too short, try to get full body content but clean it
    if (jobContent.length < 500) {
      // Remove common non-job-content elements
      $('nav, header, footer, .navigation, .breadcrumb, .sidebar, .menu, .banner, .cookie-notice, .search, .filters, script, style').remove();
      jobContent = $('body').text().trim();
    }
    
    // Clean up the content more thoroughly - aggressive cleaning for UNICEF
    jobContent = jobContent
      .replace(/<!--[\s\S]*?-->/g, '') // Remove HTML comments
      .replace(/<script[\s\S]*?<\/script>/gi, '') // Remove script tags
      .replace(/<style[\s\S]*?<\/style>/gi, '') // Remove style tags
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove CSS comments
      .replace(/\/\/.*$/gm, '') // Remove single-line JavaScript comments
      .replace(/function\s+\w+\s*\([^)]*\)\s*\{[^}]*\}/g, '') // Remove JavaScript functions
      .replace(/PU\.[^;]+;?/g, '') // Remove PageUp specific JavaScript
      .replace(/jQuery[^;]+;?/g, '') // Remove jQuery calls
      .replace(/window\.[^;]+;?/g, '') // Remove window object assignments
      .replace(/\$\([^;]+;?/g, '') // Remove jQuery selectors
      .replace(/@font-face[^}]+}/g, '') // Remove CSS font-face declarations
      .replace(/\{[^}]*\}/g, '') // Remove any remaining CSS blocks
      .replace(/#[a-zA-Z0-9-_]+\s*\{[^}]*\}/g, '') // Remove CSS ID selectors
      .replace(/\.[a-zA-Z0-9-_]+\s*\{[^}]*\}/g, '') // Remove CSS class selectors
      .replace(/form#[^{]+\{[^}]*\}/g, '') // Remove form CSS
      .replace(/\.path-search[^{]+\{[^}]*\}/g, '') // Remove specific CSS
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
      .replace(/(\s*[-–—]\s*){2,}/g, ' - ') // Clean up repeated dashes
      .trim();
    
    // Additional cleaning - remove repeating patterns and UI elements
    const cleaningPatterns = [
      /Powered by PageUp/gi,
      /Search UNICEF/gi,
      /Filter results/gi,
      /Send me jobs like these/gi,
      /Apply now/gi,
      /Back to search results/gi,
      /Refer a friend/gi,
      /Social share/gi,
      /We will email you new jobs/gi,
      /Current vacancies/gi,
      /Explore our current job opportunities/gi,
      /Search using keywords/gi,
      /Search for jobs/gi,
      /Contract type/gi,
      /Locations/gi,
      /Functional Area/gi,
      /Position level/gi,
      /Vacancies/gi,
      /Great, we can send you jobs/gi,
      /The email address was invalid/gi,
      /You must agree to the privacy statement/gi,
      /Subscribe Recaptcha Privacy agreement/gi,
      /typeof SocialShareKit/gi,
      /SocialShareKit\.init/gi,
      /#search-keyword/gi,
      /#search-filters/gi,
      /border-radius/gi,
      /font-size/gi,
      /margin/gi,
      /padding/gi,
      /background/gi,
      /webkit/gi,
      /rgba\([^)]+\)/gi,
      /px !important/gi,
      /max-width/gi,
      /min-width/gi
    ];
    
    cleaningPatterns.forEach(pattern => {
      jobContent = jobContent.replace(pattern, '');
    });
    
    // Extract only the relevant job content - focus on the actual job posting
    // Look for the main job content starting from key phrases
    const contentMarkers = [
      'Job no:',
      'Contract type:',
      'Duty Station:',
      'About UNICEF',
      'BACKGROUND',
      'Purpose of Activity',
      'Scope of Work',
      'Terms of Reference',
      'Qualifications',
      'Requirements:'
    ];
    
    let startIndex = -1;
    for (const marker of contentMarkers) {
      const index = jobContent.indexOf(marker);
      if (index !== -1) {
        startIndex = index;
        break;
      }
    }
    
    if (startIndex !== -1) {
      jobContent = jobContent.substring(startIndex);
    }
    
    // Add better formatting to job content
    jobContent = jobContent
      // Add line breaks after key sections
      .replace(/(Job no:|Contract type:|Duty Station:|Level:|Location:|Categories:)/gi, '\n\n$1')
      .replace(/(About UNICEF|BACKGROUND|Purpose of Activity|Scope of Work|Terms of Reference|Qualifications|Requirements:|Education:|Knowledge\/Expertise\/Skills required)/gi, '\n\n$1')
      .replace(/(Deliverable \d+:|Sub-Deliverable \d+\.\d+:)/gi, '\n\n$1')
      // Clean up multiple spaces and newlines
      .replace(/\n{3,}/g, '\n\n') // Replace 3+ newlines with 2
      .replace(/\s{3,}/g, ' ') // Replace 3+ spaces with 1
      .trim();
    
    // Limit content length to fit database constraint
    if (jobContent.length > 25000) { // Reasonable limit for job description
      jobContent = jobContent.substring(0, 25000) + '...';
    }
    
    // Extract specific job details from the content
    const title = basicInfo.title || extractText([
      'h1', '.job-title', '.position-title', '.posting-title'
    ]) || basicInfo.title;
    
    // Extract dates from job content - UNICEF format: "Duration: 10 October 2025 – 31 December 2025"
    let startDate = null;
    let endDate = null;
    let deadline = null;
    
    // Parse duration - improved regex to handle different formats
    const durationMatches = [
      jobContent.match(/Duration:\s*([^–\n]+)\s*[–—-]\s*([^\n]+)/i), // Em dash, en dash, hyphen
      jobContent.match(/Duration:\s*([^-\n]+)\s*-\s*([^\n]+)/i), // Regular hyphen
      jobContent.match(/Duration:\s*(\d{1,2}\s+\w+\s+\d{4})\s*[–—-]\s*(\d{1,2}\s+\w+\s+\d{4})/i) // Date format
    ];
    
    for (const durationMatch of durationMatches) {
      if (durationMatch) {
        try {
          const startStr = durationMatch[1].trim();
          const endStr = durationMatch[2].trim();
          
          console.log(`🔍 Attempting to parse duration: "${startStr}" to "${endStr}"`);
          
          startDate = new Date(startStr);
          endDate = new Date(endStr);
          
          // Validate dates
          if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
            console.log(`📅 Successfully extracted duration: ${startStr} to ${endStr}`);
            break;
          } else {
            console.log(`⚠️ Invalid dates parsed from: ${durationMatch[0]}`);
            startDate = null;
            endDate = null;
          }
        } catch (error) {
          console.log(`⚠️ Failed to parse duration: ${durationMatch[0]} - ${error.message}`);
        }
      }
    }
    
    // Parse deadline - improved to handle different formats
    const deadlineMatches = [
      jobContent.match(/Deadline:\s*(\d{1,2}\s+\w+\s+\d{4})/i), // "14 Aug 2025"
      jobContent.match(/Deadline:\s*([^,\n\r]*?)(?:\s+Greenwich Standard Time)?/i), // General format
      jobContent.match(/Application deadline:\s*([^\n\r]*)/i), // Alternative format
      jobContent.match(/Closing date:\s*([^\n\r]*)/i) // Another alternative
    ];
    
    for (const deadlineMatch of deadlineMatches) {
      if (deadlineMatch) {
        try {
          const deadlineStr = deadlineMatch[1].trim().replace(/Greenwich Standard Time/i, '').trim();
          console.log(`🔍 Attempting to parse deadline: "${deadlineStr}"`);
          
          deadline = new Date(deadlineStr);
          
          if (!isNaN(deadline.getTime())) {
            console.log(`📅 Successfully extracted deadline: ${deadlineStr}`);
            break;
          } else {
            console.log(`⚠️ Invalid deadline parsed from: ${deadlineMatch[0]}`);
            deadline = null;
          }
        } catch (error) {
          console.log(`⚠️ Failed to parse deadline: ${deadlineMatch[0]} - ${error.message}`);
        }
      }
    }
    
    // Extract other job details from content with improved patterns
    // Look for the specific patterns right after the labels, stopping at next field or whitespace
    const contractTypeMatch = jobContent.match(/Contract type:\s*([A-Za-z\s\-]{1,50})(?:\s+Duty|Location|Level|Categories|Home|About|$)/i);
    const contractType = contractTypeMatch ? contractTypeMatch[1].trim() : '';
    
    const dutyStationMatch = jobContent.match(/Duty Station:\s*([A-Za-z\s,\-\.]{1,80})(?:\s+Level|Categories|Location:|About|$)/i);
    const location = dutyStationMatch ? dutyStationMatch[1].trim() : '';
    
    const levelMatch = jobContent.match(/Level:\s*([A-Za-z0-9\s\-]{1,30})(?:\s+Location|Categories|Consultancy|About|$)/i);
    const positionLevel = levelMatch ? levelMatch[1].trim() : '';
    
    const categoriesMatch = jobContent.match(/Categories:\s*([A-Za-z\s,&\-]{1,50})(?:\s+Consultancy|About|Background|Purpose|$)/i);
    const functionalArea = categoriesMatch ? categoriesMatch[1].trim() : '';
    
    console.log(`📍 Extracted fields - Location: "${location}" (${location.length} chars), Level: "${positionLevel}" (${positionLevel.length} chars), Contract: "${contractType}" (${contractType.length} chars), Category: "${functionalArea}" (${functionalArea.length} chars)`);
    
    // Add comprehensive formatting to job description
    let formattedDescription = jobContent;
    
    // Apply formatting BEFORE cleaning up spaces to preserve structure
    formattedDescription = formattedDescription
      // Add paragraph breaks before major sections FIRST
      .replace(/(About UNICEF)/gi, '\n\n$1')
      .replace(/(BACKGROUND)/gi, '\n\n$1')
      .replace(/(Purpose of Activity)/gi, '\n\n$1')
      .replace(/(Scope of Work)/gi, '\n\n$1')
      .replace(/(Terms of Reference)/gi, '\n\n$1')
      .replace(/(Key Deliverables)/gi, '\n\n$1')
      .replace(/(Qualifications)/gi, '\n\n$1')
      .replace(/(Requirements)/gi, '\n\n$1')
      .replace(/(Education)/gi, '\n\n$1')
      .replace(/(For every Child)/gi, '\n\n$1')
      
      // Add breaks before consultancy details
      .replace(/(Consultancy Title:|Division\/Duty Station:|Duration:|Home\/Office Based:)/gi, '\n\n$1')
      
      // Add breaks before deliverables
      .replace(/(Work Assignment)/gi, '\n\n$1')
      .replace(/(Deliverable \d+:)/gi, '\n\n$1')
      .replace(/(Sub-Deliverable \d+\.\d+:)/gi, '\n$1')
      
      // Add breaks before experience requirements
      .replace(/(Professional Experience:)/gi, '\n\n$1')
      .replace(/(Knowledge\/Expertise\/Skills required)/gi, '\n\n$1')
      
      // Add paragraph breaks before key UNICEF sections
      .replace(/(UNICEF offers)/gi, '\n\n$1')
      .replace(/(UNICEF has)/gi, '\n\n$1')
      .replace(/(UNICEF reserves)/gi, '\n\n$1')
      .replace(/(Selected candidates)/gi, '\n\n$1')
      .replace(/(Individuals engaged)/gi, '\n\n$1')
      .replace(/(Consultants are responsible)/gi, '\n\n$1')
      
      // NOW clean up spaces but preserve newlines
      .replace(/[ \t]+/g, ' ')  // Only replace spaces and tabs, not newlines
      .replace(/\n /g, '\n')    // Remove spaces after newlines
      .replace(/ \n/g, '\n')    // Remove spaces before newlines
      
      // Add breaks before job details
      .replace(/(Job no:|Contract type:|Duty Station:|Level:|Location:|Categories:)/gi, '\n$1')
      
      // Add breaks before bullet points and lists  
      .replace(/\n([-•]\s+)/g, '\n$1')
      .replace(/\n(o\s+)/g, '\n$1')
      .replace(/\n(\d+\.\s+)/g, '\n$1')
      
      // Clean up excessive newlines
      .replace(/\n{4,}/g, '\n\n')
      .trim();
    
    return {
      url: jobUrl,
      title: title,
      description: formattedDescription, // Use the formatted job content
      location: location,
      deadline: deadline,
      contractType: contractType,
      functionalArea: functionalArea,
      positionLevel: positionLevel,
      startDate: startDate, // Add extracted start date
      endDate: endDate, // Add extracted end date
      extractedDeadline: deadline // Add extracted deadline
    };
    
  } catch (error) {
    console.error(`❌ Error scraping job detail ${jobUrl}:`, error.message);
    return {
      url: jobUrl,
      title: basicInfo.title || '',
      description: '',
      location: basicInfo.location || '',
      deadline: basicInfo.deadline || '',
      contractType: basicInfo.contractType || '',
      functionalArea: '',
      positionLevel: '',
      startDate: null,
      endDate: null,
      extractedDeadline: null
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

// Main ETL function for UNICEF job vacancies
async function fetchAndProcessUnicefJobVacancies() {
  console.log("==================================");
  console.log("UNICEF Job Vacancies ETL started...");
  console.log("==================================");

  const client = new Client(credentials);
  await client.connect();

  let totalProcessed = 0;
  let totalErrors = 0;
  let totalSuccess = 0;

  try {
    // Get organization ID for UNICEF
    const orgId = await getOrganizationId("UNICEF");
    
    // Step 1: Scrape job listings from main page
    const jobListings = await scrapeJobListings();
    
    if (jobListings.length === 0) {
      console.warn("⚠️ No job listings found. Website structure may have changed.");
      return;
    }
    
    console.log(`📋 Processing ${jobListings.length} job listings...`);
    
    // Step 2: Process each job
    for (const [index, basicJob] of jobListings.entries()) {
      try {
        console.log(`🔄 Processing job ${index + 1}/${jobListings.length}: ${basicJob.title}`);
        
        // Extract job ID from URL
        const jobId = extractJobId(basicJob.url);
        if (!jobId) {
          console.warn(`⚠️ Could not extract job ID from URL: ${basicJob.url}`);
          totalErrors++;
          continue;
        }
        
        // Step 3: Scrape detailed job information
        const jobDetail = await scrapeJobDetail(basicJob.url, basicJob);
        
        // Step 4: Prepare job data for database using extracted dates
        // Use the dates extracted from the job detail page
        let startDate = jobDetail.startDate;
        let endDate = jobDetail.endDate;
        let deadline = jobDetail.extractedDeadline;
        
        // Fallback logic for missing dates
        if (!endDate && deadline) {
          endDate = deadline; // Use deadline as end date if no duration found
        }
        
        if (!startDate && endDate) {
          // If we have end date but no start date, set start date to 30 days before end date
          startDate = new Date(endDate.getTime() - (30 * 24 * 60 * 60 * 1000));
        }
        
        // Final fallbacks to meet database constraints
        if (!startDate) {
          startDate = new Date(); // Default to today
        }
        if (!endDate) {
          endDate = new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)); // Default to 90 days from now
        }
        
        console.log(`📅 Final dates - Start: ${startDate.toDateString()}, End: ${endDate.toDateString()}`);
        
        // Helper function to truncate strings to fit database constraints
        const truncateField = (value, maxLength, fieldName = '') => {
          if (!value) return '';
          const str = String(value).trim();
          if (str.length <= maxLength) return str;
          console.log(`⚠️ Truncating ${fieldName} from ${str.length} to ${maxLength} characters`);
          return str.substring(0, maxLength - 3) + '...';
        };

        const jobData = {
          job_id: parseInt(jobId),
          language: 'EN',
          category_code: truncateField(jobDetail.functionalArea, 30, 'category_code'),
          job_title: truncateField(jobDetail.title, 500, 'job_title'), // Allow longer titles
          job_code_title: '',
          job_description: jobDetail.description || '',
          job_family_code: '',
          job_level: truncateField(jobDetail.positionLevel, 20, 'job_level'),
          duty_station: truncateField(jobDetail.location, 100, 'duty_station'), // Allow longer locations
          recruitment_type: truncateField(jobDetail.contractType, 100, 'recruitment_type'),
          start_date: startDate,
          end_date: endDate,
          dept: 'UNICEF',
          total_count: null,
          jn: truncateField(jobDetail.functionalArea, 100, 'jn'), // Shortened for better data
          jf: '',
          jc: '',
          jl: truncateField(jobDetail.positionLevel, 100, 'jl'), // Shortened for better data
          data_source: 'unicef',
          organization_id: orgId,
          apply_link: jobDetail.url
        };
        
        console.log(`📝 Prepared job data - Station: "${jobData.duty_station}", Level: "${jobData.job_level}", Category: "${jobData.category_code}"`);
        
        // Step 5: Validate and upsert job data
        const validation = validateJobData(jobData, ['job_id', 'job_title', 'data_source']);
        if (!validation.isValid) {
          console.error(`❌ Validation failed for job ${jobId}:`, validation.errors);
          totalErrors++;
          continue;
        }
        
        const result = await upsertJobVacancy(client, jobData, 'UNICEF');
        if (result.success) {
          console.log(`✅ ${result.action}: ${jobDetail.title}`);
          totalSuccess++;
        } else {
          console.error(`❌ Failed to save job ${jobId}:`, result.error);
          totalErrors++;
        }
        
        totalProcessed++;
        
        // Rate limiting - pause between jobs
        if (index < jobListings.length - 1) {
          await delay(1500); // 1.5 second delay between jobs
        }
        
      } catch (jobError) {
        console.error(`❌ Error processing job:`, jobError.message);
        totalErrors++;
        totalProcessed++;
      }
    }
    
  } catch (error) {
    console.error('❌ UNICEF ETL failed:', error.message);
    throw error;
  } finally {
    await client.end();
    
    console.log("==================================");
    console.log(`UNICEF ETL Summary:`);
    console.log(`📊 Total processed: ${totalProcessed} jobs`);
    console.log(`✅ Successfully saved: ${totalSuccess} jobs`);
    console.log(`❌ Errors encountered: ${totalErrors} jobs`);
    console.log("==================================");
  }
}

module.exports = { fetchAndProcessUnicefJobVacancies };