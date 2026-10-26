const fs = require("node:fs");
const path = require("path");
const multer = require("multer");

// ไฟล์อัปโหลดในเครื่อง (frontend/public/uploads) — avatar_key ใน DB = path ใต้โฟลเดอร์นี้ เช่น avatars/xxx.jpg
// ขั้น 3d: ย้ายไป S3 (EC2 หลายเครื่องเห็นไฟล์ไม่ตรงกัน)
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