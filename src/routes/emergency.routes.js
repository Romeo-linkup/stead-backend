const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
	createEmergency,
	listEmergency,
	acknowledgeEmergency,
	resolveEmergency,
} = require('../controllers/emergency.controller');

router.post('/', auth, requireRole('tenant'), createEmergency);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listEmergency);
router.patch('/:id/acknowledge', auth, requireRole('owner', 'admin', 'property_manager'), acknowledgeEmergency);
router.patch('/:id/resolve', auth, requireRole('owner', 'admin', 'property_manager'), resolveEmergency);

module.exports = router;
