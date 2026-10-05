// scripts/wipe-test-data.js
// Create a Neon branch or backup first. This deletes ALL rows.
// Usage: WIPE_CONFIRM="WIPE ALL DATA" node scripts/wipe-test-data.js
require('dotenv').config();
const pool = require('../src/db/pool');

async function main() {
  if (process.env.WIPE_CONFIRM !== 'WIPE ALL DATA') {
    console.error('Error: Set WIPE_CONFIRM="WIPE ALL DATA" to confirm you want to delete ALL data.');
    process.exit(1);
  }

  // Parse DATABASE_URL to get host and db name (no credentials)
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Error: DATABASE_URL is not set.');
    process.exit(1);
  }

  try {
    const url = new URL(dbUrl);
    console.log(`Database host: ${url.hostname}`);
    console.log(`Database name: ${url.pathname.substring(1)}`);
  } catch (err) {
    console.error('Error: Invalid DATABASE_URL format.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    // Get all data tables (BASE TABLE in public schema)
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );

    const dataTables = tables
      .map(t => t.table_name)
      .filter(name => name !== 'schema_migrations'); // Exclude migrations tracking table

    console.log('\nCurrent row counts:');
    for (const tableName of dataTables) {
      const { rows } = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
      console.log(`  ${tableName}: ${rows[0].count}`);
    }

    console.log('\nTruncating all data tables...');
    await client.query('BEGIN');

    for (const tableName of dataTables) {
      await client.query(`TRUNCATE ${tableName} RESTART IDENTITY CASCADE`);
    }

    await client.query('COMMIT');
    console.log('Done. All data has been deleted.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during wipe:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
