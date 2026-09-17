// src/controllers/users.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function getProfile(req, res, next) {
  try {
    const userId = req.user.user_id;
    const { rows } = await pool.query(
      `SELECT id, name, phone, role, district_id, next_of_kin, service_specialty, created_at
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
    const { name, phone, next_of_kin, service_specialty } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

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

// NEW: needed by admin/tenants.page.js (tenant names) and
// admin/maintenance.page.js (provider list for assignment).
async function listUsers(req, res, next) {
  try {
    const { role } = req.query;
    const clauses = [];
    const values = [];
    let i = 1;

    if (req.user.role !== 'owner') {
      clauses.push(`district_id = $${i++}`);
      values.push(req.user.district_id);
    }
    if (role) {
      clauses.push(`role = $${i++}`);
      values.push(role);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT id, name, phone, role, district_id, service_specialty
       FROM users ${where} ORDER BY name ASC`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, listUsers };