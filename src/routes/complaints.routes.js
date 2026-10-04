const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { createComplaint, listComplaints, getComplaintStatus, getComplaint, resolveComplaint, reopenComplaint } = require('../controllers/complaints.controller');

router.post('/', auth, requireRole('tenant'), createComplaint);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listComplaints);
router.get('/status/:trackingCode', auth, requireRole('tenant'), getComplaintStatus);
router.get('/:id', auth, requireRole('owner', 'admin', 'property_manager'), getComplaint);
router.patch('/:id/resolve', auth, requireRole('owner', 'admin', 'property_manager'), resolveComplaint);
router.patch('/:id/reopen', auth, requireRole('owner', 'admin', 'property_manager'), reopenComplaint);

module.exports = router;
