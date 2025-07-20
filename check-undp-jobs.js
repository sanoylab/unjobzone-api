#!/usr/bin/env node

require('dotenv').config();
const { Pool } = require('pg');
const { credentials } = require('./src/etl/db');

const pool = new Pool(credentials);

async function checkUndpJobs() {
  try {
    console.log('🚨 INVESTIGATING UNDP JOBS STATUS');
    console.log('==================================\n');

    // Check current UNDP job count
    const undpCountQuery = `
      SELECT 
        data_source,
        COUNT(*) as job_count
      FROM job_vacancies
      WHERE data_source = 'undp'
      GROUP BY data_source;
    `;
    
    const undpCount = await pool.query(undpCountQuery);
    
    if (undpCount.rows.length === 0) {
      console.log('❌ CRITICAL: No UNDP jobs found in database!');
    } else {
      console.log(`📊 Current UNDP jobs: ${undpCount.rows[0].job_count}`);
    }

    // Check all organizations for comparison
    console.log('\n📊 Current job counts by organization:');
    const allCountQuery = `
      SELECT 
        data_source,
        COUNT(*) as job_count
      FROM job_vacancies
      GROUP BY data_source
      ORDER BY job_count DESC;
    `;
    
    const allCounts = await pool.query(allCountQuery);
    allCounts.rows.forEach(row => {
      const status = row.data_source === 'undp' ? '❌ MISSING' : '✅';
      console.log(`   ${status} ${row.data_source.toUpperCase()}: ${row.job_count} jobs`);
    });

    // Check what job_ids were involved in cross-org duplicates
    console.log('\n🔍 Checking for remaining cross-organization patterns:');
    const crossOrgQuery = `
      SELECT 
        job_id,
        COUNT(*) as org_count,
        STRING_AGG(data_source, ', ') as organizations
      FROM job_vacancies
      GROUP BY job_id
      HAVING COUNT(*) > 1
      ORDER BY org_count DESC
      LIMIT 10;
    `;
    
    const crossOrgResult = await pool.query(crossOrgQuery);
    
    if (crossOrgResult.rows.length === 0) {
      console.log('✅ No cross-organization duplicates remain');
    } else {
      console.log(`⚠️  Found ${crossOrgResult.rows.length} job_ids still across multiple organizations:`);
      crossOrgResult.rows.forEach(row => {
        console.log(`   Job ID ${row.job_id}: ${row.organizations} (${row.org_count} orgs)`);
      });
    }

    // Check the most recent ETL status for UNDP
    console.log('\n📅 Checking ETL status for UNDP:');
    const etlStatusQuery = `
      SELECT 
        organization,
        last_run,
        jobs_in_db,
        status
      FROM etl_status
      WHERE LOWER(organization) = 'undp'
      ORDER BY last_run DESC
      LIMIT 1;
    `;
    
    const etlStatus = await pool.query(etlStatusQuery);
    
    if (etlStatus.rows.length === 0) {
      console.log('❌ No ETL status found for UNDP');
    } else {
      const status = etlStatus.rows[0];
      console.log(`   Last UNDP ETL run: ${status.last_run}`);
      console.log(`   Jobs in DB (from ETL): ${status.jobs_in_db}`);
      console.log(`   Status: ${status.status}`);
    }

    // Suggest recovery action
    console.log('\n💡 RECOVERY RECOMMENDATION:');
    console.log('============================');
    
    if (undpCount.rows.length === 0) {
      console.log('🚨 URGENT: All UNDP jobs were accidentally deleted!');
      console.log('🔧 IMMEDIATE ACTION NEEDED:');
      console.log('   1. Run UNDP ETL immediately to restore jobs');
      console.log('   2. Fix the cross-org cleanup logic to preserve legitimate jobs');
      console.log('   3. Update cleanup to only remove true duplicates');
      console.log('\n⚡ Run this command to restore UNDP jobs:');
      console.log('   node src/etl/etl-undp.js');
    } else {
      console.log('✅ UNDP jobs exist, investigating other issues...');
    }

  } catch (error) {
    console.error('❌ Error checking UNDP jobs:', error);
  } finally {
    await pool.end();
  }
}

checkUndpJobs(); 