// src/controllers/platform.controller.js
// Platform admin API - cross-organisation access with strict data rules
const pool = require('../db/pool');
const { writeLedger } = require('../services/ledger.service');
const { sendDirect } = require('../services/notify.service');

const platformRateLimit = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

async function getOverview(req, res, next) {
  try {
    const adminId = req.platformAdmin.id;

    const [
      orgCount,
      active7Days,
      active30Days,
      suspendedCount,
      districtsCount,
      propertiesCount,
      unitsCount,
      usersByRole,
      codesByRole,
      signupsWeekly,
      auditDaily
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM organizations'),
      pool.query(
        `SELECT COUNT(DISTINCT organization_id) AS count
         FROM audit_log
         WHERE created_at > now() - interval '7 days'`
      ),
      pool.query(
        `SELECT COUNT(DISTINCT organization_id) AS count
         FROM audit_log
         WHERE created_at > now() - interval '30 days'`
      ),
      pool.query("SELECT COUNT(*) AS count FROM organizations WHERE status = 'suspended'"),
      pool.query('SELECT COUNT(*) AS count FROM districts'),
      pool.query('SELECT COUNT(*) AS count FROM properties'),
      pool.query('SELECT COUNT(*) AS count FROM units'),
      pool.query(
        `SELECT role, COUNT(*) AS count
         FROM users
         GROUP BY role`
      ),
      pool.query(
        `SELECT c.role,
           COUNT(*) AS issued,
           COUNT(DISTINCT CASE WHEN u.id IS NOT NULL THEN c.id END) AS registered,
           COUNT(DISTINCT CASE WHEN c.active THEN c.id END) AS active,
           COUNT(DISTINCT CASE WHEN NOT c.active THEN c.id END) AS revoked
         FROM codes c
         LEFT JOIN users u ON u.code_id = c.id
         GROUP BY c.role`
      ),
      pool.query(
        `SELECT
           date_trunc('week', created_at) AS week,
           COUNT(*) AS count
         FROM organizations
         WHERE created_at > now() - interval '12 weeks'
         GROUP BY date_trunc('week', created_at)
         ORDER BY week`
      ),
      pool.query(
        `SELECT
           date_trunc('day', created_at) AS day,
           COUNT(*) AS count
         FROM audit_log
         WHERE created_at > now() - interval '30 days'
         GROUP BY date_trunc('day', created_at)
         ORDER BY day`
      )
    ]);

    res.json({
      organizations: parseInt(orgCount.rows[0].count),
      active_7_days: parseInt(active7Days.rows[0].count),
      active_30_days: parseInt(active30Days.rows[0].count),
      suspended: parseInt(suspendedCount.rows[0].count),
      districts: parseInt(districtsCount.rows[0].count),
      properties: parseInt(propertiesCount.rows[0].count),
      units: parseInt(unitsCount.rows[0].count),
      users_by_role: usersByRole.rows,
      codes_by_role: codesByRole.rows,
      signups_per_week: signupsWeekly.rows,
      audit_events_per_day: auditDaily.rows
    });
  } catch (err) {
    next(err);
  }
}

