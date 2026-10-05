// src/routes/settings.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { getSettings, updateSettings, updateNoticePeriod } = require('../controllers/settings.controller');

function requireAppSettingsMount(req, res, next) {
	if (req.baseUrl !== '/app-settings') return res.status(404).json({ error: 'Not found.' });
	next();
}

// Any authenticated role can read the business name (it's shown to everyone).
router.get('/', auth, getSettings);
// Business name and notice period are owner-only.
router.patch('/', auth, requireRole('owner'), updateSettings);
router.patch('/notice-period', auth, requireRole('owner'), requireAppSettingsMount, updateNoticePeriod);

module.exports = router;
