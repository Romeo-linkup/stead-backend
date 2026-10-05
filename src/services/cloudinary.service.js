const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadImage(fileBuffer, folder) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result.secure_url);
        }
      }
    );
    
    uploadStream.end(fileBuffer);
  });
}

// Like uploadImage, but also hands back the Cloudinary public_id so
// receipts can be deleted from Cloudinary later if ever needed.
// Additive: uploadImage's shape is unchanged for maintenance.
async function uploadReceipt(fileBuffer, folder) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve({ url: result.secure_url, public_id: result.public_id });
        }
      }
    );

    uploadStream.end(fileBuffer);
  });
}

module.exports = { uploadImage, uploadReceipt };
