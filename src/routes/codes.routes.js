// src/routes/codes.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { createCode, listCodes, revokeCode } = require('../controllers/codes.controller');

router.get('/', auth, requireRole('owner', 'admin'), listCodes);
router.post('/', auth, requireRole('owner', 'admin'), createCode);
router.patch('/:id/revoke', auth, requireRole('owner', 'admin'), revokeCode);

module.exports = router;
