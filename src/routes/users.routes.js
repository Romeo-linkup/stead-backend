// src/routes/users.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { updateProfile, getProfile, listUsers } = require('../controllers/users.controller');

router.get('/me', auth, getProfile);
router.patch('/me', auth, updateProfile);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listUsers);

module.exports = router;