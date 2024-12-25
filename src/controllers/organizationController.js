const e = require("express");
const { Pool } = require("pg");
require("dotenv").config();
const { credentials } = require("../util/db");

const pool = new Pool(credentials);

module.exports.getAll = async (req, res) => {
  try {
    const page = req.query.page || 1;
    const size = req.query.size || 10;

    let query = `SELECT id, code, logo, name, short_name, description, url, long_name FROM organization order by id LIMIT ${size}  OFFSET ((${page} - 1) * ${size});`;

    let result = null;

    // Query to get the total count of records
    let countQuery = 'SELECT COUNT(*) FROM organization';
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
    let query = `SELECT  id, code, logo, name, short_name, description, url, long_name FROM organization WHERE id=${req.params.id} order by id;`;
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

