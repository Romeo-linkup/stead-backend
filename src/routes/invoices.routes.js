const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const {
  listInvoices,
  createInvoice,
  addReceipt,
  withdrawInvoice,
  approveInvoice,
  rejectInvoice,
  markInvoicePaid,
} = require('../controllers/invoices.controller');

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

router.get('/', auth, requireRole('owner', 'admin', 'property_manager', 'service_provider'), listInvoices);
router.post('/', auth, requireRole('service_provider'), createInvoice);
router.post('/:id/receipts', auth, requireRole('service_provider'), upload.single('photo'), addReceipt);
router.delete('/:id', auth, requireRole('service_provider'), withdrawInvoice);
router.patch('/:id/approve', auth, requireRole('owner', 'admin', 'property_manager'), approveInvoice);
router.patch('/:id/reject', auth, requireRole('owner', 'admin', 'property_manager'), rejectInvoice);
router.patch('/:id/mark-paid', auth, requireRole('owner', 'admin', 'property_manager'), markInvoicePaid);

module.exports = router;
