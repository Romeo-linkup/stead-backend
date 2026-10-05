// src/controllers/assets.controller.js
// Per-unit assets register (the client's "Building & Assets List").
// Every handler loads the unit WITH its district and calls
// assertDistrictAccess so owner/admin/property_manager only ever touch
// units inside their own organisation's districts. Tenants can only
// read their own unit; they can never write. Service providers are
// turned away at the route level (and defensively here too).
const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { assertDistrictAccess } = require('../utils/scope');

const ASSET_CONDITIONS = ['good', 'fair', 'poor', 'damaged', 'missing'];
const WRITER_ROLES = ['owner', 'admin', 'property_manager'];
const MAX_AREA = 60;
const MAX_ITEM = 120;
const MAX_COMMENTS = 500;

// The client's standard "Building & Assets List", as [area, item] pairs.
const STANDARD_TEMPLATE = [
  ['Kitchen & entrances', 'Front brown door + gate (entrance/exit)'],
  ['Kitchen & entrances', 'Back white door + gate (entrance/exit)'],
  ['Kitchen & entrances', 'Kitchen cupboards'],
  ['Kitchen & entrances', 'Geyser'],
  ['Kitchen & entrances', 'Sink + tap'],
  ['Kitchen & entrances', 'Stove 4 plates'],
  ['Kitchen & entrances', 'Electricity prepaid box + switchboard'],
  ['Bathroom', 'Bath tub'],
  ['Bathroom', 'Sink + tap'],
  ['Bathroom', 'Mirror cosmetic box'],
  ['Toilet', 'Storage cupboard'],
  ['Toilet', 'Toilet'],
  ['Toilet', 'Tissue holder'],
  ['Bedroom', 'Built in wardrobes x 2'],
  ['General', 'Bulbs x 8'],
  ['General', 'Doors (indoors) x 4'],
  ['General', 'Windows x 9'],
  ['General', 'White wall paints'],
  ['General', 'Tiles'],
];

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Unit joined to its property so the district is always in hand.
async function loadUnit(unitId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.unit_number, u.property_id,
            p.name AS property_name, p.address AS property_address, p.district_id
     FROM units u
     JOIN properties p ON p.id = u.property_id
     WHERE u.id = $1`,
    [unitId]
  );
  return rows[0] || null;
}

// The single unit a tenant is linked to (units.tenant_user_id).
async function loadTenantUnit(tenantUserId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.unit_number, u.property_id,
            p.name AS property_name, p.address AS property_address, p.district_id
     FROM units u
     JOIN properties p ON p.id = u.property_id
     WHERE u.tenant_user_id = $1`,
    [tenantUserId]
  );
  return rows[0] || null;
}

function notFound(res) {
  return res.status(404).json({ error: 'Not found.' });
}

function cleanText(value, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

async function listAssets(req, res, next) {
  try {
    if (req.user.role === 'service_provider') {
      return res.status(403).json({ error: 'You do not have access to assets.' });
    }

    let unitId = parseId(req.query.unit_id);

    if (req.user.role === 'tenant') {
      // A tenant may only ever see the unit they are linked to.
      const myUnit = await loadTenantUnit(req.user.user_id);
      if (!myUnit) {
        return notFound(res);
      }
      if (unitId && unitId !== myUnit.id) {
        // Asking for another unit must not leak its existence.
        return notFound(res);
      }
      unitId = myUnit.id;
    }

    if (!unitId) {
      return res.status(400).json({ error: 'unit_id is required.' });
    }

    const unit = await loadUnit(unitId);
    if (!unit) {
      return notFound(res);
    }
    await assertDistrictAccess(req, unit.district_id);

    const { rows } = await pool.query(
      `SELECT id, unit_id, area, item, condition, comments, sort_order, updated_by, created_at, updated_at
       FROM unit_assets
       WHERE unit_id = $1
       ORDER BY sort_order, id`,
      [unitId]
    );

    res.json({
      unit: {
        id: unit.id,
        unit_number: unit.unit_number,
        property_name: unit.property_name,
        property_address: unit.property_address,
      },
      assets: rows,
    });
  } catch (err) {
    next(err);
  }
}

async function createAsset(req, res, next) {
  try {
    const { unit_id, area, item, condition, comments } = req.body || {};
    const unitId = parseId(unit_id);
    if (!unitId) {
      return res.status(400).json({ error: 'unit_id is required.' });
    }

    const areaValue = cleanText(area, MAX_AREA);
    if (areaValue === undefined) {
      return res.status(400).json({ error: `area must be at most ${MAX_AREA} characters.` });
    }

    const itemValue = cleanText(item, MAX_ITEM);
    if (itemValue === undefined || itemValue === null) {
      return res.status(400).json({ error: `item is required (1-${MAX_ITEM} characters).` });
    }

    let conditionValue = null;
    if (condition !== undefined && condition !== null && condition !== '') {
      if (!ASSET_CONDITIONS.includes(condition)) {
        return res.status(400).json({ error: `condition must be one of: ${ASSET_CONDITIONS.join(', ')}.` });
      }
      conditionValue = condition;
    }

    const commentsValue = cleanText(comments, MAX_COMMENTS);
    if (commentsValue === undefined) {
      return res.status(400).json({ error: `comments must be at most ${MAX_COMMENTS} characters.` });
    }

    const unit = await loadUnit(unitId);
    if (!unit) {
      return notFound(res);
    }
    await assertDistrictAccess(req, unit.district_id);

    // sort_order = current max + 1 so new rows land at the bottom.
    const { rows: maxRows } = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM unit_assets WHERE unit_id = $1',
      [unitId]
    );
    const nextOrder = Number(maxRows[0].max_order) + 1;

    const { rows } = await pool.query(
      `INSERT INTO unit_assets (unit_id, area, item, condition, comments, sort_order, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING id, unit_id, area, item, condition, comments, sort_order, updated_by, created_at, updated_at`,
      [unitId, areaValue, itemValue, conditionValue, commentsValue, nextOrder, req.user.user_id]
    );
    const asset = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: unit.district_id,
      organizationId: req.user.organization_id,
      action: 'asset.create',
      entityType: 'unit_asset',
      entityId: asset.id,
      metadata: { unit_id: unitId, asset_id: asset.id },
    });

    res.status(201).json(asset);
  } catch (err) {
    next(err);
  }
}

