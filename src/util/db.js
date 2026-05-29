const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === 'production';

const credentials = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
};

// Single shared connection pool for the API controllers. Before this,
// every controller (jobs, blogs, organizations, etl) did `new Pool()`
// at file scope — meaning 4× separate pools, each holding up to 10
// connections, racing each other to Postgres' max_connections under
// load. Consolidating gives us one pool with a known ceiling.
//
// The ETL still has its own pool (src/etl/db.js) because its workload
// pattern (long-running scrape transactions) shouldn't share a pool
// with quick read traffic.
const pool = new Pool({
  ...credentials,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Errors on idle clients in the pool — non-fatal, the pool replaces them.
  console.error('[pg pool] idle client error:', err.message);
});

module.exports = { credentials, pool };
