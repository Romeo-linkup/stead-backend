const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
  listUnits,
  createUnit,
  createUnitsBulk,
  updateUnit,
  deleteUnit,
  getUnit,
  getMyUnit,
} = require('../controllers/units.controller');

router.post('/', auth, requireRole('owner', 'admin', 'property_manager'), createUnit);
router.post('/bulk', auth, requireRole('owner', 'admin', 'property_manager'), createUnitsBulk);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listUnits);
router.get('/me', auth, requireRole('tenant'), getMyUnit);
router.get('/:id', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), getUnit);
router.patch('/:id', auth, requireRole('owner', 'admin', 'property_manager'), updateUnit);
router.delete('/:id', auth, requireRole('owner', 'admin', 'property_manager'), deleteUnit);

module.exports = router;