// Load an asset together with the district of its unit.
async function loadAsset(assetId) {
  const { rows } = await pool.query(
    `SELECT a.*, u.property_id, p.district_id
     FROM unit_assets a
     JOIN units u ON u.id = a.unit_id
     JOIN properties p ON p.id = u.property_id
     WHERE a.id = $1`,
    [assetId]
  );
  return rows[0] || null;
}

async function updateAsset(req, res, next) {
  try {
    const assetId = parseId(req.params.id);
    if (!assetId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const { area, item, condition, comments } = req.body || {};

    const asset = await loadAsset(assetId);
    if (!asset) {
      return notFound(res);
    }
    await assertDistrictAccess(req, asset.district_id);

    const updates = [];
    const values = [];
    let i = 1;

    if (area !== undefined) {
      const areaValue = cleanText(area, MAX_AREA);
      if (areaValue === undefined) {
        return res.status(400).json({ error: `area must be at most ${MAX_AREA} characters.` });
      }
      updates.push(`area = $${i++}`);
      values.push(areaValue);
    }

    if (item !== undefined) {
      const itemValue = cleanText(item, MAX_ITEM);
      if (itemValue === undefined || itemValue === null) {
        return res.status(400).json({ error: `item is required (1-${MAX_ITEM} characters).` });
      }
      updates.push(`item = $${i++}`);
      values.push(itemValue);
    }

    if (condition !== undefined) {
      let conditionValue = null;
      if (condition !== null && condition !== '') {
        if (!ASSET_CONDITIONS.includes(condition)) {
          return res.status(400).json({ error: `condition must be one of: ${ASSET_CONDITIONS.join(', ')}.` });
        }
        conditionValue = condition;
      }
      updates.push(`condition = $${i++}`);
      values.push(conditionValue);
    }

    if (comments !== undefined) {
      const commentsValue = cleanText(comments, MAX_COMMENTS);
      if (commentsValue === undefined) {
        return res.status(400).json({ error: `comments must be at most ${MAX_COMMENTS} characters.` });
      }
      updates.push(`comments = $${i++}`);
      values.push(commentsValue);
    }

    if (updates.length === 0) {
      return res.json(asset);
    }

    updates.push(`updated_by = $${i++}`);
    values.push(req.user.user_id);
    updates.push(`updated_at = $${i++}`);
    values.push(new Date());
    values.push(assetId);

    const { rows } = await pool.query(
      `UPDATE unit_assets SET ${updates.join(', ')} WHERE id = $${i}
       RETURNING id, unit_id, area, item, condition, comments, sort_order, updated_by, created_at, updated_at`,
      values
    );
    const updated = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: asset.district_id,
      organizationId: req.user.organization_id,
      action: 'asset.update',
      entityType: 'unit_asset',
      entityId: assetId,
      metadata: { unit_id: asset.unit_id, asset_id: assetId },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deleteAsset(req, res, next) {
  try {
    const assetId = parseId(req.params.id);
    if (!assetId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const asset = await loadAsset(assetId);
    if (!asset) {
      return notFound(res);
    }
    await assertDistrictAccess(req, asset.district_id);

    const { rows } = await pool.query(
      'DELETE FROM unit_assets WHERE id = $1 RETURNING id, unit_id, area, item, condition, comments, sort_order, updated_by, created_at, updated_at',
      [assetId]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: asset.district_id,
      organizationId: req.user.organization_id,
      action: 'asset.delete',
      entityType: 'unit_asset',
      entityId: assetId,
      metadata: { unit_id: asset.unit_id, asset_id: assetId },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// Insert the standard template into a unit that has no assets yet.
async function applyTemplate(req, res, next) {
  try {
    const { unit_id } = req.body || {};
    const unitId = parseId(unit_id);
    if (!unitId) {
      return res.status(400).json({ error: 'unit_id is required.' });
    }

    const unit = await loadUnit(unitId);
    if (!unit) {
      return notFound(res);
    }
    await assertDistrictAccess(req, unit.district_id);

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const existing = await client.query(
        'SELECT 1 FROM unit_assets WHERE unit_id = $1 LIMIT 1',
        [unitId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ error: 'This unit already has assets.' });
      }

      const created = [];
      for (let i = 0; i < STANDARD_TEMPLATE.length; i++) {
        const [area, item] = STANDARD_TEMPLATE[i];
        const { rows } = await client.query(
          `INSERT INTO unit_assets (unit_id, area, item, condition, comments, sort_order, updated_by, updated_at)
           VALUES ($1, $2, $3, NULL, NULL, $4, $5, now())
           RETURNING id, unit_id, area, item, condition, comments, sort_order, updated_by, created_at, updated_at`,
          [unitId, area, item, i, req.user.user_id]
        );
        created.push(rows[0]);
      }

      await client.query('COMMIT');
      transactionStarted = false;

      await writeAudit({
        actorId: req.user.user_id,
        actorRole: req.user.role,
        districtId: unit.district_id,
        organizationId: req.user.organization_id,
        action: 'asset.apply_template',
        entityType: 'unit_asset',
        entityId: null,
        metadata: { unit_id: unitId, asset_id: null },
      });

      res.status(201).json(created);
    } catch (err) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
}

// Copy area/item/comments from one unit to another, condition reset to NULL.
async function copyAssets(req, res, next) {
  try {
    const { from_unit_id, to_unit_id } = req.body || {};
    const fromUnitId = parseId(from_unit_id);
    const toUnitId = parseId(to_unit_id);
    if (!fromUnitId || !toUnitId) {
      return res.status(400).json({ error: 'from_unit_id and to_unit_id are required.' });
    }

    const fromUnit = await loadUnit(fromUnitId);
    if (!fromUnit) {
      return notFound(res);
    }
    await assertDistrictAccess(req, fromUnit.district_id);

    const toUnit = await loadUnit(toUnitId);
    if (!toUnit) {
      return notFound(res);
    }
    await assertDistrictAccess(req, toUnit.district_id);

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;

      const existing = await client.query(
        'SELECT 1 FROM unit_assets WHERE unit_id = $1 LIMIT 1',
        [toUnitId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ error: 'The target unit already has assets.' });
      }

      const { rows: sourceRows } = await client.query(
        'SELECT area, item, comments FROM unit_assets WHERE unit_id = $1 ORDER BY sort_order, id',
        [fromUnitId]
      );

      const created = [];
      for (let i = 0; i < sourceRows.length; i++) {
        const src = sourceRows[i];
        const { rows } = await client.query(
          `INSERT INTO unit_assets (unit_id, area, item, condition, comments, sort_order, updated_by, updated_at)
           VALUES ($1, $2, $3, NULL, $4, $5, $6, now())
           RETURNING id, unit_id, area, item, condition, comments, sort_order, updated_by, created_at, updated_at`,
          [toUnitId, src.area, src.item, src.comments, i, req.user.user_id]
        );
        created.push(rows[0]);
      }

      await client.query('COMMIT');
      transactionStarted = false;

      await writeAudit({
        actorId: req.user.user_id,
        actorRole: req.user.role,
        districtId: toUnit.district_id,
        organizationId: req.user.organization_id,
        action: 'asset.copy',
        entityType: 'unit_asset',
        entityId: null,
        metadata: { unit_id: toUnitId, asset_id: null },
      });

      res.status(201).json(created);
    } catch (err) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listAssets,
  createAsset,
  updateAsset,
  deleteAsset,
  applyTemplate,
  copyAssets,
};
