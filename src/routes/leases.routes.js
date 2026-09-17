// src/routes/leases.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { createLease, getLease, getMyLease, sendLease, signLease, listLeases } = require('../controllers/leases.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), listLeases);
router.post('/', auth, requireRole('owner', 'admin', 'property_manager'), createLease);
router.get('/mine', auth, requireRole('tenant'), getMyLease);
router.patch('/:id/send', auth, requireRole('owner', 'admin', 'property_manager'), sendLease);
router.post('/:id/sign', auth, requireRole('tenant'), signLease);
router.get('/:id', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), getLease);

module.exports = router;
