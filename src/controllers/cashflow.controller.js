const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');

const CATEGORIES = {
  in: ['rent_income', 'other_income'],
  out: ['bond_payment', 'municipal', 'water', 'electricity', 'insurance', 'levies', 'salaries', 'maintenance', 'other_expense'],
};
const MAX_ACTIVE_ITEMS = 200;
const MAX_CENTS = 10000000000; // R100,000,000.00

const ITEM_SELECT = `
  SELECT i.id, i.direction, i.category, i.label, i.amount, i.day_of_month, i.note, i.version,
         i.created_at, i.updated_at, i.amount_updated_at, au.name AS amount_updated_by_name
  FROM cashflow_items i
  LEFT JOIN users au ON au.id = i.amount_updated_by`;

function parseId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Money is handled in whole cents, never floats.
function parseAmountToCents(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) return null;
  return cents;
}

function numericToCents(text) {
  const negative = String(text).startsWith('-');
  const [whole, fraction = ''] = String(text).replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function centsToString(cents) {
  return (cents / 100).toFixed(2);
}

function readLabel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 1 && text.length <= 100 ? text : null;
}

function readDay(value) {
  const n = typeof value === 'string' && /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

function readNote(value) {
  if (value == null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || value.trim().length > 300) return { ok: false };
  return { ok: true, value: value.trim() };
}

function readReason(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length >= 5 && text.length <= 300 ? text : null;
}

function orgIdOf(req, res) {
  const id = req.user.organization_id;
  if (!id) {
    res.status(403).json({ error: 'Your account is not linked to an organisation.' });
    return null;
  }
  return id;
}

function snapshot(row) {
  return {
    label: row.label,
    category: row.category,
    day_of_month: row.day_of_month,
    amount: row.amount,
    note: row.note || null,
  };
}

async function fail(client, res, status, error) {
  await client.query('ROLLBACK');
  return res.status(status).json({ error });
}

async function listCashflow(req, res, next) {
  try {
    const orgId = orgIdOf(req, res);
    if (!orgId) return;

    const { rows } = await pool.query(
      `${ITEM_SELECT}
       WHERE i.organization_id = $1 AND i.archived_at IS NULL
       ORDER BY i.day_of_month, i.id`,
      [orgId]
    );

    let inCents = 0;
    let outCents = 0;
    for (const row of rows) {
      const cents = numericToCents(row.amount);
      if (row.direction === 'in') inCents += cents;
      else outCents += cents;
    }
    const net = inCents - outCents;

    res.set('Cache-Control', 'no-store');
    res.json({
      items: rows,
      totals: {
        in: centsToString(inCents),
        out: centsToString(outCents),
        net: centsToString(net),
        status: net > 0 ? 'profit' : net < 0 ? 'loss' : 'break_even',
      },
    });
  } catch (err) {
    next(err);
  }
}

async function listHistory(req, res, next) {
  try {
    const orgId = orgIdOf(req, res);
    if (!orgId) return;

    const { rows } = await pool.query(
      `SELECT h.id, h.item_id, h.change_type, h.old_values, h.new_values, h.reason, h.changed_at,
              u.name AS changed_by_name, i.label AS item_label, i.direction
       FROM cashflow_history h
       JOIN users u ON u.id = h.changed_by
       JOIN cashflow_items i ON i.id = h.item_id
       WHERE h.organization_id = $1
       ORDER BY h.changed_at DESC, h.id DESC
       LIMIT 200`,
      [orgId]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
}

async function createItem(req, res, next) {
  try {
    const orgId = orgIdOf(req, res);
    if (!orgId) return;
    const body = req.body || {};

    const direction = body.direction;
    if (direction !== 'in' && direction !== 'out') {
      return res.status(400).json({ error: 'Type must be money in or money out.' });
    }
    if (!CATEGORIES[direction].includes(body.category)) {
      return res.status(400).json({ error: 'Choose a valid category.' });
    }
    const label = readLabel(body.label);
    if (!label) return res.status(400).json({ error: 'Name must be between 1 and 100 characters.' });
    const day = readDay(body.day_of_month);
    if (!day) return res.status(400).json({ error: 'Day of the month must be between 1 and 31.' });
    const cents = parseAmountToCents(body.amount);
    if (!cents) return res.status(400).json({ error: 'Amount must be above 0 with at most 2 decimals.' });
    const note = readNote(body.note);
    if (!note.ok) return res.status(400).json({ error: 'Note must be 300 characters or fewer.' });

    const count = await pool.query(
      'SELECT count(*)::int AS n FROM cashflow_items WHERE organization_id = $1 AND archived_at IS NULL',
      [orgId]
    );
    if (count.rows[0].n >= MAX_ACTIVE_ITEMS) {
      return res.status(409).json({ error: `You can have at most ${MAX_ACTIVE_ITEMS} active cashflow items.` });
    }

    const client = await pool.connect();
    let item;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO cashflow_items
           (organization_id, direction, category, label, amount, day_of_month, note,
            created_by, updated_by, amount_updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
         RETURNING *`,
        [orgId, direction, body.category, label, centsToString(cents), day, note.value, req.user.user_id]
      );
      item = inserted.rows[0];
      await client.query(
        `INSERT INTO cashflow_history (item_id, organization_id, change_type, old_values, new_values, changed_by)
         VALUES ($1, $2, 'create', NULL, $3, $4)`,
        [item.id, orgId, JSON.stringify(snapshot(item)), req.user.user_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // The shared audit log is visible to property managers, so it records that a change happened, never the amounts.
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: null,
      organizationId: orgId,
      action: 'cashflow.create',
      entityType: 'cashflow_item',
      entityId: item.id,
      metadata: {},
    });

    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
}

async function updateItem(req, res, next) {
  try {
    const orgId = orgIdOf(req, res);
    if (!orgId) return;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const body = req.body || {};

    const expectedVersion = Number(body.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return res.status(400).json({ error: 'expected_version is required.' });
    }

    const changes = {};
    if (body.label !== undefined) {
      changes.label = readLabel(body.label);
      if (!changes.label) return res.status(400).json({ error: 'Name must be between 1 and 100 characters.' });
    }
    if (body.category !== undefined) {
      if (typeof body.category !== 'string') return res.status(400).json({ error: 'Choose a valid category.' });
      changes.category = body.category;
    }
    if (body.day_of_month !== undefined) {
      changes.day = readDay(body.day_of_month);
      if (!changes.day) return res.status(400).json({ error: 'Day of the month must be between 1 and 31.' });
    }
    if (body.amount !== undefined) {
      changes.cents = parseAmountToCents(body.amount);
      if (!changes.cents) return res.status(400).json({ error: 'Amount must be above 0 with at most 2 decimals.' });
    }
    if (body.note !== undefined) {
      const note = readNote(body.note);
      if (!note.ok) return res.status(400).json({ error: 'Note must be 300 characters or fewer.' });
      changes.note = note.value;
    }
    const reason = readReason(body.reason);

    const client = await pool.connect();
    let updated;
    let changedFields;
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM cashflow_items
         WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
         FOR UPDATE`,
        [id, orgId]
      );
      const before = current.rows[0];
      if (!before) return await fail(client, res, 404, 'Item not found.');
      if (before.version !== expectedVersion) {
        return await fail(client, res, 409, 'This item was changed by someone else. Refresh and try again.');
      }

      const oldVals = snapshot(before);
      const nextVals = snapshot(before);
      if (changes.label !== undefined) nextVals.label = changes.label;
      if (changes.category !== undefined) {
        if (!CATEGORIES[before.direction].includes(changes.category)) {
          return await fail(client, res, 400, 'Choose a valid category.');
        }
        nextVals.category = changes.category;
      }
      if (changes.day !== undefined) nextVals.day_of_month = changes.day;
      if (changes.cents !== undefined) nextVals.amount = centsToString(changes.cents);
      if (changes.note !== undefined) nextVals.note = changes.note;

      changedFields = Object.keys(nextVals).filter((key) => (nextVals[key] ?? null) !== (oldVals[key] ?? null));
      if (changedFields.length === 0) return await fail(client, res, 400, 'Nothing was changed.');

      const amountChanged = changedFields.includes('amount');
      const sensitive = amountChanged || changedFields.includes('day_of_month');
      if (sensitive && !reason) {
        return await fail(client, res, 400, 'A reason of at least 5 characters is required when the amount or date changes.');
      }

      const result = await client.query(
        `UPDATE cashflow_items
         SET label = $1, category = $2, day_of_month = $3, amount = $4, note = $5,
             version = version + 1, updated_by = $6, updated_at = now(),
             amount_updated_by = CASE WHEN $7::boolean THEN $6 ELSE amount_updated_by END,
             amount_updated_at = CASE WHEN $7::boolean THEN now() ELSE amount_updated_at END
         WHERE id = $8
         RETURNING *`,
        [nextVals.label, nextVals.category, nextVals.day_of_month, nextVals.amount, nextVals.note,
         req.user.user_id, amountChanged, id]
      );
      updated = result.rows[0];

      await client.query(
        `INSERT INTO cashflow_history (item_id, organization_id, change_type, old_values, new_values, reason, changed_by)
         VALUES ($1, $2, 'update', $3, $4, $5, $6)`,
        [id, orgId, JSON.stringify(oldVals), JSON.stringify(nextVals), reason, req.user.user_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: null,
      organizationId: orgId,
      action: 'cashflow.update',
      entityType: 'cashflow_item',
      entityId: id,
      metadata: { changed_fields: changedFields },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function archiveItem(req, res, next) {
  try {
    const orgId = orgIdOf(req, res);
    if (!orgId) return;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id.' });
    const body = req.body || {};

    const expectedVersion = Number(body.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return res.status(400).json({ error: 'expected_version is required.' });
    }
    const reason = readReason(body.reason);
    if (!reason) return res.status(400).json({ error: 'A reason of at least 5 characters is required.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM cashflow_items
         WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
         FOR UPDATE`,
        [id, orgId]
      );
      const before = current.rows[0];
      if (!before) return await fail(client, res, 404, 'Item not found.');
      if (before.version !== expectedVersion) {
        return await fail(client, res, 409, 'This item was changed by someone else. Refresh and try again.');
      }

      await client.query(
        `UPDATE cashflow_items
         SET archived_at = now(), archived_by = $1, version = version + 1, updated_by = $1, updated_at = now()
         WHERE id = $2`,
        [req.user.user_id, id]
      );
      await client.query(
        `INSERT INTO cashflow_history (item_id, organization_id, change_type, old_values, new_values, reason, changed_by)
         VALUES ($1, $2, 'archive', $3, NULL, $4, $5)`,
        [id, orgId, JSON.stringify(snapshot(before)), reason, req.user.user_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: null,
      organizationId: orgId,
      action: 'cashflow.archive',
      entityType: 'cashflow_item',
      entityId: id,
      metadata: {},
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { listCashflow, listHistory, createItem, updateItem, archiveItem };
