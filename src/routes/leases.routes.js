// src/routes/leases.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
	createLease,
	getLease,
	getMyLease,
	sendLease,
	signLease,
	listLeases,
	updateLease,
	deleteLease,
	supersedeLease,
	getSavedSignature,
	saveSignature,
	removeSavedSignature,
	lessorSignLease,
} = require('../controllers/leases.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), listLeases);
router.post('/', auth, requireRole('owner', 'admin', 'property_manager'), createLease);
router.get('/signature/saved', auth, requireRole('owner', 'admin', 'property_manager'), getSavedSignature);
router.put('/signature/saved', auth, requireRole('owner', 'admin', 'property_manager'), saveSignature);
router.delete('/signature/saved', auth, requireRole('owner', 'admin', 'property_manager'), removeSavedSignature);
router.get('/mine', auth, requireRole('tenant'), getMyLease);
router.patch('/:id', auth, requireRole('owner', 'admin', 'property_manager'), updateLease);
router.delete('/:id', auth, requireRole('owner', 'admin', 'property_manager'), deleteLease);
router.post('/:id/supersede', auth, requireRole('owner', 'admin', 'property_manager'), supersedeLease);
router.patch('/:id/send', auth, requireRole('owner', 'admin', 'property_manager'), sendLease);
router.post('/:id/sign', auth, requireRole('tenant'), signLease);
router.post('/:id/lessor-sign', auth, requireRole('owner', 'admin', 'property_manager'), lessorSignLease);
router.get('/:id', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), getLease);

module.exports = router;
