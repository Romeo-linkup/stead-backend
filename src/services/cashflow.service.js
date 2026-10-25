const TZ = 'Africa/Johannesburg';
const MAX_CENTS = 10000000000; // R100,000,000.00

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Accepts a pg Date (local midnight) or a 'YYYY-MM-DD' string. Returns 'YYYY-MM-DD' or null.
function ymdOf(value) {
  if (!value) return null;
  if (value instanceof Date) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  return String(value).slice(0, 10);
}

function isValidYmd(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
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

// Number of due dates that fall after fromYmd and on or before toYmd. Day 29-31 clamps to the month's last day.
function dueDatesPassed(day, fromYmd, toYmd) {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  const from = fy * 10000 + fm * 100 + fd;
  const to = ty * 10000 + tm * 100 + td;
  let count = 0;
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const due = y * 10000 + m * 100 + Math.min(day, lastDay);
    if (due > from && due <= to) count += 1;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return count;
}

// Bond progress, worked out from the due dates that have passed since the baseline date.
function bondProgress(row, today = todayYmd()) {
  const baseline = ymdOf(row.bond_baseline_on);
  if (row.category !== 'bond_payment' || row.kind === 'one_off' || row.bond_months_remaining == null || !baseline) return null;
  const monthly = numericToCents(row.amount);
  const elapsed = Math.min(row.bond_months_remaining, dueDatesPassed(row.day_of_month, baseline, today));
  const left = row.bond_months_remaining - elapsed;
  return {
    months_remaining: left,
    paid: centsToString(numericToCents(row.bond_paid_before || '0') + elapsed * monthly),
    remaining: centsToString(left * monthly),
    completed: left === 0,
  };
}

function snapshot(row, today = todayYmd()) {
  const bond = bondProgress(row, today);
  return {
    label: row.label,
    category: row.category,
    day_of_month: row.day_of_month,
    amount: row.amount,
    note: row.note || null,
    property_id: row.property_id ?? null,
    kind: row.kind || 'monthly',
    paid_on: ymdOf(row.paid_on),
    bond_months_remaining: bond ? bond.months_remaining : null,
  };
}

// Records a maintenance payment as a one-off expense. Safe to call twice for the same sourceRef.
// db can be a pool or a transaction client.
async function recordMaintenanceExpense(db, { organizationId, propertyId, amount, label, sourceRef, userId, paidOn, note }) {
  if (!propertyId) {
    console.warn('[cashflow] maintenance expense not recorded: no property', sourceRef);
    return { skipped: 'no_property' };
  }
  const cents = parseAmountToCents(amount);
  if (!cents) {
    console.warn('[cashflow] maintenance expense not recorded: invalid amount', sourceRef);
    return { skipped: 'bad_amount' };
  }
  const paid = paidOn || todayYmd();
  const day = Number(paid.slice(8, 10));
  const inserted = await db.query(
    `INSERT INTO cashflow_items
       (organization_id, property_id, direction, category, label, amount, day_of_month, note, source, source_ref,
        kind, paid_on, created_by, updated_by, amount_updated_by)
     VALUES ($1, $2, 'out', 'maintenance', $3, $4, $5, $6, 'maintenance', $7, 'one_off', $8, $9, $9, $9)
     ON CONFLICT (organization_id, source_ref) WHERE source_ref IS NOT NULL AND archived_at IS NULL DO NOTHING
     RETURNING *`,
    [organizationId, propertyId, String(label).slice(0, 100), centsToString(cents), day, note || null, sourceRef, paid, userId]
  );
  const row = inserted.rows[0];
  if (!row) return { skipped: 'duplicate' };
  await db.query(
    `INSERT INTO cashflow_history (item_id, organization_id, change_type, old_values, new_values, reason, changed_by)
     VALUES ($1, $2, 'create', NULL, $3, $4, $5)`,
    [row.id, organizationId, JSON.stringify(snapshot(row)), 'Recorded automatically when the maintenance payment was marked paid', userId]
  );
  return { id: row.id };
}

module.exports = {
  todayYmd, ymdOf, isValidYmd, parseAmountToCents, numericToCents, centsToString,
  dueDatesPassed, bondProgress, snapshot, recordMaintenanceExpense,
};
