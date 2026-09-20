// src/routes/districts.routes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listDistricts, createDistrict, deleteDistrict } = require('../controllers/districts.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listDistricts);
router.post('/', auth, requireRole('owner'), createDistrict);
router.delete('/:id', auth, requireRole('owner', 'admin'), deleteDistrict);

module.exports = router;
