require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./db");
const path = require('path');

const url = 'https://careers.un.org/api/admin/un-entity/en'; // Replace with your API endpoint

// Function to fetch and process job vacancies
async function fetchOrganizationList() {
    console.log("UN Organization list");

    const client = new Client(credentials);

    await client.connect();

    let page = 0;
    const itemsPerPage = 100; // items per page
    let totalPages = 1; // Initialize to 1 to enter the loop

    

        try {
            const response = await fetch("https://careers.un.org/api/admin/un-entity/en");

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
          
            // Save data to PostgreSQL database
            for (const job of data.data.result) {
              const {
                  code,
                  logo,
                  name,
                  shortName,
                  description,
                  url
              } = job;
  
              // Prepare the insert query
              const query = `
                  INSERT INTO organization (code, logo, name, short_name, description, url)
                  VALUES ($1, $2, $3, $4, $5, $6)
                  RETURNING id;
              `;
  
              // Insert the job vacancy into the database
              await client.query(query, [
                code,
                path.basename(logo),
                name,
                shortName,
                description,
                url
            ]);
            //console.log(jobTitle); // Handle the response data here

          }

            page++; // Move to the next page
        } catch (error) {
            console.error('Error fetching or saving data:', error);
        }
 

    await client.end(); // Close the database connection
}



module.exports = { fetchOrganizationList  };
