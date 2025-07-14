const { Client } = require("pg");
const { credentials } = require("./db");
const { 
  getOrganizationId, 
  validateJobData, 
  safeApiCall, 
  upsertJobVacancy,
  logETLStatus 
} = require("./shared");

const url = "https://unhcr.wd3.myworkdayjobs.com/wday/cxs/unhcr/External/jobs";

/**
 * Improved UNHCR ETL with duplicate prevention
 * No more temporary duplicates - uses UPSERT logic
 */
async function fetchAndProcessUnhcrJobVacanciesImproved(client = null) {
  const organizationName = 'UNHCR';
  let ownClient = false;
  
  // Use provided client or create new one
  if (!client) {
    client = new Client(credentials);
    await client.connect();
    ownClient = true;
  }

  console.log("==================================");
  console.log("UNHCR Job Vacancies ETL started (Improved - No Duplicates)...");
  console.log("==================================");

  const stats = {
    processedCount: 0,
    successCount: 0,
    errorCount: 0,
    updatedCount: 0,
    insertedCount: 0
  };

  try {
    // Get organization ID once
    const orgId = await getOrganizationId("UNHCR");
    if (!orgId) {
      throw new Error('Could not find UNHCR organization in database');
    }

    let page = 0;
    const itemsPerPage = 20;
    let totalPages = 1;

    await logETLStatus(organizationName, 'running', { start_time: new Date() });

    while (page < totalPages) {
      const payload = {
        "appliedFacets": {},
        "limit": itemsPerPage,
        "offset": page * itemsPerPage,
        "searchText": ""
      };

      console.log(`📄 ${organizationName}: Processing page ${page + 1}...`);

      // Safe API call with retries
      const apiResponse = await safeApiCall(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!apiResponse.success) {
        console.error(`❌ ${organizationName}: Failed to fetch page ${page + 1}: ${apiResponse.error}`);
        stats.errorCount++;
        page++;
        continue;
      }

      const data = apiResponse.data;

      // Set total pages on first response
      if (totalPages === 1 && data.total) {
        totalPages = Math.ceil(data.total / itemsPerPage);
        console.log(`📊 ${organizationName}: Found ${data.total} jobs across ${totalPages} pages`);
      }

      // Process each job
      for (const job of data.jobPostings || []) {
        stats.processedCount++;

        try {
          // Fetch detailed job information
          const jobDetailAPI = `https://unhcr.wd3.myworkdayjobs.com/wday/cxs/unhcr/External${job.externalPath}`;
          
          const detailResponse = await safeApiCall(jobDetailAPI);
          if (!detailResponse.success) {
            console.warn(`⚠️ ${organizationName}: Failed to fetch details for job "${job.title}": ${detailResponse.error}`);
            stats.errorCount++;
            continue;
          }

          const jobDetail = detailResponse.data;

          // Prepare job data for upsert
          const jobData = {
            job_id: jobDetail.jobPostingInfo.id,
            language: "EN",
            category_code: job.bulletFields?.[0] || '',
            job_title: job.title,
            job_code_title: jobDetail.jobPostingInfo.jobPostingId,
            job_description: jobDetail.jobPostingInfo.jobDescription || '',
            job_family_code: '',
            job_level: '',
            duty_station: jobDetail.jobPostingInfo.location || '',
            recruitment_type: jobDetail.jobPostingInfo.timeType || '',
            start_date: jobDetail.jobPostingInfo.startDate ? new Date(jobDetail.jobPostingInfo.startDate) : null,
            end_date: jobDetail.jobPostingInfo.endDate ? new Date(jobDetail.jobPostingInfo.endDate) : null,
            dept: jobDetail.hiringOrganization?.name || '',
            total_count: job.total || null,
            jn: '',
            jf: '',
            jc: '',
            jl: '',
            data_source: 'unhcr',
            organization_id: orgId,
            apply_link: `https://unhcr.wd3.myworkdayjobs.com/en-US/External/details/${jobDetail.jobPostingInfo.jobPostingId}`
          };

          // Validate job data
          const validation = validateJobData(jobData, ['job_id', 'job_title', 'data_source']);
          if (!validation.isValid) {
            console.warn(`⚠️ ${organizationName}: Skipping invalid job "${job.title}": ${validation.errors.join(', ')}`);
            stats.errorCount++;
            continue;
          }

          // Use upsert to prevent duplicates
          const result = await upsertJobVacancy(client, jobData, organizationName);
          
          if (result.success) {
            stats.successCount++;
            if (result.action === 'inserted') {
              stats.insertedCount++;
            } else {
              stats.updatedCount++;
            }
            console.log(`✅ ${organizationName}: ${result.action} "${result.jobTitle}"`);
          } else {
            stats.errorCount++;
            console.warn(`⚠️ ${organizationName}: Failed to save "${job.title}": ${result.error}`);
          }

        } catch (jobError) {
          stats.errorCount++;
          console.error(`❌ ${organizationName}: Error processing job "${job.title}":`, jobError.message);
        }
      }

      page++;
    }

    // Final statistics
    console.log(`\n📊 ${organizationName} ETL Summary:`);
    console.log(`   📝 Total Processed: ${stats.processedCount}`);
    console.log(`   ✅ Successful: ${stats.successCount} (${stats.insertedCount} new, ${stats.updatedCount} updated)`);
    console.log(`   ❌ Errors: ${stats.errorCount}`);

    await logETLStatus(organizationName, 'success', {
      end_time: new Date(),
      processed_count: stats.processedCount,
      success_count: stats.successCount,
      error_count: stats.errorCount
    });

    return {
      success: true,
      organizationName,
      processedCount: stats.processedCount,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      insertedCount: stats.insertedCount,
      updatedCount: stats.updatedCount
    };

  } catch (error) {
    console.error(`❌ ${organizationName}: ETL failed:`, error.message);
    
    await logETLStatus(organizationName, 'failed', {
      end_time: new Date(),
      error_message: error.message,
      processed_count: stats.processedCount,
      success_count: stats.successCount,
      error_count: stats.errorCount
    });

    return {
      success: false,
      error: error.message,
      organizationName,
      processedCount: stats.processedCount,
      successCount: stats.successCount,
      errorCount: stats.errorCount
    };

  } finally {
    if (ownClient) {
      await client.end();
    }
  }
}

module.exports = {
  fetchAndProcessUnhcrJobVacanciesImproved
}; 