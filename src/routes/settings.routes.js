// src/routes/settings.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { getSettings, updateSettings, updateNoticePeriod } = require('../controllers/settings.controller');

// Any authenticated role can read the business name (it's shown to everyone).
router.get('/', auth, getSettings);
// Business name remains owner-only; notice period can be changed by management roles.
router.patch('/', auth, requireRole('owner', 'admin', 'property_manager'), updateSettings);
router.patch('/notice-period', auth, requireRole('owner', 'admin'), updateNoticePeriod);

module.exports = router;