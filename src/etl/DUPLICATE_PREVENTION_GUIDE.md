# 🚫 ETL Duplicate Prevention Solution

## 🔍 Problem Identified

Your original ETL process had a critical data integrity issue:

1. **Delete** all existing records for an organization
2. **Insert** new records one by one (creating temporary duplicates during API retries/errors)
3. **Later cleanup** duplicates with `removeDuplicateJobVacancies()`

**Result**: Database contained invalid duplicate data during processing windows.

## ✅ Solution: UPSERT Approach

The new solution **prevents duplicates from being inserted** rather than cleaning them up afterward:

### 🔧 Key Components

1. **Database Unique Constraint**: `(job_id, data_source, organization_id)`
2. **UPSERT Function**: `INSERT ... ON CONFLICT DO UPDATE`
3. **No More Global Cleanup**: Eliminates `removeDuplicateJobVacancies()`

### 📊 Benefits

- ✅ **Zero Duplicate Window**: No temporary duplicates ever exist
- ✅ **Data Integrity**: Database always consistent
- ✅ **Better Performance**: No cleanup overhead
- ✅ **Atomic Operations**: Each job insert/update is atomic
- ✅ **Resilient**: Handles API retries and network issues gracefully

## 🚀 Implementation Steps

### Step 1: Run Database Migration

```bash
# Apply the migration to add unique constraint and remove existing duplicates
node src/etl/migrate-prevent-duplicates.js

# If you need to rollback (optional)
node src/etl/migrate-prevent-duplicates.js rollback
```

### Step 2: Update Your ETL Functions

Replace the old pattern:
```javascript
// OLD WAY (creates duplicates)
await client.query(`DELETE FROM job_vacancies WHERE data_source = 'unhcr'`);
// ... process jobs
await client.query('INSERT INTO job_vacancies (...) VALUES (...)');
```

With the new upsert pattern:
```javascript
// NEW WAY (prevents duplicates)
const { upsertJobVacancy } = require('./shared');

const jobData = {
  job_id: job.id,
  job_title: job.title,
  data_source: 'unhcr',
  organization_id: orgId,
  // ... other fields
};

const result = await upsertJobVacancy(client, jobData, 'UNHCR');
```

### Step 3: Remove Global Cleanup

The main `app.js` has been updated to remove the global duplicate cleanup since it's no longer needed.

## 📝 Example: Improved ETL Function

See `etl-unhcr-improved.js` for a complete example of the new approach:

```javascript
// Highlights of the new approach:
const result = await upsertJobVacancy(client, jobData, organizationName);

if (result.success) {
  console.log(`✅ ${organizationName}: ${result.action} "${result.jobTitle}"`);
  // result.action will be either 'inserted' or 'updated'
}
```

## 🗃️ Database Schema Changes

The migration adds:

```sql
-- Unique constraint prevents duplicates
ALTER TABLE job_vacancies 
ADD CONSTRAINT unique_job_vacancy 
UNIQUE (job_id, data_source, organization_id);

-- Performance indexes
CREATE INDEX idx_job_vacancies_unique_lookup 
ON job_vacancies(job_id, data_source, organization_id);
```

## 🔍 How UPSERT Works

```sql
INSERT INTO job_vacancies (...) VALUES (...)
ON CONFLICT (job_id, data_source, organization_id) 
DO UPDATE SET
  job_title = EXCLUDED.job_title,
  job_description = EXCLUDED.job_description,
  -- ... update other fields
  created = NOW()
RETURNING id, job_title, 
CASE WHEN xmax = 0 THEN 'inserted' ELSE 'updated' END as action;
```

**What happens:**
- If job doesn't exist → **INSERT** (new record)
- If job already exists → **UPDATE** (refresh existing record)
- **Never creates duplicates**

## 🚦 Migration Safety

The migration is designed to be safe:

1. ✅ **Checks existing duplicates** before adding constraint
2. ✅ **Removes duplicates** (keeps most recent)
3. ✅ **Verifies constraint** works properly
4. ✅ **Rollback option** available if needed

## 📈 Performance Impact

**Positive impacts:**
- ✅ No more global duplicate cleanup (faster ETL completion)
- ✅ Better database performance with proper indexes
- ✅ Reduced storage usage (no temporary duplicates)

**Considerations:**
- ⚠️ UPSERT is slightly slower than INSERT (but prevents duplicates)
- ✅ Overall ETL process is faster due to no cleanup phase

## 🔧 Updating All Organizations

To update all your ETL functions, follow this pattern:

1. **Import upsert function**:
   ```javascript
   const { upsertJobVacancy } = require('./shared');
   ```

2. **Remove DELETE statement**:
   ```javascript
   // Remove this line:
   // await client.query(`DELETE FROM job_vacancies WHERE data_source = 'org'`);
   ```

3. **Replace INSERT with upsert**:
   ```javascript
   // Instead of direct INSERT, use:
   const result = await upsertJobVacancy(client, jobData, organizationName);
   ```

4. **Handle results**:
   ```javascript
   if (result.success) {
     stats.successCount++;
     if (result.action === 'inserted') stats.insertedCount++;
     else stats.updatedCount++;
   } else {
     stats.errorCount++;
   }
   ```

## 🎯 Testing the Solution

1. **Run migration**:
   ```bash
   node src/etl/migrate-prevent-duplicates.js
   ```

2. **Test with improved UNHCR function**:
   ```javascript
   const { fetchAndProcessUnhcrJobVacanciesImproved } = require('./etl/etl-unhcr-improved');
   await fetchAndProcessUnhcrJobVacanciesImproved();
   ```

3. **Verify no duplicates**:
   ```sql
   SELECT job_id, data_source, organization_id, COUNT(*) 
   FROM job_vacancies 
   GROUP BY job_id, data_source, organization_id 
   HAVING COUNT(*) > 1;
   -- Should return 0 rows
   ```

## 🔄 Migration Checklist

- [ ] Run database migration
- [ ] Test with one organization (UNHCR improved function)
- [ ] Update remaining ETL functions one by one
- [ ] Remove global duplicate cleanup (already done in app.js)
- [ ] Monitor ETL dashboard for clean runs
- [ ] Verify database integrity

## 🆘 Troubleshooting

**Q: Migration fails with constraint violation**
A: Run the migration script - it automatically removes existing duplicates first

**Q: UPSERT operation fails**
A: Check that `job_id`, `data_source`, and `organization_id` are not null

**Q: Want to rollback**
A: Run `node src/etl/migrate-prevent-duplicates.js rollback`

## 🎉 Results

After implementation:
- ✅ **Zero duplicate window** - database always consistent
- ✅ **Faster ETL** - no cleanup phase needed
- ✅ **Better reliability** - handles API errors gracefully
- ✅ **Atomic operations** - each job insert is safe
- ✅ **Performance boost** - optimized indexes and no duplicate overhead

Your ETL system is now **enterprise-grade** with proper data integrity! 🚀 