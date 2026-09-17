const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { createComplaint, listComplaints, getComplaintStatus } = require('../controllers/complaints.controller');

router.post('/', auth, requireRole('tenant'), createComplaint);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listComplaints);
router.get('/status/:trackingCode', auth, requireRole('tenant'), getComplaintStatus);

module.exports = router;
