// scripts/create-platform-admin.js
// Usage: PLATFORM_ADMIN_PASSWORD=... node scripts/create-platform-admin.js you@email.com
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const pool = require('../src/db/pool');

async function main() {
  const email = process.argv[2];
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('Usage: PLATFORM_ADMIN_PASSWORD=... node scripts/create-platform-admin.js you@email.com');
    process.exit(1);
  }

  if (typeof email !== 'string' || email.length > 254) {
    console.error('Email must be at most 254 characters.');
    process.exit(1);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error('Invalid email format.');
    process.exit(1);
  }

  const passwordBytes = Buffer.byteLength(password, 'utf8');
  const no2fa = process.env.NO_2FA === 'true';

  if (no2fa) {
    if (passwordBytes < 16 || passwordBytes > 72) {
      console.error('Password must be between 16 and 72 bytes when NO_2FA=true.');
      process.exit(1);
    }
  } else {
    if (passwordBytes < 10 || passwordBytes > 72) {
      console.error('Password must be between 10 and 72 bytes.');
      process.exit(1);
    }
  }

  if (!no2fa && !process.env.PLATFORM_TOTP_KEY) {
    console.error('PLATFORM_TOTP_KEY is not set.');
    process.exit(1);
  }

  const emailLower = email.trim().toLowerCase();

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT id FROM platform_admins WHERE lower(email) = lower($1)',
      [emailLower]
    );

    if (rows[0]) {
      console.error('An admin with this email already exists.');
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    if (no2fa) {
      await client.query(
        `INSERT INTO platform_admins (email, password_hash, totp_secret_encrypted)
         VALUES ($1, $2, NULL)`,
        [emailLower, passwordHash]
      );

      console.log('\n=== PLATFORM ADMIN CREATED ===');
      console.log(`Email: ${emailLower}`);
      console.log('\nCreated WITHOUT two-factor. Set PLATFORM_ALLOW_NO_2FA=true in Render for this login to work.');
    } else {
      const totpSecret = authenticator.generateSecret();

      const key = Buffer.from(process.env.PLATFORM_TOTP_KEY, 'hex');
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(totpSecret, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const tag = cipher.getAuthTag();
      const encryptedSecret = `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;

      await client.query(
        `INSERT INTO platform_admins (email, password_hash, totp_secret_encrypted)
         VALUES ($1, $2, $3)`,
        [emailLower, passwordHash, encryptedSecret]
      );

      const otpauthUri = authenticator.keyuri(emailLower, 'SteadPlatform', totpSecret);

      console.log('\n=== PLATFORM ADMIN CREATED ===');
      console.log(`Email: ${emailLower}`);
      console.log(`\nTOTP Secret: ${totpSecret}`);
      console.log(`\nOTPAuth URI: ${otpauthUri}`);
      console.log('\nAdd this to your authenticator app, then close this window.');
    }
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
