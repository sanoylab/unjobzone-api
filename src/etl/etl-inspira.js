require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");  
const url = 'https://careers.un.org/api/public/opening/jo/list/filteredV2/en'; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchAndProcessInspiraJobVacancies() {
    console.log("============================================");

    console.log("UN Secretariate Job Vacancies ETL started...");
    console.log("============================================");


    const client = new Client(credentials);

    await client.connect();
    // NOTE: No longer deleting existing records - using UPSERT to prevent duplicates

    let page = 0;
    const itemsPerPage = 10; // items per page
    let totalPages = 1; // Initialize to 1 to enter the loop

    while (page < totalPages) {
        const payload = {
            filterConfig: {
                keyword: "" // empty keyword as per the payload you provided
            },
            pagination: {
                page: page, // specify the page
                itemPerPage: itemsPerPage, // items per page
                sortBy: "startDate", // sort by startDate
                sortDirection: -1 // sort in descending order
            }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            totalPages = Math.ceil(data.data.count / 10);

            // Save data to PostgreSQL database using UPSERT to prevent duplicates
            for (const job of data.data.list) {
              const {
                  jobId,
                  language,
                  categoryCode,
                  jobTitle,
                  jobCodeTitle,
                  jobDescription,
                  jobFamilyCode,
                  jobLevel,
                  dutyStation,
                  recruitmentType,
                  startDate,
                  endDate,
                  dept,
                  totalCount,
                  jn,
                  jf,
                  jc,
                  jl
                  
              } = job;
  
              try {
                const orgId = await getOrganizationId(dept?.name); // Get organization id

                // Prepare job data for upsert
                const jobData = {
                  job_id: jobId,
                  language: language || 'EN',
                  category_code: categoryCode || '',
                  job_title: jobTitle,
                  job_code_title: jobCodeTitle || '',
                  job_description: jobDescription || '',
                  job_family_code: jobFamilyCode || '',
                  job_level: jobLevel || '',
                  duty_station: dutyStation?.[0]?.description || '',
                  recruitment_type: recruitmentType || '',
                  start_date: startDate ? new Date(startDate) : null,
                  end_date: endDate ? new Date(endDate) : null,
                  dept: dept?.name || '',
                  total_count: totalCount || null,
                  jn: jn?.name || '',
                  jf: jf?.Name || '',
                  jc: jc?.name || '',
                  jl: jl?.name || '',
                  data_source: 'inspira',
                  organization_id: orgId,
                  apply_link: `https://careers.un.org/jobSearchDescription/${jobId}?language=en`
                };

                // Use upsert to prevent duplicates
                const result = await upsertJobVacancy(client, jobData, 'INSPIRA');
                
                if (result.success) {
                  console.log(`✅ INSPIRA: ${result.action} "${result.jobTitle}"`);
                } else {
                  console.warn(`⚠️ INSPIRA: Failed to save "${jobTitle}": ${result.error}`);
                }

              } catch (jobError) {
                console.error(`❌ INSPIRA: Error processing job "${jobTitle}":`, jobError.message);
              }
          }

            page++; // Move to the next page
        } catch (error) {
            console.error('Error fetching or saving data:', error);
        }
    }

    await client.end(); // Close the database connection
}

module.exports = { fetchAndProcessInspiraJobVacancies };