const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listProperties, createProperty } = require('../controllers/properties.controller');

router.get('/', auth, requireRole('owner', 'admin'), listProperties);
router.post('/', auth, requireRole('owner', 'admin'), createProperty);

module.exports = router;
