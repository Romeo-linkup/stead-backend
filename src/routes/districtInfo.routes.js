const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { getDistrictInfo, updateDistrictInfo } = require('../controllers/districtInfo.controller');

router.get('/', auth, requireRole('owner', 'admin', 'property_manager', 'tenant', 'service_provider'), getDistrictInfo);
router.put('/:sectionKey', auth, requireRole('owner', 'admin', 'property_manager'), updateDistrictInfo);

module.exports = router;