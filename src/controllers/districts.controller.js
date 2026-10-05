// src/controllers/districts.controller.js
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { validateDistrictName } = require('../utils/validators');
const { allowedDistrictIds, orgId } = require('../utils/scope');

async function listDistricts(req, res, next) {
  try {
    const districtIds = await allowedDistrictIds(req);
    const { rows } = await pool.query(
      `SELECT districts.*,
              COUNT(DISTINCT properties.id) AS property_count,
              COUNT(DISTINCT units.id) AS unit_count
       FROM districts
       LEFT JOIN properties ON properties.district_id = districts.id
       LEFT JOIN units ON units.property_id = properties.id
       WHERE districts.id = ANY($1::int[])
       GROUP BY districts.id
       ORDER BY districts.name`,
      [districtIds]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createDistrict(req, res, next) {
  try {
    const { name } = req.body;
    const nameErr = validateDistrictName(name);
    if (nameErr) return res.status(400).json({ error: nameErr });

    const organizationId = orgId(req);

    const { rows } = await pool.query(
      'INSERT INTO districts (name, organization_id) VALUES ($1, $2) RETURNING *',
      [name.trim(), organizationId]
    );
    const district = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: district.id,
      organizationId,
      action: 'district.create',
      entityType: 'district',
      entityId: district.id,
      metadata: { name: district.name },
    });

    res.status(201).json(district);
  } catch (err) {
    next(err);
  }
}

async function deleteDistrict(req, res, next) {
  try {
    const districtId = parseInt(req.params.id, 10);
    if (isNaN(districtId)) {
      return res.status(400).json({ error: 'Invalid district ID' });
    }

    // Check district belongs to org
    const { rows: districtRows } = await pool.query(
      'SELECT * FROM districts WHERE id = $1',
      [districtId]
    );
    if (!districtRows.length) {
      return res.status(404).json({ error: 'District not found' });
    }
    const district = districtRows[0];

    if (district.organization_id !== req.user.organization_id) {
      return res.status(404).json({ error: 'District not found' });
    }

    // Check for dependencies before deleting
    const [properties, codes, users] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM properties WHERE district_id = $1', [districtId]),
      pool.query('SELECT COUNT(*) FROM codes WHERE district_id = $1', [districtId]),
      pool.query('SELECT COUNT(*) FROM users WHERE district_id = $1', [districtId]),
    ]);

    const propertyCount = parseInt(properties.rows[0].count, 10);
    const codeCount = parseInt(codes.rows[0].count, 10);
    const userCount = parseInt(users.rows[0].count, 10);

    if (propertyCount > 0 || codeCount > 0 || userCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete a district that still has properties, codes, or people assigned to it. Reassign or remove them first.'
      });
    }

    // Delete the district
    await pool.query('DELETE FROM districts WHERE id = $1', [districtId]);

    // Write audit log
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: district.id,
      organizationId: district.organization_id,
      action: 'district.delete',
      entityType: 'district',
      entityId: district.id,
      metadata: { name: district.name },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { listDistricts, createDistrict, deleteDistrict };
