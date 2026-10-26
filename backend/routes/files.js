// routes/files.js — S3 pre-signed URL (3d, STORAGE_MODE=s3)
//   POST /files/presign  { kind: "requests"|"avatars", files: [{type, size}] } → [{ key, url, headers }]
//   GET  /files/<key>    → 302 ไป pre-signed GET ของ S3 (ต้องล็อกอิน)
// ในโหมด local ไม่ใช้ (ไฟล์อยู่ที่ /uploads)

const express = require("express");
const router = express.Router();

const { storage } = require("../service/storage");

router.use((req, res, next) => {
  if (!req.session.user || !req.account) return res.status(401).json({ error: "กรุณาเข้าสู่ระบบ" });
  if (!storage.s3) return res.status(404).json({ error: "ไม่ได้ใช้ S3" });
  next();
});

// ใช้เฉพาะ fetch จากหน้าเว็บเดียวกัน (JSON จากเว็บอื่นต้องผ่าน CORS preflight ซึ่งเว็บนี้ไม่อนุญาต)
router.post("/presign", express.json({ limit: "4kb" }), async (req, res) => {
  const kind = req.body?.kind;
  // รูปโปรไฟล์: ทุก role / รูปแนบคำร้อง: นักศึกษาเท่านั้น
  if (kind === "requests" && req.account.role !== "USER") {
    return res.status(403).json({ error: "ไม่มีสิทธิ์" });
  }
  try {
    const uploads = await storage.presignUpload({ userId: req.account.id, kind, files: req.body?.files });
    res.json({ uploads });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "สร้าง URL อัปโหลดไม่สำเร็จ" });
    if (!error.status) console.error("[s3] presign:", error.message);
  }
});

// Express 5: "/*key" = ทุก path ที่เหลือ (req.params.key เป็น array ของแต่ละส่วน)
router.get("/*key", async (req, res) => {
  const key = [].concat(req.params.key || []).join("/");
  if (!storage.validKey(key)) return res.sendStatus(404);
  try {
    const url = await storage.downloadUrl(key);
    if (!url) return res.sendStatus(404);
    res.set("Cache-Control", "private, max-age=240");
    res.redirect(302, url);
  } catch (error) {
    console.error("[s3] download:", error.message);
    res.sendStatus(500);
  }
});

module.exports = router;
