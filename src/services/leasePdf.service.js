// src/services/leasePdf.service.js — renders a signed lease as a PDF Buffer.
// Mirrors the on-screen lease rendering in pdf.service.js (renderLeaseHtml):
// same clause order, same fallbacks, same generated sections.
const PDFDocument = require('pdfkit');
const pool = require('../db/pool');

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const MAX_SIGNATURE_BYTES = 1024 * 1024;

// Same clause text and order as the on-screen lease (pdf.service.js
// renderLeaseHtml / admin leases.page.js CLAUSES).
const CLAUSE_FALLBACKS = {
  additional_charges: 'The tenant shall be responsible for utilities and services as specified in the schedule.',
  payments: "Rent shall be paid by electronic transfer to the landlord's designated bank account. The tenant shall provide proof of payment upon request.",
  pets: "No pets shall be kept on the premises without the landlord's prior written consent.",
  assignment_subletting: "The tenant shall not assign or sublet the premises without the landlord's prior written consent.",
  sundry_duties: 'The tenant shall keep the premises in a clean and habitable condition, and shall comply with all reasonable rules and regulations of the property.',
  maintenance: 'The landlord shall be responsible for structural maintenance, while the tenant shall be responsible for day-to-day maintenance and minor repairs.',
  special_remedy: 'In the event of breach, the landlord shall have all remedies available at law and equity, including but not limited to eviction and damages.',
  option_of_renewal: 'This lease may be renewed upon mutual agreement of both parties, subject to rent adjustment and terms to be negotiated.',
};

function parseTerms(lease) {
  let terms = {};
  try {
    const parsed = typeof lease.terms_json === 'string'
      ? JSON.parse(lease.terms_json)
      : lease.terms_json;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      terms = parsed;
    }
  } catch {
    terms = {};
  }
  return terms;
}

