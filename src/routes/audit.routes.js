const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listAudit } = require('../controllers/audit.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listAudit);

module.exports = router;
