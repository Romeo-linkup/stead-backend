// src/routes/assets.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
  listAssets,
  createAsset,
  updateAsset,
  deleteAsset,
  applyTemplate,
  copyAssets,
} = require('../controllers/assets.controller');

const WRITER_ROLES = ['owner', 'admin', 'property_manager'];

// Read: owner, admin, property_manager (any unit in scope) and tenant
// (their own unit only). Service providers are rejected here (403).
router.get('/', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), listAssets);

// Write: owner, admin, property_manager only. Tenants and service
// providers can never write.
router.post('/', auth, requireRole(...WRITER_ROLES), createAsset);
router.patch('/:id', auth, requireRole(...WRITER_ROLES), updateAsset);
router.delete('/:id', auth, requireRole(...WRITER_ROLES), deleteAsset);
router.post('/apply-template', auth, requireRole(...WRITER_ROLES), applyTemplate);
router.post('/copy', auth, requireRole(...WRITER_ROLES), copyAssets);

module.exports = router;
