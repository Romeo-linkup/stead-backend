// src/controllers/codes.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { generateCode } = require('../utils/generateCode');
const { validateRole } = require('../utils/validators');
const { allowedDistrictIds, resolveTargetDistrict, canActOrgWide } = require('../utils/scope');

const OWNER_ONLY_ROLES = ['owner'];
const CREATOR_ROLES = {
  owner: ['admin', 'property_manager', 'service_provider', 'tenant'],
  admin: ['admin', 'service_provider', 'tenant'],
  property_manager: ['service_provider', 'tenant'],
};

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function createCode(req, res, next) {
  const client = await pool.connect();
  try {
    const { role, district_id, unit_id, districts, all_districts } = req.body;
    const roleErr = validateRole(role);
    if (roleErr) return res.status(400).json({ error: roleErr });

    if (role === 'owner') {
      return res.status(400).json({ error: "Cannot create a code for role 'owner'." });
    }

    const allowed = CREATOR_ROLES[req.user.role];
    if (!allowed || !allowed.includes(role)) {
      return res.status(403).json({ error: 'You do not have permission to create that role.' });
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

    let targetDistrictId;
    let targetAllDistricts = false;
    let targetDistrictIds = [];

    if (role === 'admin') {
      // Only owner or admin can create admin codes (enforced by CREATOR_ROLES and requireRole)
      if (all_districts === true) {
        if (!canActOrgWide(req)) {
          return res.status(403).json({ error: 'You can only grant districts you have access to yourself.' });
        }
        targetAllDistricts = true;
        const allowedIds = await allowedDistrictIds(req);
        if (allowedIds.length === 0) {
          return res.status(400).json({ error: 'No districts available in your organisation.' });
        }
        targetDistrictId = Math.min(...allowedIds); // smallest allowed id
        targetDistrictIds = allowedIds;
      } else {
        if (!districts || !Array.isArray(districts) || districts.length === 0) {
          return res.status(400).json({ error: 'districts must be a non-empty array.' });
        }
        if (districts.length > 50) {
          return res.status(400).json({ error: 'districts array exceeds maximum of 50.' });
        }
        const uniqueDistricts = [...new Set(districts.map(Number).filter(n => Number.isInteger(n) && n > 0))];
        if (uniqueDistricts.length !== districts.length) {
          return res.status(400).json({ error: 'districts must contain unique positive integers.' });
        }
        const allowedIds = await allowedDistrictIds(req);
        for (const d of uniqueDistricts) {
          if (!allowedIds.includes(d)) {
            return res.status(404).json({ error: 'Not found.' });
          }
        }
        targetDistrictIds = uniqueDistricts;
        targetDistrictId = Math.min(...targetDistrictIds);
      }
    } else if (req.user.role === 'owner' || req.user.role === 'admin') {
      targetDistrictId = await resolveTargetDistrict(req, district_id);
    } else {
      // property_manager: forced to their own district_id
      targetDistrictId = Number(req.user.district_id);
    }

    // the district must belong to the caller's organisation
    const districtResult = await client.query(
      'SELECT id, name FROM districts WHERE id = $1 AND organization_id = $2',
      [targetDistrictId, req.user.organization_id]
    );
    const district = districtResult.rows[0];
    if (!district) {
      return res.status(404).json({ error: 'District not found.' });
    }

    let unit = null;
    if (targetUnitId !== null) {
      const unitResult = await client.query(
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

      const existing = await client.query(
        `SELECT 1 FROM codes
         WHERE unit_id = $1 AND active = true AND role = 'tenant'
         LIMIT 1`,
        [targetUnitId]
      );
      if (existing.rows[0]) {
        return res.status(409).json({ error: 'This unit already has an active tenant code.' });
      }
    }

    await client.query('BEGIN');
    try {
      let code, inserted;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        code = generateCode(district.name, role);
        try {
          const result = await client.query(
            `INSERT INTO codes (code, role, district_id, organization_id, created_by, unit_id, all_districts)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [code, role, targetDistrictId, req.user.organization_id, req.user.user_id, targetUnitId, targetAllDistricts]
          );
          inserted = result.rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err;
          if (err.constraint === 'codes_one_active_tenant_per_unit') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This unit already has an active tenant code.' });
          }
          if (err.constraint !== 'codes_code_key') throw err;
        }
      }
      if (!inserted) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'Could not generate a unique code, try again.' });
      }

      // Insert code_districts rows if not all_districts and role is admin
      if (role === 'admin' && !targetAllDistricts && targetDistrictIds.length > 0) {
        const values = targetDistrictIds.map((d, idx) => `($1, $${idx + 2})`).join(', ');
        const params = [inserted.id, ...targetDistrictIds];
        await client.query(
          `INSERT INTO code_districts (code_id, district_id) VALUES ${values}`,
          params
        );
      }

      await client.query('COMMIT');

      const response = { ...inserted };
      if (role === 'admin') {
        response.all_districts = targetAllDistricts;
        response.district_ids = targetAllDistricts ? targetDistrictIds : targetDistrictIds;
      }

      await writeAudit({
        actorId: req.user.user_id,
        actorRole: req.user.role,
        districtId: targetDistrictId,
        organizationId: req.user.organization_id,
        action: 'code.create',
        entityType: 'code',
        entityId: inserted.id,
        metadata: role === 'admin' ? { role, districts: targetDistrictIds.length, all_districts: targetAllDistricts } : { role },
      });

      res.status(201).json(response);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    next(err);
  } finally {
    client.release();
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

    if (req.user.role === 'admin') {
      const allowed = await allowedDistrictIds(req);
      const { rows } = await pool.query(
        `SELECT c.*, u.unit_number, p.name AS property_name,
                CASE WHEN c.role = 'admin' THEN c.all_districts ELSE false END AS all_districts,
                CASE WHEN c.role = 'admin' THEN (
                  SELECT COALESCE(array_agg(d.name ORDER BY d.name), '{}')
                  FROM code_districts cd
                  JOIN districts d ON d.id = cd.district_id
                  WHERE cd.code_id = c.id
                ) ELSE '{}'::text[] END AS district_names,
                CASE WHEN c.role = 'admin' THEN (
                  SELECT COUNT(*) FROM code_districts cd WHERE cd.code_id = c.id
                ) ELSE 0 END AS district_count
         FROM codes c
         LEFT JOIN units u ON u.id = c.unit_id
         LEFT JOIN properties p ON p.id = u.property_id
         WHERE c.organization_id = $1
           AND ((c.role IN ('tenant','service_provider') AND c.district_id = ANY($2::int[]))
                OR (c.role = 'admin' AND c.created_by = $3))
         ORDER BY c.created_at DESC`,
        [req.user.organization_id, allowed, req.user.user_id]
      );
      return res.json(rows);
    }

    // property_manager
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
      return res.status(404).json({ error: 'Code not found.' });
    }

    // Get user's code_id
    const userResult = await pool.query('SELECT code_id FROM users WHERE id = $1', [req.user.user_id]);
    const userCodeId = userResult.rows[0]?.code_id;

    // Prevent revoking the code you're signed in with
    if (userCodeId === Number(id)) {
      return res.status(409).json({ error: "You can't revoke the code you are signed in with." });
    }

    let allowed = false;
    if (req.user.role === 'owner') {
      allowed = true;
    } else if (req.user.role === 'admin') {
      const allowedDistrictIdsArr = await allowedDistrictIds(req);
      if (['tenant', 'service_provider'].includes(code.role) && allowedDistrictIdsArr.includes(code.district_id)) {
        allowed = true;
      } else if (code.role === 'admin' && code.created_by === req.user.user_id) {
        allowed = true;
      }
    } else if (req.user.role === 'property_manager') {
      allowed = ['tenant', 'service_provider'].includes(code.role) && code.district_id === req.user.district_id;
    }

    if (!allowed) {
      return res.status(404).json({ error: 'Code not found.' });
    }

    await pool.query('UPDATE codes SET active = false WHERE id = $1', [id]);

    let metadata = { role: code.role };
    if (code.role === 'admin') {
      const { rows: cdRows } = await pool.query('SELECT district_id FROM code_districts WHERE code_id = $1', [code.id]);
      metadata = { role: code.role, districts: cdRows.length, all_districts: code.all_districts };
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: code.district_id,
      organizationId: req.user.organization_id,
      action: 'code.revoke',
      entityType: 'code',
      entityId: code.id,
      metadata,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function updateCodeDistricts(req, res, next) {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { districts, all_districts } = req.body;

    const { rows } = await pool.query('SELECT * FROM codes WHERE id = $1', [id]);
    const code = rows[0];
    if (!code) return res.status(404).json({ error: 'Code not found.' });

    if (code.organization_id !== req.user.organization_id) {
      return res.status(404).json({ error: 'Code not found.' });
    }

    if (code.role !== 'admin') {
      return res.status(400).json({ error: 'Only admin codes can have their districts updated.' });
    }

    // Owner can edit any admin code in the org; admin can only edit their own
    if (req.user.role === 'admin' && code.created_by !== req.user.user_id) {
      return res.status(404).json({ error: 'Code not found.' });
    }

    let targetAllDistricts = false;
    let targetDistrictIds = [];
    let targetDistrictId;

    if (all_districts === true) {
      if (!canActOrgWide(req)) {
        return res.status(403).json({ error: 'You can only grant districts you have access to yourself.' });
      }
      targetAllDistricts = true;
      const allowedIds = await allowedDistrictIds(req);
      if (allowedIds.length === 0) {
        return res.status(400).json({ error: 'No districts available in your organisation.' });
      }
      targetDistrictId = Math.min(...allowedIds);
      targetDistrictIds = allowedIds;
    } else {
      if (!districts || !Array.isArray(districts) || districts.length === 0) {
        return res.status(400).json({ error: 'districts must be a non-empty array.' });
      }
      if (districts.length > 50) {
        return res.status(400).json({ error: 'districts array exceeds maximum of 50.' });
      }
      const uniqueDistricts = [...new Set(districts.map(Number).filter(n => Number.isInteger(n) && n > 0))];
      if (uniqueDistricts.length !== districts.length) {
        return res.status(400).json({ error: 'districts must contain unique positive integers.' });
      }
      const allowedIds = await allowedDistrictIds(req);
      for (const d of uniqueDistricts) {
        if (!allowedIds.includes(d)) {
          return res.status(404).json({ error: 'Not found.' });
        }
      }
      targetDistrictIds = uniqueDistricts;
      targetDistrictId = Math.min(...targetDistrictIds);
    }

    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE codes SET district_id = $1, all_districts = $2 WHERE id = $3`,
        [targetDistrictId, targetAllDistricts, id]
      );

      await client.query('DELETE FROM code_districts WHERE code_id = $1', [id]);

      if (!targetAllDistricts && targetDistrictIds.length > 0) {
        const values = targetDistrictIds.map((d, idx) => `($1, $${idx + 2})`).join(', ');
        const params = [id, ...targetDistrictIds];
        await client.query(
          `INSERT INTO code_districts (code_id, district_id) VALUES ${values}`,
          params
        );
      }

      await client.query('COMMIT');

      await writeAudit({
        actorId: req.user.user_id,
        actorRole: req.user.role,
        districtId: targetDistrictId,
        organizationId: req.user.organization_id,
        action: 'code.update_districts',
        entityType: 'code',
        entityId: Number(id),
        metadata: { code_id: Number(id), districts: targetDistrictIds.length, all_districts: targetAllDistricts },
      });

      const { rows: updated } = await pool.query(
        `SELECT c.*, 
                CASE WHEN c.role = 'admin' THEN c.all_districts ELSE false END AS all_districts,
                CASE WHEN c.role = 'admin' THEN (
                  SELECT COALESCE(array_agg(d.name ORDER BY d.name), '{}')
                  FROM code_districts cd
                  JOIN districts d ON d.id = cd.district_id
                  WHERE cd.code_id = c.id
                ) ELSE '{}'::text[] END AS district_names,
                CASE WHEN c.role = 'admin' THEN (
                  SELECT COUNT(*) FROM code_districts cd WHERE cd.code_id = c.id
                ) ELSE 0 END AS district_count
         FROM codes c WHERE c.id = $1`,
        [id]
      );
      res.json(updated[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
}

module.exports = { createCode, listCodes, revokeCode, updateCodeDistricts };
