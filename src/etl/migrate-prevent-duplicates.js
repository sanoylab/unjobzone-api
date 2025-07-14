const { Client } = require('pg');
const { credentials } = require("./db");

/**
 * Database Migration: Prevent Duplicate Job Vacancies
 * 
 * This migration:
 * 1. Removes existing duplicate records
 * 2. Adds a unique constraint to prevent future duplicates
 * 3. Creates necessary indexes for performance
 */
async function migrateToPrevantDuplicates() {
  const client = new Client(credentials);
  
  try {
    await client.connect();
    console.log("🔗 Connected to database");
    
    console.log("\n🧹 Step 1: Removing existing duplicates...");
    
    // First, let's see how many duplicates exist
    const duplicateCountResult = await client.query(`
      SELECT COUNT(*) as duplicate_count
      FROM (
        SELECT job_id, data_source, organization_id, COUNT(*) as cnt
        FROM job_vacancies
        GROUP BY job_id, data_source, organization_id
        HAVING COUNT(*) > 1
      ) duplicates
    `);
    
    const duplicateGroups = parseInt(duplicateCountResult.rows[0].duplicate_count);
    console.log(`📊 Found ${duplicateGroups} groups of duplicate jobs`);
    
    if (duplicateGroups > 0) {
      // Remove duplicates, keeping the most recent one
      const deleteResult = await client.query(`
        DELETE FROM job_vacancies
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                       PARTITION BY job_id, data_source, organization_id 
                       ORDER BY created DESC, id DESC
                   ) AS rn
            FROM job_vacancies
          ) t
          WHERE rn > 1
        )
      `);
      
      console.log(`✅ Removed ${deleteResult.rowCount} duplicate records`);
    } else {
      console.log("✅ No duplicates found - database is clean");
    }
    
    console.log("\n🔒 Step 2: Adding unique constraint...");
    
    // Check if constraint already exists
    const constraintExists = await client.query(`
      SELECT 1 FROM pg_constraint 
      WHERE conname = 'unique_job_vacancy'
    `);
    
    if (constraintExists.rows.length === 0) {
      await client.query(`
        ALTER TABLE job_vacancies 
        ADD CONSTRAINT unique_job_vacancy 
        UNIQUE (job_id, data_source, organization_id)
      `);
      console.log("✅ Added unique constraint 'unique_job_vacancy'");
    } else {
      console.log("✅ Unique constraint already exists");
    }
    
    console.log("\n📈 Step 3: Adding performance indexes...");
    
    // Add indexes for better performance
    const indexes = [
      {
        name: 'idx_job_vacancies_unique_lookup',
        sql: 'CREATE INDEX IF NOT EXISTS idx_job_vacancies_unique_lookup ON job_vacancies(job_id, data_source, organization_id)'
      },
      {
        name: 'idx_job_vacancies_data_source_created',
        sql: 'CREATE INDEX IF NOT EXISTS idx_job_vacancies_data_source_created ON job_vacancies(data_source, created DESC)'
      },
      {
        name: 'idx_job_vacancies_org_created',
        sql: 'CREATE INDEX IF NOT EXISTS idx_job_vacancies_org_created ON job_vacancies(organization_id, created DESC)'
      }
    ];
    
    for (const index of indexes) {
      await client.query(index.sql);
      console.log(`✅ Created index: ${index.name}`);
    }
    
    console.log("\n📊 Step 4: Verification...");
    
    // Verify the constraint works
    const totalJobs = await client.query('SELECT COUNT(*) as count FROM job_vacancies');
    console.log(`📝 Total job records in database: ${totalJobs.rows[0].count}`);
    
    // Check if we can detect constraint violations
    const constraintInfo = await client.query(`
      SELECT 
        conname as constraint_name,
        contype as constraint_type,
        pg_get_constraintdef(oid) as constraint_definition
      FROM pg_constraint 
      WHERE conname = 'unique_job_vacancy'
    `);
    
    if (constraintInfo.rows.length > 0) {
      console.log("✅ Constraint verification successful:");
      console.log(`   Name: ${constraintInfo.rows[0].constraint_name}`);
      console.log(`   Type: ${constraintInfo.rows[0].constraint_type}`);
      console.log(`   Definition: ${constraintInfo.rows[0].constraint_definition}`);
    }
    
    console.log("\n🎉 Migration completed successfully!");
    console.log("🚫 Future duplicate insertions will be automatically prevented");
    console.log("✨ ETL processes can now use UPSERT operations safely");
    
    return { success: true };
    
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    console.error("Stack trace:", error.stack);
    return { success: false, error: error.message };
  } finally {
    await client.end();
    console.log("🔌 Database connection closed");
  }
}

/**
 * Rollback function to remove the constraint if needed
 */
async function rollbackDuplicatePrevention() {
  const client = new Client(credentials);
  
  try {
    await client.connect();
    console.log("🔗 Connected to database for rollback");
    
    // Remove the unique constraint
    await client.query(`
      ALTER TABLE job_vacancies 
      DROP CONSTRAINT IF EXISTS unique_job_vacancy
    `);
    console.log("✅ Removed unique constraint");
    
    // Optionally remove indexes (keeping them might still be beneficial)
    console.log("ℹ️  Performance indexes are kept (they're still beneficial)");
    
    console.log("🔄 Rollback completed successfully");
    return { success: true };
    
  } catch (error) {
    console.error("❌ Rollback failed:", error.message);
    return { success: false, error: error.message };
  } finally {
    await client.end();
    console.log("🔌 Database connection closed");
  }
}

// If run directly (not imported)
if (require.main === module) {
  const action = process.argv[2];
  
  if (action === 'rollback') {
    rollbackDuplicatePrevention()
      .then(result => {
        process.exit(result.success ? 0 : 1);
      });
  } else {
    migrateToPrevantDuplicates()
      .then(result => {
        process.exit(result.success ? 0 : 1);
      });
  }
}

module.exports = {
  migrateToPrevantDuplicates,
  rollbackDuplicatePrevention
}; 