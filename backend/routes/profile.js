// routes/profile.js — ผู้ใช้แก้ชื่อและรูปโปรไฟล์ของตัวเอง
// แก้ (3b-2): อ่าน/บันทึกที่ตาราง users (เดิม mockUsers) ชื่อเป็นช่องเดียว "ชื่อ-นามสกุล"
// คณะ/ฝ่าย/บทบาท แสดงอย่างเดียว (Admin เป็นคนแก้)

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const router = express.Router();

const usersRepo = require("../repo/users");
const { avatarUrl } = require("../auth/session-user");
const { avatarUpload, UPLOAD_ROOT } = require("../utils/upload");

// ต้อง login ก่อน (role ไหนก็ได้) — app.js โหลด req.account จาก DB ให้แล้ว
router.use((req, res, next) => {
  if (!req.session.user || !req.account) return res.redirect("/login");
  next();
});

function removeAvatarFile(key) {
  if (typeof key !== "string" || !/^avatars\/[\w.-]+$/.test(key)) return;
  fs.rmSync(path.join(UPLOAD_ROOT, key), { force: true });
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
    const uploadedKey = req.file ? `avatars/${req.file.filename}` : null;

    try {
      const me = req.account;

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