async function getOrgs(req, res, next) {
  try {
    const { search = '', status = '', sort = 'created_at', page = '1' } = req.query;
    const offset = (parseInt(page) - 1) * 25;
    const adminId = req.platformAdmin.id;

    let whereClauses = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
      whereClauses.push(`(o.name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status) {
      whereClauses.push(`o.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const validSorts = ['name', 'created_at', 'status', 'last_activity_at'];
    const sortColumn = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = sort === 'name' ? 'ASC' : 'DESC';

    const { rows } = await pool.query(
      `SELECT
         o.id,
         o.name,
         o.status,
         o.created_at,
         u.name AS owner_name,
         u.email AS owner_email,
         (SELECT COUNT(*) FROM districts WHERE organization_id = o.id) AS districts,
         (SELECT COUNT(*) FROM properties p JOIN districts d ON d.id = p.district_id WHERE d.organization_id = o.id) AS properties,
         (SELECT COUNT(*) FROM units u JOIN properties p ON p.id = u.property_id JOIN districts d ON d.id = p.district_id WHERE d.organization_id = o.id) AS units,
         (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'admin') AS admins,
         (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'property_manager') AS property_managers,
         (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'service_provider') AS service_providers,
         (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'tenant') AS tenants,
         (SELECT COUNT(DISTINCT CASE WHEN c.active THEN c.id END) FROM codes c WHERE c.organization_id = o.id) AS active_codes,
         (SELECT MAX(al.created_at) FROM audit_log al WHERE al.organization_id = o.id) AS last_activity_at
       FROM organizations o
       LEFT JOIN users u ON u.organization_id = o.id AND u.role = 'owner'
       ${whereClause}
       ORDER BY o.${sortColumn} ${sortOrder}
       LIMIT 25 OFFSET $${paramIndex}`,
      [...params, offset]
    );

    const totalResult = await pool.query(
      `SELECT COUNT(*) AS count
       FROM organizations o
       LEFT JOIN users u ON u.organization_id = o.id AND u.role = 'owner'
       ${whereClause}`,
      params
    );

    res.json({
      orgs: rows,
      total: parseInt(totalResult.rows[0].count),
      page: parseInt(page),
      per_page: 25
    });
  } catch (err) {
    next(err);
  }
}

async function getOrgDetail(req, res, next) {
  try {
    const { id } = req.params;
    const adminId = req.platformAdmin.id;

    const [orgResult, districtBreakdown, notes, ledger] = await Promise.all([
      pool.query(
        `SELECT
           o.id,
           o.name,
           o.status,
           o.suspended_reason,
           o.created_at,
           u.name AS owner_name,
           u.email AS owner_email,
           (SELECT COUNT(*) FROM districts WHERE organization_id = o.id) AS districts,
           (SELECT COUNT(*) FROM properties p JOIN districts d ON d.id = p.district_id WHERE d.organization_id = o.id) AS properties,
           (SELECT COUNT(*) FROM units u JOIN properties p ON p.id = u.property_id JOIN districts d ON d.id = p.district_id WHERE d.organization_id = o.id) AS units,
           (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'admin') AS admins,
           (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'property_manager') AS property_managers,
           (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'service_provider') AS service_providers,
           (SELECT COUNT(*) FROM users WHERE organization_id = o.id AND role = 'tenant') AS tenants,
           (SELECT COUNT(DISTINCT CASE WHEN c.active THEN c.id END) FROM codes c WHERE c.organization_id = o.id) AS active_codes,
           (SELECT MAX(al.created_at) FROM audit_log al WHERE al.organization_id = o.id) AS last_activity_at
         FROM organizations o
         LEFT JOIN users u ON u.organization_id = o.id AND u.role = 'owner'
         WHERE o.id = $1`,
        [id]
      ),
      pool.query(
        `SELECT
           d.id,
           d.name,
           (SELECT COUNT(*) FROM properties WHERE district_id = d.id) AS properties,
           (SELECT COUNT(*) FROM units u JOIN properties p ON p.id = u.property_id WHERE p.district_id = d.id) AS units,
           (SELECT COUNT(*) FROM users WHERE district_id = d.id AND role = 'admin') AS admins,
           (SELECT COUNT(*) FROM users WHERE district_id = d.id AND role = 'property_manager') AS property_managers,
           (SELECT COUNT(*) FROM users WHERE district_id = d.id AND role = 'service_provider') AS service_providers,
           (SELECT COUNT(*) FROM users WHERE district_id = d.id AND role = 'tenant') AS tenants,
           (SELECT COUNT(DISTINCT CASE WHEN c.active THEN c.id END) FROM codes c WHERE c.district_id = d.id) AS active_codes
         FROM districts d
         WHERE d.organization_id = $1
         ORDER BY d.name`,
        [id]
      ),
      pool.query(
        `SELECT id, note, created_at, created_by_admin_id
         FROM org_notes
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT id, occurred_at, actor_type, actor_id, organization_id, organization_name, event_type, detail
         FROM platform_ledger
         WHERE organization_id = $1
         ORDER BY id DESC
         LIMIT 50`,
        [id]
      )
    ]);

    if (!orgResult.rows[0]) {
      return res.status(404).json({ error: 'Organisation not found.' });
    }

    res.json({
      org: orgResult.rows[0],
      district_breakdown: districtBreakdown.rows,
      notes: notes.rows,
      ledger: ledger.rows
    });
  } catch (err) {
    next(err);
  }
}

async function suspendOrg(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.platformAdmin.id;

    if (typeof reason !== 'string' || reason.length < 5 || reason.length > 300) {
      return res.status(400).json({ error: 'Reason must be between 5 and 300 characters.' });
    }

    const result = await pool.query(
      `UPDATE organizations
       SET status = 'suspended', suspended_reason = $1
       WHERE id = $2
       RETURNING name`,
      [reason.trim(), id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Organisation not found.' });
    }

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: adminId,
        organizationId: parseInt(id),
        organizationName: result.rows[0].name,
        eventType: 'org.suspended',
        detail: { reason: reason.trim() }
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    res.json({ suspended: true });
  } catch (err) {
    next(err);
  }
}

async function unsuspendOrg(req, res, next) {
  try {
    const { id } = req.params;
    const adminId = req.platformAdmin.id;

    const result = await pool.query(
      `UPDATE organizations
       SET status = 'active', suspended_reason = NULL
       WHERE id = $1
       RETURNING name`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Organisation not found.' });
    }

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: adminId,
        organizationId: parseInt(id),
        organizationName: result.rows[0].name,
        eventType: 'org.unsuspended',
        detail: {}
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    res.json({ suspended: false });
  } catch (err) {
    next(err);
  }
}

async function addOrgNote(req, res, next) {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const adminId = req.platformAdmin.id;

    if (typeof note !== 'string' || note.length < 1 || note.length > 1000) {
      return res.status(400).json({ error: 'Note must be between 1 and 1000 characters.' });
    }

    const result = await pool.query(
      `INSERT INTO org_notes (organization_id, note, created_by_admin_id)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [id, note.trim(), adminId]
    );

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: adminId,
        organizationId: parseInt(id),
        eventType: 'org.note_added',
        detail: { note_id: result.rows[0].id }
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    res.json({ id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (err) {
    next(err);
  }
}

async function grantDisputeAccess(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.platformAdmin.id;

    if (typeof reason !== 'string' || reason.length < 10 || reason.length > 500) {
      return res.status(400).json({ error: 'Reason must be between 10 and 500 characters.' });
    }

    const orgResult = await pool.query(
      `SELECT o.name, u.email
       FROM organizations o
       LEFT JOIN users u ON u.organization_id = o.id AND u.role = 'owner'
       WHERE o.id = $1`,
      [id]
    );

    if (!orgResult.rows[0]) {
      return res.status(404).json({ error: 'Organisation not found.' });
    }

    const orgName = orgResult.rows[0].name;
    const ownerEmail = orgResult.rows[0].email;

    const result = await pool.query(
      `INSERT INTO dispute_access (organization_id, admin_id, reason, expires_at)
       VALUES ($1, $2, $3, now() + interval '24 hours')
       RETURNING id, expires_at`,
      [id, adminId, reason.trim()]
    );

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: adminId,
        organizationId: parseInt(id),
        organizationName: orgName,
        eventType: 'dispute.access_granted',
        detail: { grant_id: result.rows[0].id, expires_at: result.rows[0].expires_at }
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    if (ownerEmail && process.env.EMAIL_ENABLED === 'true') {
      setImmediate(async () => {
        try {
          await sendDirect({
            to: ownerEmail,
            subject: 'Stead: Dispute access granted to your account',
            heading: 'Stead support opened a 24 hour access to your account\'s activity log',
            lines: [
              `Reason: ${reason.trim()}`,
              'This access is recorded in the platform ledger.',
              'If you did not request this, please contact support immediately.'
            ],
            businessName: 'Stead',
          });
        } catch (err) {
          console.error('[dispute access] failed to send email:', err.message);
        }
      });
    }

    res.json({ id: result.rows[0].id, expires_at: result.rows[0].expires_at });
  } catch (err) {
    next(err);
  }
}

async function getOrgAudit(req, res, next) {
  try {
    const { id } = req.params;
    const { from, to, limit = '100' } = req.query;
    const adminId = req.platformAdmin.id;
    const limitNum = Math.min(parseInt(limit), 500);

    const grantResult = await pool.query(
      `SELECT id, expires_at
       FROM dispute_access
       WHERE organization_id = $1 AND admin_id = $2 AND expires_at > now()`,
      [id, adminId]
    );

    if (!grantResult.rows[0]) {
      return res.status(403).json({ error: 'Open dispute access first.' });
    }

    const grantId = grantResult.rows[0].id;

    let whereClause = 'WHERE al.organization_id = $1';
    let params = [id];
    let paramIndex = 2;

    if (from) {
      whereClause += ` AND al.created_at >= $${paramIndex}`;
      params.push(from);
      paramIndex++;
    }

    if (to) {
      whereClause += ` AND al.created_at <= $${paramIndex}`;
      params.push(to);
      paramIndex++;
    }

    const { rows } = await pool.query(
      `SELECT
         al.id,
         al.created_at,
         al.actor_role,
         u.name AS actor_name,
         al.action,
         al.entity_type,
         al.entity_id,
         al.metadata,
         al.ip,
         al.user_agent
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_id
       ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${paramIndex}`,
      [...params, limitNum]
    );

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: adminId,
        organizationId: parseInt(id),
        eventType: 'dispute.audit_read',
        detail: { grant_id: grantId, rows: rows.length }
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    res.json({ audit: rows });
  } catch (err) {
    next(err);
  }
}

async function getLedger(req, res, next) {
  try {
    const { org, type, from, to, page = '1' } = req.query;
    const offset = (parseInt(page) - 1) * 50;
    const adminId = req.platformAdmin.id;

    let whereClauses = [];
    let params = [];
    let paramIndex = 1;

    if (org) {
      whereClauses.push(`organization_id = $${paramIndex}`);
      params.push(org);
      paramIndex++;
    }

    if (type) {
      whereClauses.push(`event_type = $${paramIndex}`);
      params.push(type);
      paramIndex++;
    }

    if (from) {
      whereClauses.push(`occurred_at >= $${paramIndex}`);
      params.push(from);
      paramIndex++;
    }

    if (to) {
      whereClauses.push(`occurred_at <= $${paramIndex}`);
      params.push(to);
      paramIndex++;
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT id, occurred_at, actor_type, actor_id, organization_id, organization_name, event_type, detail
       FROM platform_ledger
       ${whereClause}
       ORDER BY id DESC
       LIMIT 50 OFFSET $${paramIndex}`,
      [...params, offset]
    );

    const totalResult = await pool.query(
      `SELECT COUNT(*) AS count FROM platform_ledger ${whereClause}`,
      params
    );

    res.json({
      ledger: rows,
      total: parseInt(totalResult.rows[0].count),
      page: parseInt(page),
      per_page: 50
    });
  } catch (err) {
    next(err);
  }
}

