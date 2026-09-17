const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listMaintenance, createMaintenance, assignMaintenance, acceptMaintenance, completeMaintenance } = require('../controllers/maintenance.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, and WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

router.get('/', auth, requireRole('owner', 'admin', 'tenant', 'service_provider'), listMaintenance);
router.post('/', auth, requireRole('tenant'), upload.single('photo'), createMaintenance);
router.patch('/:id/assign', auth, requireRole('owner', 'admin'), assignMaintenance);
router.patch('/:id/accept', auth, requireRole('service_provider'), acceptMaintenance);
router.patch('/:id/complete', auth, requireRole('service_provider'), upload.single('after'), completeMaintenance);

module.exports = router;