function formatDate(value) {
  if (value == null || value === '') return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-ZA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatCurrency(amount) {
  if (amount == null || amount === '') return '';
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  return `R${value.toLocaleString('en-ZA')}`;
}

// The 12 sections exactly as the on-screen lease renders them: the 8
// clauses from terms_json (with the same fallbacks) plus the generated
// duration, rent, deposit and cancellation sections that carry the key
// amounts (rent, deposit, notice period, penalty).
function buildSections(lease) {
  const terms = parseTerms(lease);
  const clauseText = (key) => (typeof terms[key] === 'string' && terms[key] !== ''
    ? terms[key]
    : CLAUSE_FALLBACKS[key]);

  const cancellationNotice = Number.isInteger(terms.notice_period_months)
    && terms.notice_period_months >= 1
    && terms.notice_period_months <= 12
    ? `Either party may terminate this lease by giving ${terms.notice_period_months} calendar months' written notice.`
    : `Either party may terminate this lease by giving ${lease.cancellation_notice_days == null ? '30' : lease.cancellation_notice_days} days' written notice.`;
  const cancellationPenalty = lease.cancellation_penalty == null || lease.cancellation_penalty === ''
    ? ''
    : ` A cancellation penalty of ${formatCurrency(lease.cancellation_penalty)} shall apply for early termination.`;

  const rentText = `The monthly rental shall be ${formatCurrency(lease.rent_amount)}, payable in advance on the first day of each month.`
    + (lease.rent_increase_pct == null || lease.rent_increase_pct === ''
      ? ''
      : ` The rent may be increased by ${lease.rent_increase_pct}% upon renewal.`);

  return [
    [1, 'DURATION', `This lease shall commence on ${formatDate(lease.start_date)} and continue for a period of ${lease.duration_months} months, expiring on ${formatDate(lease.end_date)}.`],
    [2, 'RENT', rentText],
    [3, 'ADDITIONAL CHARGES', clauseText('additional_charges')],
    [4, 'PAYMENTS', clauseText('payments')],
    [5, 'DEPOSIT', `A deposit of ${formatCurrency(lease.deposit_amount)} shall be paid prior to occupation. This deposit shall be returned within 14 days of lease termination, less any deductions for damages or outstanding amounts.`],
    [6, 'CANCELLATION', `${cancellationNotice}${cancellationPenalty}`],
    [7, 'PETS', clauseText('pets')],
    [8, 'ASSIGNMENT & SUBLETTING', clauseText('assignment_subletting')],
    [9, 'SUNDRY DUTIES', clauseText('sundry_duties')],
    [10, 'MAINTENANCE', clauseText('maintenance')],
    [11, 'SPECIAL REMEDY', clauseText('special_remedy')],
    [12, 'OPTION OF RENEWAL', clauseText('option_of_renewal')],
  ];
}

async function loadLeaseForPdf(leaseId) {
  const { rows } = await pool.query(
    `SELECT l.*, u.unit_number, u.tenant_user_id, p.name AS property_name,
            p.district_id, d.organization_id
     FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     JOIN districts d ON d.id = p.district_id
     WHERE l.id = $1`,
    [leaseId]
  );
  return rows[0] || null;
}

async function loadBusinessName(organizationId) {
  const { rows } = await pool.query(
    'SELECT business_name FROM app_settings WHERE organization_id = $1',
    [organizationId]
  );
  return rows[0]?.business_name || 'Stead';
}

async function fetchSignatureImage(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_SIGNATURE_BYTES) return null;
    return buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function scopedError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function drawSignatureBlock(doc, label, name, signedAt, imageBuffer) {
  doc.font('Times-Bold').fontSize(11);
  doc.text(`${label}: ${name || ''}`);
  doc.moveDown(0.5);
  if (imageBuffer) {
    doc.image(imageBuffer, { fit: [160, 60] });
  } else {
    doc.font('Times-Italic').fontSize(11);
    doc.text('[signature on file]');
  }
  doc.moveDown(0.5);
  doc.font('Times-Roman').fontSize(10);
  const signed = formatDate(signedAt);
  doc.text(signed ? `Signed: ${signed}` : 'Not yet signed');
}

function renderPdf({ lease, businessName, sections, images, totalPages }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks = [];
    let pages = 1;

    const drawFooter = () => {
      const y = PAGE_HEIGHT - 40;
      doc.font('Times-Roman').fontSize(9).fillColor('#5B6570');
      doc.text(`Electronically signed on Stead. Lease reference ${lease.id}.`, MARGIN, y, { align: 'center', width: CONTENT_WIDTH });
      doc.text(totalPages ? `Page ${pages} of ${totalPages}` : `Page ${pages}`, MARGIN, y + 12, { align: 'center', width: CONTENT_WIDTH });
      doc.fillColor('#1C2321');
    };

    const newPage = () => {
      drawFooter();
      doc.addPage();
      pages += 1;
    };

    // Avoid splitting a clause across pages where practical: estimate the
    // space a section needs and start a new page before writing it.
    const ensureSpace = (needed) => {
      if (doc.y + needed > PAGE_HEIGHT - MARGIN) {
        newPage();
      }
    };

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages }));
    doc.on('error', reject);

    // Header
    doc.font('Times-Bold').fontSize(13);
    doc.text(businessName, { align: 'center' });
    doc.moveDown();
    doc.fontSize(20);
    doc.text('AGREEMENT OF LEASE', { align: 'center' });
    doc.font('Times-Roman').fontSize(12);
    doc.text('(APARTMENT)', { align: 'center' });
    doc.moveDown(2);

    // Parties
    doc.font('Times-Bold').fontSize(12);
    doc.text('PARTIES');
    doc.moveDown(0.5);
    doc.font('Times-Roman').fontSize(11);
    doc.text(`LESSOR (Landlord): ${lease.lessor_name || ''}`);
    doc.text(`LESSEE (Tenant): ${lease.lessee_name || ''}`);
    doc.moveDown(2);

    // Clauses
    for (const [number, title, text] of sections) {
      const estimatedLines = Math.max(1, Math.ceil(String(text).length / 80));
      ensureSpace(24 + estimatedLines * 14);
      doc.font('Times-Bold').fontSize(12);
      doc.text(`${number}. ${title}`);
      doc.moveDown(0.3);
      doc.font('Times-Roman').fontSize(11);
      doc.text(String(text), { width: CONTENT_WIDTH });
      doc.moveDown();
    }

    // Signatures
    ensureSpace(240);
    doc.font('Times-Bold').fontSize(12);
    doc.text('SIGNATURES');
    doc.moveDown();
    drawSignatureBlock(doc, 'LESSOR', lease.lessor_name, lease.lessor_signed_at, images.lessor);
    doc.moveDown(2);
    drawSignatureBlock(doc, 'LESSEE', lease.lessee_name, lease.signed_at, images.lessee);

    drawFooter();
    doc.end();
  });
}

async function buildLeasePdf(leaseId, organizationId) {
  const lease = await loadLeaseForPdf(leaseId);
  if (!lease) {
    throw scopedError('Lease not found.', 404);
  }
  if (Number(lease.organization_id) !== Number(organizationId)) {
    throw scopedError('Not found.', 404);
  }
  if (!['signed', 'superseded'].includes(lease.status)) {
    throw scopedError('Only signed leases have a PDF.', 409);
  }

  const businessName = await loadBusinessName(organizationId);
  const sections = buildSections(lease);
  const images = {
    lessor: await fetchSignatureImage(lease.lessor_signature_url),
    lessee: await fetchSignatureImage(lease.signature_image_url),
  };

  // First pass counts the pages (output discarded); the second pass
  // renders the final buffer with the real "Page X of Y" footer.
  const firstPass = await renderPdf({ lease, businessName, sections, images, totalPages: 0 });
  return renderPdf({ lease, businessName, sections, images, totalPages: firstPass.pages })
    .then((result) => result.buffer);
}

module.exports = { buildLeasePdf };
