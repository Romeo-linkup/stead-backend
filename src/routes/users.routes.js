// src/routes/users.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { avatarUpload } = require('../middleware/avatarUpload');
const { updateProfile, getProfile, listUsers, setAvatar } = require('../controllers/users.controller');

router.get('/me', auth, getProfile);
router.patch('/me', auth, updateProfile);
router.post('/me/avatar', auth, avatarUpload, setAvatar);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listUsers);

module.exports = router;