const { Pool } = require("pg");
const { credentials } = require("../util/db");
const redisClient = require('../redisClient');

const pool = new Pool(credentials);

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

module.exports.getAll = async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const size = clampSize(req.query.size);
    const offset = (page - 1) * size;
    const cacheKey = `jobs:all:${page}:${size}`;

    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

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

    // 1 h TTL — the ETL flushes jobs:* on each successful agency run.
    await redisClient.set(cacheKey, JSON.stringify(payload), 'EX', 3600);

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
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

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
    await redisClient.set(cacheKey, JSON.stringify(payload), 'EX', 3600);

    res.status(200).json(payload);
  } catch (err) {
    console.error('[jobs.getById]', err);
    // TEMP: surface the underlying error so we can diagnose a live 400.
    // Remove once the root cause is known.
    res.status(500).json({
      success: false,
      message: 'Failed to load job',
      _debug: { name: err.name, message: err.message, code: err.code },
    });
  }
};

module.exports.getFilteredJobs = async (req, res) => {
  try {
    // Use LEFT JOIN to include all job_vacancies even if organization is missing
    let baseQuery = `
      SELECT
        jv.id, 
        jv.job_id, 
        jv.language, 
        jv.category_code, 
        jv.job_title, 
        jv.job_code_title, 
        jv.job_description, 
        jv.job_family_code, 
        jv.job_level, 
        jv.duty_station, 
        jv.recruitment_type, 
        jv.start_date, 
        jv.end_date, 
        jv.dept, 
        jv.apply_link,
        jv.total_count, 
        jv.jn, 
        jv.jf, 
        jv.jc, 
        jv.jl, 
        jv.created, 
        jv.data_source,
        jv.source_logo_url,
        org.logo,
        org.short_name,
        org.long_name
      FROM
        job_vacancies jv
      LEFT JOIN
        organization org ON jv.organization_id = org.id
      WHERE
        1=1
    `;

    // Build the count query with the same LEFT JOIN
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

    res.status(200).json({
      success: true,
      timestamp: new Date(),
      totalRecords,
      data: result.rows,
    });
  } catch (err) {
    console.error('[jobs.getFilteredJobs]', err);
    res.status(500).json({ success: false, message: 'Failed to load jobs' });
  }
};

module.exports.getAllJobCategories = async (req, res) => {
  try {
    let query = `
      SELECT jn, COUNT(*) as total
      FROM job_vacancies
      WHERE jn IS NOT NULL AND jn <> ''
      GROUP BY jn
      ORDER BY jn;
    `;
    let result = null;
    try {
      result = await pool.query(query);
      console.log(result);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.getAllJobFunctionCategories = async (req, res) => {
  try {
    let query = `
      SELECT jf, COUNT(*) as total
      FROM job_vacancies
      WHERE jf IS NOT NULL AND jf <> ''
      GROUP BY jf
      ORDER BY jf;
    `;
    let result = null;
    try {
      result = await pool.query(query);
      console.log(result);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.getAllJobOrganizations = async (req, res) => {
  try {
    let query = `
      SELECT 
        jv.dept, 
        org.description,
        org.logo, 
        COUNT(*) as total
      FROM 
        job_vacancies jv
      INNER JOIN 
        organization org ON jv.organization_id = org.id
      WHERE 
        jv.dept IS NOT NULL AND jv.dept <> ''
      GROUP BY 
        jv.dept, org.logo, org.description
      ORDER BY 
        total DESC;
    `;
    let result = null;
    try {
      result = await pool.query(query);
      console.log(result);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.getLogoJobOrganizations = async (req, res) => {
  try {
    let query = `
      SELECT DISTINCT org.logo, org.name
      FROM organization org 
      INNER JOIN job_vacancies jv ON org.id = jv.organization_id
    `;
    let result = null;
    try {
      result = await pool.query(query);
      console.log(result);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.getAllDutyStations = async (req, res) => {
  try {
    let query = `
      SELECT duty_station, COUNT(*) as total
      FROM job_vacancies
      WHERE duty_station IS NOT NULL AND duty_station <> ''
      GROUP BY duty_station
      ORDER BY total DESC;
    `;
    let result = null;
    try {
      result = await pool.query(query);
      console.log(result);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};