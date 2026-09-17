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
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { validateName, validatePhone } = require('../utils/validators');

const FULL_TOKEN_EXPIRY = '90d';
const PRE_TOKEN_EXPIRY = '10m';

function issueFullToken(user) {
  return jwt.sign(
    { type: 'full', user_id: user.id, role: user.role, district_id: user.district_id },
    process.env.JWT_SECRET,
    { expiresIn: FULL_TOKEN_EXPIRY }
  );
}

function issuePreToken(code) {
  return jwt.sign(
    { type: 'pre', code_id: code.id, role: code.role, district_id: code.district_id },
    process.env.JWT_SECRET,
    { expiresIn: PRE_TOKEN_EXPIRY }
  );
}

async function validateCode(req, res, next) {
  try {
    const raw = (req.body.code || '').trim().toUpperCase();
    if (!raw) return res.status(400).json({ error: 'Code is required.' });

    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.role, c.district_id, c.active, d.name AS district_name
       FROM codes c
       LEFT JOIN districts d ON d.id = c.district_id
       WHERE c.code = $1`,
      [raw]
    );
    const code = rows[0];

    if (!code || !code.active) {
      return res.status(401).json({ error: 'That code is invalid or has been deactivated.' });
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
        `INSERT INTO users (name, phone, role, district_id, code_id, last_login_at)
         VALUES ($1, $2, $3, $4, $5, now())
         RETURNING *`,
        [name.trim(), phone || null, payload.role, payload.district_id, payload.code_id]
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
      `SELECT u.id, u.role, u.district_id, c.active AS code_active
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

module.exports = { validateCode, registerName, refresh };
