// src/utils/imageUrl.js
// Generates Cloudinary transformation URLs for property images.

function imageVariant(url, variant) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('https://res.cloudinary.com/')) return null;

  const transformations = {
    thumb: 'c_fill,w_160,h_160,g_auto,q_auto,f_auto',
    hero: 'c_limit,w_1000,q_auto,f_auto',
  };

  const transform = transformations[variant];
  if (!transform) return null;

  const uploadIndex = url.indexOf('/upload/');
  if (uploadIndex === -1) return null;

  const insertPos = uploadIndex + '/upload/'.length;
  return url.slice(0, insertPos) + transform + '/' + url.slice(insertPos);
}

module.exports = { imageVariant };