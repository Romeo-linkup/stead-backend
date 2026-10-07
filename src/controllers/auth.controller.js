// src/controllers/auth.controller.js
// Code-based, passwordless auth. See BLUEPRINT.md Section 5.
//
// Flow this file implements:
// 1. POST /auth/validate-code
//    - Looks up the code. If a user is ALREADY registered against it
//      (returning device, or a code shared by several people who've all
//      registered before), issues a full JWT immediately — no second
//      step needed.
//    - If nobody has registered against this code yet, issues a
//      short-lived "pre_token" and tells the frontend to show the
//      one-time "who are you?" screen.
// 2. POST /auth/register-name (Bearer: pre_token)
//    - Creates the user row tied to that code, issues the full JWT.
// 3. POST /auth/refresh (Bearer: full token)
//    - Issues a new full token with a fresh expiry.

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { validateName, validatePhone } = require('../utils/validators');
const { sendVerificationEmail, sendDirect } = require('../services/notify.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FULL_TOKEN_EXPIRY = '90d';
const PRE_TOKEN_EXPIRY = '10m';

function issueFullToken(user) {
  return jwt.sign(
    { type: 'full', user_id: user.id, role: user.role, district_id: user.district_id, organization_id: user.organization_id },
    process.env.JWT_SECRET,
    { expiresIn: FULL_TOKEN_EXPIRY }
  );
}

function issuePreToken(code) {
  return jwt.sign(
    { type: 'pre', code_id: code.id, role: code.role, district_id: code.district_id, organization_id: code.organization_id },
    process.env.JWT_SECRET,
    { expiresIn: PRE_TOKEN_EXPIRY }
  );
}

async function validateCode(req, res, next) {
  try {
    const raw = (req.body.code || '').trim().toUpperCase();
    if (!raw) return res.status(400).json({ error: 'Code is required.' });

    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.role, c.district_id, c.active, c.organization_id, d.name AS district_name
       FROM codes c
       LEFT JOIN districts d ON d.id = c.district_id
       WHERE c.code = $1`,
      [raw]
    );
    const code = rows[0];

    if (!code || !code.active) {
      return res.status(401).json({ error: 'That code is invalid or has been deactivated.' });
    }

    if (code.organization_id === null) {
      return res.status(403).json({ error: 'This code is not linked to an organisation.' });
    }

    const existing = await pool.query('SELECT * FROM users WHERE code_id = $1', [code.id]);

    if (existing.rows[0]) {
      const user = existing.rows[0];
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      const token = issueFullToken(user);
      return res.json({
        needs_registration: false,
        token,
        role: user.role,
        district_id: user.district_id,
        district_name: code.district_name,
        name: user.name,
      });
    }

    const pre_token = issuePreToken(code);
    return res.json({
      needs_registration: true,
      pre_token,
      role: code.role,
      district_id: code.district_id,
      district_name: code.district_name,
    });
  } catch (err) {
    next(err);
  }
}

async function registerName(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, preToken] = header.split(' ');
    if (scheme !== 'Bearer' || !preToken) {
      return res.status(401).json({ error: 'Missing pre-registration token.' });
    }

    let payload;
    try {
      payload = jwt.verify(preToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Pre-registration token is invalid or expired. Re-enter your code.' });
    }
    if (payload.type !== 'pre') {
      return res.status(401).json({ error: 'Wrong token type for this step.' });
    }

    const { name, phone, email } = req.body;
    const nameErr = validateName(name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    const phoneErr = validatePhone(phone);
    if (phoneErr) return res.status(400).json({ error: phoneErr });

    let emailValue = null;
    if (email !== undefined) {
      const trimmed = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (trimmed !== '') {
        if (!EMAIL_REGEX.test(trimmed)) {
          return res.status(400).json({ error: 'Invalid email format.' });
        }
        if (trimmed.length > 254) {
          return res.status(400).json({ error: 'Email must be at most 254 characters.' });
        }
        emailValue = trimmed;
      }
    }

    // Guard against a double-submit registering the same code twice.
    const existing = await pool.query('SELECT * FROM users WHERE code_id = $1', [payload.code_id]);
    let user;
    if (existing.rows[0]) {
      user = existing.rows[0];
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    } else {
      // Resolve the code's unit (if any) so a tenant can be linked to it.
      const codeResult = await pool.query(
        'SELECT id, unit_id FROM codes WHERE id = $1',
        [payload.code_id]
      );
      const code = codeResult.rows[0];
      const codeUnitId = code && code.unit_id ? code.unit_id : null;

      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query('BEGIN');
        transactionStarted = true;

        const inserted = await client.query(
          `INSERT INTO users (name, phone, email, role, district_id, code_id, organization_id, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           RETURNING *`,
          [name.trim(), phone || null, emailValue, payload.role, payload.district_id, payload.code_id, payload.organization_id]
        );
        user = inserted.rows[0];

        // Link the tenant to the code's unit when it has no tenant yet.
        // If the unit already has a different tenant, create the user but
        // do NOT overwrite tenant_user_id.
        if (codeUnitId !== null) {
          await client.query(
            `UPDATE units
             SET tenant_user_id = $1, updated_at = now()
             WHERE id = $2 AND tenant_user_id IS NULL`,
            [user.id, codeUnitId]
          );
        }

        await client.query('COMMIT');
        transactionStarted = false;
      } catch (err) {
        if (transactionStarted) await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await writeAudit({
        actorId: user.id,
        actorRole: user.role,
        districtId: user.district_id,
        action: 'user.register',
        entityType: 'user',
        entityId: user.id,
        metadata: { via_code_id: payload.code_id },
      });

      if (emailValue) {
        setImmediate(() => sendVerificationEmail(user.id).catch(() => {}));
      }
    }

    const token = issueFullToken(user);
    res.status(201).json({
      token,
      role: user.role,
      district_id: user.district_id,
      name: user.name,
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing token.' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    } catch (err) {
      return res.status(401).json({ error: 'Token could not be parsed.' });
    }
    if (payload.type !== 'full') {
      return res.status(401).json({ error: 'Wrong token type for this step.' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.role, u.district_id, u.organization_id, c.active AS code_active
       FROM users u JOIN codes c ON c.id = u.code_id
       WHERE u.id = $1`,
      [payload.user_id]
    );
    const row = rows[0];
    if (!row || !row.code_active) {
      return res.status(401).json({ error: 'Your access code has been revoked.' });
    }

    const newToken = issueFullToken(row);
    res.json({ token: newToken });
  } catch (err) {
    next(err);
  }
}

async function getConfig(req, res, next) {
  try {
    res.json({ signup_open: process.env.SIGNUP_ENABLED === 'true', email_enabled: process.env.EMAIL_ENABLED === 'true' });
  } catch (err) {
    next(err);
  }
}

const signupRateLimit = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-up attempts. Try again later.' },
});

