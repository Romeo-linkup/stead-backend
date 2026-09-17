// src/middleware/auth.js
// Verifies the JWT on the Authorization header and attaches req.user.
// Also re-checks that the underlying code is still active, so that
// revoking a code (codes.routes.js) signs everyone out on their very
// next request, per the blueprint's Section 5 spec — a JWT alone can't
// reflect that, so this does one lightweight DB lookup per request.
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  if (payload.type !== 'full') {
    return res.status(401).json({ error: 'This token cannot be used to authenticate requests.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.role, u.district_id, c.active AS code_active
       FROM users u
       JOIN codes c ON c.id = u.code_id
       WHERE u.id = $1`,
      [payload.user_id]
    );

    const row = rows[0];
    if (!row || !row.code_active) {
      return res.status(401).json({ error: 'Your access code has been revoked.' });
    }

    req.user = {
      user_id: row.id,
      role: row.role,
      district_id: row.district_id,
    };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = auth;
