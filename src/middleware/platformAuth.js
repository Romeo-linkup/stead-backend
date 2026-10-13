// src/middleware/platformAuth.js
// Verifies platform admin JWT token
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function platformAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.PLATFORM_JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  if (payload.typ !== 'platform') {
    return res.status(401).json({ error: 'This token cannot be used for platform authentication.' });
  }

  // IP restriction if configured
  if (process.env.PLATFORM_ALLOWED_IPS) {
    const allowedIps = process.env.PLATFORM_ALLOWED_IPS.split(',').map(ip => ip.trim());
    if (!allowedIps.includes(req.ip)) {
      return res.status(403).json({ error: 'Access denied from this IP.' });
    }
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email FROM platform_admins WHERE id = $1',
      [payload.admin_id]
    );

    const row = rows[0];
    if (!row) {
      return res.status(401).json({ error: 'Platform admin not found.' });
    }

    req.platformAdmin = { id: row.id, email: row.email };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = platformAuth;
