// Check current job description formatting in database
require("dotenv").config();

const { Client } = require('pg');
const { credentials } = require("./src/etl/db");

async function checkDatabaseFormatting() {
  console.log("🔍 Checking current database job formatting...");
  
  const client = new Client(credentials);
  
  try {
    await client.connect();
    
    // Get a recent UNICEF job to check formatting
    const result = await client.query(`
      SELECT 
        job_id,
        job_title, 
        duty_station,
        job_level,
        SUBSTRING(job_description, 1, 500) as description_preview,
        LENGTH(job_description) as total_length,
        (LENGTH(job_description) - LENGTH(REPLACE(job_description, E'\n', ''))) as line_breaks,
        (LENGTH(job_description) - LENGTH(REPLACE(job_description, E'\n\n', ''))) as paragraph_breaks
      FROM job_vacancies 
      WHERE data_source = 'unicef' 
      ORDER BY created DESC 
      LIMIT 2
    `);
    
    console.log(`\n📊 Found ${result.rows.length} recent UNICEF jobs in database:`);
    
    result.rows.forEach((job, index) => {
      console.log(`\n${index + 1}. Job ID: ${job.job_id}`);
      console.log(`   📄 Title: ${job.job_title.substring(0, 60)}...`);
      console.log(`   📍 Location: "${job.duty_station}"`);
      console.log(`   📊 Level: "${job.job_level}"`);
      console.log(`   📏 Total length: ${job.total_length} chars`);
      console.log(`   📝 Line breaks: ${job.line_breaks}`);
      console.log(`   📝 Paragraph breaks: ${job.paragraph_breaks}`);
      console.log(`   📖 Description preview (first 500 chars):`);
      console.log(`   "${job.description_preview}"`);
      console.log(`   ---`);
    });
    
  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.end();
  }
}

checkDatabaseFormatting();