// src/utils/generateCode.js
// Generates codes in the format <DISTRICT_ABBR>-<ROLE_ABBR>-####
// e.g. SDL-TEN-4821, SDL-ADM-0193
const ROLE_ABBR = {
  owner: 'OWN',
  admin: 'ADM',
  property_manager: 'PMG',
  service_provider: 'SVC',
  tenant: 'TEN',
};

function districtAbbr(districtName) {
  if (!districtName) return 'GEN';
  const cleaned = districtName.trim().toUpperCase().replace(/[^A-Z ]/g, '');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).padEnd(3, 'X');
  return words.map((w) => w[0]).join('').slice(0, 3).padEnd(3, 'X');
}

function randomDigits(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/**
 * @param {string|null} districtName - null for district-less roles like owner
 * @param {string} role - one of the CHECK-constrained roles
 * @returns {string} a candidate code (caller must verify uniqueness against the DB)
 */
function generateCode(districtName, role) {
  const roleAbbr = ROLE_ABBR[role];
  if (!roleAbbr) throw new Error(`Unknown role: ${role}`);
  return `${districtAbbr(districtName)}-${roleAbbr}-${randomDigits(4)}`;
}

module.exports = { generateCode };
