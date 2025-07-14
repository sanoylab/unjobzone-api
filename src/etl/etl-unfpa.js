require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const { getOrganizationId, upsertJobVacancy, validateJobData } = require("./shared");

const url = 'https://estm.fa.em2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&finder=findReqs;'; // Replace with your API endpoint
//const url = 'https://estm.fa.em2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=flexFieldsFacet.values&finder=findReqs;siteNumber=CX_2003,facetsList=LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS'

// Function to fetch and process job vacancies
async function fetchAndProcessUnfpaJobVacancies() {
    console.log("==================================");
    console.log("UNFPA Job Vacancies ETL started...");
    console.log("==================================");

    const client = new Client(credentials);
    await client.connect();

    let page = 0;
    const itemsPerPage = 25; // items per page
    let totalPages = 1; // Initialize to 1 to enter the loop
    let totalProcessed = 0;
    let totalErrors = 0;

    while (page < totalPages) {
        try {
            const response = await fetch(`${url}offset=${page}`);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            totalPages = Math.ceil(data.items[0].TotalJobsCount / 25);

            // Process each job in the current page
            for (const job of data.items[0].requisitionList) {
                try {
                    const jobDetailAPI = `https://estm.fa.em2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${job.Id}%22,siteNumber=CX_2003`;

                    const responseDetail = await fetch(jobDetailAPI);
                    const jobDetail = await responseDetail.json();
                    
                    const startDate = jobDetail.items[0].ExternalPostedStartDate ? new Date(jobDetail.items[0].ExternalPostedStartDate) : null;
                    const endDate = jobDetail.items[0].ExternalPostedEndDate ? new Date(jobDetail.items[0].ExternalPostedEndDate) : null;

                    const requisitionFlexFields = jobDetail.items[0].requisitionFlexFields || [];

                    const agency = requisitionFlexFields[0] && requisitionFlexFields[0].Prompt === "Agency" ? requisitionFlexFields[0].Value : 'UNFPA';
                    const practiceArea = requisitionFlexFields[3] && requisitionFlexFields[3].Prompt === "Practice Area" ? requisitionFlexFields[3].Value : '';
                    const grade = requisitionFlexFields[1] && requisitionFlexFields[1].Prompt === "Grade" ? requisitionFlexFields[1].Value : '';

                    const orgId = await getOrganizationId(agency); // Get organization id

                    // Prepare job data for validation and upsert
                    const jobData = {
                        job_id: job.Id,
                        language: job.Language,
                        category_code: jobDetail.items[0].Category,
                        job_title: job.Title,
                        job_code_title: job.JobFunction,
                        job_description: jobDetail.items[0].ExternalDescriptionStr,
                        job_family_code: job.JobFamily,
                        job_level: '', // job level
                        duty_station: job.PrimaryLocation || '', // Convert duty station to JSON string
                        recruitment_type: jobDetail.items[0].RequisitionType,
                        start_date: startDate, // Convert to Date object
                        end_date: endDate, // Convert to Date object
                        dept: agency,
                        total_count: null,
                        jn: practiceArea,
                        jf: '',
                        jc: '',
                        jl: grade,
                        created: new Date(),
                        data_source: 'unfpa',
                        organization_id: orgId,
                        apply_link: "https://estm.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2003/job/" + job.Id
                    };

                    // Validate job data
                    const validation = validateJobData(jobData);
                    if (!validation.isValid) {
                        console.error(`❌ Validation failed for job ${job.Id}:`, validation.errors);
                        totalErrors++;
                        continue;
                    }

                    // Upsert the job vacancy
                    await upsertJobVacancy(client, jobData);
                    console.log(`✅ ${job.Title}`);
                    totalProcessed++;

                } catch (jobError) {
                    console.error(`❌ Error processing job ${job.Id}:`, jobError.message);
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
    console.log(`UNFPA ETL Summary:`);
    console.log(`✅ Successfully processed: ${totalProcessed} jobs`);
    console.log(`❌ Errors encountered: ${totalErrors} jobs`);
    console.log("==================================");
}

module.exports = { fetchAndProcessUnfpaJobVacancies };