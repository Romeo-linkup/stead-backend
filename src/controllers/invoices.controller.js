const pool = require('../db/pool');
const { writeAudit } = require('../services/audit.service');
const { uploadImage } = require('../services/cloudinary.service');

const MANAGEMENT_ROLES = ['owner', 'admin', 'property_manager'];
const INVOICE_STATUSES = ['submitted', 'approved', 'rejected', 'paid'];
const MAX_TOTAL_CENTS = 1000000000;

function parseId(raw) {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function toCents(value) {
  const text = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) {
    throw badRequest('Amount must be a non-negative number with at most 2 decimals.');
  }
  const [whole = '0', fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw badRequest('Amount must be a non-negative number with at most 2 decimals.');
  }
  return cents;
}

function parseDecimal(value, field) {
  const text = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) {
    throw badRequest(`${field} must be a number with at most 2 decimals.`);
  }
  const number = Number(text);
  if (!Number.isFinite(number)) throw badRequest(`${field} must be a valid number.`);
  return number;
}

function fmt(cents) {
  return (cents / 100).toFixed(2);
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    throw badRequest('items must contain between 1 and 30 entries.');
  }

  let totalCents = 0;
  const validatedItems = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest('Each item must be an object.');
    }
    if (typeof item.description !== 'string') {
      throw badRequest('Item description must be between 1 and 200 characters.');
    }
    const description = item.description.trim();
    if (!description || description.length > 200) {
      throw badRequest('Item description must be between 1 and 200 characters.');
    }

    const qty = parseDecimal(item.qty, 'qty');
    if (qty <= 0 || qty > 10000) {
      throw badRequest('qty must be greater than 0 and no more than 10000.');
    }
    const qtyHundredths = Math.round(qty * 100);
    const priceCents = toCents(item.unit_price);
    if (priceCents > 1000000000) {
      throw badRequest('unit_price must not exceed 10000000.00.');
    }
    const lineCents = Math.round(qtyHundredths * priceCents / 100);
    totalCents += lineCents;
    if (totalCents > MAX_TOTAL_CENTS) {
      throw badRequest('Invoice total must not exceed 10000000.00.');
    }

    return {
      description,
      qty: (qtyHundredths / 100).toFixed(2),
      unit_price: fmt(priceCents),
      line_total: fmt(lineCents),
      lineCents,
    };
  });

  if (totalCents <= 0) throw badRequest('Invoice total must be greater than 0.');
  return { items: validatedItems, totalCents };
}

async function hydrate(rows) {
  if (!rows.length) return [];
  const invoiceIds = rows.map((invoice) => invoice.id);
  const [itemsResult, receiptsResult] = await Promise.all([
    pool.query(
      `SELECT invoice_id, description, qty, unit_price, line_total
       FROM invoice_items
       WHERE invoice_id = ANY($1)
       ORDER BY invoice_id, position`,
      [invoiceIds]
    ),
    pool.query(
      `SELECT id, invoice_id, image_url
       FROM invoice_receipts
       WHERE invoice_id = ANY($1)
       ORDER BY invoice_id, id`,
      [invoiceIds]
    ),
  ]);

  const itemsByInvoice = new Map(invoiceIds.map((id) => [id, []]));
  const receiptsByInvoice = new Map(invoiceIds.map((id) => [id, []]));
  for (const item of itemsResult.rows) {
    itemsByInvoice.get(item.invoice_id)?.push({
      description: item.description,
      qty: item.qty,
      unit_price: item.unit_price,
      line_total: item.line_total,
    });
  }
  for (const receipt of receiptsResult.rows) {
    receiptsByInvoice.get(receipt.invoice_id)?.push({ id: receipt.id, image_url: receipt.image_url });
  }
  return rows.map((invoice) => ({
    ...invoice,
    items: itemsByInvoice.get(invoice.id) || [],
    receipts: receiptsByInvoice.get(invoice.id) || [],
  }));
}

