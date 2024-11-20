const e = require("express");
const { Pool } = require("pg");
require("dotenv").config();
const { credentials } = require("../util/db");

const pool = new Pool(credentials);

module.exports.getAll = async (req, res) => {
  try {
    const { page, size } = req.query;

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
