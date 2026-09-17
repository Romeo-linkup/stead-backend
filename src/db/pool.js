// src/db/pool.js
// Single shared Postgres connection pool (Neon). Import this everywhere
// instead of creating new pools/clients.
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set — queries will fail.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] unexpected error on idle client', err);
});

module.exports = pool;
