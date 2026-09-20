// src/routes/districts.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listDistricts, createDistrict } = require('../controllers/districts.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listDistricts);
router.post('/', auth, requireRole('owner'), createDistrict);

module.exports = router;
