// src/services/pdf.service.js — renders lease document as HTML
// Uses Newsreader serif font for document look, matching Section 7 design tokens

function renderLeaseHtml(lease) {
  let terms = {};
  try {
    const parsedTerms = typeof lease.terms_json === 'string'
      ? JSON.parse(lease.terms_json)
      : lease.terms_json;
    if (parsedTerms && typeof parsedTerms === 'object' && !Array.isArray(parsedTerms)) {
      terms = parsedTerms;
    }
  } catch {
    terms = {};
  }

  const formatDate = (date) => {
    if (date == null || date === '') return '';
    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) return '';
    return parsedDate.toLocaleDateString('en-ZA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatCurrency = (amount) => {
    if (amount == null || amount === '') return '';
    const value = Number(amount);
    if (!Number.isFinite(value)) return '';
    return `R${value.toLocaleString('en-ZA')}`;
  };

  const clause = (key, fallback) => escapeHtml(terms[key] || fallback);
  const status = String(lease.status == null ? '' : lease.status);
  const cancellationNotice = Number.isInteger(terms.notice_period_months)
    && terms.notice_period_months >= 1
    && terms.notice_period_months <= 12
    ? `Either party may terminate this lease by giving ${terms.notice_period_months} calendar months' written notice.`
    : `Either party may terminate this lease by giving ${lease.cancellation_notice_days == null ? '30' : lease.cancellation_notice_days} days' written notice.`;
  const cancellationPenalty = lease.cancellation_penalty == null || lease.cancellation_penalty === ''
    ? ''
    : ` A cancellation penalty of ${formatCurrency(lease.cancellation_penalty)} shall apply for early termination.`;
  const lessorSignatureImage = typeof lease.lessor_signature_url === 'string'
    && lease.lessor_signature_url.startsWith('https://')
    ? `<img class="sig-img" src="${escapeHtml(lease.lessor_signature_url)}" alt="Lessor signature" style="max-height:80px;display:block;">`
    : '';
  const lesseeSignatureImage = typeof lease.signature_image_url === 'string'
    && lease.signature_image_url.startsWith('https://')
    ? `<img class="sig-img" src="${escapeHtml(lease.signature_image_url)}" alt="Lessee signature" style="max-height:80px;display:block;">`
    : '';

  return `<div class="lease-doc">
  <style>
    .lease-doc {
      background: #fff;
      color: #1C2321;
      color-scheme: light;
      font-family: 'Newsreader', Georgia, serif;
      max-width: 800px;
      margin: 0 auto;
      padding: clamp(20px, 5vw, 60px);
      box-sizing: border-box;
      border: 1px solid #DAD3C2;
      border-radius: 4px;
      line-height: 1.6;
    }
    .lease-doc h1 {
      font-size: 28px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 8px;
      color: #1C2321;
    }
    .lease-doc .subtitle {
      text-align: center;
      font-size: 14px;
      color: #5B6570;
      margin-bottom: 40px;
      font-style: italic;
    }
    .lease-doc .section {
      margin-bottom: 32px;
    }
    .lease-doc h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #1C2321;
    }
    .lease-doc .parties {
      margin-bottom: 32px;
      padding: 20px;
      background: #F6F4EE;
      border-radius: 4px;
    }
    .lease-doc .party {
      margin-bottom: 16px;
    }
    .lease-doc .party-label {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
    }
    .lease-doc .party-details {
      font-size: 14px;
      line-height: 1.5;
    }
    .lease-doc .clause {
      margin-bottom: 20px;
    }
    .lease-doc .clause-number {
      font-weight: 600;
      margin-right: 8px;
    }
    .lease-doc .clause-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    .lease-doc .clause-content {
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .lease-doc .signature-section {
      margin-top: 48px;
      padding-top: 32px;
      border-top: 1px solid #DAD3C2;
    }
    .lease-doc .signature-block {
      margin-bottom: 32px;
    }
    .lease-doc .signature-line {
      border-bottom: 1px solid #1C2321;
      margin-top: 40px;
      margin-bottom: 8px;
    }
    .lease-doc .signature-label {
      font-size: 12px;
      color: #5B6570;
    }
    .lease-doc .sig-img {
      max-height: 80px;
      display: block;
    }
    .lease-doc .status {
      text-align: center;
      padding: 12px;
      margin-bottom: 24px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 14px;
    }
    .lease-doc .status.draft {
      background: #EDE8DC;
      color: #5B6570;
    }
    .lease-doc .status.sent {
      background: #FEF3E2;
      color: #A8823A;
    }
    .lease-doc .status.signed {
      background: #E8F5E9;
      color: #3F6B4E;
    }
    .lease-doc .status.expired {
      background: #FEE2E2;
      color: #A14E3B;
    }
    .lease-doc .status.superseded {
      background: #EDE8DC;
      color: #5B6570;
    }
  </style>
    <h1>RESIDENTIAL LEASE AGREEMENT</h1>
    <div class="subtitle">This agreement is made and entered into on ${escapeHtml(formatDate(lease.created_at))}</div>
    
    <div class="status ${escapeHtml(status)}">${escapeHtml(status.toUpperCase())}</div>
    
    <div class="parties">
      <div class="party">
        <div class="party-label">LESSOR (Landlord)</div>
        <div class="party-details">
          ${escapeHtml(lease.lessor_name)}<br>
          ID Number: ${escapeHtml(lease.lessor_id_number)}
        </div>
      </div>
      <div class="party">
        <div class="party-label">LESSEE (Tenant)</div>
        <div class="party-details">
          ${escapeHtml(lease.lessee_name)}<br>
          ID Number: ${escapeHtml(lease.lessee_id_number)}
        </div>
      </div>
    </div>
    
    <div class="section">
      <h2>1. DURATION</h2>
      <div class="clause-content">
        This lease shall commence on ${escapeHtml(formatDate(lease.start_date))} and continue for a period of ${escapeHtml(lease.duration_months)} months, expiring on ${escapeHtml(formatDate(lease.end_date))}.
      </div>
    </div>
    
    <div class="section">
      <h2>2. RENT</h2>
      <div class="clause-content">
        The monthly rental shall be ${escapeHtml(formatCurrency(lease.rent_amount))}, payable in advance on the first day of each month.
        ${lease.rent_increase_pct == null || lease.rent_increase_pct === '' ? '' : ` The rent may be increased by ${escapeHtml(lease.rent_increase_pct)}% upon renewal.`}
      </div>
    </div>
    
    <div class="section">
      <h2>3. ADDITIONAL CHARGES</h2>
      <div class="clause-content">
        ${clause('additional_charges', 'The tenant shall be responsible for utilities and services as specified in the schedule.')}
      </div>
    </div>
    
    <div class="section">
      <h2>4. PAYMENTS</h2>
      <div class="clause-content">
        ${clause('payments', 'Rent shall be paid by electronic transfer to the landlord\'s designated bank account. The tenant shall provide proof of payment upon request.')}
      </div>
    </div>
    
    <div class="section">
      <h2>5. DEPOSIT</h2>
      <div class="clause-content">
        A deposit of ${escapeHtml(formatCurrency(lease.deposit_amount))} shall be paid prior to occupation. This deposit shall be returned within 14 days of lease termination, less any deductions for damages or outstanding amounts.
      </div>
    </div>
    
    <div class="section">
      <h2>6. CANCELLATION</h2>
      <div class="clause-content">
        ${escapeHtml(cancellationNotice)}${escapeHtml(cancellationPenalty)}
      </div>
    </div>
    
    <div class="section">
      <h2>7. PETS</h2>
      <div class="clause-content">
        ${clause('pets', 'No pets shall be kept on the premises without the landlord\'s prior written consent.')}
      </div>
    </div>
    
    <div class="section">
      <h2>8. ASSIGNMENT & SUBLETTING</h2>
      <div class="clause-content">
        ${clause('assignment_subletting', 'The tenant shall not assign or sublet the premises without the landlord\'s prior written consent.')}
      </div>
    </div>
    
    <div class="section">
      <h2>9. SUNDRY DUTIES</h2>
      <div class="clause-content">
        ${clause('sundry_duties', 'The tenant shall keep the premises in a clean and habitable condition, and shall comply with all reasonable rules and regulations of the property.')}
      </div>
    </div>
    
    <div class="section">
      <h2>10. MAINTENANCE</h2>
      <div class="clause-content">
        ${clause('maintenance', 'The landlord shall be responsible for structural maintenance, while the tenant shall be responsible for day-to-day maintenance and minor repairs.')}
      </div>
    </div>
    
    <div class="section">
      <h2>11. SPECIAL REMEDY</h2>
      <div class="clause-content">
        ${clause('special_remedy', 'In the event of breach, the landlord shall have all remedies available at law and equity, including but not limited to eviction and damages.')}
      </div>
    </div>
    
    <div class="section">
      <h2>12. OPTION OF RENEWAL</h2>
      <div class="clause-content">
        ${clause('option_of_renewal', 'This lease may be renewed upon mutual agreement of both parties, subject to rent adjustment and terms to be negotiated.')}
      </div>
    </div>
    
    <div class="signature-section">
      <div class="signature-block">
        ${lessorSignatureImage}
        <div class="signature-line"></div>
        <div class="signature-label">LESSOR SIGNATURE</div>
        <div class="signature-label">${lessorSignatureImage ? `Signed: ${escapeHtml(formatDate(lease.lessor_signed_at))}` : 'Not yet signed'}</div>
      </div>
      <div class="signature-block">
        ${lesseeSignatureImage}
        <div class="signature-line"></div>
        <div class="signature-label">LESSEE SIGNATURE</div>
        <div class="signature-label">${lesseeSignatureImage ? `Signed: ${escapeHtml(formatDate(lease.signed_at))}` : 'Not yet signed'}</div>
      </div>
    </div>
  </div>`;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { renderLeaseHtml };
