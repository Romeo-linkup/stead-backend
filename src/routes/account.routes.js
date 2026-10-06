// src/routes/account.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { deletionCheck, deleteAccount, deleteRateLimit } = require('../controllers/account.controller');

router.get('/deletion-check', auth, requireRole('owner'), deletionCheck);
router.delete('/', auth, requireRole('owner'), deleteRateLimit, deleteAccount);

module.exports = router;