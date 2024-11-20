require("dotenv").config();

const { Client } = require("pg");
const { credentials } = require("./db");

const url = "https://unhcr.wd3.myworkdayjobs.com/wday/cxs/unhcr/External/jobs"; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchAndProcessUnhcrJobVacancies() {
  console.log("UNHCR Job Vacancies ETL started...");
  const client = new Client(credentials);

  await client.connect();
  await client.query(`DELETE FROM job_vacancies WHERE data_source = 'unhcr'`);

  let page = 0;
  const itemsPerPage = 20; // items per page
  let totalPages = 1; // Initialize to 1 to enter the loop

  while (page < totalPages) {

   const payload = {
    "appliedFacets": {},
    "limit": itemsPerPage,
    "offset": page * itemsPerPage,
    "searchText": ""
}



    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
        //console.log("response", response);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      //console.log('response', response.body)
      if(totalPages == 1) {
        totalPages = Math.ceil(data.total / itemsPerPage);
      }
      
     // console.log("total records", data.title);
   
      // Handle the response data here

      // Save data to PostgreSQL database

      for (const job of data.jobPostings) {
        var jobDetailAPI = `https://unhcr.wd3.myworkdayjobs.com/wday/cxs/unhcr/External${job.externalPath}`;

        const responseDetail = await fetch(jobDetailAPI);
        const jobDetail = await responseDetail.json();
        //const jobDetail = jobResponse.jobPostingInfo;

        console.log(job.title);

        const startDate = jobDetail.jobPostingInfo.startDate
          ? new Date(jobDetail.jobPostingInfo.startDate)
          : null;
        const endDate = jobDetail.jobPostingInfo.endDate
          ? new Date(jobDetail.jobPostingInfo.endDate)
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
          jobDetail.jobPostingInfo.id,
          "EN",
          job.bulletFields[0],
          job.title,
          jobDetail.jobPostingInfo.jobPostingId,
          jobDetail.jobPostingInfo.jobDescription,
          "", //jobFamilyCode,
          "", //jobLevel,
          jobDetail.jobPostingInfo.location, // Convert duty station to JSON string
          jobDetail.jobPostingInfo.timeType,
          startDate, // Convert to Date object
          endDate, // Convert to Date object
          jobDetail.hiringOrganization.name || "", // Check if dept is defined
          job.total,
          "", // Check if jn is defined
          "",
          "",
          "",
          new Date(),
          "unhcr",
        ]);
      }

      page++; // Move to the next page
    } catch (error) {
      console.error("Error fetching or saving data:", error);
    }
  }

  await client.end(); // Close the database connection
}

module.exports = { fetchAndProcessUnhcrJobVacancies };
