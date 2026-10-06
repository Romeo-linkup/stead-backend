// src/controllers/codes.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { generateCode } = require('../utils/generateCode');
const { validateRole } = require('../utils/validators');

const OWNER_ONLY_ROLES = ['owner'];
const CREATOR_ROLES = {
  owner: ['admin', 'property_manager', 'service_provider', 'tenant'],
  admin: ['service_provider', 'tenant'],
  property_manager: ['service_provider', 'tenant'],
};

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function createCode(req, res, next) {
  try {
    const { role, district_id, unit_id } = req.body;
    const roleErr = validateRole(role);
    if (roleErr) return res.status(400).json({ error: roleErr });

    if (role === 'owner') {
      return res.status(400).json({ error: "Cannot create a code for role 'owner'." });
    }

    const allowed = CREATOR_ROLES[req.user.role];
    if (!allowed || !allowed.includes(role)) {
      return res.status(403).json({ error: 'You do not have permission to create that role.' });
    }

    let targetDistrictId;
    if (req.user.role === 'owner') {
      targetDistrictId = parseId(district_id);
      if (!targetDistrictId) {
        return res.status(400).json({ error: 'district_id is required.' });
      }
    } else {
      targetDistrictId = Number(req.user.district_id);
    }

    // tenant codes require a unit; non-tenant roles must not send one
    let targetUnitId = null;
    if (role === 'tenant') {
      targetUnitId = parseId(unit_id);
      if (!targetUnitId) {
        return res.status(400).json({ error: 'unit_id is required for tenant codes.' });
      }
    } else if (unit_id !== undefined && unit_id !== null && unit_id !== '') {
      return res.status(400).json({ error: 'unit_id must not be sent for non-tenant roles.' });
    }

    // the district must belong to the caller's organisation
    const districtResult = await pool.query(
      'SELECT id, name FROM districts WHERE id = $1 AND organization_id = $2',
      [targetDistrictId, req.user.organization_id]
    );
    const district = districtResult.rows[0];
    if (!district) {
      return res.status(404).json({ error: 'District not found.' });
    }

    let unit = null;
    if (targetUnitId !== null) {
      const unitResult = await pool.query(
        `SELECT u.id, u.unit_number, p.name AS property_name
         FROM units u
         JOIN properties p ON p.id = u.property_id
         WHERE u.id = $1 AND p.district_id = $2`,
        [targetUnitId, targetDistrictId]
      );
      unit = unitResult.rows[0];
      if (!unit) {
        return res.status(404).json({ error: 'Unit not found.' });
      }

      const existing = await pool.query(
        `SELECT 1 FROM codes
         WHERE unit_id = $1 AND active = true AND role = 'tenant'
         LIMIT 1`,
        [targetUnitId]
      );
      if (existing.rows[0]) {
        return res.status(409).json({ error: 'This unit already has an active tenant code.' });
      }
    }

    let code, inserted;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateCode(district.name, role);
      try {
        const result = await pool.query(
          `INSERT INTO codes (code, role, district_id, organization_id, created_by, unit_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [code, role, targetDistrictId, req.user.organization_id, req.user.user_id, targetUnitId]
        );
        inserted = result.rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err; // 23505 = unique_violation, retry
      }
    }
    if (!inserted) return res.status(500).json({ error: 'Could not generate a unique code, try again.' });

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: targetDistrictId,
      organizationId: req.user.organization_id,
      action: 'code.create',
      entityType: 'code',
      entityId: inserted.id,
      metadata: { role },
    });

    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
}

async function listCodes(req, res, next) {
  try {
    if (req.user.role === 'owner') {
      const { rows } = await pool.query(
        `SELECT c.*, u.unit_number, p.name AS property_name
         FROM codes c
         LEFT JOIN units u ON u.id = c.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
         WHERE c.organization_id = $1
         ORDER BY c.created_at DESC`,
        [req.user.organization_id]
      );
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT c.*, u.unit_number, p.name AS property_name
       FROM codes c
       LEFT JOIN units u ON u.id = c.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE c.district_id = $1 AND c.organization_id = $2
         AND c.role IN ('tenant', 'service_provider')
       ORDER BY c.created_at DESC`,
      [req.user.district_id, req.user.organization_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function revokeCode(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM codes WHERE id = $1', [id]);
    const code = rows[0];
    if (!code) return res.status(404).json({ error: 'Code not found.' });

    if (code.organization_id !== req.user.organization_id) {
      return res.status(403).json({ error: 'You do not have access to that code.' });
    }

    // Get user's code_id
    const userResult = await pool.query('SELECT code_id FROM users WHERE id = $1', [req.user.user_id]);
    const userCodeId = userResult.rows[0]?.code_id;

    // Prevent revoking the code you're signed in with
    if (userCodeId === Number(id)) {
      return res.status(409).json({ error: "You can't revoke the code you are signed in with." });
    }

    if (req.user.role !== 'owner') {
      const allowed = ['tenant', 'service_provider'].includes(code.role)
        && code.district_id === req.user.district_id;
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have access to that code.' });
      }
    }

    await pool.query('UPDATE codes SET active = false WHERE id = $1', [id]);

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: code.district_id,
      organizationId: req.user.organization_id,
      action: 'code.revoke',
      entityType: 'code',
      entityId: code.id,
      metadata: { role: code.role },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { createCode, listCodes, revokeCode };
