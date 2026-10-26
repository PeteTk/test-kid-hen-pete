const fs = require("node:fs");
const path = require("path");
const multer = require("multer");

// ไฟล์อัปโหลดในเครื่อง (STORAGE_MODE=local, frontend/public/uploads) — avatar_key ใน DB = path ใต้โฟลเดอร์นี้ เช่น avatars/xxx.jpg
// 3d: บน AWS (STORAGE_MODE=s3) browser อัปโหลดตรงไป S3 ด้วย pre-signed URL แทน (service/storage.js) — multer ไม่ได้รับไฟล์
const UPLOAD_ROOT = path.join(__dirname, "../../frontend/public/uploads");
const AVATAR_DIR = path.join(UPLOAD_ROOT, "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `avatar-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // ไม่เกิน 2MB
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

module.exports = { avatarUpload, UPLOAD_ROOT, AVATAR_DIR };