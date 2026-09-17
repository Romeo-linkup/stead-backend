// src/middleware/errorHandler.js
// Mount this LAST, after all routes. Any next(err) call in a route or
// other middleware lands here.
const multer = require('multer');

function errorHandler(err, req, res, next) {
  console.error('[error]', err);

  if (res.headersSent) return next(err);

  // Handle multer-specific errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size exceeds 5MB limit.' });
    }
    return res.status(400).json({ error: err.message });
  }

  // Handle file filter errors
  if (err.message === 'Only JPG, PNG, and WEBP images are allowed.') {
    return res.status(400).json({ error: err.message });
  }

  const status = err.status || 500;
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'Something went wrong on our end.'
      : err.message || 'Something went wrong.';

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
