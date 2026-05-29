const { pool } = require("../util/db");
const cache = require("../util/cache");

// Whitelist of column names that getFilteredJobs is allowed to filter on.
// Any other key in req.query is silently ignored. Keeps caller-controlled
// strings out of the SQL identifier position.
const FILTERABLE_COLUMNS = new Set([
  'job_title',
  'duty_station',
  'dept',
  'recruitment_type',
  'start_date',
  'end_date',
  'jn', 'jf', 'jc', 'jl',
]);

// Bound pagination so a hostile client can't pull the whole table.
// Ceiling is 1000 because Jobs.jsx + HomeHero.jsx fetch up to 500 rows
// and then filter client-side — keep that working but cap the worst case.
function clampPage(raw)  { return Math.max(1, parseInt(raw, 10) || 1); }
function clampSize(raw)  { return Math.min(1000, Math.max(1, parseInt(raw, 10) || 10)); }

// Cache TTLs (seconds). Anything under jobs:* is auto-flushed by the ETL
// after each successful agency run, so these can be longer than the data
// "really" stays fresh — the ETL invalidation is what drives correctness.
const TTL_JOB_ROW       = 3600;   // 1 h — single job & paginated jobs lists
const TTL_AGGREGATION   = 3600;   // 1 h — categories, organizations, duty stations
const TTL_FILTERED      = 600;    // 10 min — filtered queries (long-tail of unique keys)

// Stable serialization of req.query for cache keys — sorted by name so
// ?a=1&b=2 and ?b=2&a=1 collide on the same cache entry.
function stableQueryString(query) {
  const params = new URLSearchParams();
  Object.keys(query).sort().forEach((k) => {
    const v = query[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') params.set(k, v);
  });
  return params.toString();
}

module.exports.getAll = async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const size = clampSize(req.query.size);
    const offset = (page - 1) * size;
    const cacheKey = `jobs:all:${page}:${size}`;

    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Note: job_description is intentionally NOT selected — list views in
    // the SPA never render it (it's HTML, often 5–50 KB per row), only
    // JobDetail.jsx does via getById. Empty-string fallback preserves the
    // response shape for any other consumer.
    const query = `
      SELECT
        jv.id, jv.job_id, jv.language, jv.category_code, jv.job_title,
        jv.job_code_title, '' AS job_description, jv.job_family_code,
        jv.job_level, jv.duty_station, jv.recruitment_type,
        jv.start_date, jv.end_date, jv.dept, jv.total_count,
        jv.jn, jv.jf, jv.jc, jv.jl, jv.created, jv.data_source,
        jv.apply_link, jv.source_logo_url,
        org.logo, org.short_name, org.long_name
      FROM job_vacancies jv
      JOIN organization org ON jv.organization_id = org.id
      ORDER BY jv.end_date ASC
      LIMIT $1 OFFSET $2;
    `;

    const [result, countResult] = await Promise.all([
      pool.query(query, [size, offset]),
      pool.query('SELECT COUNT(*) FROM job_vacancies'),
    ]);

    const totalRecords = parseInt(countResult.rows[0].count, 10);
    const payload = { success: true, totalRecords, timestamp: new Date(), data: result.rows };

    await cache.set(cacheKey, payload, TTL_JOB_ROW);
    cache.httpCache(res, 60);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[jobs.getAll]', err);
    res.status(500).json({ success: false, message: 'Failed to load jobs' });
  }
};

