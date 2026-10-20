const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { allowedDistrictIds, assertDistrictAccess, resolveTargetDistrict } = require('../utils/scope');
const { uploadReceipt: cloudinaryUploadReceipt } = require('../services/cloudinary.service');
const cloudinary = require('cloudinary').v2;
const { imageVariant } = require('../utils/imageUrl');

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
    res.json(enrichPropertyRows(rows));
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
    } else if (req.user.role === 'admin') {
      targetDistrictId = await resolveTargetDistrict(req, req.body.district_id);
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

    let deleted;
    try {
      deleted = await pool.query('DELETE FROM properties WHERE id = $1 RETURNING *', [propertyId]);
    } catch (err) {
      if (err.code === '23503') {
        return res.status(409).json({ error: "This property still has records linked to it, so it can't be deleted yet." });
      }
      throw err;
    }

    if (property.image_public_id) {
      try {
        await cloudinary.uploader.destroy(property.image_public_id);
      } catch (err) {
        console.error('[property delete] failed to delete photo:', err.message);
      }
    }

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

    res.json(deleted.rows[0]);
  } catch (err) {
    next(err);
  }
}

function validateImageBuffer(buffer) {
  if (!buffer || buffer.length === 0) return false;
  if (buffer.length > 5 * 1024 * 1024) return false;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) return true;

  return false;
}

async function setPropertyImage(req, res, next) {
  try {
    const propertyId = parseId(req.params.id);
    if (!propertyId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required.' });
    }

    if (!validateImageBuffer(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid image format. Only JPEG, PNG, and WebP are allowed.' });
    }

    const lookup = await pool.query(
      `SELECT p.*, d.id AS district_id
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

    const folder = `stead/properties/${req.user.organization_id}`;
    const uploadResult = await cloudinaryUploadReceipt(req.file.buffer, folder);

    const previousPublicId = property.image_public_id;
    if (previousPublicId) {
      try {
        await cloudinary.uploader.destroy(previousPublicId);
      } catch (err) {
        console.error('[property image] failed to delete previous image:', err.message);
      }
    }

    const { rows } = await pool.query(
      `UPDATE properties
       SET image_url = $1, image_public_id = $2, image_updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [uploadResult.url, uploadResult.public_id, propertyId]
    );
    const updated = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'property.image_set',
      entityType: 'property',
      entityId: property.id,
      metadata: { property_id: property.id },
    });

    res.json({
      image_url: imageVariant(updated.image_url, 'hero'),
      thumb_url: imageVariant(updated.image_url, 'thumb'),
    });
  } catch (err) {
    next(err);
  }
}

async function deletePropertyImage(req, res, next) {
  try {
    const propertyId = parseId(req.params.id);
    if (!propertyId) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const lookup = await pool.query(
      `SELECT p.*, d.id AS district_id
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

    const publicId = property.image_public_id;
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        console.error('[property image] failed to delete image:', err.message);
      }
    }

    const { rows } = await pool.query(
      `UPDATE properties
       SET image_url = NULL, image_public_id = NULL, image_updated_at = NULL
       WHERE id = $1
       RETURNING *`,
      [propertyId]
    );

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: property.district_id,
      organizationId: req.user.organization_id,
      action: 'property.image_remove',
      entityType: 'property',
      entityId: property.id,
      metadata: { property_id: property.id },
    });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

function enrichPropertyRows(rows) {
  return rows.map(row => ({
    ...row,
    image_thumb_url: imageVariant(row.image_url, 'thumb'),
    image_url: imageVariant(row.image_url, 'hero'),
  }));
}

async function getMyProperties(req, res, next) {
  try {
    let districtIds;
    if (req.user.role === 'tenant') {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.address, p.image_url, p.district_id
         FROM units u
         JOIN properties p ON p.id = u.property_id
         WHERE u.tenant_user_id = $1`,
        [req.user.user_id]
      );
      const property = rows[0];
      if (!property) {
        return res.json([]);
      }
      await assertDistrictAccess(req, property.district_id);
      return res.json(enrichPropertyRows([{
        id: property.id,
        name: property.name,
        address: property.address,
        image_url: property.image_url,
      }]));
    }

    if (req.user.role === 'service_provider') {
      districtIds = await allowedDistrictIds(req);
    } else {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, address, image_url
       FROM properties
       WHERE district_id = ANY($1::int[])
       ORDER BY name`,
      [districtIds]
    );

    res.json(enrichPropertyRows(rows));
  } catch (err) {
    next(err);
  }
}

module.exports = { listProperties, createProperty, updateProperty, deleteProperty, setPropertyImage, deletePropertyImage, enrichPropertyRows, getMyProperties };
