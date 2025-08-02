require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const baseUrl = 'https://jobs.unops.org';
const listingUrl = 'https://jobs.unops.org/Pages/ViewVacancy/VAListing.aspx';

// Helper function to add delay between requests (rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Extract job ID from UNOPS job URL
const extractJobId = (jobUrl) => {
  const match = jobUrl.match(/id=(\d+)/);
  return match ? match[1] : null;
};

// Parse deadline date from UNOPS format
const parseDeadline = (deadlineText) => {
  if (!deadlineText) return null;
  
  try {
    // UNOPS uses format like "24-Aug-2025"
    const cleanText = deadlineText.replace(/Closing date:\s*/i, '').trim();
    const date = new Date(cleanText);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.warn(`Failed to parse deadline: ${deadlineText}`);
    return null;
  }
};

// Scrape job listings from the main UNOPS jobs page using Puppeteer
const scrapeJobListings = async () => {
  console.log("🔍 Scraping UNOPS job listings with Puppeteer...");
  
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
    
    console.log("🌐 Navigating to UNOPS jobs page...");
    
    // Navigate to the page and wait for network to be idle
    await page.goto(listingUrl, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    console.log("⏳ Waiting for page to fully load...");
    await delay(5000);
    
    // Try to wait for job listings table to appear
    try {
      await page.waitForSelector('table, .gvActiveVacancies, #ctl00_MainPageContent_ActiveVacancies_gvActiveVacancies', { timeout: 15000 });
      console.log("✅ Job listings table found on page");
    } catch (waitError) {
      console.log("⚠️ No specific job table selectors found, proceeding with page content...");
    }
    
    const allJobs = [];
    let currentPage = 1;
    let hasMorePages = true;
    const maxPages = 10; // Prevent infinite loops
    
    while (hasMorePages && currentPage <= maxPages) {
      console.log(`📄 Processing page ${currentPage}...`);
      
      // Get current page content
      const html = await page.content();
      const $ = cheerio.load(html);
      
      // Extract jobs from current page
      const pageJobs = [];
      
      // Strategy 1: Look for job rows in table
      $('table tr').each((index, element) => {
        const $row = $(element);
        
        // Skip header row
        if ($row.find('th').length > 0) return;
        
        const cells = $row.find('td');
        if (cells.length >= 4) {
          const $titleCell = $(cells[0]);
          const $levelCell = $(cells[1]);
          const $locationCell = $(cells[2]);
          const $deadlineCell = $(cells[3]);
          
          // Look for job link in title cell
          const $jobLink = $titleCell.find('a[href*="VADetails.aspx"]');
          if ($jobLink.length > 0) {
            const href = $jobLink.attr('href');
            let jobUrl = href;
            if (jobUrl.startsWith('/')) {
              jobUrl = baseUrl + jobUrl;
            } else if (jobUrl.startsWith('VADetails.aspx')) {
              jobUrl = baseUrl + '/Pages/ViewVacancy/' + jobUrl;
            }
            
            const title = $jobLink.text().trim();
            // Clean level field to get just the level code (e.g., "LICA Specialist-11", "IICA-2")
            const level = $levelCell.text().trim().replace(/\s+/g, ' ').substring(0, 50);
            const location = $locationCell.text().trim().replace(/\s+/g, ' ').substring(0, 100);
            const deadline = $deadlineCell.text().trim().replace(/\s+/g, ' ').substring(0, 50);
            
            if (title && title.length > 5) {
              pageJobs.push({
                url: jobUrl,
                title: title,
                level: level,
                location: location,
                deadline: deadline,
                contractType: '' // Will be extracted from detail page
              });
            }
          }
        }
      });
      
      // Strategy 2: Look for direct job links if table parsing didn't work
      if (pageJobs.length === 0) {
        $('a[href*="VADetails.aspx"]').each((index, element) => {
          const $element = $(element);
          const href = $element.attr('href');
          
          if (href && href.includes('id=')) {
            let jobUrl = href;
            if (jobUrl.startsWith('/')) {
              jobUrl = baseUrl + jobUrl;
            } else if (jobUrl.startsWith('VADetails.aspx')) {
              jobUrl = baseUrl + '/Pages/ViewVacancy/' + jobUrl;
            }
            
            const title = $element.text().trim();
            if (title && title.length > 5 && title.length < 200) {
              // Try to find additional info from surrounding elements
              const $parent = $element.closest('tr, div');
              const location = $parent.find('td').eq(2).text().trim() || '';
              const level = $parent.find('td').eq(1).text().trim() || '';
              const deadline = $parent.find('td').eq(3).text().trim() || '';
              
              pageJobs.push({
                url: jobUrl,
                title: title,
                level: level.substring(0, 50), // Limit length
                location: location.substring(0, 100), // Limit length
                deadline: deadline.substring(0, 50), // Limit length
                contractType: '' // Will be extracted from detail page
              });
            }
          }
        });
      }
      
      console.log(`📋 Found ${pageJobs.length} jobs on page ${currentPage}`);
      allJobs.push(...pageJobs);
      
      // Check for next page pagination
      let nextPageClicked = false;
      
      try {
        // Look for next page button
        const nextPageSelectors = [
          'a[href*="Page$2"]', // Page 2 link
          'a[href*="Page$' + (currentPage + 1) + '"]', // Next page number
          'a[href*="Page$Next"]', // Next page link
          'a:contains(">")', // Generic next
          'a:contains("Next")',
          'a[href*="Page$Last"]' // If we find last page, check if we can go to it
        ];
        
        for (const selector of nextPageSelectors) {
          const nextPageButton = await page.$(selector);
          if (nextPageButton) {
            console.log(`🔄 Found next page button with selector: ${selector}`);
            
            // Check if this is for the current+1 page or just any next page
            const buttonText = await page.evaluate(el => el.textContent, nextPageButton);
            const targetPage = currentPage + 1;
            
            if (selector.includes('Page$' + targetPage) || 
                buttonText.includes('>') || 
                buttonText.toLowerCase().includes('next') ||
                (currentPage === 1 && selector.includes('Page$2'))) {
              
              console.log(`📄 Clicking to go to page ${targetPage}...`);
              await nextPageButton.click();
              
              // Wait for new page to load
              await delay(3000);
              await page.waitForLoadState?.('networkidle') || await delay(2000);
              
              nextPageClicked = true;
              currentPage++;
              break;
            }
          }
        }
        
        // If no specific next page button found, try to find page numbers
        if (!nextPageClicked && currentPage < maxPages) {
          const pageNumberButtons = await page.$$('a[href*="Page$"]');
          for (const button of pageNumberButtons) {
            const buttonText = await page.evaluate(el => el.textContent, button);
            if (buttonText.trim() === (currentPage + 1).toString()) {
              console.log(`📄 Clicking page number ${currentPage + 1}...`);
              await button.click();
              await delay(3000);
              nextPageClicked = true;
              currentPage++;
              break;
            }
          }
        }
        
      } catch (paginationError) {
        console.log("⚠️ Pagination error:", paginationError.message);
      }
      
      if (!nextPageClicked) {
        console.log("✅ No more pages found or reached max pages");
        hasMorePages = false;
      }
    }
    
    console.log(`✅ Found ${allJobs.length} total job listings across ${currentPage} pages`);
    return allJobs;
    
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
    
    await delay(3000);
    
    // Wait for the job content to load
    try {
      await page.waitForSelector('main, .job-detail, .MainPageContent, #MainPageContent', { timeout: 10000 });
    } catch (waitError) {
      console.log("⚠️ Job content selectors not found, proceeding with full page...");
    }
    
    // Get the page content
    const html = await page.content();
    const $ = cheerio.load(html);
    
    // Extract job details
    const extractText = (selectors) => {
      for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text && text.length > 0) return text;
      }
      return '';
    };
    
    // Get the main job content - focus on job-specific sections only
    let jobContent = '';
    
    // First remove navigation and unwanted elements from the entire page
    $('nav, header, footer, .navigation, .breadcrumb, .sidebar, script, style').remove();
    $('[class*="nav"], [class*="menu"], [class*="header"], [class*="footer"]').remove();
    
    // Find the main job content by looking for key job information
    let mainJobContent = '';
    
    // Strategy 1: Look for the job title and extract everything after it
    const jobTitleElement = $('h1, .job-title, [class*="title"]').filter((i, el) => {
      const text = $(el).text().trim();
      return text.length > 10 && text.includes('Technical Advisor') || text.includes('Advisor') || text.includes('Officer') || text.includes('Specialist');
    }).first();
    
    if (jobTitleElement.length > 0) {
      // Get all content after the job title, excluding navigation elements
      let currentElement = jobTitleElement.parent();
      while (currentElement.length > 0 && currentElement.text().length < 1000) {
        currentElement = currentElement.parent();
      }
      
      if (currentElement.length > 0) {
        // Remove navigation and UI elements from this section
        currentElement.find('nav, .nav, .navigation, .menu, .breadcrumb').remove();
        currentElement.find('[class*="social"], [class*="share"], [class*="button"]').remove();
        mainJobContent = currentElement.text();
      }
    }
    
    // Strategy 2: If strategy 1 didn't work, look for specific job sections
    if (!mainJobContent || mainJobContent.length < 500) {
      const jobSections = [];
      
      // Look for expandable sections or content divs that contain job information
      $('div').each((i, el) => {
        const $el = $(el);
        const text = $el.text();
        
        // Check if this div contains job-specific content
        if (text.includes('Background Information') || 
            text.includes('Functional Responsibilities') ||
            text.includes('Education/Experience') ||
            text.includes('Competencies') ||
            text.includes('Contract type') ||
            (text.includes('Job categories') && text.length > 100)) {
          
          // Get the text but clean it of navigation elements
          $el.find('nav, .nav, .navigation, .menu, .breadcrumb').remove();
          jobSections.push($el.text());
        }
      });
      
      if (jobSections.length > 0) {
        mainJobContent = jobSections.join('\n\n');
      }
    }
    
    // Strategy 3: Fallback to main content areas
    if (!mainJobContent || mainJobContent.length < 500) {
      const mainContentSelectors = [
        '#MainPageContent',
        '.MainPageContent', 
        'main',
        '.job-detail-content',
        '.content-area'
      ];
      
      for (const selector of mainContentSelectors) {
        const element = $(selector);
        if (element.length > 0) {
          // Clean the element first
          element.find('nav, .nav, .navigation, .menu, .breadcrumb, .social-share, .apply-buttons').remove();
          mainJobContent = element.text().trim();
          if (mainJobContent.length > 500) {
            break;
          }
        }
      }
    }
    
    jobContent = mainJobContent;
    
    // Clean up the content more aggressively to remove UI elements and unwanted content
    jobContent = jobContent
      .replace(/<!--[\s\S]*?-->/g, '') // Remove HTML comments
      .replace(/<script[\s\S]*?<\/script>/gi, '') // Remove script tags
      .replace(/<style[\s\S]*?<\/style>/gi, '') // Remove style tags
      
      // Remove JavaScript code and social media widgets
      .replace(/\(function\([\s\S]*?\}\)\([\s\S]*?\);?/g, '') // Remove function expressions
      .replace(/!function\s*\([\s\S]*?\}\s*\([\s\S]*?\);?/g, '') // Remove !function expressions
      .replace(/function\s*\([\s\S]*?\{[\s\S]*?\}/g, '') // Remove function declarations
      .replace(/var\s+[\w\s,=]+;/g, '') // Remove variable declarations
      .replace(/js\.src\s*=[\s\S]*?;/g, '') // Remove script src assignments
      .replace(/getElementsByTagName[\s\S]*?;/g, '') // Remove DOM manipulation
      .replace(/getElementById[\s\S]*?;/g, '') // Remove DOM queries
      .replace(/createElement[\s\S]*?;/g, '') // Remove element creation
      .replace(/insertBefore[\s\S]*?;/g, '') // Remove DOM insertion
      .replace(/\.test\([\s\S]*?\)/g, '') // Remove test method calls
      .replace(/d\.location[\s\S]*?;/g, '') // Remove location checks
      .replace(/connect\.facebook\.net[\s\S]*?"/g, '') // Remove Facebook SDK URLs
      .replace(/platform\.twitter\.com[\s\S]*?"/g, '') // Remove Twitter widget URLs
      .replace(/#xfbml[\s\S]*?"/g, '') // Remove Facebook parameters
      .replace(/version=v[\d\.]+/g, '') // Remove version parameters
      
      // Remove specific UNOPS UI elements and unwanted content
      .replace(/VACANCIES INTERNSHIPS ROSTERS TALENT BENCHES/gi, '') // Remove main navigation
      .replace(/Toggle navigation.*?BENCHES/gi, '') // Remove navigation toggle
      .replace(/VACANCIES\s*INTERNSHIPS\s*ROSTERS\s*TALENT\s*BENCHES/gi, '') // Remove spaced navigation
      .replace(/Share[\s\S]*?Email/gi, '') // Remove entire sharing section
      .replace(/Chat with us[\s\S]*?(?=\n|$)/gi, '') // Remove "Chat with us" content
      .replace(/Facebook[\s\S]*?Twitter[\s\S]*?LinkedIn[\s\S]*?Email/gi, '') // Remove social sharing
      .replace(/APPLICATION TIPS[\s\S]*?(?=\n|$)/gi, '') // Remove application tips
      .replace(/TOGETHER, WE BUILD THE FUTURE[\s\S]*?(?=\n|$)/gi, '') // Remove footer content
      .replace(/This vacancy is closed\.*/gi, '') // Remove closed vacancy notice
      .replace(/Apply\s*Print/gi, '') // Remove apply/print buttons
      .replace(/Apply\s*$/gm, '') // Remove standalone Apply buttons
      .replace(/Print\s*$/gm, '') // Remove standalone Print buttons
      .replace(/Expand all \[\+\]/gi, '') // Remove expand UI elements
      .replace(/How to send a good application:[\s\S]*?Spanish/gi, '') // Remove application guide
      .replace(/UNOPS – an operational arm[\s\S]*?flexible working options\./gi, '') // Remove footer description
      .replace(/We understand the importance[\s\S]*?here\./gi, '') // Remove additional footer
      .replace(/Background Information - UNOPS[\s\S]*?balancing professional and personal demands\./gi, '') // Remove UNOPS background
      .replace(/Toggle navigation/gi, '') // Remove toggle text
      .replace(/help\s*$/gm, '') // Remove help links
      
      // Remove additional unwanted patterns
      .replace(/d\s*,\s*s\s*,\s*id/g, '') // Remove parameter lists from JS
      .replace(/js\s*,\s*fjs\s*=/g, '') // Remove JS variable assignments
      .replace(/p\s*=\s*\/\^http[\s\S]*?\?/g, '') // Remove protocol checks
      .replace(/https?:\/\/[\w\.\-\/]+\.js/g, '') // Remove JS file URLs
      .replace(/sdk\.js[\s\S]*?"/g, '') // Remove SDK references
      .replace(/widgets\.js[\s\S]*?"/g, '') // Remove widget references
      
      // Clean up spacing and formatting
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
      .replace(/\s*\n\s*/g, '\n') // Clean up newlines with spaces
      .trim();
    
    // Extract specific job details
    const title = basicInfo.title || extractText([
      'h1', '.job-title', '.position-title'
    ]) || basicInfo.title;
    
    // Extract dates and other details from content
    let startDate = null;
    let endDate = null;
    let deadline = null;
    
    // Parse duration from content
    const durationMatch = jobContent.match(/Duration:\s*([^–\n]+)\s*[–—-]\s*([^\n]+)/i);
    if (durationMatch) {
      try {
        startDate = new Date(durationMatch[1].trim());
        endDate = new Date(durationMatch[2].trim());
        
        if (isNaN(startDate.getTime())) startDate = null;
        if (isNaN(endDate.getTime())) endDate = null;
      } catch (error) {
        console.log(`⚠️ Failed to parse duration: ${durationMatch[0]}`);
      }
    }
    
    // Parse deadline
    const deadlineMatch = jobContent.match(/Application period:.*?to\s+([^\n\r]*)/i) ||
                         jobContent.match(/Closing date:\s*([^\n\r]*)/i) ||
                         jobContent.match(/Application deadline:\s*([^\n\r]*)/i);
    
    if (deadlineMatch) {
      try {
        deadline = parseDeadline(deadlineMatch[1]);
      } catch (error) {
        console.log(`⚠️ Failed to parse deadline: ${deadlineMatch[0]}`);
      }
    }
    
    // Extract specific fields with improved patterns to get exact values only
    // Contract type (e.g., "International ICA")
    const contractTypeMatch = jobContent.match(/Contract type:\s*([A-Za-z\s]{3,50})(?:\s|$)/i);
    const contractType = contractTypeMatch ? contractTypeMatch[1].trim() : basicInfo.level || '';
    
    // Duty station (e.g., "Copenhagen, Denmark") 
    const dutyStationMatch = jobContent.match(/Duty station:\s*([A-Za-z\s,.-]{3,80})(?:\s|$)/i);
    const location = dutyStationMatch ? dutyStationMatch[1].trim() : basicInfo.location || '';
    
    // Extract both Level and Contract level fields
    const levelMatch = jobContent.match(/Level:\s*([A-Za-z0-9\s-]{2,20})(?:\s|$)/i);
    const contractLevelMatch = jobContent.match(/Contract level:\s*([A-Za-z0-9\s-]{2,20})(?:\s|$)/i);
    
    // Use the more specific contract level if available, otherwise use level
    const positionLevel = contractLevelMatch ? contractLevelMatch[1].trim() : 
                         (levelMatch ? levelMatch[1].trim() : basicInfo.level || '');
    
    // Job categories (e.g., "Climate, Programme Management") - stop before "Vacancy code"
    const categoriesMatch = jobContent.match(/Job categories[:\s]*([A-Za-z\s,&-]{3,100})(?:\s+Vacancy|\s+code|\s*$)/i);
    let functionalArea = categoriesMatch ? categoriesMatch[1].trim() : '';
    
    // Clean up the functional area to remove unwanted suffixes
    functionalArea = functionalArea
      .replace(/\s+Vacancy\s*$/i, '') // Remove "Vacancy" at the end
      .replace(/\s+code\s*$/i, '') // Remove "code" at the end  
      .replace(/\s*,\s*$/, '') // Remove trailing comma
      .trim();
    
    // Limit content length
    if (jobContent.length > 25000) {
      jobContent = jobContent.substring(0, 25000) + '...';
    }
    
    // Format the description for proper readability with clear structure
    let formattedDescription = jobContent
      // First pass: create structured sections with proper breaks
      .replace(/(Background Information[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Functional Responsibilities[^:]*:?)/gi, '\n\n## $1\n\n') 
      .replace(/(Key Responsibilities[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Education\/Experience\/Language requirements[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Qualifications[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Requirements[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Competencies[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Terms and Conditions[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Contract type, level and duration[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Additional Considerations[^:]*:?)/gi, '\n\n## $1\n\n')
      .replace(/(Additional Information[^:]*:?)/gi, '\n\n## $1\n\n')
      
      // Format job metadata at the top more cleanly
      .replace(/(Job categories:)\s*([^\n]*)/gi, '\n**$1** $2\n')
      .replace(/(Vacancy code:)\s*([^\n]*)/gi, '**$1** $2\n')
      .replace(/(Department\/office:)\s*([^\n]*)/gi, '**$1** $2\n')
      .replace(/(Duty station:)\s*([^\n]*)/gi, '**$1** $2\n')
      .replace(/(Contract type:)\s*([^\n]*)/gi, '**$1** $2\n')
      .replace(/(Contract level:)\s*([^\n]*)/gi, '**$1** $2\n')
      .replace(/(Duration:)\s*([^\n]*)/gi, '**$1** $2\n')
      .replace(/(Application period:)\s*([^\n]*)/gi, '**$1** $2\n')
      
      // Format subsections within major sections
      .replace(/\b(Education|Experience|Languages?):\s*/gi, '\n\n### $1:\n')
      .replace(/\b(Required|Desired):\s*/gi, '\n\n**$1:**\n')
      
      // Create proper paragraphs by adding breaks after sentences that clearly end paragraphs
      .replace(/([.!?])\s+([A-Z][a-z]{3,})/g, '$1\n\n$2') // Break after sentence if next word is capitalized and long
      .replace(/([.!?])\s+(UNOPS|The|This|All|For|Please)\s/g, '$1\n\n$2 ') // Break before common paragraph starters
      .replace(/([.!?])\s+(\d+\.)/g, '$1\n\n$2') // Break before numbered items
      
      // Format numbered and bulleted lists properly
      .replace(/\s*(\d+)\.\s*([A-Z])/g, '\n\n$1. $2') // Numbered lists
      .replace(/\s*[•·]\s*([A-Z])/g, '\n• $1') // Bullet points
      .replace(/\s*[-–—]\s*([A-Z][a-z]{3,})/g, '\n• $1') // Convert dashes to bullets for long words
      
      // Format competency sections specially
      .replace(/\b(Treats all individuals|Develops and implements|Acts as a positive|Demonstrates understanding|Efficiently establishes|Open to change|Evaluates data|Expresses ideas)\b/gi, '\n\n**• $1**')
      
      // Clean up UNOPS-specific formatting issues
      .replace(/\*\*([^*]+)\*\*\s*\*\*([^*]+)\*\*/g, '**$1** $2') // Merge adjacent bold sections
      .replace(/\*\*\s*\*\*/g, '') // Remove empty bold markers
      
      // Remove any remaining unwanted fragments
      .replace(/return\s*;/g, '') // Remove return statements
      .replace(/function\s*\([^)]*\)/g, '') // Remove function declarations
      .replace(/var\s+\w+/g, '') // Remove variable declarations
      .replace(/\{[^}]*\}/g, '') // Remove code blocks
      .replace(/\[[^\]]*\]/g, '') // Remove array-like structures
      
      // Final whitespace and structure cleanup
      .replace(/\s{2,}/g, ' ') // Normalize multiple spaces to single space
      .replace(/\n\s+/g, '\n') // Remove spaces after line breaks
      .replace(/\s+\n/g, '\n') // Remove spaces before line breaks
      .replace(/\n{4,}/g, '\n\n\n') // Max 3 line breaks for major sections
      .replace(/\n{3}/g, '\n\n') // Normalize triple breaks to double
      .replace(/^\n+/, '') // Remove leading newlines
      .replace(/\n+$/, '') // Remove trailing newlines
      .trim();
    
    return {
      url: jobUrl,
      title: title,
      description: formattedDescription,
      location: location,
      deadline: deadline,
      contractType: contractType,
      functionalArea: functionalArea,
      positionLevel: positionLevel,
      startDate: startDate,
      endDate: endDate,
      extractedDeadline: deadline
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

// Main ETL function for UNOPS job vacancies
async function fetchAndProcessUnopsJobVacancies() {
  console.log("==================================");
  console.log("UNOPS Job Vacancies ETL started...");
  console.log("==================================");

  const client = new Client(credentials);
  await client.connect();

  let totalProcessed = 0;
  let totalErrors = 0;
  let totalSuccess = 0;

  try {
    // Get organization ID for UNOPS
    const orgId = await getOrganizationId("UNOPS");
    
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
        
        // Step 4: Prepare job data for database
        let startDate = jobDetail.startDate;
        let endDate = jobDetail.endDate;
        let deadline = jobDetail.extractedDeadline;
        
        // Use deadline as end date if no end date found
        if (!endDate && deadline) {
          endDate = deadline;
        }
        
        // Set default start date if missing
        if (!startDate && endDate) {
          startDate = new Date(endDate.getTime() - (90 * 24 * 60 * 60 * 1000)); // 90 days before end
        }
        
        // Final fallbacks
        if (!startDate) {
          startDate = new Date(); // Default to today
        }
        if (!endDate) {
          endDate = new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)); // Default to 90 days from now
        }
        
        console.log(`📅 Final dates - Start: ${startDate.toDateString()}, End: ${endDate.toDateString()}`);
        console.log(`🔍 Extracted fields - Contract Type: "${jobDetail.contractType}" (${jobDetail.contractType.length} chars), Level: "${jobDetail.positionLevel}" (${jobDetail.positionLevel.length} chars), Location: "${jobDetail.location}" (${jobDetail.location.length} chars), Category: "${jobDetail.functionalArea}" (${jobDetail.functionalArea.length} chars)`);
        
        // Helper function to truncate strings
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
          job_title: truncateField(jobDetail.title, 500, 'job_title'),
          job_code_title: '',
          job_description: jobDetail.description || '',
          job_family_code: '',
          job_level: truncateField(jobDetail.positionLevel, 20, 'job_level'),
          duty_station: truncateField(jobDetail.location, 100, 'duty_station'),
          recruitment_type: truncateField(jobDetail.contractType, 100, 'recruitment_type'),
          start_date: startDate,
          end_date: endDate,
          dept: 'UNOPS',
          total_count: null,
          jn: truncateField(jobDetail.functionalArea, 100, 'jn'),
          jf: '',
          jc: '',
          jl: truncateField(jobDetail.positionLevel, 100, 'jl'),
          data_source: 'unops',
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
        
        const result = await upsertJobVacancy(client, jobData, 'UNOPS');
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
    console.error('❌ UNOPS ETL failed:', error.message);
    throw error;
  } finally {
    await client.end();
    
    console.log("==================================");
    console.log(`UNOPS ETL Summary:`);
    console.log(`📊 Total processed: ${totalProcessed} jobs`);
    console.log(`✅ Successfully saved: ${totalSuccess} jobs`);
    console.log(`❌ Errors encountered: ${totalErrors} jobs`);
    console.log("==================================");
  }
}

module.exports = { fetchAndProcessUnopsJobVacancies, scrapeJobDetail };