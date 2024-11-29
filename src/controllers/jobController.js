const e = require("express");
const { Pool } = require("pg");
require("dotenv").config();
const { credentials } = require("../util/db");

const pool = new Pool(credentials);

module.exports.getAll = async (req, res) => {
  try {
    const page = req.query.page || 1;
    const size = req.query.size || 10;

    let query = `SELECT id, job_id, language, category_code, job_title, job_code_title, job_description, job_family_code, job_level, duty_station, recruitment_type, start_date, end_date, dept, total_count, jn, jf, jc, jl, created, data_source 
	 FROM job_vacancies order by id LIMIT ${size}  OFFSET ((${page} - 1) * ${size});`;

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

    res.status(200).json({ success: true, totalRecords, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: err.message });
  }
};

module.exports.getById = async (req, res) => {
  try {
    let query = `SELECT  id, job_id, language, category_code, job_title, job_code_title, job_description, job_family_code, job_level, duty_station, recruitment_type, start_date, end_date, dept, total_count, jn, jf, jc, jl, created, data_source FROM job_vacancies WHERE id=${req.params.id} order by id;`;
    let result = null;
    try {
      result = await pool.query(query);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }
    
    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: err.message });
  }
};

module.exports.getFilteredJobs = async (req, res) => {
  try {
    let baseQuery = 'SELECT id, job_id, language, category_code, job_title, job_code_title, job_description, job_family_code, job_level, duty_station, recruitment_type, start_date, end_date, dept, total_count, jn, jf, jc, jl, created, data_source FROM job_vacancies WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) FROM job_vacancies WHERE 1=1';
    const queryParams = [];

    // Dynamically construct the WHERE clause based on filters
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== 'page' && key !== 'size') {
        if (typeof value === 'string') {
          baseQuery += ` AND ${key} ILIKE $${queryParams.length + 1}`;
          countQuery += ` AND ${key} ILIKE $${queryParams.length + 1}`;
        } else {
          baseQuery += ` AND ${key} = $${queryParams.length + 1}`;
          countQuery += ` AND ${key} = $${queryParams.length + 1}`;
        }
        queryParams.push(value);
      }
    }

    // Add pagination
    const page = req.query.page || 1;
    const size = req.query.size || 10;
    const offset = (page - 1) * size;
    baseQuery += ` ORDER BY id LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(size, offset);

    let result = null;
    let countResult = null;

    try {
      result = await pool.query(baseQuery, queryParams);
      countResult = await pool.query(countQuery, queryParams.slice(0, -2)); // Exclude pagination params for count query
      
    } catch (e) {
      console.log(e);
      return res.status(500).json({ success: false, message: 'Database query error' });
    }

    const totalRecords = parseInt(countResult.rows[0].count, 10);

    res.status(200).json({ success: true, timestamp: new Date(), totalRecords, data: result.rows });
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
    res.status(400).json({ success: false, message: err.message });
  }
};


module.exports.getAllJobOrganizations = async (req, res) => {
  try {
    let query = `
    SELECT dept, COUNT(*) as total
    FROM job_vacancies
    WHERE dept IS NOT NULL AND dept <> ''
    GROUP BY dept
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
    res.status(400).json({ success: false, message: err.message });
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
    res.status(400).json({ success: false, message: err.message });
  }
};