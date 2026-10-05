// scripts/reset-owner-password.js
// Usage: NEW_PASSWORD=... node scripts/reset-owner-password.js owner@email.com
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

async function main() {
  const email = process.argv[2];
  const newPassword = process.env.NEW_PASSWORD;

  if (!email) {
    console.error('Error: Email address is required as the first argument.');
    process.exit(1);
  }

  if (!newPassword) {
    console.error('Error: NEW_PASSWORD environment variable is required.');
    process.exit(1);
  }

  const passwordBytes = Buffer.byteLength(newPassword, 'utf8');
  if (passwordBytes < 10 || passwordBytes > 72) {
    console.error('Error: Password must be between 10 and 72 bytes.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  const result = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE lower(email) = lower($2) AND role = $3',
    [passwordHash, email, 'owner']
  );

  console.log(`Updated ${result.rowCount} row(s).`);

  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