async function verifyLedger(req, res, next) {
  try {
    const { verifyLedger: verify } = require('../services/ledger.service');
    const result = await verify();

    const headResult = await pool.query(
      'SELECT id, entry_hash FROM platform_ledger ORDER BY id DESC LIMIT 1'
    );

    res.json({
      ...result,
      head_id: headResult.rows[0]?.id || null,
      head_hash: headResult.rows[0]?.entry_hash || null
    });
  } catch (err) {
    next(err);
  }
}

async function exportLedger(req, res, next) {
  try {
    const { from, to } = req.query;
    const adminId = req.platformAdmin.id;

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to dates are required.' });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    const daysDiff = (toDate - fromDate) / (1000 * 60 * 60 * 24);

    if (daysDiff > 31) {
      return res.status(400).json({ error: 'Date range must be 31 days or less.' });
    }

    const { rows } = await pool.query(
      `SELECT id, occurred_at, actor_type, organization_id, organization_name, event_type, detail
       FROM platform_ledger
       WHERE occurred_at >= $1 AND occurred_at <= $2
       ORDER BY id`,
      [from, to]
    );

    try {
      await writeLedger({
        actorType: 'platform_admin',
        actorId: adminId,
        eventType: 'platform.ledger_exported',
        detail: { from, to, rows: rows.length }
      });
    } catch (err) {
      console.error('[ledger] failed to write ledger entry:', err.message);
    }

    const header = 'id,occurred_at,actor_type,organization_id,organization_name,event_type,detail\n';
    const csv = header + rows.map(row =>
      `${row.id},${row.occurred_at.toISOString()},${row.actor_type},${row.organization_id || ''},${row.organization_name || ''},${row.event_type},"${JSON.stringify(row.detail).replace(/"/g, '""')}"`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="platform-ledger.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  platformRateLimit,
  getOverview,
  getOrgs,
  getOrgDetail,
  suspendOrg,
  unsuspendOrg,
  addOrgNote,
  grantDisputeAccess,
  getOrgAudit,
  getLedger,
  verifyLedger,
  exportLedger
};
