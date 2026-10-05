// src/controllers/codes.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { generateCode } = require('../utils/generateCode');
const { validateRole } = require('../utils/validators');

const DISTRICT_LESS_ROLES = ['owner']; // owner code isn't tied to one district

async function createCode(req, res, next) {
  try {
    const { role, district_id } = req.body;
    const roleErr = validateRole(role);
    if (roleErr) return res.status(400).json({ error: roleErr });

    const needsDistrict = !DISTRICT_LESS_ROLES.includes(role);
    if (needsDistrict && !district_id) {
      return res.status(400).json({ error: 'district_id is required for this role.' });
    }

    // Non-owner admins can only issue codes scoped to their own district.
    if (req.user.role !== 'owner' && needsDistrict && Number(district_id) !== req.user.district_id) {
      return res.status(403).json({ error: 'You can only issue codes for your own district.' });
    }

    let districtName = null;
    if (needsDistrict) {
      const d = await pool.query('SELECT name, organization_id FROM districts WHERE id = $1', [district_id]);
      if (!d.rows[0]) return res.status(404).json({ error: 'District not found.' });
      if (d.rows[0].organization_id !== req.user.organization_id) {
        return res.status(404).json({ error: 'District not found.' });
      }
      districtName = d.rows[0].name;
    }

    // Regenerate on the rare collision instead of failing the request.
    let code, inserted;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateCode(districtName, role);
      try {
        const result = await pool.query(
          `INSERT INTO codes (code, role, district_id, organization_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [code, role, needsDistrict ? district_id : null, req.user.organization_id, req.user.user_id]
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
      districtId: needsDistrict ? Number(district_id) : null,
      organizationId: req.user.organization_id,
      action: 'code.create',
      entityType: 'code',
      entityId: inserted.id,
      metadata: { role, code: inserted.code },
    });

    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
}

async function listCodes(req, res, next) {
  try {
    if (req.user.role === 'owner') {
      const { rows } = await pool.query('SELECT * FROM codes WHERE organization_id = $1 ORDER BY created_at DESC', [req.user.organization_id]);
      return res.json(rows);
    }
    const { rows } = await pool.query(
      'SELECT * FROM codes WHERE district_id = $1 AND organization_id = $2 ORDER BY created_at DESC',
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

    // Get user's code_id
    const userResult = await pool.query('SELECT code_id FROM users WHERE id = $1', [req.user.user_id]);
    const userCodeId = userResult.rows[0]?.code_id;

    // Prevent revoking the code you're signed in with
    if (userCodeId === Number(id)) {
      return res.status(409).json({ error: "You can't revoke the code you are signed in with." });
    }

    if (req.user.role !== 'owner' && code.district_id !== req.user.district_id) {
      return res.status(403).json({ error: 'You do not have access to that code.' });
    }

    if (code.organization_id !== req.user.organization_id) {
      return res.status(403).json({ error: 'You do not have access to that code.' });
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
      metadata: { code: code.code },
    });

    // Everyone using this code is signed out on their next request —
    // see the code_active check in middleware/auth.js.
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { createCode, listCodes, revokeCode };
