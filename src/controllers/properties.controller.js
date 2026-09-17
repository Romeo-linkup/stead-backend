const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

async function listProperties(req, res, next) {
  try {
    if (req.user.role === 'owner') {
      const { rows } = await pool.query(
        `SELECT p.*, pcs.score_percent AS current_score, pcs.created_at AS score_created_at
         FROM properties p
         LEFT JOIN property_current_score pcs ON pcs.property_id = p.id
         ORDER BY p.created_at DESC`
      );
      return res.json(rows);
    }

    const { rows } = await pool.query(
      `SELECT p.*, pcs.score_percent AS current_score, pcs.created_at AS score_created_at
       FROM properties p
       LEFT JOIN property_current_score pcs ON pcs.property_id = p.id
       WHERE p.district_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.district_id]
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

    if (req.user.role !== 'owner' && targetDistrictId !== req.user.district_id) {
      return res.status(403).json({ error: 'You can only create properties in your own district.' });
    }

    const districtCheck = await pool.query('SELECT id FROM districts WHERE id = $1', [targetDistrictId]);
    if (!districtCheck.rows[0]) {
      return res.status(404).json({ error: 'District not found.' });
    }

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
