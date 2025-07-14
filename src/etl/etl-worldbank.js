require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");

const url = 'https://us.api.csod.com/rec-job-search/external/jobs'; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchAndProcessWorldBankJobVacancies() {
    console.log("==================================");
    console.log("World Bank Job Vacancies ETL started...");
    console.log("==================================");

    const client = new Client(credentials);
    await client.connect();

    let page = 0;
    const itemsPerPage = 25; // items per page
    let totalPages = 1; // Initialize to 1 to enter the loop
    let totalProcessed = 0;
    let totalErrors = 0;

    while (page < totalPages) {
        const payload = {   
            careerSiteId: 1,
            careerSitePageId:1,
            cities: [],
            countryCodes:[],
            cultureId: 1,
            cultureName: "en-US",
            customFieldCheckboxKeys: [],
            customFieldDropdowns: [],
            customFieldRadios: [],
            pageNumber: page + 1,
            pageSize: 25,
            placeID: "",
            postingsWithinDays: null,
            radius: null,
            searchText: "",
            states: [],
            search: "", // empty keyword as per the payload you provided
        };
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.WORLDBANK_API_KEY}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            totalPages = Math.ceil(data.data.totalCount / 25);

            // Process each job in the current page
            for (const job of data.data.requisitions) {
                try {
                    const jobDetailAPI = `https://worldbankgroup.csod.com/services/x/job-requisition/v2/requisitions/${job.requisitionId}/jobDetails?cultureId=1`;

                    const responseDetail = await fetch(jobDetailAPI, {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${process.env.WORLDBANK_API_KEY}`,
                            'Accept': 'application/json; q=1.0, text/*; q=0.8, */*; q=0.1',
                            'Accept-Encoding': 'gzip, deflate, br, zstd',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Cache-Control': 'no-cache',
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                            'X-Requested-With': 'XMLHttpRequest'
                        }
                    });

                    if (!responseDetail.ok) {
                        console.log(`❌ Error fetching job details for ${job.requisitionId}: ${responseDetail.status}`);
                        totalErrors++;
                        continue;
                    }

                    const jobDetail = await responseDetail.json();
                    const orgId = await getOrganizationId("World Bank"); // Get organization id

                    // Prepare job data for validation and upsert
                    // NOTE: This section needs to be completed based on the actual API response structure
                    const jobData = {
                        job_id: job.requisitionId,
                        language: "EN",
                        category_code: job.category || '',
                        job_title: job.title || '',
                        job_code_title: job.jobCode || '',
                        job_description: jobDetail.description || '',
                        job_family_code: "",
                        job_level: "",
                        duty_station: job.location || '',
                        recruitment_type: job.type || '',
                        start_date: job.startDate ? new Date(job.startDate) : null,
                        end_date: job.endDate ? new Date(job.endDate) : null,
                        dept: "World Bank",
                        total_count: null,
                        jn: "",
                        jf: "",
                        jc: "",
                        jl: "",
                        created: new Date(),
                        data_source: 'worldbank',
                        organization_id: orgId,
                        apply_link: job.applyUrl || `https://worldbankgroup.csod.com/careers/${job.requisitionId}`
                    };

                    // Validate job data
                    const validation = validateJobData(jobData);
                    if (!validation.isValid) {
                        console.error(`❌ Validation failed for job ${job.requisitionId}:`, validation.errors);
                        totalErrors++;
                        continue;
                    }

                    // Upsert the job vacancy
                    await upsertJobVacancy(client, jobData);
                    console.log(`✅ ${job.title || job.requisitionId}`);
                    totalProcessed++;

                } catch (jobError) {
                    console.error(`❌ Error processing job ${job.requisitionId}:`, jobError.message);
                    totalErrors++;
                }
            }

            page++; // Move to the next page
        } catch (error) {
            console.error('❌ Error fetching page data:', error);
            break; // Break the loop on fetch error
        }
    }

    await client.end(); // Close the database connection
    
    console.log("==================================");
    console.log(`World Bank ETL Summary:`);
    console.log(`✅ Successfully processed: ${totalProcessed} jobs`);
    console.log(`❌ Errors encountered: ${totalErrors} jobs`);
    console.log("Note: World Bank ETL may need API response structure adjustments");
    console.log("==================================");
}

module.exports = { fetchAndProcessWorldBankJobVacancies };