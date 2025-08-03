require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const baseUrl = 'https://careers.unesco.org';
const listingUrl = 'https://careers.unesco.org/go/All-jobs-openings/782502/';

// Helper function to add delay between requests (rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Extract job ID from UNESCO job URL
const extractJobId = (jobUrl) => {
  // UNESCO URLs have format: https://careers.unesco.org/job/Title/ID/
  const match = jobUrl.match(/\/job\/[^\/]+\/(\d+)\/?$/);
  return match ? match[1] : null;
};

// Parse deadline date from UNESCO format
const parseDeadline = (deadlineText) => {
  if (!deadlineText) return null;
  
  try {
    // UNESCO uses formats like "14-Aug-2025", "01-SEP-2025", "31-DEC-2025"
    const cleanText = deadlineText.trim();
    const date = new Date(cleanText);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.warn(`Failed to parse deadline: ${deadlineText}`);
    return null;
  }
};

// Scrape job listings from the main UNESCO jobs page using Puppeteer
const scrapeJobListings = async () => {
  console.log("🔍 Scraping UNESCO job listings with Puppeteer...");
  
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
    
    console.log("🌐 Navigating to UNESCO jobs page...");
    
    // Navigate to the page and wait for network to be idle
    await page.goto(listingUrl, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    console.log("⏳ Waiting for page to fully load...");
    await delay(5000);
    
    // Try to wait for job listings table to appear
    try {
      await page.waitForSelector('table, .job-listing, [role="table"]', { timeout: 15000 });
      console.log("✅ Job listings table found on page");
    } catch (waitError) {
      console.log("⚠️ No specific job table selectors found, proceeding with page content...");
    }
    
    const allJobs = [];
    let currentPage = 1;
    let hasMorePages = true;
    // Limit pages for testing, use 10 for production
    const maxPages = process.env.NODE_ENV === 'test' ? 1 : 10;
    
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
        if (cells.length >= 5) { // Title, Location, Type, Grade, Closing date
          const $titleCell = $(cells[0]);
          const $locationCell = $(cells[1]);
          const $typeCell = $(cells[2]);
          const $gradeCell = $(cells[3]);
          const $deadlineCell = $(cells[4]);
          
          // Extract job link and title
          const jobLink = $titleCell.find('a').attr('href');
          let jobTitle = $titleCell.find('a').text().trim();
          
          // Fix duplicate title issue - UNESCO seems to duplicate job titles
          // Look for pattern like "TitleTitle" and extract just "Title"
          if (jobTitle.length > 10) {
            const halfPoint = Math.floor(jobTitle.length / 2);
            const firstHalf = jobTitle.substring(0, halfPoint);
            const secondHalf = jobTitle.substring(halfPoint);
            
            // If the two halves are identical, use just the first half
            if (firstHalf === secondHalf) {
              jobTitle = firstHalf;
            } else {
              // Try splitting by words and checking for duplicated phrases
              const words = jobTitle.split(' ');
              const midPoint = Math.floor(words.length / 2);
              const firstHalfWords = words.slice(0, midPoint).join(' ');
              const secondHalfWords = words.slice(midPoint).join(' ');
              
              if (firstHalfWords === secondHalfWords && firstHalfWords.length > 5) {
                jobTitle = firstHalfWords;
              }
            }
          }
          
          if (jobLink && jobTitle) {
            const fullJobUrl = jobLink.startsWith('http') ? jobLink : baseUrl + jobLink;
            const jobId = extractJobId(fullJobUrl);
            
            const jobData = {
              id: jobId,
              title: jobTitle,
              url: fullJobUrl,
              location: $locationCell.text().trim(),
              type: $typeCell.text().trim(),
              grade: $gradeCell.text().trim(),
              deadline: parseDeadline($deadlineCell.text().trim())
            };
            
            pageJobs.push(jobData);
          }
        }
      });
      
      // Alternative strategy: Look for other job listing structures
      if (pageJobs.length === 0) {
        $('[href*="/job/"]').each((index, element) => {
          const $link = $(element);
          const jobUrl = $link.attr('href');
          const jobTitle = $link.text().trim();
          
          if (jobUrl && jobTitle) {
            const fullJobUrl = jobUrl.startsWith('http') ? jobUrl : baseUrl + jobUrl;
            const jobId = extractJobId(fullJobUrl);
            
            // Try to find additional details in the same row or nearby elements
            const $container = $link.closest('tr, .job-item, .vacancy-item');
            
            const jobData = {
              id: jobId,
              title: jobTitle,
              url: fullJobUrl,
              location: '',
              type: '',
              grade: '',
              deadline: null
            };
            
            pageJobs.push(jobData);
          }
        });
      }
      
      console.log(`📋 Found ${pageJobs.length} jobs on page ${currentPage}`);
      allJobs.push(...pageJobs);
      
      // Check for pagination and navigate to next page
      hasMorePages = false;
      
      try {
        // Look for pagination controls using valid CSS selectors
        const paginationSelectors = [
          '.pagination a',
          'a[href*="page"]',
          'a[href*="782502"]',
          '.pagination-next',
          '[data-page]'
        ];
        
        let nextPageLink = null;
        for (const selector of paginationSelectors) {
          const links = await page.$$(selector);
          if (links.length > 0) {
            nextPageLink = links[0];
            break;
          }
        }
        
        // Alternative: Look for page numbers
        if (!nextPageLink) {
          const nextPageNumber = currentPage + 1;
          const pageLinks = await page.$$(`a[href*="${nextPageNumber}"]`);
          if (pageLinks.length > 0) {
            nextPageLink = pageLinks[0];
          }
        }
        
        if (nextPageLink) {
          console.log(`🔄 Navigating to page ${currentPage + 1}...`);
          await nextPageLink.click();
          await page.waitForLoadState?.('networkidle') || await delay(3000);
          currentPage++;
          hasMorePages = true;
        } else {
          console.log("📄 No more pages found");
        }
        
      } catch (pageError) {
        console.log(`⚠️ Pagination error: ${pageError.message}`);
        hasMorePages = false;
      }
      
      // Safety check: if no jobs found on this page, stop
      if (pageJobs.length === 0) {
        console.log("⚠️ No jobs found on current page, stopping pagination");
        hasMorePages = false;
      }
    }
    
    console.log(`✅ Total jobs found: ${allJobs.length}`);
    return allJobs;
    
  } catch (error) {
    console.error("❌ Error scraping UNESCO job listings:", error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

// Scrape detailed job information from individual job pages
const scrapeJobDetails = async (jobUrl, maxRetries = 3) => {
  let browser = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
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
      
      console.log(`🔍 Scraping job details from: ${jobUrl} (attempt ${attempt})`);
      
      await page.goto(jobUrl, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });
      
      await delay(2000);
      
      const html = await page.content();
      const $ = cheerio.load(html);
      
      // Extract job details from the page
      const jobDetails = {
        title: '',
        description: '',
        requirements: '',
        location: '',
        deadline: null,
        startDate: null,
        endDate: null,
        type: '',
        grade: '',
        dutyStation: '',
        contractType: '',
        department: '',
        salary: ''
      };
      
      // Extract title
      const titleSelectors = [
        'h1',
        '.job-title',
        '[data-automation-id="jobPostingHeader"]',
        '.vacancy-title'
      ];
      
      for (const selector of titleSelectors) {
        const title = $(selector).first().text().trim();
        if (title) {
          jobDetails.title = title;
          break;
        }
      }
      
      // Extract job description
      const descriptionSelectors = [
        '.job-description',
        '#job-description',
        '[data-automation-id="jobPostingDescription"]',
        '.vacancy-description',
        '.job-details',
        '.content'
      ];
      
      for (const selector of descriptionSelectors) {
        const description = $(selector).text().trim();
        if (description && description.length > 50) {
          jobDetails.description = description;
          break;
        }
      }
      
      // Extract requirements
      const requirementsSelectors = [
        '.requirements',
        '#requirements',
        '[data-automation-id="requirements"]',
        '.qualifications',
        'h3:contains("Requirements") + *',
        'h3:contains("Qualifications") + *'
      ];
      
      for (const selector of requirementsSelectors) {
        const requirements = $(selector).text().trim();
        if (requirements && requirements.length > 20) {
          jobDetails.requirements = requirements;
          break;
        }
      }
      
      // Extract location/duty station  
      const locationSelectors = [
        '.location',
        '.duty-station',
        '[data-automation-id="locations"]',
        '.job-location',
        'td:contains("Location") + td',
        'strong:contains("Location") + *',
        '.job-details td:contains("Location") + td'
      ];
      
      for (const selector of locationSelectors) {
        const location = $(selector).text().trim();
        if (location) {
          jobDetails.location = location;
          jobDetails.dutyStation = location;
          break;
        }
      }
      
      // Extract deadline from various possible locations
      const deadlineSelectors = [
        '.deadline',
        '.closing-date',
        '[data-automation-id="deadline"]',
        'td:contains("Closing date") + td',
        'td:contains("closing date") + td',
        'strong:contains("Closing date") + *',
        'strong:contains("closing date") + *',
        '.application-deadline',
        '.job-deadline',
        'div:contains("Closing date")',
        'div:contains("closing date")'
      ];
      
      for (const selector of deadlineSelectors) {
        const deadlineText = $(selector).text().trim();
        if (deadlineText) {
          jobDetails.deadline = parseDeadline(deadlineText);
          if (jobDetails.deadline) break;
        }
      }
      
      // Extract contract type and grade from job details
      const detailSelectors = [
        '.job-details tr',
        '.vacancy-details tr',
        '.job-info tr'
      ];
      
      for (const selector of detailSelectors) {
        $(selector).each((index, element) => {
          const $row = $(element);
          const label = $row.find('td:first-child, th:first-child').text().trim().toLowerCase();
          const value = $row.find('td:last-child').text().trim();
          
          if (label.includes('type') || label.includes('post')) {
            jobDetails.type = value;
            jobDetails.contractType = value;
          } else if (label.includes('grade') || label.includes('level')) {
            jobDetails.grade = value;
          } else if (label.includes('department') || label.includes('unit')) {
            jobDetails.department = value;
          } else if (label.includes('salary') || label.includes('compensation')) {
            jobDetails.salary = value;
          }
        });
      }
      
      // Set default dates if not found
      if (!jobDetails.startDate) {
        jobDetails.startDate = new Date();
      }
      if (!jobDetails.endDate && jobDetails.deadline) {
        jobDetails.endDate = jobDetails.deadline;
      } else if (!jobDetails.endDate) {
        // Default to 30 days from now if no deadline found
        jobDetails.endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
      
      return jobDetails;
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed for ${jobUrl}:`, error.message);
      
      if (attempt === maxRetries) {
        console.error(`❌ Failed to scrape ${jobUrl} after ${maxRetries} attempts`);
        return null;
      }
      
      // Wait before retrying
      await delay(2000 * attempt);
    } finally {
      if (browser) {
        await browser.close();
        browser = null;
      }
    }
  }
  
  return null;
};

// Main ETL function
const fetchAndProcessUnescoJobVacancies = async () => {
  console.log("==================================");
  console.log("UNESCO Job Vacancies ETL started...");
  console.log("==================================");
  
  const client = new Client(credentials);
  let jobsProcessed = 0;
  let jobsSuccessful = 0;
  let jobsErrored = 0;
  
  try {
    await client.connect();
    
    // Get UNESCO organization ID
    const organizationId = await getOrganizationId('UNESCO');
    console.log(`🏢 UNESCO Organization ID: ${organizationId}`);
    
    // Step 1: Scrape job listings
    const jobListings = await scrapeJobListings();
    
    if (jobListings.length === 0) {
      console.log("⚠️ No job listings found");
      return;
    }
    
    console.log(`📋 Found ${jobListings.length} job listings to process`);
    
    // Limit to first 5 jobs for testing (remove this line for production)
    const jobsToProcess = process.env.NODE_ENV === 'test' ? jobListings.slice(0, 5) : jobListings;
    console.log(`📝 Processing ${jobsToProcess.length} jobs...`);
    
    // Step 2: Process each job
    for (const [index, job] of jobsToProcess.entries()) {
      jobsProcessed++;
      
      try {
        console.log(`\n📄 Processing job ${index + 1}/${jobListings.length}: ${job.title}`);
        
        // Get detailed job information
        const jobDetails = await scrapeJobDetails(job.url);
        
        if (!jobDetails) {
          console.log(`⚠️ Failed to get details for: ${job.title}`);
          jobsErrored++;
          continue;
        }
        
        // Merge basic info with detailed info
        const completeJobData = {
          job_id: job.id || `unesco_${index}`,
          job_title: jobDetails.title || job.title,
          job_description: jobDetails.description || '',
          job_requirements: jobDetails.requirements || '',
          job_url: job.url,
          start_date: jobDetails.startDate,
          end_date: jobDetails.endDate,
          duty_station: jobDetails.dutyStation || job.location || '',
          organization_id: organizationId,
          data_source: 'UNESCO',
          contract_type: jobDetails.contractType || job.type || '',
          grade: jobDetails.grade || job.grade || '',
          department: jobDetails.department || '',
          salary: jobDetails.salary || '',
          apply_link: job.url
        };
        
        // Validate job data
        const validation = validateJobData(completeJobData);
        if (!validation.isValid) {
          console.log(`❌ Invalid job data for "${completeJobData.job_title}": ${validation.errors.join(', ')}`);
          jobsErrored++;
          continue;
        }
        
        // Upsert job vacancy
        const upsertResult = await upsertJobVacancy(client, completeJobData);
        
        if (upsertResult.success) {
          console.log(`✅ ${completeJobData.job_title}`);
          jobsSuccessful++;
        } else {
          console.log(`❌ Failed to save "${completeJobData.job_title}": ${upsertResult.error}`);
          jobsErrored++;
        }
        
        // Rate limiting
        await delay(1000);
        
      } catch (error) {
        console.error(`❌ Error processing job "${job.title}":`, error.message);
        jobsErrored++;
      }
    }
    
  } catch (error) {
    console.error("❌ UNESCO ETL Error:", error);
    throw error;
  } finally {
    await client.end();
    
    // Print summary
    console.log("==================================");
    console.log("UNESCO ETL Summary:");
    console.log(`✅ Successfully processed: ${jobsSuccessful} jobs`);
    console.log(`❌ Errors encountered: ${jobsErrored} jobs`);
    console.log("==================================");
  }
};

module.exports = {
  fetchAndProcessUnescoJobVacancies,
  scrapeJobListings,
  scrapeJobDetails
};