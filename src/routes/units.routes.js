const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listUnits, getUnit, createUnit, getMyUnit } = require('../controllers/units.controller');

router.post('/', auth, requireRole('owner', 'admin'), createUnit);
router.get('/', auth, requireRole('owner', 'admin'), listUnits);
router.get('/me', auth, requireRole('tenant'), getMyUnit);
router.get('/:id', auth, requireRole('admin', 'tenant'), getUnit);

module.exports = router;
