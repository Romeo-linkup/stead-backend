const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { getNotices, createNotice, deleteNotice } = require('../controllers/notices.controller');

router.get('/', auth, getNotices);
router.post('/', auth, requireRole('owner', 'admin', 'property_manager'), createNotice);
router.delete('/:id', auth, requireRole('owner', 'admin', 'property_manager'), deleteNotice);

module.exports = router;