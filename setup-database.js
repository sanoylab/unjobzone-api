#!/usr/bin/env node
/**
 * Database Setup Script for ETL Dashboard
 * 
 * This script sets up the required database schema for the ETL dashboard
 * to work properly. Run this if the dashboard shows "Loading..." forever.
 * 
 * Usage: node setup-database.js
 */

require("dotenv").config();
const { Pool } = require("pg");

// Database credentials from environment or default (using same vars as codebase)
const credentials = {
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost', 
  database: process.env.PGDATABASE || 'unjobzone',
  password: process.env.PGPASSWORD || 'password',
  port: process.env.PGPORT || 5432,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
};

console.log('🚀 ETL Database Setup Script');
console.log('============================');
console.log(`📡 Connecting to: ${credentials.host}:${credentials.port}/${credentials.database}`);

async function setupDatabase() {
  const pool = new Pool(credentials);
  
  try {
    // Test connection
    console.log('🔌 Testing database connection...');
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful');
    
    // Step 1: Create etl_status table
    console.log('\n📝 Step 1: Creating etl_status table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS etl_status (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        processed_count INTEGER DEFAULT 0 CHECK (processed_count >= 0),
        success_count INTEGER DEFAULT 0 CHECK (success_count >= 0),
        error_count INTEGER DEFAULT 0 CHECK (error_count >= 0),
        error_message TEXT,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        duration_seconds INTEGER CHECK (duration_seconds >= 0),
        jobs_in_db INTEGER DEFAULT 0 CHECK (jobs_in_db >= 0),
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        
        -- Constraints
        CONSTRAINT valid_counts CHECK (success_count + error_count <= processed_count),
        CONSTRAINT valid_time_range CHECK (end_time IS NULL OR end_time >= start_time)
      );
    `);
    console.log('✅ etl_status table created/verified');
    
    // Step 2: Create latest_etl_status view
    console.log('\n📝 Step 2: Creating latest_etl_status view...');
    await pool.query(`
      CREATE OR REPLACE VIEW latest_etl_status AS
      SELECT DISTINCT ON (organization_name) 
        organization_name,
        status,
        processed_count,
        success_count,
        error_count,
        error_message,
        start_time,
        end_time,
        duration_seconds,
        jobs_in_db,
        created_at
      FROM etl_status 
      ORDER BY organization_name, created_at DESC;
    `);
    console.log('✅ latest_etl_status view created');
    
    // Step 3: Create get_etl_statistics function
    console.log('\n📝 Step 3: Creating get_etl_statistics function...');
    await pool.query(`
      CREATE OR REPLACE FUNCTION get_etl_statistics(days_back INTEGER DEFAULT 7)
      RETURNS TABLE (
          total_organizations INTEGER,
          successful_orgs INTEGER,
          failed_orgs INTEGER,
          total_jobs INTEGER,
          avg_duration NUMERIC,
          last_run_time TIMESTAMPTZ
      ) AS $$
      BEGIN
          RETURN QUERY
          SELECT 
              COUNT(DISTINCT l.organization_name)::INTEGER as total_organizations,
              SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END)::INTEGER as successful_orgs,
              SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END)::INTEGER as failed_orgs,
              SUM(l.jobs_in_db)::INTEGER as total_jobs,
              AVG(l.duration_seconds)::NUMERIC as avg_duration,
              MAX(l.created_at) as last_run_time
          FROM latest_etl_status l
          WHERE l.created_at >= NOW() - INTERVAL '1 day' * days_back;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('✅ get_etl_statistics function created');
    
    // Step 4: Create indexes
    console.log('\n📝 Step 4: Creating performance indexes...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_etl_status_org_created 
      ON etl_status(organization_name, created_at DESC);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_etl_status_created 
      ON etl_status(created_at DESC);
    `);
    console.log('✅ Performance indexes created');
    
    // Step 5: Check if we need sample data
    const dataCheck = await pool.query("SELECT COUNT(*) FROM etl_status");
    const currentCount = parseInt(dataCheck.rows[0].count);
    
    if (currentCount === 0) {
      console.log('\n📝 Step 5: Adding sample ETL status data...');
      
      const sampleOrgs = ['UNHCR', 'UNICEF', 'UNOPS', 'UNESCO', 'WFP', 'UNDP', 'IMF', 'UNWOMEN', 'ICAO', 'IOM', 'UNFPA', 'INSPIRA'];
      
      for (const org of sampleOrgs) {
        await pool.query(`
          INSERT INTO etl_status 
          (organization_name, status, processed_count, success_count, error_count, 
           start_time, end_time, duration_seconds, jobs_in_db, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          org,
          Math.random() > 0.2 ? 'success' : 'failed', // 80% success rate
          Math.floor(Math.random() * 50) + 10, // 10-60 processed
          Math.floor(Math.random() * 45) + 5,  // 5-50 success
          Math.floor(Math.random() * 5),       // 0-5 errors
          new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000), // Random start time in last 24h
          new Date(Date.now() - Math.random() * 12 * 60 * 60 * 1000), // Random end time in last 12h  
          Math.floor(Math.random() * 300) + 30, // 30-330 seconds duration
          Math.floor(Math.random() * 200) + 50, // 50-250 jobs in DB
          new Date(Date.now() - Math.random() * 12 * 60 * 60 * 1000)  // Random created time in last 12h
        ]);
      }
      
      console.log(`✅ Added sample data for ${sampleOrgs.length} organizations`);
    } else {
      console.log(`\n✅ Step 5: Database already has ${currentCount} ETL status records`);
    }
    
    // Step 6: Test everything
    console.log('\n📝 Step 6: Testing setup...');
    const testStats = await pool.query('SELECT * FROM get_etl_statistics($1)', [7]);
    const testView = await pool.query("SELECT COUNT(*) FROM latest_etl_status");
    
    const stats = testStats.rows[0] || {};
    const recordCount = parseInt(testView.rows[0].count);
    
    console.log('\n🎉 DATABASE SETUP COMPLETED SUCCESSFULLY!');
    console.log('==========================================');
    console.log(`📊 Total Organizations: ${stats.total_organizations || 0}`);
    console.log(`✅ Successful ETLs: ${stats.successful_orgs || 0}`);
    console.log(`❌ Failed ETLs: ${stats.failed_orgs || 0}`);
    console.log(`📋 Total Jobs: ${stats.total_jobs || 0}`);
    console.log(`📊 Records in latest_etl_status: ${recordCount}`);
    console.log('');
    console.log('🌐 Your dashboard should now work at:');
    console.log('   https://unjobzone-api.onrender.com/api/v1/etl');
    console.log('');
    console.log('🔧 If dashboard still shows "Loading...", check:');
    console.log('   1. Network connectivity to database');
    console.log('   2. Environment variables are correct');
    console.log('   3. Server logs for any errors');
    
  } catch (error) {
    console.error('\n❌ ERROR SETTING UP DATABASE:');
    console.error('================================');
    console.error(`Error: ${error.message}`);
    console.error(`Code: ${error.code}`);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 Connection refused - check:');
      console.error('   • Database server is running');
      console.error('   • Host and port are correct');
      console.error('   • Firewall allows connections');
    } else if (error.code === '28P01') {
      console.error('\n💡 Authentication failed - check:');
      console.error('   • Username and password are correct');
      console.error('   • User has required permissions');
    } else if (error.code === '3D000') {
      console.error('\n💡 Database does not exist - check:');
      console.error('   • Database name is correct');
      console.error('   • Database exists on the server');
    }
    
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the setup
setupDatabase().catch(console.error);
