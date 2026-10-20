const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
  listProperties,
  createProperty,
  updateProperty,
  deleteProperty,
  setPropertyImage,
  deletePropertyImage,
  getMyProperties,
} = require('../controllers/properties.controller');

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

router.get('/', auth, requireRole('owner', 'admin', 'property_manager'), listProperties);
router.post('/', auth, requireRole('owner', 'admin', 'property_manager'), createProperty);

router.get('/mine', auth, requireRole('tenant', 'service_provider'), getMyProperties);

router.post('/:id/image', auth, requireRole('owner', 'admin', 'property_manager'), upload.single('image'), setPropertyImage);
router.delete('/:id/image', auth, requireRole('owner', 'admin', 'property_manager'), deletePropertyImage);

router.patch('/:id', auth, requireRole('owner', 'admin', 'property_manager'), updateProperty);
router.delete('/:id', auth, requireRole('owner', 'admin'), deleteProperty);

module.exports = router;