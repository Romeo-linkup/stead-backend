// src/services/pdf.service.js — renders lease document as HTML
// Uses Newsreader serif font for document look, matching Section 7 design tokens

function renderLeaseHtml(lease) {
  const terms = typeof lease.terms_json === 'string' 
    ? JSON.parse(lease.terms_json) 
    : lease.terms_json || {};

  const formatDate = (date) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('en-ZA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatCurrency = (amount) => {
    if (!amount) return '';
    return `R${Number(amount).toLocaleString('en-ZA')}`;
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lease Agreement</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&display=swap');
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'Newsreader', Georgia, serif;
      background: #F6F4EE;
      color: #1C2321;
      line-height: 1.6;
      padding: 40px 20px;
    }
    
    .document {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      padding: 60px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    
    h1 {
      font-size: 28px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 8px;
      color: #1C2321;
    }
    
    .subtitle {
      text-align: center;
      font-size: 14px;
      color: #5B6570;
      margin-bottom: 40px;
      font-style: italic;
    }
    
    .section {
      margin-bottom: 32px;
    }
    
    h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #1C2321;
    }
    
    .parties {
      margin-bottom: 32px;
      padding: 20px;
      background: #F6F4EE;
      border-radius: 4px;
    }
    
    .party {
      margin-bottom: 16px;
    }
    
    .party-label {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
    }
    
    .party-details {
      font-size: 14px;
      line-height: 1.5;
    }
    
    .clause {
      margin-bottom: 20px;
    }
    
    .clause-number {
      font-weight: 600;
      margin-right: 8px;
    }
    
    .clause-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    
    .clause-content {
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    
    .signature-section {
      margin-top: 48px;
      padding-top: 32px;
      border-top: 1px solid #DAD3C2;
    }
    
    .signature-block {
      margin-bottom: 32px;
    }
    
    .signature-line {
      border-bottom: 1px solid #1C2321;
      margin-top: 40px;
      margin-bottom: 8px;
    }
    
    .signature-label {
      font-size: 12px;
      color: #5B6570;
    }
    
    .status {
      text-align: center;
      padding: 12px;
      margin-bottom: 24px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 14px;
    }
    
    .status.draft {
      background: #EDE8DC;
      color: #5B6570;
    }
    
    .status.sent {
      background: #FEF3E2;
      color: #A8823A;
    }
    
    .status.signed {
      background: #E8F5E9;
      color: #3F6B4E;
    }
    
    .status.expired {
      background: #FEE2E2;
      color: #A14E3B;
    }
  </style>
</head>
<body>
  <div class="document">
    <h1>RESIDENTIAL LEASE AGREEMENT</h1>
    <div class="subtitle">This agreement is made and entered into on ${formatDate(lease.created_at)}</div>
    
    <div class="status ${lease.status}">${lease.status.toUpperCase()}</div>
    
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
        This lease shall commence on ${formatDate(lease.start_date)} and continue for a period of ${lease.duration_months} months, expiring on ${formatDate(lease.end_date)}.
      </div>
    </div>
    
    <div class="section">
      <h2>2. RENT</h2>
      <div class="clause-content">
        The monthly rental shall be ${formatCurrency(lease.rent_amount)}, payable in advance on the first day of each month.
        ${lease.rent_increase_pct ? ` The rent may be increased by ${lease.rent_increase_pct}% upon renewal.` : ''}
      </div>
    </div>
    
    <div class="section">
      <h2>3. ADDITIONAL CHARGES</h2>
      <div class="clause-content">
        ${terms.additional_charges || 'The tenant shall be responsible for utilities and services as specified in the schedule.'}
      </div>
    </div>
    
    <div class="section">
      <h2>4. PAYMENTS</h2>
      <div class="clause-content">
        ${terms.payments || 'Rent shall be paid by electronic transfer to the landlord\'s designated bank account. The tenant shall provide proof of payment upon request.'}
      </div>
    </div>
    
    <div class="section">
      <h2>5. DEPOSIT</h2>
      <div class="clause-content">
        A deposit of ${formatCurrency(lease.deposit_amount)} shall be paid prior to occupation. This deposit shall be returned within 14 days of lease termination, less any deductions for damages or outstanding amounts.
      </div>
    </div>
    
    <div class="section">
      <h2>6. CANCELLATION</h2>
      <div class="clause-content">
        Either party may terminate this lease by giving ${lease.cancellation_notice_days || '30'} days\' written notice.
        ${lease.cancellation_penalty ? `A cancellation penalty of ${formatCurrency(lease.cancellation_penalty)} shall apply for early termination.` : ''}
      </div>
    </div>
    
    <div class="section">
      <h2>7. PETS</h2>
      <div class="clause-content">
        ${terms.pets || 'No pets shall be kept on the premises without the landlord\'s prior written consent.'}
      </div>
    </div>
    
    <div class="section">
      <h2>8. ASSIGNMENT & SUBLETTING</h2>
      <div class="clause-content">
        ${terms.assignment_subletting || 'The tenant shall not assign or sublet the premises without the landlord\'s prior written consent.'}
      </div>
    </div>
    
    <div class="section">
      <h2>9. SUNDRY DUTIES</h2>
      <div class="clause-content">
        ${terms.sundry_duties || 'The tenant shall keep the premises in a clean and habitable condition, and shall comply with all reasonable rules and regulations of the property.'}
      </div>
    </div>
    
    <div class="section">
      <h2>10. MAINTENANCE</h2>
      <div class="clause-content">
        ${terms.maintenance || 'The landlord shall be responsible for structural maintenance, while the tenant shall be responsible for day-to-day maintenance and minor repairs.'}
      </div>
    </div>
    
    <div class="section">
      <h2>11. SPECIAL REMEDY</h2>
      <div class="clause-content">
        ${terms.special_remedy || 'In the event of breach, the landlord shall have all remedies available at law and equity, including but not limited to eviction and damages.'}
      </div>
    </div>
    
    <div class="section">
      <h2>12. OPTION OF RENEWAL</h2>
      <div class="clause-content">
        ${terms.option_of_renewal || 'This lease may be renewed upon mutual agreement of both parties, subject to rent adjustment and terms to be negotiated.'}
      </div>
    </div>
    
    ${lease.status === 'signed' ? `
    <div class="signature-section">
      <div class="signature-block">
        <div class="signature-line"></div>
        <div class="signature-label">LESSOR SIGNATURE</div>
        <div class="signature-label">Signed: ${formatDate(lease.signed_at)}</div>
      </div>
      <div class="signature-block">
        <div class="signature-line"></div>
        <div class="signature-label">LESSEE SIGNATURE</div>
        <div class="signature-label">Signed: ${formatDate(lease.signed_at)}</div>
      </div>
    </div>
    ` : ''}
  </div>
</body>
</html>
  `.trim();
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { renderLeaseHtml };
