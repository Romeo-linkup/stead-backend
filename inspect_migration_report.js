require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const files = [
  'src/db/migrations/002_leases.sql',
  'src/db/migrations/003_maintenance.sql',
  'src/db/migrations/004_complaints_payments.sql',
  'src/db/migrations/005_audit_emergency.sql',
  'src/db/migrations/006_evaluations.sql',
];

for (const f of files) {
  const abs = path.join(__dirname, f);
  const buf = fs.readFileSync(abs);
  const txt = buf.toString('utf8');
  console.log(`FILE=${f};SIZE=${buf.length};HAS_CREATE_TABLE=${/CREATE\s+TABLE/i.test(txt)}`);
  console.log('CONTENT_START');
  console.log(txt);
  console.log('CONTENT_END');
  console.log('---');
}

const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    await client.connect();
    const q = await client.query('SELECT * FROM schema_migrations ORDER BY applied_at;');
    console.log('SCHEMA_MIGRATIONS_ROWS=' + JSON.stringify(q.rows));
  } catch (e) {
    console.log('SCHEMA_MIGRATIONS_ERROR=' + e.message);
  } finally {
    await client.end();
  }
})();
