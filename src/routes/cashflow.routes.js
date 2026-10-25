const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { listCashflow, listHistory, createItem, updateItem, archiveItem, rentPreview, addRentFromUnits } = require('../controllers/cashflow.controller');

// Owner only. Every query is also scoped to the owner's organisation inside the controller.
router.get('/', auth, requireRole('owner', 'admin'), listCashflow);
router.get('/history', auth, requireRole('owner', 'admin'), listHistory);
router.get('/rent-preview', auth, requireRole('owner'), rentPreview);
router.post('/rent-from-units', auth, requireRole('owner'), addRentFromUnits);
router.post('/', auth, requireRole('owner'), createItem);
router.patch('/:id', auth, requireRole('owner'), updateItem);
router.post('/:id/archive', auth, requireRole('owner'), archiveItem);

module.exports = router;
