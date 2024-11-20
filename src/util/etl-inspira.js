require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");

const url = 'https://careers.un.org/api/public/opening/jo/list/filteredV2/en'; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchAndProcessInspiraJobVacancies() {
    console.log("UN Secretariate Job Vacancies ETL started...");

    const client = new Client(credentials);

    await client.connect();
    await client.query(`DELETE FROM job_vacancies WHERE data_source = 'inspira'`);

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

            // Save data to PostgreSQL database
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
                jobId,
                language,
                categoryCode,
                jobTitle,
                jobCodeTitle,
                jobDescription,
                jobFamilyCode,
                jobLevel,
                dutyStation[0]?.description || '',  // Convert duty station to JSON string
                recruitmentType,
                new Date(startDate),  // Convert to Date object
                new Date(endDate),    // Convert to Date object
                dept?.name || '',     // Check if dept is defined
                totalCount,
                jn?.name || '',       // Check if jn is defined
                jf?.Name || '',
                jc?.name || '' ,
                jl?.name || '' ,
                new Date(),
                'inspira'
            ]);
            console.log(jobTitle); // Handle the response data here

          }

            page++; // Move to the next page
        } catch (error) {
            console.error('Error fetching or saving data:', error);
        }
    }

    await client.end(); // Close the database connection
}



module.exports = { fetchAndProcessInspiraJobVacancies  };
