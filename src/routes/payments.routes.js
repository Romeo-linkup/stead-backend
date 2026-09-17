const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listPayments, markPaid, markOutstanding } = require('../controllers/payments.controller');

router.get('/', auth, requireRole('owner', 'admin', 'tenant'), listPayments);
router.patch('/:id/mark-paid', auth, requireRole('admin'), markPaid);
router.patch('/:id/mark-outstanding', auth, requireRole('admin'), markOutstanding);

module.exports = router;
