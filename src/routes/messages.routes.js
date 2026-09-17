const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { listMessages, createMessage } = require('../controllers/messages.controller');

router.get('/', auth, listMessages);
router.post('/', auth, createMessage);

module.exports = router;
