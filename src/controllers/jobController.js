const e = require("express");
const { Pool } = require("pg");
require("dotenv").config();
const { credentials } = require("../util/db");
const redisClient = require('../redisClient');

const pool = new Pool(credentials);

module.exports.getAll = async (req, res) => {
  try {
    const page = req.query.page || 1;
    const size = req.query.size || 10;
    const cacheKey = `jobs:all:${page}:${size}`;

    // Check if data is in cache
    let cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    let query = `
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
        jv.total_count, 
        jv.jn, 
        jv.jf, 
        jv.jc, 
        jv.jl, 
        jv.created, 
        jv.data_source,
        jv.apply_link,
        org.logo,
        org.short_name,
        org.long_name
      FROM 
        job_vacancies jv
      JOIN 
        organization org ON jv.organization_id = org.id
      ORDER BY 
        jv.end_date ASC
      LIMIT 
        ${size} 
      OFFSET 
        ((${page} - 1) * ${size});
    `;

    let result = null;

    // Query to get the total count of records
    let countQuery = 'SELECT COUNT(*) FROM job_vacancies';
    let countResult = null;

    try {
      result = await pool.query(query);
      countResult = await pool.query(countQuery);
    } catch (e) {
      console.log(e);
    }

    const totalRecords = parseInt(countResult.rows[0].count, 10);

    // Cache the result
    await redisClient.set(cacheKey, JSON.stringify({ success: true, totalRecords, timestamp: new Date(), data: result.rows }), 'EX', 3600); // Cache for 1 hour

    res.status(200).json({ success: true, totalRecords, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.getById = async (req, res) => {
  try {
    const cacheKey = `jobs:${req.params.id}`;

    // Check if data is in cache
    let cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    const query = `
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
        jv.apply_link,
        org.logo,
        org.short_name,
        org.long_name
      FROM 
        job_vacancies jv
      JOIN 
        organization org ON jv.organization_id = org.id
      WHERE 
        jv.id = $1
      ORDER BY 
        jv.end_date ASC;
    `;

    const values = [req.params.id];
    let result = null;
    try {
      result = await pool.query(query, values);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }

    // Cache the result
    await redisClient.set(cacheKey, JSON.stringify({ success: true, timestamp: new Date(), data: result.rows }), 'EX', 3600); // Cache for 1 hour

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
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

    // Construct the dynamic WHERE clause based on provided filters.
    // Ignore keys with empty values.
    Object.entries(req.query).forEach(([key, value]) => {
      if (key === 'page' || key === 'size') return;
      if (!value || value.toString().trim() === '') return;

      if (key === 'job_title') {
        baseQuery += ` AND to_tsvector('english', ${key}) @@ to_tsquery('english', $${queryParams.length + 1})`;
        countQuery += ` AND to_tsvector('english', ${key}) @@ to_tsquery('english', $${queryParams.length + 1})`;
        queryParams.push(value.split(' ').join(' & '));
      } else {
        baseQuery += ` AND ${key} ILIKE $${queryParams.length + 1}`;
        countQuery += ` AND ${key} ILIKE $${queryParams.length + 1}`;
        queryParams.push(value);
      }
    });

    // Add pagination parameters
    const page = parseInt(req.query.page, 10) || 1;
    const size = parseInt(req.query.size, 10) || 10;
    const offset = (page - 1) * size;
    baseQuery += ` ORDER BY end_date ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(size, offset);

    let result = null;
    let countResult = null;

    try {
      result = await pool.query(baseQuery, queryParams);
      // Exclude pagination values for the count query
      countResult = await pool.query(countQuery, queryParams.slice(0, -2));
      console.log(countQuery);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, message: 'Database query error' });
    }

    const totalRecords = parseInt(countResult.rows[0].count, 10);

    res.status(200).json({
      success: true,
      timestamp: new Date(),
      totalRecords,
      data: result.rows,
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
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