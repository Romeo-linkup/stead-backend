const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess } = require('../utils/scope');

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
    const { name, address, district_id } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Property name is required.' });
    }

    const targetDistrictId = Number(district_id ?? req.user.district_id);
    if (!targetDistrictId) {
      return res.status(400).json({ error: 'district_id is required.' });
    }

    await assertDistrictAccess(req, targetDistrictId);

    const { rows } = await pool.query(
      `INSERT INTO properties (district_id, name, address)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [targetDistrictId, name.trim(), address ? address.trim() : null]
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
      metadata: { name: property.name, address: property.address },
    });

    res.status(201).json(property);
  } catch (err) {
    next(err);
  }
}

module.exports = { listProperties, createProperty };
