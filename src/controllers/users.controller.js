// src/controllers/users.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds } = require('../utils/scope');
const { sendVerificationEmail } = require('../services/notify.service');
const { uploadAvatar, deleteImage } = require('../services/cloudinary.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getProfile(req, res, next) {
  try {
    const userId = req.user.user_id;
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, email_notifications, role, district_id, next_of_kin, service_specialty, created_at, avatar_url,
       (email_verified_at IS NOT NULL) AS email_verified,
       CASE WHEN role = 'admin' THEN all_districts ELSE false END AS all_districts,
       CASE WHEN role = 'admin' THEN district_ids ELSE NULL END AS district_ids
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

    let emailChanged = false;
    if (email !== undefined) {
      if (currentUser.role === 'owner') {
        return res.status(400).json({ error: 'Your login email can\'t be changed here.' });
      }
      const trimmed = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (trimmed === '') {
        emailChanged = currentUser.email !== null;
        updates.push(`email = $${paramCount++}`);
        values.push(null);
      } else {
        if (!EMAIL_REGEX.test(trimmed)) {
          return res.status(400).json({ error: 'Invalid email format.' });
        }
        if (trimmed.length > 254) {
          return res.status(400).json({ error: 'Email must be at most 254 characters.' });
        }
        emailChanged = currentUser.email !== trimmed;
        updates.push(`email = $${paramCount++}`);
        values.push(trimmed);
      }
      if (emailChanged) {
        updates.push('email_verified_at = NULL');
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

    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      email_notifications: user.email_notifications,
      role: user.role,
      district_id: user.district_id,
      next_of_kin: user.next_of_kin,
      service_specialty: user.service_specialty,
      avatar_url: user.avatar_url,
    });

    if (emailChanged) {
      setImmediate(() => sendVerificationEmail(user.id).catch(() => {}));
    }
  } catch (err) {
    next(err);
  }
}

// Tenants and service providers only. Replaces the photo and deletes the old one from Cloudinary.
async function setAvatar(req, res, next) {
  try {
    const userId = req.user.user_id;
    if (!['tenant', 'service_provider'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Profile photos are for tenants and service providers.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a photo to upload.' });

    const current = await pool.query('SELECT avatar_public_id FROM users WHERE id = $1', [userId]);
    if (!current.rows[0]) return res.status(404).json({ error: 'User not found' });
    const oldPublicId = current.rows[0].avatar_public_id;

    const uploaded = await uploadAvatar(req.file.buffer, `stead/avatars/org-${req.user.organization_id}`);

    let updated;
    try {
      updated = await pool.query(
        `UPDATE users SET avatar_url = $1, avatar_public_id = $2, avatar_updated_at = now()
         WHERE id = $3 RETURNING avatar_url`,
        [uploaded.url, uploaded.public_id, userId]
      );
    } catch (err) {
      await deleteImage(uploaded.public_id);
      throw err;
    }

    if (oldPublicId) await deleteImage(oldPublicId);

    await writeAudit({
      actorId: userId,
      actorRole: req.user.role,
      districtId: req.user.district_id,
      action: 'user.update_avatar',
      entityType: 'user',
      entityId: userId,
      metadata: {},
    });

    res.json({ avatar_url: updated.rows[0].avatar_url });
  } catch (err) {
    next(err);
  }
}

// Needed by admin/maintenance.page.js for the provider list in the assign
// dropdown. Deliberately narrow: service providers only, and only the fields
// that dropdown needs. Never expose code_id / code or any other user data.
const LISTABLE_ROLES = ['service_provider', 'tenant'];

async function listUsers(req, res, next) {
  try {
    const { role, district_id: districtFilter } = req.query;

    if (!LISTABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: "role must be 'service_provider' or 'tenant'." });
    }

    const clauses = ['u.role = $1', 'u.organization_id = $2'];
    const values = [role, req.user.organization_id];
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
    } else if (req.user.role === 'admin') {
      const dids = await allowedDistrictIds(req);
      if (dids.length > 0) {
        clauses.push(`u.district_id = ANY($${i++}::int[])`);
        values.push(dids);
      }
    } else if (req.user.role !== 'owner' && req.user.district_id) {
      clauses.push(`u.district_id = $${i++}`);
      values.push(req.user.district_id);
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.phone, u.district_id, d.name AS district_name, u.avatar_url
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

module.exports = { getProfile, updateProfile, listUsers, setAvatar };