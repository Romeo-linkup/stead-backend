const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { assertDistrictAccess, orgId } = require('../utils/scope');

const DEFAULT_SECTIONS = {
  building_rules: [
    'Quiet hours are 22:00–06:00, every day.',
    'No structural changes or painting without written permission.',
    'Refuse goes out the night before collection, in sealed bags.',
    'Common areas must be kept clear of personal items.',
    'Pets are only allowed where your lease specifically permits them.',
  ].join('\n'),
  utilities: 'Water is metered per unit and billed with rent. Electricity is prepaid — load tokens using your meter number. If a meter looks faulty, log a maintenance request rather than adjusting it yourself.',
  contacts: 'For anything non-urgent, log a maintenance request or a complaint so there is a written record, and check Notices for updates from management. For a genuine emergency, use the SOS button at the top of the screen.',
  access: 'Gate code changes monthly — check Notices. Sign in at the office before entering any unit.',
};

function buildLeavingPropertyText(months) {
  const safeMonths = Number.isInteger(months) && months > 0 ? months : 3;
  return `${safeMonths} calendar months' written notice is required before moving out. A joint inspection is done before keys are handed back, and your deposit is refunded after that, less any damage beyond fair wear and tear.`;
}

const SECTION_KEYS = Object.keys(DEFAULT_SECTIONS).concat('leaving_property');

function parseDistrictId(value) {
  const districtId = Number(value);
  return Number.isInteger(districtId) && districtId > 0 ? districtId : null;
}

async function getDistrictInfo(req, res, next) {
  try {
    let districtId;
    if (req.user.role === 'owner') {
      districtId = parseDistrictId(req.query.district_id);
      if (!districtId) return res.status(400).json({ error: 'district_id is required' });
    } else {
      districtId = parseDistrictId(req.user.district_id);
      if (!districtId) return res.status(400).json({ error: 'district_id is required' });
    }

    const district = await pool.query('SELECT id FROM districts WHERE id = $1', [districtId]);
    if (!district.rows[0]) return res.status(404).json({ error: 'District not found.' });

    await assertDistrictAccess(req, districtId);

    const noticePeriodResult = await pool.query(
      'SELECT notice_period_months FROM app_settings WHERE organization_id = $1',
      [orgId(req)]
    );
    const noticePeriodMonths = Number(noticePeriodResult.rows[0]?.notice_period_months);
    const { rows } = await pool.query(
      'SELECT section_key, body FROM district_info WHERE district_id = $1',
      [districtId]
    );
    const sections = {
      ...DEFAULT_SECTIONS,
      leaving_property: buildLeavingPropertyText(noticePeriodMonths),
    };
    for (const row of rows) sections[row.section_key] = row.body;

    res.json({ district_id: districtId, sections });
  } catch (err) {
    next(err);
  }
}

async function updateDistrictInfo(req, res, next) {
  try {
    const { sectionKey } = req.params;
    if (!SECTION_KEYS.includes(sectionKey)) {
      return res.status(400).json({ error: 'Invalid section key.' });
    }

    if (typeof req.body?.body !== 'string') {
      return res.status(400).json({ error: 'body must be a string.' });
    }
    const body = req.body.body.trim();
    if (body.length > 4000) {
      return res.status(400).json({ error: 'body must be no more than 4000 characters.' });
    }

    let districtId;
    if (req.user.role === 'owner') {
      districtId = parseDistrictId(req.body.district_id);
      if (!districtId) return res.status(400).json({ error: 'district_id is required' });
    } else {
      districtId = parseDistrictId(req.user.district_id);
      if (!districtId) return res.status(400).json({ error: 'district_id is required' });
    }

    const district = await pool.query('SELECT id FROM districts WHERE id = $1', [districtId]);
    if (!district.rows[0]) return res.status(404).json({ error: 'District not found.' });

    await assertDistrictAccess(req, districtId);

    if (body === '') {
      await pool.query(
        'DELETE FROM district_info WHERE district_id = $1 AND section_key = $2',
        [districtId, sectionKey]
      );
    } else {
      await pool.query(
        `INSERT INTO district_info (district_id, section_key, body, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (district_id, section_key)
         DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [districtId, sectionKey, body, req.user.user_id]
      );
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId,
      action: 'district_info.update',
      entityType: 'district_info',
      metadata: { section_key: sectionKey },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getDistrictInfo, updateDistrictInfo };