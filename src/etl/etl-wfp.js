require("dotenv").config();

const { Client } = require("pg");
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");

const url = "https://wd3.myworkdaysite.com/wday/cxs/wfp/job_openings/jobs"; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchAndProcessWfpJobVacancies() {
  console.log("==================================");
  console.log("WFP Job Vacancies ETL started...");
  console.log("==================================");
  
  const client = new Client(credentials);
  await client.connect();

  let page = 0;
  const itemsPerPage = 20; // items per page
  let totalPages = 1; // Initialize to 1 to enter the loop
  let totalProcessed = 0;
  let totalErrors = 0;

  while (page < totalPages) {
    const payload = {
      "appliedFacets": {},
      "limit": itemsPerPage,
      "offset": page * itemsPerPage,
      "searchText": ""
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (totalPages == 1) {
        totalPages = Math.ceil(data.total / itemsPerPage);
      }

      // Process each job in the current page
      for (const job of data.jobPostings) {
        try {
          var jobDetailAPI = `https://wd3.myworkdaysite.com/wday/cxs/wfp/job_openings${job.externalPath}`;

          const responseDetail = await fetch(jobDetailAPI);
          const jobDetail = await responseDetail.json();

          const startDate = jobDetail.jobPostingInfo.startDate
            ? new Date(jobDetail.jobPostingInfo.startDate)
            : null;
          const endDate = jobDetail.jobPostingInfo.endDate
            ? new Date(jobDetail.jobPostingInfo.endDate)
            : null;

          const orgId = await getOrganizationId("WFP"); // Get organization id

          // Prepare job data for validation and upsert
          const jobData = {
            job_id: jobDetail.jobPostingInfo.id,
            language: "EN",
            category_code: job.bulletFields[0] || '',
            job_title: job.title,
            job_code_title: jobDetail.jobPostingInfo.jobPostingId,
            job_description: jobDetail.jobPostingInfo.jobDescription,
            job_family_code: "", // jobFamilyCode,
            job_level: "", // jobLevel,
            duty_station: jobDetail.jobPostingInfo.location, // Convert duty station to JSON string
            recruitment_type: jobDetail.jobPostingInfo.timeType,
            start_date: startDate, // Convert to Date object
            end_date: endDate, // Convert to Date object
            dept: jobDetail.hiringOrganization.name || "", // Check if dept is defined
            total_count: job.total,
            jn: "", // Check if jn is defined
            jf: "",
            jc: "",
            jl: "",
            created: new Date(),
            data_source: "wfp",
            organization_id: orgId,
            apply_link: "https://wd3.myworkdaysite.com/en-US/recruiting/wfp/job_openings/details/" + jobDetail.jobPostingInfo.jobPostingId
          };

          // Validate job data
          const validation = validateJobData(jobData);
          if (!validation.isValid) {
            console.error(`❌ Validation failed for job ${jobDetail.jobPostingInfo.id}:`, validation.errors);
            totalErrors++;
            continue;
          }

          // Upsert the job vacancy
          await upsertJobVacancy(client, jobData);
          console.log(`✅ ${job.title}`);
          totalProcessed++;

        } catch (jobError) {
          console.error(`❌ Error processing job ${job.title}:`, jobError.message);
          totalErrors++;
        }
      }

      page++; // Move to the next page
    } catch (error) {
      console.error("❌ Error fetching page data:", error);
      break; // Break the loop on fetch error
    }
  }

  await client.end(); // Close the database connection
  
  console.log("==================================");
  console.log(`WFP ETL Summary:`);
  console.log(`✅ Successfully processed: ${totalProcessed} jobs`);
  console.log(`❌ Errors encountered: ${totalErrors} jobs`);
  console.log("==================================");
}

module.exports = { fetchAndProcessWfpJobVacancies };