// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const { validateCode, registerName, refresh, getConfig, signup, loginPassword, signupRateLimit, loginRateLimit, forgotPassword, resetPassword, forgotPasswordRateLimit, resetPasswordRateLimit } = require('../controllers/auth.controller');
const { avatarUpload } = require('../middleware/avatarUpload');

router.get('/config', getConfig);
router.post('/validate-code', validateCode);
router.post('/register-name', avatarUpload, registerName);
router.post('/refresh', refresh);
router.post('/signup', signupRateLimit, signup);
router.post('/login-password', loginRateLimit, loginPassword);
router.post('/forgot-password', forgotPasswordRateLimit, forgotPassword);
router.post('/reset-password', resetPasswordRateLimit, resetPassword);

module.exports = router;