async function createInvoice(req, res, next) {
  try {
    const maintenanceRequestId = parseId(req.body?.maintenance_request_id);
    if (!maintenanceRequestId) return res.status(400).json({ error: 'Invalid id.' });

    const toParty = typeof req.body.to_party === 'string' ? req.body.to_party.trim() : '';
    if (!toParty || toParty.length > 120) {
      return res.status(400).json({ error: 'to_party must be between 1 and 120 characters.' });
    }
    const payoutAccount = typeof req.body.payout_account === 'string' ? req.body.payout_account.trim() : '';
    if (!payoutAccount || payoutAccount.length > 160) {
      return res.status(400).json({ error: 'payout_account must be between 1 and 160 characters.' });
    }
    if (req.body.note !== undefined && (typeof req.body.note !== 'string' || req.body.note.trim().length > 600)) {
      return res.status(400).json({ error: 'note must be a string of at most 600 characters.' });
    }
    let validated;
    try {
      validated = validateItems(req.body.items);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }

    const requestResult = await pool.query(
      `SELECT mr.id, mr.assigned_to, mr.status, p.district_id
       FROM maintenance_requests mr
       JOIN units u ON u.id = mr.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE mr.id = $1`,
      [maintenanceRequestId]
    );
    const maintenanceRequest = requestResult.rows[0];
    if (!maintenanceRequest) return res.status(404).json({ error: 'Maintenance request not found.' });
    if (maintenanceRequest.assigned_to !== req.user.user_id) {
      return res.status(403).json({ error: 'You can only invoice tasks assigned to you.' });
    }
    if (!['pending', 'finished'].includes(maintenanceRequest.status)) {
      return res.status(409).json({ error: 'Invoices can be added once you have accepted the task.' });
    }

    const client = await pool.connect();
    let transactionStarted = false;
    let invoice;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const invoiceResult = await client.query(
        `INSERT INTO invoices
           (maintenance_request_id, provider_user_id, district_id, to_party, note,
            payout_account, total, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted')
         RETURNING *`,
        [
          maintenanceRequestId,
          req.user.user_id,
          maintenanceRequest.district_id,
          toParty,
          req.body.note == null ? null : req.body.note.trim(),
          payoutAccount,
          fmt(validated.totalCents),
        ]
      );
      invoice = invoiceResult.rows[0];

      const itemValues = [];
      const itemParams = [];
      validated.items.forEach((item, position) => {
        const offset = itemParams.length;
        itemValues.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`);
        itemParams.push(
          invoice.id,
          position,
          item.description,
          item.qty,
          item.unit_price,
          item.line_total
        );
      });
      await client.query(
        `INSERT INTO invoice_items (invoice_id, position, description, qty, unit_price, line_total)
         VALUES ${itemValues.join(', ')}`,
        itemParams
      );
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      transactionStarted = false;
      if (error.code === '23505') {
        return res.status(409).json({ error: 'An invoice is already active for this task.' });
      }
      throw error;
    } finally {
      client.release();
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: maintenanceRequest.district_id,
      action: 'invoice.submit',
      entityType: 'invoice',
      entityId: invoice.id,
      metadata: { maintenance_request_id: maintenanceRequestId, total: fmt(validated.totalCents) },
    });
    res.status(201).json((await hydrate([invoice]))[0]);
  } catch (error) {
    next(error);
  }
}

async function addReceipt(req, res, next) {
  try {
  const invoiceId = parseId(req.params.id);
  if (!invoiceId) return res.status(400).json({ error: 'Invalid id.' });
  if (!req.file) return res.status(400).json({ error: 'Receipt image is required.' });

  const client = await pool.connect();
  let transactionStarted = false;
  let invoice;
  let receipt;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const invoiceResult = await client.query(
      `SELECT id, maintenance_request_id, district_id, status
       FROM invoices
       WHERE id = $1 AND provider_user_id = $2
       FOR UPDATE`,
      [invoiceId, req.user.user_id]
    );
    invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (invoice.status !== 'submitted') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ error: 'Receipts can only be added while the invoice is awaiting review.' });
    }

    const receiptCountResult = await client.query(
      'SELECT count(*)::int AS count FROM invoice_receipts WHERE invoice_id = $1',
      [invoiceId]
    );
    if (receiptCountResult.rows[0].count >= 5) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ error: 'A maximum of 5 receipts can be attached.' });
    }

    let imageUrl;
    try {
      imageUrl = await uploadImage(req.file.buffer, 'stead/receipts');
    } catch (error) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Receipt upload failed.' });
    }
    const inserted = await client.query(
      `INSERT INTO invoice_receipts (invoice_id, image_url)
       VALUES ($1, $2)
       RETURNING id, image_url`,
      [invoiceId, imageUrl]
    );
    receipt = inserted.rows[0];
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    next(error);
    return;
  } finally {
    client.release();
  }

  await writeAudit({
    actorId: req.user.user_id,
    actorRole: req.user.role,
    districtId: invoice.district_id,
    action: 'invoice.receipt_add',
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { maintenance_request_id: invoice.maintenance_request_id },
  });
  res.status(201).json(receipt);
  } catch (error) {
    next(error);
  }
}

async function withdrawInvoice(req, res, next) {
  try {
    const invoiceId = parseId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid id.' });
    const result = await pool.query(
      `DELETE FROM invoices
       WHERE id = $1 AND provider_user_id = $2 AND status = 'submitted'
       RETURNING maintenance_request_id, district_id`,
      [invoiceId, req.user.user_id]
    );
    const invoice = result.rows[0];
    if (!invoice) {
      const existing = await pool.query(
        'SELECT id, status FROM invoices WHERE id = $1 AND provider_user_id = $2',
        [invoiceId, req.user.user_id]
      );
      if (!existing.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
      return res.status(409).json({ error: 'Only invoices awaiting review can be withdrawn.' });
    }

    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: invoice.district_id,
      action: 'invoice.withdraw',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { maintenance_request_id: invoice.maintenance_request_id },
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

async function listInvoices(req, res, next) {
  try {
    const conditions = [];
    const params = [];
    if (req.query.status !== undefined) {
      if (!INVOICE_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: 'Invalid invoice status.' });
      }
      params.push(req.query.status);
      conditions.push(`i.status = $${params.length}`);
    }
    if (req.query.maintenance_request_id !== undefined) {
      const maintenanceRequestId = parseId(req.query.maintenance_request_id);
      if (!maintenanceRequestId) return res.status(400).json({ error: 'Invalid id.' });
      params.push(maintenanceRequestId);
      conditions.push(`i.maintenance_request_id = $${params.length}`);
    }

    if (req.user.role === 'service_provider') {
      params.push(req.user.user_id);
      conditions.push(`i.provider_user_id = $${params.length}`);
    } else if (req.user.role === 'admin' || req.user.role === 'property_manager') {
      params.push(req.user.district_id);
      conditions.push(`i.district_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT i.id, i.maintenance_request_id, i.status, i.to_party, i.note,
              i.payout_account, i.total, i.review_note, i.reviewed_at, i.paid_at,
              i.created_at, m.category AS task_category,
              left(m.description, 200) AS task_description, u.unit_number,
              p.name AS property_name, pu.name AS provider_name
       FROM invoices i
       JOIN maintenance_requests m ON m.id = i.maintenance_request_id
       JOIN units u ON u.id = m.unit_id
       JOIN properties p ON p.id = u.property_id
       JOIN users pu ON pu.id = i.provider_user_id
       ${where}
       ORDER BY i.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(await hydrate(rows));
  } catch (error) {
    next(error);
  }
}

async function loadManagedInvoice(invoiceId, user, res) {
  const { rows } = await pool.query(
    `SELECT id, maintenance_request_id, district_id, status
     FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const invoice = rows[0];
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found.' });
    return null;
  }
  if (user.role !== 'owner' && invoice.district_id !== user.district_id) {
    res.status(403).json({ error: 'You can only manage invoices in your district.' });
    return null;
  }
  return invoice;
}

async function approveInvoice(req, res, next) {
  try {
    const invoiceId = parseId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid id.' });
    const invoice = await loadManagedInvoice(invoiceId, req.user, res);
    if (!invoice) return;
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status = 'approved', reviewed_by = $1, reviewed_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'submitted'
       RETURNING *`,
      [req.user.user_id, invoiceId]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Only invoices awaiting review can be approved.' });
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: invoice.district_id,
      action: 'invoice.approve',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { maintenance_request_id: invoice.maintenance_request_id },
    });
    res.json((await hydrate(rows))[0]);
  } catch (error) {
    next(error);
  }
}

