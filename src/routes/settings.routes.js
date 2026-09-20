// src/routes/settings.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { getSettings, updateSettings } = require('../controllers/settings.controller');

// Any authenticated role can read the business name (it's shown to everyone).
router.get('/', auth, getSettings);
// Only the owner can change it.
router.patch('/', auth, requireRole('owner'), updateSettings);

module.exports = router;