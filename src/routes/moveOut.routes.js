const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
  submitMoveOutNotice,
  getMyMoveOutNotice,
  withdrawMoveOutNotice,
  listMoveOutNotices,
  acknowledgeMoveOutNotice,
} = require('../controllers/moveOut.controller');

router.post('/', auth, requireRole('tenant'), submitMoveOutNotice);
router.get('/mine', auth, requireRole('tenant'), getMyMoveOutNotice);
router.patch('/:id/withdraw', auth, requireRole('tenant'), withdrawMoveOutNotice);
router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listMoveOutNotices);
router.patch('/:id/acknowledge', auth, requireRole('owner', 'admin', 'property_manager'), acknowledgeMoveOutNotice);

module.exports = router;