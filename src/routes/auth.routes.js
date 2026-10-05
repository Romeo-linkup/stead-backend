// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const { validateCode, registerName, refresh, getConfig, signup, loginPassword, signupRateLimit, loginRateLimit } = require('../controllers/auth.controller');

router.get('/config', getConfig);
router.post('/validate-code', validateCode);
router.post('/register-name', registerName);
router.post('/refresh', refresh);
router.post('/signup', signupRateLimit, signup);
router.post('/login-password', loginRateLimit, loginPassword);

module.exports = router;
