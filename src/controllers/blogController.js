const e = require("express");
const { Pool } = require("pg");
require("dotenv").config();
const { credentials } = require("../util/db");

const pool = new Pool(credentials);

module.exports.getAll = async (req, res) => {
  try {
    

    let query = `
  SELECT 
    id,
    thumbnail,
    title,
    content,
    featured
   
  FROM 
    blog;
`;



    let result = null;

    // Query to get the total count of records
    let countQuery = 'SELECT COUNT(*) FROM blog';
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
    const query = `
    SELECT 
      id,
    thumbnail,
    title,
    content,
    featured
    FROM 
      blog
    WHERE 
      id = $1
    
  `;   
  const values = [req.params.id];
  let result = null;
    try {
      result = await pool.query(query, values);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
    }
    
    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: err.message });
  }
};
module.exports.getFeaturedBlog = async (req, res) => {
  try {
    const query = `
    SELECT 
      id,
    thumbnail,
    title,
    content,
    featured
    FROM 
      blog
    WHERE 
      featured = 'Yes'
    
  `;   
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