module.exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid job id' });
    }

    const cacheKey = `jobs:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const query = `
      SELECT
        jv.id, jv.job_id, jv.language, jv.category_code, jv.job_title,
        jv.job_code_title, jv.job_description, jv.job_family_code,
        jv.job_level, jv.duty_station, jv.recruitment_type,
        jv.start_date, jv.end_date, jv.dept, jv.total_count,
        jv.jn, jv.jf, jv.jc, jv.jl, jv.created, jv.data_source,
        jv.apply_link, jv.source_logo_url,
        org.logo, org.short_name, org.long_name
      FROM job_vacancies jv
      LEFT JOIN organization org ON jv.organization_id = org.id
      WHERE jv.id = $1
      LIMIT 1;
    `;

    const result = await pool.query(query, [id]);
    const payload = { success: true, timestamp: new Date(), data: result.rows };

    await cache.set(cacheKey, payload, TTL_JOB_ROW);
    cache.httpCache(res, 300);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[jobs.getById]', err);
    res.status(500).json({ success: false, message: 'Failed to load job' });
  }
};

module.exports.getFilteredJobs = async (req, res) => {
  try {
    const cacheKey = `jobs:filter:${stableQueryString(req.query)}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    // job_description omitted for the same reason as getAll — list views
    // don't render it, and shipping it inflates the filtered-jobs payload
    // by an order of magnitude.
    let baseQuery = `
      SELECT
        jv.id, jv.job_id, jv.language, jv.category_code, jv.job_title,
        jv.job_code_title, '' AS job_description, jv.job_family_code,
        jv.job_level, jv.duty_station, jv.recruitment_type,
        jv.start_date, jv.end_date, jv.dept, jv.apply_link,
        jv.total_count, jv.jn, jv.jf, jv.jc, jv.jl, jv.created,
        jv.data_source, jv.source_logo_url,
        org.logo, org.short_name, org.long_name
      FROM job_vacancies jv
      LEFT JOIN organization org ON jv.organization_id = org.id
      WHERE 1=1
    `;

    let countQuery = `
      SELECT COUNT(jv.id)
      FROM job_vacancies jv
      LEFT JOIN organization org ON jv.organization_id = org.id
      WHERE 1=1
    `;

    const queryParams = [];

    // Build the dynamic WHERE — but only for whitelisted column names so
    // a hostile ?key injection can't reach the SQL identifier position.
    Object.entries(req.query).forEach(([key, value]) => {
      if (!FILTERABLE_COLUMNS.has(key)) return;
      if (!value || value.toString().trim() === '') return;

      if (key === 'job_title') {
        baseQuery += ` AND to_tsvector('english', job_title) @@ to_tsquery('english', $${queryParams.length + 1})`;
        countQuery += ` AND to_tsvector('english', job_title) @@ to_tsquery('english', $${queryParams.length + 1})`;
        queryParams.push(value.split(' ').join(' & '));
      } else {
        baseQuery += ` AND ${key} ILIKE $${queryParams.length + 1}`;
        countQuery += ` AND ${key} ILIKE $${queryParams.length + 1}`;
        queryParams.push(value);
      }
    });

    const page = clampPage(req.query.page);
    const size = clampSize(req.query.size);
    const offset = (page - 1) * size;
    baseQuery += ` ORDER BY end_date ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(size, offset);

    const [result, countResult] = await Promise.all([
      pool.query(baseQuery, queryParams),
      pool.query(countQuery, queryParams.slice(0, -2)),
    ]);

    const totalRecords = parseInt(countResult.rows[0].count, 10);
    const payload = { success: true, timestamp: new Date(), totalRecords, data: result.rows };

    await cache.set(cacheKey, payload, TTL_FILTERED);
    cache.httpCache(res, 60);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[jobs.getFilteredJobs]', err);
    res.status(500).json({ success: false, message: 'Failed to load jobs' });
  }
};

// — Small helper for the five aggregation endpoints below. Each does the
//   same thing: cache-check → run a fixed query → cache → respond. —
async function cachedAggregation(cacheKey, sql, res, label) {
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await pool.query(sql);
    const payload = { success: true, timestamp: new Date(), data: result.rows };

    await cache.set(cacheKey, payload, TTL_AGGREGATION);
    cache.httpCache(res, 300);
    res.status(200).json(payload);
  } catch (err) {
    console.error(`[${label}]`, err);
    res.status(500).json({ success: false, message: `Failed to load ${label}` });
  }
}

module.exports.getAllJobCategories = (req, res) =>
  cachedAggregation(
    'jobs:categories:list',
    `SELECT jn, COUNT(*) as total
     FROM job_vacancies
     WHERE jn IS NOT NULL AND jn <> ''
     GROUP BY jn
     ORDER BY jn;`,
    res, 'jobs.categories'
  );

module.exports.getAllJobFunctionCategories = (req, res) =>
  cachedAggregation(
    'jobs:categories:job_function:list',
    `SELECT jf, COUNT(*) as total
     FROM job_vacancies
     WHERE jf IS NOT NULL AND jf <> ''
     GROUP BY jf
     ORDER BY jf;`,
    res, 'jobs.function_categories'
  );

module.exports.getAllJobOrganizations = (req, res) =>
  cachedAggregation(
    'jobs:organizations:list',
    `SELECT jv.dept, org.description, org.logo, COUNT(*) as total
     FROM job_vacancies jv
     INNER JOIN organization org ON jv.organization_id = org.id
     WHERE jv.dept IS NOT NULL AND jv.dept <> ''
     GROUP BY jv.dept, org.logo, org.description
     ORDER BY total DESC;`,
    res, 'jobs.organizations'
  );

module.exports.getLogoJobOrganizations = (req, res) =>
  cachedAggregation(
    'jobs:organizations:logo:list',
    `SELECT DISTINCT org.logo, org.name
     FROM organization org
     INNER JOIN job_vacancies jv ON org.id = jv.organization_id;`,
    res, 'jobs.logo_organizations'
  );

module.exports.getAllDutyStations = (req, res) =>
  cachedAggregation(
    'jobs:duty_stations:list',
    `SELECT duty_station, COUNT(*) as total
     FROM job_vacancies
     WHERE duty_station IS NOT NULL AND duty_station <> ''
     GROUP BY duty_station
     ORDER BY total DESC;`,
    res, 'jobs.duty_stations'
  );
