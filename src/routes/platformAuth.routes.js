// src/routes/platformAuth.routes.js
// Platform admin login with two-factor authentication
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const router = express.Router();
const pool = require('../db/pool');
const { writeLedger } = require('../services/ledger.service');

const loginRateLimit = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

const loginFailures = new Map();

function cleanLoginFailures() {
  const now = Date.now();
  for (const [email, data] of loginFailures.entries()) {
    if (now - data.lastAttempt > 30 * 60 * 1000) {
      loginFailures.delete(email);
    }
  }
}

setInterval(cleanLoginFailures, 5 * 60 * 1000);

function decryptTotpSecret(encrypted) {
  const key = Buffer.from(process.env.PLATFORM_TOTP_KEY, 'hex');
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret format');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

router.post('/login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password, code } = req.body;

    if (typeof email !== 'string' || email.length > 254) {
      return res.status(400).json({ error: 'Email is required and must be at most 254 characters.' });
    }
    if (typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ error: 'Password is required and must be at most 200 characters.' });
    }
    if (code !== undefined && code !== '' && (typeof code !== 'string' || code.length !== 6 || !/^\d{6}$/.test(code))) {
      return res.status(400).json({ error: 'Code must be 6 digits.' });
    }

    const emailLower = email.trim().toLowerCase();
    const now = Date.now();

    const failure = loginFailures.get(emailLower);
    if (failure && failure.count >= 5 && now - failure.lastAttempt < 30 * 60 * 1000) {
      try {
        await writeLedger({
          actorType: 'platform_admin',
          actorId: null,
          eventType: 'platform.login_failed',
          detail: { reason: 'locked' }
        });
      } catch (err) {
        console.error('[ledger] failed to write ledger entry:', err.message);
      }
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM platform_admins WHERE lower(email) = lower($1)',
      [emailLower]
    );
    const admin = rows[0];

    const dummyHash = await bcrypt.hash('dummy', 12);
    const isValid = admin ? await bcrypt.compare(password, admin.password_hash) : await bcrypt.compare(password, dummyHash);

    if (!isValid) {
      if (failure) {
        failure.count++;
        failure.lastAttempt = now;
      } else {
        loginFailures.set(emailLower, { count: 1, lastAttempt: now });
      }
      try {
        await writeLedger({
          actorType: 'platform_admin',
          actorId: admin?.id || null,
          eventType: 'platform.login_failed',
          detail: { reason: 'bad_credentials' }
        });
      } catch (err) {
        console.error('[ledger] failed to write ledger entry:', err.message);
      }
      return res.status(401).json({ error: 'Incorrect email, password or code.' });
    }

    // Check if 2FA is enabled
    const no2faAllowed = process.env.PLATFORM_ALLOW_NO_2FA === 'true';
    const has2fa = admin.totp_secret_encrypted !== null;

    if (!has2fa) {
      if (!no2faAllowed) {
        try {
          await writeLedger({
            actorType: 'platform_admin',
            actorId: admin.id,
            eventType: 'platform.login_failed',
            detail: { reason: 'no_2fa_not_allowed' }
          });
        } catch (err) {
          console.error('[ledger] failed to write ledger entry:', err.message);
        }
        return res.status(401).json({ error: 'Incorrect email, password or code.' });
      }

      // Stricter lockout for no-2FA logins: 3 failures in 30 minutes
      const no2faFailure = loginFailures.get(emailLower);
      if (no2faFailure && no2faFailure.count >= 3 && now - no2faFailure.lastAttempt < 30 * 60 * 1000) {
        try {
          await writeLedger({
            actorType: 'platform_admin',
            actorId: admin.id,
            eventType: 'platform.login_failed',
            detail: { reason: 'locked_no_2fa' }
          });
        } catch (err) {
          console.error('[ledger] failed to write ledger entry:', err.message);
        }
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
    } else {
      // 2FA is enabled, require valid code
      if (!code || code === '') {
        try {
          await writeLedger({
            actorType: 'platform_admin',
            actorId: admin.id,
            eventType: 'platform.login_failed',
            detail: { reason: 'missing_code' }
          });
        } catch (err) {
          console.error('[ledger] failed to write ledger entry:', err.message);
        }
        return res.status(401).json({ error: 'Incorrect email, password or code.' });
      }

      const totpSecret = decryptTotpSecret(admin.totp_secret_encrypted);
      const codeValid = authenticator.check(code, totpSecret);

      if (!codeValid) {
        if (failure) {
          failure.count++;
          failure.lastAttempt = now;
        } else {
          loginFailures.set(emailLower, { count: 1, lastAttempt: now });
        }
        try {
          await writeLedger({
            actorType: 'platform_admin',
            actorId: admin.id,
            eventType: 'platform.login_failed',
            detail: { reason: 'bad_code' }
          });
        } catch (err) {
          console.error('[ledger] failed to write ledger entry:', err.message);
        }
        return res.status(401).json({ error: 'Incorrect email, password or code.' });
      }
    }

    loginFailures.delete(emailLower);

    await pool.query('UPDATE platform_admins SET last_login_at = now() WHERE id = $1', [admin.id]);

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: admin.id,
        eventType: 'platform.login',
        detail: { two_factor: has2fa }
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { admin_id: admin.id, typ: 'platform' },
      process.env.PLATFORM_JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
