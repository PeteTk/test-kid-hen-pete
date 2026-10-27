// routes/profile.js — ผู้ใช้แก้ชื่อและรูปโปรไฟล์ของตัวเอง
// แก้ (3b-2): อ่าน/บันทึกที่ตาราง users (เดิม mockUsers) ชื่อเป็นช่องเดียว "ชื่อ-นามสกุล"
// คณะ/ฝ่าย/บทบาท แสดงอย่างเดียว (Admin เป็นคนแก้)

const express = require("express");
const router = express.Router();

const usersRepo = require("../repo/users");
const { avatarUrl } = require("../auth/session-user");
const { avatarUpload } = require("../utils/upload");
const { storage } = require("../service/storage");
const { emailNotify, STATUS } = require("../service/email-notify");

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

// อีเมลแจ้งสถานะคำร้อง (นักศึกษาเท่านั้น): null = ไม่แสดงส่วนนี้
async function emailNotifyInfo(me) {
  if (!emailNotify.eligible(me)) return null;
  const enabled = Number(me.email_notify ?? 1) === 1;
  if (!enabled) return { enabled, status: STATUS.OFF };
  try {
    return { enabled, status: await emailNotify.status(me.email_sub_arn) };
  } catch (error) {
    console.warn("[email-notify] อ่านสถานะไม่สำเร็จ:", error.message);
    return { enabled, status: STATUS.UNAVAILABLE };
  }
}

async function renderProfile(res, me, extra = {}) {
  const { facultyLabel, departmentLabel } = usersRepo.labels(me);
  const emailInfo = await emailNotifyInfo(me);

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
    emailInfo,
    emailFlash: null,
    ...extra,
  });
}

// เปิดหน้าโปรไฟล์
router.get("/", async (req, res, next) => {
  try {
    const flash = { on: "เปิดรับอีเมลแล้ว", sent: "ส่งอีเมลยืนยันแล้ว กรุณากดลิงก์ในอีเมล (จาก AWS Notifications)", off: "ปิดการรับอีเมลแล้ว" };
    await renderProfile(res, req.account, {
      saved: req.query.saved === "1",
      emailFlash: flash[req.query.email] || null,
    });
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

// อีเมลแจ้งสถานะคำร้อง: action = on (เปิด) | off (ปิด) | resend (ส่งอีเมลยืนยันอีกครั้ง)
router.post("/email-notify", async (req, res, next) => {
  try {
    const me = req.account;
    if (!emailNotify.eligible(me)) return res.redirect("/profile");
    const action = req.body?.action;

    if (action === "off") {
      if ((await emailNotify.status(me.email_sub_arn)) === STATUS.CONFIRMED) {
        await emailNotify.unsubscribe(me.email_sub_arn);
      }
      await usersRepo.setEmailNotify(me.id, { enabled: false, arn: null });
      return res.redirect("/profile?email=off");
    }

    if (action === "on" || action === "resend") {
      const current = await emailNotify.status(me.email_sub_arn);
      let arn = me.email_sub_arn ?? null;
      // ยืนยันแล้ว = เปิดใช้ได้เลย / ยังไม่ยืนยันหรือหมดอายุ = สมัครใหม่ (AWS ส่งอีเมลยืนยัน)
      if (current !== STATUS.CONFIRMED) arn = await emailNotify.subscribe(me.email);
      await usersRepo.setEmailNotify(me.id, { enabled: true, arn });
      return res.redirect(`/profile?email=${current === STATUS.CONFIRMED ? "on" : "sent"}`);
    }

    res.redirect("/profile");
  } catch (error) {
    console.error("[email-notify]", error.message);
    try {
      await renderProfile(res, req.account, { error: "ตั้งค่าอีเมลแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่" });
    } catch (renderError) {
      next(renderError);
    }
  }
});

module.exports = router;
