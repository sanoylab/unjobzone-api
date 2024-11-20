require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");

const url = 'https://estm.fa.em2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&finder=findReqs;'; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchAndProcessUndpJobVacancies() {
    console.log("UNDP Job Vacancies ETL started...");

    const client = new Client(credentials);

    await client.connect();
    await client.query(`DELETE FROM job_vacancies WHERE data_source = 'undp'`);

    let page = 0;
    const itemsPerPage = 25; // items per page
    let totalPages = 1; // Initialize to 1 to enter the loop

    while (page < totalPages) {
    

        try {
            const response = await fetch(`${url}offset=${page}`);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            totalPages = Math.ceil(data.items[0].TotalJobsCount / 25);
            //console.log('totalPages', totalPages);

            // Save data to PostgreSQL database
            for (const job of data.items[0].requisitionList) {

                var jobDetailAPI = `https://estm.fa.em2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${job.Id}%22,siteNumber=CX_1`;

                const responseDetail = await fetch(jobDetailAPI);
                const jobDetail = await responseDetail.json();
//console.log('jobDetail', jobDetail);    

             
                const startDate = jobDetail.items[0].ExternalPostedStartDate
                ? new Date(jobDetail.items[0].ExternalPostedStartDate)
                : null;
              const endDate = jobDetail.items[0].ExternalPostedEndDate
                ? new Date(jobDetail.items[0].ExternalPostedEndDate)
                : null;
              // Prepare the insert query
              const query = `
                  INSERT INTO job_vacancies (job_id, language, category_code, job_title, job_code_title, job_description,
                      job_family_code, job_level, duty_station, recruitment_type, start_date, end_date, dept,
                      total_count, jn, jf, jc, jl, created, data_source)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                  RETURNING id;
              `;
  
              // Insert the job vacancy into the database
              await client.query(query, [
                job.Id,
                job.Language,
                jobDetail.items[0].Category,
                job.Title,
                job.JobFunction,
                jobDetail.items[0].ExternalDescriptionStr,
                job.JobFamily,
                '',//job level
                job.PrimaryLocation || '',  // Convert duty station to JSON string
                jobDetail.items[0].RequisitionType,
                startDate,  // Convert to Date object
                endDate,    // Convert to Date object
                jobDetail.items[0].requisitionFlexFields[0].Prompt =="Agency"? jobDetail.items[0].requisitionFlexFields[0].Value:'UNDP',     // Check if dept is defined
                null,
                jobDetail.items[0].requisitionFlexFields[3].Prompt =="Practice Area"? jobDetail.items[0].requisitionFlexFields[3].Value:'',     // Check if dept is defined

                 '',
                '' ,
                jobDetail.items[0].requisitionFlexFields[1].Prompt =="Grade"? jobDetail.items[0].requisitionFlexFields[1].Value:'',     // Check if dept is defined

                new Date(),
                'undp'
            ]);
            console.log(job.Title); // Handle the response data here

          }

            page++; // Move to the next page
        } catch (error) {
            console.error('Error fetching or saving data:', error);
        }
    }

    await client.end(); // Close the database connection
}



module.exports = { fetchAndProcessUndpJobVacancies  };
