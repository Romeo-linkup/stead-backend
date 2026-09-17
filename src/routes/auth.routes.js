// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const { validateCode, registerName, refresh } = require('../controllers/auth.controller');

router.post('/validate-code', validateCode);
router.post('/register-name', registerName);
router.post('/refresh', refresh);

module.exports = router;
