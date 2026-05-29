const { pool } = require("../util/db");
const cache = require("../util/cache");

function clampPage(raw) { return Math.max(1, parseInt(raw, 10) || 1); }
function clampSize(raw) { return Math.min(1000, Math.max(1, parseInt(raw, 10) || 10)); }

// Organizations change only when the ETL discovers a new agency, which is
// rare. 30 min is a comfortable TTL — short enough that a real change shows
// up quickly, long enough that the page-load case is a cache hit.
const TTL = 30 * 60;

module.exports.getAll = async (req, res) => {
  try {
    const page = clampPage(req.query.page);
    const size = clampSize(req.query.size);
    const offset = (page - 1) * size;
    const cacheKey = `orgs:all:${page}:${size}`;

    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

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
    const payload = {
      success: true,
      totalRecords,
      timestamp: new Date(),
      data: result.rows,
    };

    await cache.set(cacheKey, payload, TTL);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[organization.getAll]', err);
    res.status(500).json({ success: false, message: 'Failed to load organizations' });
  }
};

module.exports.getById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid organization id' });
    }

    const cacheKey = `orgs:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const query = `
      SELECT id, code, logo, name, short_name, description, url, long_name
      FROM organization
      WHERE id = $1
      ORDER BY id;
    `;
    const result = await pool.query(query, [id]);
    const payload = { success: true, timestamp: new Date(), data: result.rows };

    await cache.set(cacheKey, payload, TTL);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[organization.getById]', err);
    res.status(500).json({ success: false, message: 'Failed to load organization' });
  }
};
