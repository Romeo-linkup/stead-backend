const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { createEvaluation, getAverageScore } = require('../controllers/evaluations.controller');

router.post('/', auth, requireRole('owner', 'admin'), createEvaluation);
router.get('/average', auth, requireRole('owner', 'admin'), getAverageScore);

module.exports = router;
