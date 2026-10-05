const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

const MANAGEMENT_ROLES = ['owner', 'admin', 'property_manager'];

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function listProperties(req, res, next) {
  try {
    const districtIds = await allowedDistrictIds(req);
    const { rows } = await pool.query(
      `SELECT p.*, d.name AS district_name,
              COUNT(DISTINCT u.id) AS unit_count,
              pcs.score_percent AS current_score, pcs.created_at AS score_created_at
       FROM properties p
       JOIN districts d ON d.id = p.district_id
       LEFT JOIN units u ON u.property_id = p.id
       LEFT JOIN property_current_score pcs ON pcs.property_id = p.id
       WHERE p.district_id = ANY($1::int[])
       GROUP BY p.id, d.id, pcs.score_percent, pcs.created_at
       ORDER BY p.created_at DESC`,
      [districtIds]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createProperty(req, res, next) {
  try {
    const { name, address } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      return res.status(400).json({ error: 'Property name is required.' });
    }
    if (trimmedName.length > 100) {
      return res.status(400).json({ error: 'Property name must be 100 characters or fewer.' });
    }
    const trimmedAddress = typeof address === 'string' ? address.trim() : '';
    if (trimmedAddress.length > 200) {
      return res.status(400).json({ error: 'Property address must be 200 characters or fewer.' });
    }

    let targetDistrictId;
    if (req.user.role === 'owner') {
      targetDistrictId = parseId(req.body.district_id);
      if (!targetDistrictId) {
        return res.status(400).json({ error: 'district_id is required.' });
      }
    } else {
      targetDistrictId = Number(req.user.district_id);
    }

    await assertDistrictAccess(req, targetDistrictId);

    const { rows } = await pool.query(
      `INSERT INTO properties (district_id, name, address)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [targetDistrictId, trimmedName, trimmedAddress || null]
    );
    const property = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'property.create',
      entityType: 'property',
      entityId: property.id,
      metadata: { name: property.name },
    });

    res.status(201).json(property);
  } catch (err) {
    next(err);
  }
}

async function updateProperty(req, res, next) {
  try {
    const propertyId = parseId(req.params.id);
    if (!propertyId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const { name, address } = req.body;
    const trimmedName = typeof name === 'string' ? name.trim() : undefined;
    if (trimmedName !== undefined && !trimmedName) {
      return res.status(400).json({ error: 'Property name cannot be empty.' });
    }
    if (trimmedName !== undefined && trimmedName.length > 100) {
      return res.status(400).json({ error: 'Property name must be 100 characters or fewer.' });
    }
    const trimmedAddress = typeof address === 'string' ? address.trim() : undefined;
    if (trimmedAddress !== undefined && trimmedAddress.length > 200) {
      return res.status(400).json({ error: 'Property address must be 200 characters or fewer.' });
    }

    const lookup = await pool.query(
      `SELECT p.*, d.name AS district_name, d.district_id AS district_id
       FROM properties p
       JOIN districts d ON d.id = p.district_id
       WHERE p.id = $1`,
      [propertyId]
    );
    const property = lookup.rows[0];
    if (!property) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    await assertDistrictAccess(req, property.district_id);

    const updates = [];
    const values = [];
    let i = 1;
    if (trimmedName !== undefined) {
      updates.push(`name = $${i++}`);
      values.push(trimmedName);
    }
    if (trimmedAddress !== undefined) {
      updates.push(`address = $${i++}`);
      values.push(trimmedAddress || null);
    }
    if (updates.length === 0) {
      return res.json(property);
    }
    values.push(propertyId);

    const { rows } = await pool.query(
      `UPDATE properties SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    const updated = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'property.update',
      entityType: 'property',
      entityId: property.id,
      metadata: { name: updated.name },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deleteProperty(req, res, next) {
  try {
    const propertyId = parseId(req.params.id);
    if (!propertyId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const lookup = await pool.query(
      `SELECT p.*, d.name AS district_name
       FROM properties p
       JOIN districts d ON d.id = p.district_id
       WHERE p.id = $1`,
      [propertyId]
    );
    const property = lookup.rows[0];
    if (!property) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    await assertDistrictAccess(req, property.district_id);

    const unitCount = await pool.query(
      'SELECT COUNT(*)::int AS count FROM units WHERE property_id = $1',
      [propertyId]
    );
    if (unitCount.rows[0].count > 0) {
      return res.status(409).json({ error: 'Remove or move its units first.' });
    }

    const { rows } = await pool.query(
      'DELETE FROM properties WHERE id = $1 RETURNING *',
      [propertyId]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'property.delete',
      entityType: 'property',
      entityId: property.id,
      metadata: { name: property.name },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listProperties, createProperty, updateProperty, deleteProperty };
