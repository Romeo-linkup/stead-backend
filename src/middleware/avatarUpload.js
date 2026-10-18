const multer = require('multer');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Please upload a JPG, PNG or WEBP image.'));
  },
}).single('photo');

// The browser-supplied mimetype can be faked, so check the file's real signature too.
function isImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return jpeg || png || webp;
}

function avatarUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Photo must be 2MB or less.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (req.file && !isImageBuffer(req.file.buffer)) {
      return res.status(400).json({ error: 'That file is not a valid image.' });
    }
    next();
  });
}

module.exports = { avatarUpload };
