require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    await client.connect();

    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log('TABLES=' + (tables.rows.length ? tables.rows.map(r => r.table_name).join(', ') : '(none)'));

    for (const t of ['districts', 'codes', 'users', 'properties', 'units']) {
      const cols = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position;`,
        [t]
      );
      console.log(
        'TABLE_COLUMNS:' + t + '=' +
        (cols.rows.length ? cols.rows.map(r => `${r.column_name}:${r.data_type}:${r.is_nullable}:${r.column_default ?? ''}`).join(' | ') : 'MISSING')
      );
    }
  } catch (e) {
    console.log('DB_ERROR=' + e.message);
  } finally {
    await client.end();
  }
})();
