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
    try {
      result = await pool.query(query);
    } catch (e) {
      console.log(e);
    }   

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
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
    let query = 'SELECT id, job_id, language, category_code, job_title, job_code_title, job_description, job_family_code, job_level, duty_station, recruitment_type, start_date, end_date, dept, total_count, jn, jf, jc, jl, created, data_source FROM job_vacancies WHERE 1=1';
    const queryParams = [];
   
    // Dynamically construct the WHERE clause based on filters
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== 'page' && key !== 'size') {
        if (typeof value === 'string') {
          query += ` AND ${key} ILIKE $${queryParams.length + 1}`;
        } else {
          query += ` AND ${key} = $${queryParams.length + 1}`;
        }
        queryParams.push(value);
      }
    }
    const page = req.query.page || 1;
    const size = req.query.size || 10;
    const offset = (page - 1) * size;
    query += ` ORDER BY id LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(size, offset);

    
    let result = null;

    try {
      result = await pool.query(query, queryParams);
      
    } catch (e) {
      console.log(e);
    }

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};