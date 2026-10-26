// routes/notifications.js — กระดิ่งแจ้งเตือน
// แก้ (3c): อ่านจากตาราง notifications (เขียนโดยเว็บ และโดย Lambda status.py บน AWS)

const express = require("express");
const router = express.Router();
const notifications = require("../repo/notifications");
const { formatThaiDate } = require("../utils/date");

// หน้าคำร้องของแต่ละ role (ใช้ตอนกดแจ้งเตือน)
const BASE = { ADMIN: "/admin", STAFF: "/staff", USER: "/user" };

// ต้อง login ก่อน
router.use((req, res, next) => {
  if (!req.session.user || !req.account) return res.redirect("/login");
  next();
});

// หน้าแจ้งเตือน
router.get("/", async (req, res, next) => {
  try {
    const tab = typeof req.query.tab === "string" ? req.query.tab : "all";
    const mine = await notifications.listForUser(req.account.id);

    let list = mine;
    if (tab === "unread") list = mine.filter((n) => !n.read);
    if (tab === "request") list = mine.filter((n) => n.category === "request");

    res.render("notifications", {
      title: "แจ้งเตือน",
      active: "notifications",
      role: req.session.user.role.toLowerCase(),
      list: list.map((n) => ({ ...n, time: formatThaiDate(n.createdAt) })),
      tab,
    });
  } catch (error) {
    next(error);
  }
});

// กดที่แจ้งเตือน → ทำเป็นอ่านแล้ว → ไปหน้าคำร้องตาม role
router.get("/:id", async (req, res, next) => {
  try {
    const n = await notifications.open(req.params.id, req.account.id);
    if (!n) return res.redirect("/notifications");

    const base = BASE[req.session.user.role];
    res.redirect(n.requestId ? `${base}/requests/${n.requestId}` : "/notifications");
  } catch (error) {
    next(error);
  }
});

module.exports = router;
