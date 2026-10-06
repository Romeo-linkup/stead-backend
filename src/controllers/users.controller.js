// src/controllers/users.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds } = require('../utils/scope');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getProfile(req, res, next) {
  try {
    const userId = req.user.user_id;
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, email_notifications, role, district_id, next_of_kin, service_specialty, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const userId = req.user.user_id;
    const { name, phone, next_of_kin, service_specialty, email, email_notifications } = req.body;

    const current = await pool.query('SELECT role, email FROM users WHERE id = $1', [userId]);
    const currentUser = current.rows[0];
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (email !== undefined) {
      if (currentUser.role === 'owner') {
        return res.status(400).json({ error: 'Your login email can\'t be changed here.' });
      }
      const trimmed = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (trimmed === '') {
        updates.push(`email = $${paramCount++}`);
        values.push(null);
      } else {
        if (!EMAIL_REGEX.test(trimmed)) {
          return res.status(400).json({ error: 'Invalid email format.' });
        }
        if (trimmed.length > 254) {
          return res.status(400).json({ error: 'Email must be at most 254 characters.' });
        }
        updates.push(`email = $${paramCount++}`);
        values.push(trimmed);
      }
    }

    if (email_notifications !== undefined) {
      if (typeof email_notifications !== 'boolean') {
        return res.status(400).json({ error: 'email_notifications must be a boolean.' });
      }
      updates.push(`email_notifications = $${paramCount++}`);
      values.push(email_notifications);
    }

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      values.push(phone);
    }
    if (next_of_kin !== undefined) {
      updates.push(`next_of_kin = $${paramCount++}`);
      values.push(next_of_kin);
    }
    if (service_specialty !== undefined) {
      updates.push(`service_specialty = $${paramCount++}`);
      values.push(service_specialty);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(userId);

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const user = rows[0];

    await writeAudit({
      actorId: user.id,
      actorRole: user.role,
      districtId: user.district_id,
      action: 'user.update_profile',
      entityType: 'user',
      entityId: user.id,
      metadata: { updated_fields: updates },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
}

// Needed by admin/maintenance.page.js for the provider list in the assign
// dropdown. Deliberately narrow: service providers only, and only the fields
// that dropdown needs. Never expose code_id / code or any other user data.
async function listUsers(req, res, next) {
  try {
    const { role, district_id: districtFilter } = req.query;

    if (role !== 'service_provider') {
      return res.status(400).json({ error: "role must be 'service_provider'." });
    }

    const clauses = ['u.role = $1', 'u.organization_id = $2'];
    const values = ['service_provider', req.user.organization_id];
    let i = 3;

    // district_id is an owner-only convenience filter. For everyone else the
    // scope comes from the session, so a district admin cannot read another
    // district's providers by passing a different id.
    const ownerFilter =
      req.user.role === 'owner' && districtFilter !== undefined && districtFilter !== ''
        ? Number(districtFilter)
        : null;

    if (ownerFilter !== null) {
      if (!Number.isInteger(ownerFilter) || ownerFilter < 1) {
        return res.status(400).json({ error: 'district_id must be a valid district ID.' });
      }
      clauses.push(`u.district_id = $${i++}`);
      values.push(ownerFilter);
    } else if (req.user.role !== 'owner' && req.user.district_id) {
      clauses.push(`u.district_id = $${i++}`);
      values.push(req.user.district_id);
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.phone, u.district_id, d.name AS district_name
       FROM users u
       LEFT JOIN districts d ON d.id = u.district_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY u.name ASC`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, listUsers };