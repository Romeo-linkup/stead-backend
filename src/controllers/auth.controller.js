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
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { validateName, validatePhone } = require('../utils/validators');

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

    const { name, phone } = req.body;
    const nameErr = validateName(name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    const phoneErr = validatePhone(phone);
    if (phoneErr) return res.status(400).json({ error: phoneErr });

    // Guard against a double-submit registering the same code twice.
    const existing = await pool.query('SELECT * FROM users WHERE code_id = $1', [payload.code_id]);
    let user;
    if (existing.rows[0]) {
      user = existing.rows[0];
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    } else {
      const inserted = await pool.query(
        `INSERT INTO users (name, phone, role, district_id, code_id, organization_id, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING *`,
        [name.trim(), phone || null, payload.role, payload.district_id, payload.code_id, payload.organization_id]
      );
      user = inserted.rows[0];

      await writeAudit({
        actorId: user.id,
        actorRole: user.role,
        districtId: user.district_id,
        action: 'user.register',
        entityType: 'user',
        entityId: user.id,
        metadata: { via_code_id: payload.code_id },
      });
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
    res.json({ signup_open: process.env.SIGNUP_ENABLED === 'true' });
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

module.exports = { validateCode, registerName, refresh, getConfig, signup, loginPassword, signupRateLimit, loginRateLimit };