async function rejectInvoice(req, res, next) {
  try {
    const invoiceId = parseId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid id.' });
    const invoice = await loadManagedInvoice(invoiceId, req.user, res);
    if (!invoice) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 300) {
      return res.status(400).json({ error: 'reason must be between 1 and 300 characters.' });
    }
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status = 'rejected', review_note = $1, reviewed_by = $2,
           reviewed_at = now(), updated_at = now()
       WHERE id = $3 AND status = 'submitted'
       RETURNING *`,
      [reason, req.user.user_id, invoiceId]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Only invoices awaiting review can be rejected.' });
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: invoice.district_id,
      action: 'invoice.reject',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { maintenance_request_id: invoice.maintenance_request_id },
    });
    res.json((await hydrate(rows))[0]);
  } catch (error) {
    next(error);
  }
}

async function markInvoicePaid(req, res, next) {
  try {
    const invoiceId = parseId(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Invalid id.' });
    const invoice = await loadManagedInvoice(invoiceId, req.user, res);
    if (!invoice) return;
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status = 'paid', paid_by = $1, paid_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'approved'
       RETURNING *`,
      [req.user.user_id, invoiceId]
    );
    if (!rows[0]) {
      if (invoice.status !== 'approved') {
        return res.status(409).json({ error: 'Approve the invoice before marking it paid.' });
      }
      return res.status(409).json({ error: 'Only approved invoices can be marked paid.' });
    }
    await writeAudit({
      actorId: req.user.user_id,
      actorRole: req.user.role,
      districtId: invoice.district_id,
      action: 'invoice.mark_paid',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { maintenance_request_id: invoice.maintenance_request_id },
    });
    res.json((await hydrate(rows))[0]);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createInvoice,
  addReceipt,
  withdrawInvoice,
  listInvoices,
  approveInvoice,
  rejectInvoice,
  markInvoicePaid,
};
