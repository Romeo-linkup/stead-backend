const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

const MANAGEMENT_ROLES = ['owner', 'admin', 'property_manager'];
const AUDIENCES = ['all', 'tenants', 'providers'];

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function getNotices(req, res, next) {
  try {
    const isOwner = req.user.role === 'owner';
    const isManager = MANAGEMENT_ROLES.includes(req.user.role);
    let districtId = null;
    if (isOwner && req.query.district_id != null && req.query.district_id !== '') {
      districtId = parseId(req.query.district_id);
      if (!districtId) return res.status(400).json({ error: 'district_id must be a positive integer.' });
    } else if (!isOwner) {
      districtId = parseId(req.user.district_id);
      if (!districtId) return res.status(400).json({ error: 'Your account is not linked to a district.' });
    }

    const audience = isManager ? null : req.user.role === 'tenant' ? 'tenants' : 'providers';
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.body, n.audience, n.district_id,
              d.name AS district_name, n.created_at
       FROM notices n
       LEFT JOIN districts d ON d.id = n.district_id
       WHERE n.organization_id = $1
         AND ($2::boolean OR n.district_id = $3 OR n.district_id IS NULL)
         AND ($4::text IS NULL OR n.audience = 'all' OR n.audience = $4)
       ORDER BY n.created_at DESC
       LIMIT 100`,
      [req.user.organization_id, isOwner && districtId === null, districtId, audience]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createNotice(req, res, next) {
  try {
    const input = req.body || {};
    if (typeof input.title !== 'string' || !input.title.trim()) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    const title = input.title.trim();
    if (title.length > 120) {
      return res.status(400).json({ error: 'Title must be 120 characters or fewer.' });
    }

    const body = input.body === undefined ? '' : input.body;
    if (typeof body !== 'string') {
      return res.status(400).json({ error: 'Message must be a string.' });
    }
    if (body.length > 2000) {
      return res.status(400).json({ error: 'Message must be 2000 characters or fewer.' });
    }

    const audience = input.audience === undefined ? 'all' : input.audience;
    if (!AUDIENCES.includes(audience)) {
      return res.status(400).json({ error: 'Audience must be all, tenants, or providers.' });
    }

    let districtId;
    if (req.user.role === 'owner') {
      districtId = input.district_id == null ? null : parseId(input.district_id);
      if (input.district_id != null && !districtId) {
        return res.status(400).json({ error: 'district_id must be a positive integer or null.' });
      }
    } else {
      districtId = parseId(req.user.district_id);
      if (!districtId) return res.status(400).json({ error: 'Your account is not linked to a district.' });
    }

    if (districtId !== null) {
      const district = await pool.query('SELECT id FROM districts WHERE id = $1 AND organization_id = $2', [districtId, req.user.organization_id]);
      if (!district.rows[0]) return res.status(404).json({ error: 'District not found.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO notices (district_id, audience, title, body, created_by, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, body, audience, district_id, created_at`,
      [districtId, audience, title, body, req.user.user_id, req.user.organization_id]
    );
    const notice = rows[0];

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId,
      organizationId: req.user.organization_id,
      action: 'notice.create',
      entityType: 'notice',
      entityId: notice.id,
      metadata: { audience },
    });

    res.status(201).json(notice);
  } catch (err) {
    next(err);
  }
}

async function deleteNotice(req, res, next) {
  try {
    const noticeId = parseId(req.params.id);
    if (!noticeId) return res.status(400).json({ error: 'Invalid notice ID.' });

    const isOwner = req.user.role === 'owner';
    const values = isOwner ? [noticeId, req.user.organization_id] : [noticeId, req.user.district_id, req.user.organization_id];
    const scope = isOwner ? 'id = $1 AND organization_id = $2' : 'id = $1 AND district_id = $2 AND organization_id = $3';
    const { rows } = await pool.query(
      `DELETE FROM notices WHERE ${scope}
       RETURNING id, district_id, audience`,
      values
    );
    const notice = rows[0];
    if (!notice) return res.status(404).json({ error: 'Notice not found.' });

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: notice.district_id,
      organizationId: req.user.organization_id,
      action: 'notice.delete',
      entityType: 'notice',
      entityId: notice.id,
      metadata: { audience: notice.audience },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getNotices, createNotice, deleteNotice };