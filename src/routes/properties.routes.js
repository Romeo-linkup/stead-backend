const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listProperties, createProperty, updateProperty, deleteProperty } = require('../controllers/properties.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listProperties);
router.post('/', auth, requireRole('owner', 'admin', 'property_manager'), createProperty);
router.patch('/:id', auth, requireRole('owner', 'admin', 'property_manager'), updateProperty);
router.delete('/:id', auth, requireRole('owner', 'admin', 'property_manager'), deleteProperty);

module.exports = router;
