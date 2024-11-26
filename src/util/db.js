require("dotenv").config();

const isProduction = process.env.NODE_ENV === 'production';

const credentials = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
  ssl: isProduction ? { rejectUnauthorized: false } : false
};



module.exports = { credentials };
