// routes/profile.js — ผู้ใช้แก้ชื่อและรูปโปรไฟล์ของตัวเอง
// แก้ (3b-2): อ่าน/บันทึกที่ตาราง users (เดิม mockUsers) ชื่อเป็นช่องเดียว "ชื่อ-นามสกุล"
// คณะ/ฝ่าย/บทบาท แสดงอย่างเดียว (Admin เป็นคนแก้)

const express = require("express");
const router = express.Router();

const usersRepo = require("../repo/users");
const { avatarUrl } = require("../auth/session-user");
const { avatarUpload } = require("../utils/upload");
const { storage } = require("../service/storage");

// ต้อง login ก่อน (role ไหนก็ได้) — app.js โหลด req.account จาก DB ให้แล้ว
router.use((req, res, next) => {
  if (!req.session.user || !req.account) return res.redirect("/login");
  next();
});

// รูปเก่า/รูปที่บันทึกไม่สำเร็จ (ในเครื่อง = ไฟล์, บน AWS = object ใน S3)
function removeAvatarFile(key) {
  if (typeof key === "string" && key.startsWith("avatars/")) storage.remove(key);
}

// 3d: รูปจากฟอร์ม — บน AWS browser อัปโหลดตรงไป S3 แล้วส่ง avatar_keys มา (ตรวจว่าเป็นของผู้ใช้นี้ + มีไฟล์จริง)
async function uploadedAvatar(req) {
  if (!storage.s3) return req.file ? `avatars/${req.file.filename}` : null;
  const [file] = await storage.confirm(req.body.avatar_keys, { userId: req.account.id, kind: "avatars" });
  return file ? file.key : null;
}

async function renderProfile(res, me, extra = {}) {
  const { facultyLabel, departmentLabel } = usersRepo.labels(me);

  res.render("profile", {
    title: "แก้ไขข้อมูลผู้ใช้",
    active: "profile",
    me: {
      ...me,
      avatar: avatarUrl(me),
      faculty: facultyLabel,
      department: departmentLabel,
    },
    error: null,
    saved: false,
    ...extra,
  });
}

// เปิดหน้าโปรไฟล์
router.get("/", async (req, res, next) => {
  try {
    await renderProfile(res, req.account, { saved: req.query.saved === "1" });
  } catch (error) {
    next(error);
  }
});

// กด บันทึกข้อมูล
router.post("/", (req, res, next) => {
  avatarUpload.single("avatar")(req, res, async (err) => {
    let uploadedKey = null;

    try {
      const me = req.account;
      try {
        uploadedKey = err ? null : await uploadedAvatar(req);
      } catch (error) {
        return renderProfile(res, me, { error: error.message });
      }

      if (err) {
        removeAvatarFile(uploadedKey);
        return renderProfile(res, me, { error: "อัปโหลดรูปไม่สำเร็จ: ต้องเป็นไฟล์รูป และไม่เกิน 2MB" });
      }

      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 150) {
        removeAvatarFile(uploadedKey);
        return renderProfile(res, me, { error: "กรุณากรอกชื่อ-นามสกุล (ไม่เกิน 150 ตัวอักษร)" });
      }

      // แก้เฉพาะชื่อ/รูป ไม่ส่ง role (ผู้ใช้เปลี่ยนสิทธิ์ตัวเองไม่ได้)
      await usersRepo.update(me.id, {
        name,
        ...(uploadedKey ? { avatarKey: uploadedKey } : {}),
      });

      if (uploadedKey) removeAvatarFile(me.avatar_key);

      req.session.user.name = name;
      res.redirect("/profile?saved=1");
    } catch (error) {
      removeAvatarFile(uploadedKey);
      next(error);
    }
  });
});

module.exports = router;
