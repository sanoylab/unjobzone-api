const { Pool } = require("pg");
const { credentials } = require("../util/db");

const pool = new Pool(credentials);

function clampPage(raw) { return Math.max(1, parseInt(raw, 10) || 1); }
function clampSize(raw) { return Math.min(1000, Math.max(1, parseInt(raw, 10) || 10)); }

module.exports.getAll = async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const size = clampSize(req.query.size);
    const offset = (page - 1) * size;

    const query = `
      SELECT id, code, logo, name, short_name, description, url, long_name
      FROM organization
      ORDER BY id
      LIMIT $1 OFFSET $2;
    `;

    const [result, countResult] = await Promise.all([
      pool.query(query, [size, offset]),
      pool.query('SELECT COUNT(*) FROM organization'),
    ]);

    const totalRecords = parseInt(countResult.rows[0].count, 10);
    res.status(200).json({
      success: true,
      totalRecords,
      timestamp: new Date(),
      data: result.rows,
    });
  } catch (err) {
    console.error('[organization.getAll]', err);
    res.status(500).json({ success: false, message: 'Failed to load organizations' });
  }
};

module.exports.getById = async (req, res) => {
  try {
    // Path param `id` must be a positive integer — reject anything else
    // outright rather than try to coerce silently.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid organization id' });
    }

    const query = `
      SELECT id, code, logo, name, short_name, description, url, long_name
      FROM organization
      WHERE id = $1
      ORDER BY id;
    `;
    const result = await pool.query(query, [id]);

    res.status(200).json({ success: true, timestamp: new Date(), data: result.rows });
  } catch (err) {
    console.error('[organization.getById]', err);
    res.status(500).json({ success: false, message: 'Failed to load organization' });
  }
};
