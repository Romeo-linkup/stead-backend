// src/routes/payments.routes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
  listPayments,
  markPaid,
  markOutstanding,
  createReceipt,
  deleteReceipt,
} = require('../controllers/payments.controller');

// Proof-of-payment receipts: JPEG, PNG, WebP or PDF, max 5 MB,
// validated by mimetype (same pattern as maintenance photos).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, WebP or PDF files are allowed.'));
    }
    cb(null, true);
  },
});

router.get('/', auth, requireRole('owner', 'admin', 'property_manager', 'tenant'), listPayments);
router.patch('/:id/mark-paid', auth, requireRole('admin', 'property_manager'), markPaid);
router.patch('/:id/mark-outstanding', auth, requireRole('admin', 'property_manager'), markOutstanding);

// Receipts: tenants only, and only while the payment is unpaid.
router.post('/:id/receipts', auth, requireRole('tenant'), upload.single('receipt'), createReceipt);
router.delete('/:id/receipts/:receiptId', auth, requireRole('tenant'), deleteReceipt);

module.exports = router;
