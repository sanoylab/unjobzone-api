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
    const cacheKey = `blogs:all:${page}:${size}`;

    // Check if data is in cache
    let cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

    let query = `
      SELECT 
        id,
        thumbnail,
        title,
        content,
        featured
      FROM 
        blog
      LIMIT 
        ${size} 
      OFFSET 
        ((${page} - 1) * ${size});
    `;

    let result = null;

    // Query to get the total count of records
    let countQuery = 'SELECT COUNT(*) FROM blog';
    let countResult = null;

    try {
      result = await pool.query(query);
      countResult = await pool.query(countQuery);
      console.log(countQuery);
    } catch (e) {
      console.log(e);
    }

    const totalRecords = parseInt(countResult.rows[0].count, 10);

    // Cache the result with a shorter expiration time
    await redisClient.set(cacheKey, JSON.stringify({ success: true, totalRecords, timestamp: new Date(), data: result.rows }), 'EX', 600); // Cache for 10 minutes

    res.status(200).json({ success: true, totalRecords, timestamp: new Date(), data: result.rows });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

module.exports.getById = async (req, res) => {
  try {
    const cacheKey = `blogs:${req.params.id}`;

    // Check if data is in cache
    let cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

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

    // Cache the result with a shorter expiration time
    await redisClient.set(cacheKey, JSON.stringify({ success: true, timestamp: new Date(), data: result.rows }), 'EX', 600); // Cache for 10 minutes

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.getFeaturedBlog = async (req, res) => {
  try {
    const cacheKey = `blogs:featured`;

    // Check if data is in cache
    let cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }

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

    // Cache the result with a shorter expiration time
    await redisClient.set(cacheKey, JSON.stringify({ success: true, timestamp: new Date(), data: result.rows }), 'EX', 600); // Cache for 10 minutes

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.addBlog = async (req, res) => {
  try {
    const { thumbnail, title, content, featured } = req.body;
    const query = `
      INSERT INTO blog (thumbnail, title, content, featured)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const values = [thumbnail, title, content, featured];
    let result = null;

    try {
      result = await pool.query(query, values);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
      return res.status(400).json({ success: false, message: e.message });
    }

    // Invalidate the cache
    await redisClient.del('blogs:all:*');
    await redisClient.del('blogs:featured');

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

module.exports.updateBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const { thumbnail, title, content, featured } = req.body;
    const query = `
      UPDATE blog
      SET thumbnail = $1, title = $2, content = $3, featured = $4
      WHERE id = $5
      RETURNING *;
    `;
    const values = [thumbnail, title, content, featured, id];
    let result = null;

    try {
      result = await pool.query(query, values);
      console.log(result.rows);
    } catch (e) {
      console.log(e);
      return res.status(400).json({ success: false, message: e.message });
    }

    // Invalidate the cache
    await redisClient.del(`blogs:${id}`);
    await redisClient.del('blogs:all:*');
    await redisClient.del('blogs:featured');

    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};