// src/utils/validators.js
// Small hand-rolled validators — intentionally dependency-free for
// Phase 1. Each returns a string error message, or null if valid.

function validateCodeFormat(code) {
  if (typeof code !== 'string' || !code.trim()) return 'Code is required.';
  if (!/^[A-Z0-9]{2,5}-[A-Z]{3}-\d{3,6}$/.test(code.trim().toUpperCase())) {
    return 'Code format looks wrong.';
  }
  return null;
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length < 2) {
    return 'Name must be at least 2 characters.';
  }
  return null;
}

function validatePhone(phone) {
  if (!phone) return null; // phone is optional
  if (!/^[0-9+\s()-]{7,20}$/.test(phone)) return 'Phone number looks invalid.';
  return null;
}

function validateDistrictName(name) {
  if (typeof name !== 'string' || name.trim().length < 2) {
    return 'District name must be at least 2 characters.';
  }
  return null;
}

const ALLOWED_ROLES = ['owner', 'admin', 'property_manager', 'service_provider', 'tenant'];

function validateRole(role) {
  if (!ALLOWED_ROLES.includes(role)) return `Role must be one of: ${ALLOWED_ROLES.join(', ')}`;
  return null;
}

module.exports = {
  validateCodeFormat,
  validateName,
  validatePhone,
  validateDistrictName,
  validateRole,
  ALLOWED_ROLES,
};