async function signup(req, res, next) {
  try {
    if (process.env.SIGNUP_ENABLED !== 'true') {
      return res.status(403).json({ error: 'Sign-up is not open yet.' });
    }

    const { name, email, password, business_name, districts } = req.body;

    // Validate name
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
      return res.status(400).json({ error: 'Name must be between 1 and 100 characters.' });
    }

    // Validate email
    if (typeof email !== 'string' || email.trim().length === 0 || email.trim().length > 254) {
      return res.status(400).json({ error: 'Email is required and must be at most 254 characters.' });
    }
    const emailLower = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailLower)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    // Validate password
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (passwordBytes < 10 || passwordBytes > 72) {
      return res.status(400).json({ error: 'Password must be between 10 and 72 bytes.' });
    }
    if (password === emailLower) {
      return res.status(400).json({ error: 'Password cannot be the same as your email.' });
    }

    // Validate business_name
    if (typeof business_name !== 'string' || business_name.trim().length < 1 || business_name.trim().length > 120) {
      return res.status(400).json({ error: 'Business name must be between 1 and 120 characters.' });
    }

    // Validate districts
    if (!Array.isArray(districts) || districts.length > 10) {
      return res.status(400).json({ error: 'You can have at most 10 districts.' });
    }

    const districtNames = new Set();
    let totalUnits = 0;

    for (const district of districts) {
      if (typeof district.name !== 'string' || district.name.trim().length < 1 || district.name.trim().length > 100) {
        return res.status(400).json({ error: 'District name must be between 1 and 100 characters.' });
      }
      const dNameLower = district.name.trim().toLowerCase();
      if (districtNames.has(dNameLower)) {
        return res.status(400).json({ error: 'District names must be unique.' });
      }
      districtNames.add(dNameLower);

      if (!Array.isArray(district.properties) || district.properties.length > 30) {
        return res.status(400).json({ error: 'Each district can have at most 30 properties.' });
      }

      const propertyNames = new Set();
      for (const property of district.properties) {
        if (typeof property.name !== 'string' || property.name.trim().length < 1 || property.name.trim().length > 100) {
          return res.status(400).json({ error: 'Property name must be between 1 and 100 characters.' });
        }
        const pNameLower = property.name.trim().toLowerCase();
        if (propertyNames.has(pNameLower)) {
          return res.status(400).json({ error: 'Property names must be unique within a district.' });
        }
        propertyNames.add(pNameLower);

        if (property.address && (typeof property.address !== 'string' || property.address.length > 200)) {
          return res.status(400).json({ error: 'Property address must be at most 200 characters.' });
        }

        if (!Array.isArray(property.units)) {
          return res.status(400).json({ error: 'Units must be an array.' });
        }

        const unitNumbers = new Set();
        for (const unit of property.units) {
          if (typeof unit !== 'string' || unit.trim().length < 1 || unit.trim().length > 20) {
            return res.status(400).json({ error: 'Unit number must be between 1 and 20 characters.' });
          }
          const unitTrimmed = unit.trim();
          const unitRegex = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/;
          if (!unitRegex.test(unitTrimmed)) {
            return res.status(400).json({ error: 'Unit number contains invalid characters.' });
          }
          const unitLower = unitTrimmed.toLowerCase();
          if (unitNumbers.has(unitLower)) {
            return res.status(400).json({ error: 'Unit numbers must be unique within a property.' });
          }
          unitNumbers.add(unitLower);
          totalUnits++;
        }
      }
    }

    if (totalUnits > 500) {
      return res.status(400).json({ error: 'You can have at most 500 units total.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert organization
      const orgResult = await client.query(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
        [business_name.trim()]
      );
      const organizationId = orgResult.rows[0].id;

      // Insert user
      const userResult = await client.query(
        `INSERT INTO users (name, email, password_hash, role, organization_id, district_id, code_id, last_login_at)
         VALUES ($1, $2, $3, 'owner', $4, NULL, NULL, now())
         RETURNING *`,
        [name.trim(), emailLower, passwordHash, organizationId]
      );
      const user = userResult.rows[0];

      // Insert districts, properties, and units
      for (const district of districts) {
        const districtResult = await client.query(
          'INSERT INTO districts (name, organization_id) VALUES ($1, $2) RETURNING id',
          [district.name.trim(), organizationId]
        );
        const districtId = districtResult.rows[0].id;

        for (const property of district.properties) {
          const propertyResult = await client.query(
            'INSERT INTO properties (name, district_id, address) VALUES ($1, $2, $3) RETURNING id',
            [property.name.trim(), districtId, property.address ? property.address.trim() : null]
          );
          const propertyId = propertyResult.rows[0].id;

          for (const unit of property.units) {
            await client.query(
              'INSERT INTO units (property_id, unit_number) VALUES ($1, $2)',
              [propertyId, unit.trim()]
            );
          }
        }
      }

      // Create app_settings row
      await client.query(
        `INSERT INTO app_settings (id, business_name, notice_period_months, organization_id)
         VALUES (1, $1, 3, $2)
         ON CONFLICT (id) DO UPDATE SET business_name = EXCLUDED.business_name, notice_period_months = EXCLUDED.notice_period_months, organization_id = EXCLUDED.organization_id`,
        [business_name.trim(), organizationId]
      );

      // Write audit entry (counts only, no email/password)
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, district_id, organization_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'owner', NULL, $2, 'org.signup', 'organization', $3, $4)`,
        [user.id, organizationId, organizationId, JSON.stringify({
          districts_count: districts.length,
          properties_count: districts.reduce((sum, d) => sum + d.properties.length, 0),
          units_count: totalUnits
        })]
      );

      await client.query('COMMIT');

      setImmediate(() => sendVerificationEmail(user.id).catch(() => {}));

      const token = issueFullToken(user);
      res.status(201).json({
        token,
        role: user.role,
        district_id: user.district_id,
        name: user.name,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
}

const loginRateLimit = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

const loginFailures = new Map(); // email -> { count, lastAttempt }

function cleanLoginFailures() {
  const now = Date.now();
  for (const [email, data] of loginFailures.entries()) {
    if (now - data.lastAttempt > 15 * 60 * 1000) {
      loginFailures.delete(email);
    }
  }
}

setInterval(cleanLoginFailures, 5 * 60 * 1000); // Clean every 5 minutes

async function loginPassword(req, res, next) {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || email.length > 254) {
      return res.status(400).json({ error: 'Email is required and must be at most 254 characters.' });
    }
    if (typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ error: 'Password is required and must be at most 200 characters.' });
    }

    const emailLower = email.trim().toLowerCase();
    const now = Date.now();

    // Check lockout
    const failure = loginFailures.get(emailLower);
    if (failure && failure.count >= 8 && now - failure.lastAttempt < 15 * 60 * 1000) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(email) = lower($1) AND password_hash IS NOT NULL AND role = $2',
      [emailLower, 'owner']
    );
    const user = rows[0];

    // Always run bcrypt.compare to prevent timing attacks
    const dummyHash = await bcrypt.hash('dummy', 12);
    const isValid = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, dummyHash);

    if (!isValid) {
      if (failure) {
        failure.count++;
        failure.lastAttempt = now;
      } else {
        loginFailures.set(emailLower, { count: 1, lastAttempt: now });
      }
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // Clear failures on success
    loginFailures.delete(emailLower);

    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const token = issueFullToken(user);
    res.json({
      token,
      role: user.role,
      district_id: user.district_id,
      name: user.name,
    });
  } catch (err) {
    next(err);
  }
}

const forgotPasswordRateLimit = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

const resetPasswordRateLimit = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

// In-memory limit: 3 password-reset emails per hour per email address.
const FORGOT_WINDOW_MS = 60 * 60 * 1000;
const FORGOT_MAX_PER_EMAIL = 3;

const forgotPasswordAttempts = new Map(); // lowercased email -> [timestamps]

function checkForgotPasswordLimit(emailLower) {
  const now = Date.now();
  const entries = (forgotPasswordAttempts.get(emailLower) || []).filter(ts => now - ts < FORGOT_WINDOW_MS);
  if (entries.length >= FORGOT_MAX_PER_EMAIL) {
    forgotPasswordAttempts.set(emailLower, entries);
    return false;
  }
  entries.push(now);
  forgotPasswordAttempts.set(emailLower, entries);
  return true;
}

function cleanForgotPasswordAttempts() {
  const now = Date.now();
  for (const [email, entries] of forgotPasswordAttempts.entries()) {
    const filtered = entries.filter(ts => now - ts < FORGOT_WINDOW_MS);
    if (filtered.length === 0) {
      forgotPasswordAttempts.delete(email);
    } else {
      forgotPasswordAttempts.set(email, filtered);
    }
  }
}

setInterval(cleanForgotPasswordAttempts, 5 * 60 * 1000); // Clean every 5 minutes

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body || {};
    if (typeof email !== 'string' || email.length > 254) {
      return res.status(400).json({ error: 'Email is required and must be at most 254 characters.' });
    }
    const emailLower = email.trim().toLowerCase();

    const allowed = checkForgotPasswordLimit(emailLower);

    // Always the same response, whether or not the account exists (and
    // whether or not the per-email limit was hit). All lookup work happens
    // after responding so timing never leaks which emails exist.
    res.json({ ok: true });

    if (!allowed) return;

    setImmediate(async () => {
      try {
        if (process.env.EMAIL_ENABLED !== 'true') return;

        const { rows } = await pool.query(
          `SELECT id, email FROM users WHERE lower(email) = lower($1) AND role = 'owner' AND password_hash IS NOT NULL`,
          [emailLower]
        );
        const user = rows[0];
        if (!user) return;

        // Invalidate any older, unused reset tokens for this user.
        await pool.query(
          'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
          [user.id]
        );

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '1 hour')`,
          [user.id, tokenHash]
        );

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        await sendDirect({
          to: user.email,
          subject: 'Reset your Stead password',
          heading: 'Reset your Stead password',
          lines: [
            'We received a request to reset the password for your Stead owner account.',
            'This reset link expires in 1 hour. If you did not ask for this email, you can safely ignore it.',
          ],
          ctaLabel: 'Choose a new password',
          ctaUrl: `${frontendUrl}/#/reset-password?token=${token}`,
          businessName: 'Stead',
        });
      } catch (err) {
        // Swallow errors; never log the token, email or password
      }
    });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body || {};

    // Validate the password exactly like signup.
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required.' });
    }
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (passwordBytes < 10 || passwordBytes > 72) {
      return res.status(400).json({ error: 'Password must be between 10 and 72 bytes.' });
    }
    if (typeof token !== 'string' || token.length === 0) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query(
      `SELECT pr.user_id, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
      [tokenHash]
    );
    const reset = rows[0];
    if (!reset) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    if (password === reset.email.toLowerCase()) {
      return res.status(400).json({ error: 'Password cannot be the same as your email.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2',
        [passwordHash, reset.user_id]
      );

      // Mark this token used, and invalidate every other unused token for the user.
      await client.query(
        'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
        [reset.user_id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Clear the failed-login lockout for this email.
    loginFailures.delete(reset.email.toLowerCase());

    setImmediate(async () => {
      try {
        await sendDirect({
          to: reset.email,
          subject: 'Your Stead password was changed',
          heading: 'Your Stead password was changed',
          lines: ['If this wasn\'t you, reset it again straight away.'],
          businessName: 'Stead',
        });
      } catch (err) {
        // Swallow errors; never log the token, email or password
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { validateCode, registerName, refresh, getConfig, signup, loginPassword, signupRateLimit, loginRateLimit, forgotPassword, resetPassword, forgotPasswordRateLimit, resetPasswordRateLimit };
