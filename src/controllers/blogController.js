const { Pool } = require("pg");
const { credentials } = require("../util/db");

const pool = new Pool(credentials);

function clampPage(raw) { return Math.max(1, parseInt(raw, 10) || 1); }
// Ceiling 1000 — Api.js fetches up to size=100 for blog lists; headroom.
function clampSize(raw) { return Math.min(1000, Math.max(1, parseInt(raw, 10) || 10)); }

module.exports.getAll = async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const size = clampSize(req.query.size);
    const offset = (page - 1) * size;

    const query = `
      SELECT id, thumbnail, title, content, featured
      FROM blog
      LIMIT $1 OFFSET $2;
    `;

    const [result, countResult] = await Promise.all([
      pool.query(query, [size, offset]),
      pool.query('SELECT COUNT(*) FROM blog'),
    ]);

    const totalRecords = parseInt(countResult.rows[0].count, 10);
    res.status(200).json({
      success: true,
      totalRecords,
      timestamp: new Date(),
      data: result.rows,
    });
  } catch (err) {
    console.error('[blog.getAll]', err);
    res.status(500).json({ success: false, message: 'Failed to load blog posts' });
  }
};

module.exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid blog id' });
    }

    const query = `
      SELECT id, thumbnail, title, content, featured
      FROM blog
      WHERE id = $1;
    `;
    const result = await pool.query(query, [id]);

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (err) {
    console.error('[blog.getById]', err);
    res.status(500).json({ success: false, message: 'Failed to load blog post' });
  }
};

module.exports.getFeaturedBlog = async (req, res) => {
  try {
    // The previous version had a `W HERE` typo here that made every call
    // fail with a SQL syntax error.
    const query = `
      SELECT id, thumbnail, title, content, featured
      FROM blog
      WHERE featured = 'Yes';
    `;
    const result = await pool.query(query);
    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (err) {
    console.error('[blog.getFeaturedBlog]', err);
    res.status(500).json({ success: false, message: 'Failed to load featured blog posts' });
  }
};

module.exports.addBlog = async (req, res) => {
  try {
    const { thumbnail, title, content, featured } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ success: false, message: 'title and content are required' });
    }

    const query = `
      INSERT INTO blog (thumbnail, title, content, featured)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const result = await pool.query(query, [thumbnail, title, content, featured]);

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[blog.addBlog]', err);
    res.status(500).json({ success: false, message: 'Failed to create blog post' });
  }
};

module.exports.updateBlog = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid blog id' });
    }

    const { thumbnail, title, content, featured } = req.body || {};
    const query = `
      UPDATE blog
      SET thumbnail = $1, title = $2, content = $3, featured = $4
      WHERE id = $5
      RETURNING *;
    `;
    const result = await pool.query(query, [thumbnail, title, content, featured, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Blog post not found' });
    }

    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[blog.updateBlog]', err);
    res.status(500).json({ success: false, message: 'Failed to update blog post' });
  }
};
