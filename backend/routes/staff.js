// routes/staff.js — หน้าเจ้าหน้าที่ (role STAFF)
//
// แก้ (3c): คำร้องจากตาราง tickets; Staff เห็นเฉพาะคำร้องที่ (คณะ + หน่วยงาน) ตรงกับ user_units ของตัวเอง
// เปลี่ยนสถานะ → บันทึก ticket_updates แล้วส่ง TicketStatusChanged (EventBridge บน AWS / แจ้งเตือนในเว็บตอนรันในเครื่อง)

const express = require("express");
const router = express.Router();
const { normalizeText } = require("../utils/text");

const tickets = require("../repo/tickets");
const { TYPES, STATUSES } = require("../service/catalog");
const { events } = require("../service/events");
const { buildDashboardData } = require("../utils/dashboard");

function clean(value) {
  return normalizeText(value).trim();
}

// ตรวจ role และ units ปัจจุบันจากบัญชีใน DB ทุกครั้ง (ไม่เชื่อค่าจาก browser)
router.use((req, res, next) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  const account = req.account;

  if (!account || account.role !== "STAFF") {
    return res.status(403).type("text").send("บัญชีนี้ไม่มีสิทธิ์เจ้าหน้าที่");
  }

  if (!account.units?.length) {
    return res
      .status(403)
      .type("text")
      .send("บัญชียังไม่มีข้อมูลคณะ/ฝ่าย กรุณาให้ Admin ตรวจข้อมูลบัญชี");
  }

  res.locals.staffUnits = account.units;
  next();
});

function canAccess(units, ticket) {
  return units.some(
    (u) => u.faculty_id === ticket.facultyId && u.department_id === ticket.departmentId
  );
}

// ตรวจสิทธิ์ทุก route ที่มี :id (ทั้งดูรายละเอียดและแก้สถานะ)
router.param("id", async (req, res, next, id) => {
  try {
    const item = /^[1-9]\d{0,8}$/.test(id) ? await tickets.findBySeq(id) : null;

    // ใช้คำตอบเดียวกันสำหรับคำร้องที่ไม่มีและคำร้องที่ไม่มีสิทธิ์
    if (!item || !canAccess(res.locals.staffUnits, item)) {
      return res.status(404).type("text").send("ไม่พบคำร้อง");
    }

    req.staffRequest = item;
    next();
  } catch (error) {
    next(error);
  }
});

// สถิติเฉพาะคำร้องในความรับผิดชอบ
router.get("/dashboard", async (req, res, next) => {
  try {
    const list = await tickets.list({ units: res.locals.staffUnits });

    res.render("dashboard", {
      title: "Dashboard",
      active: "dashboard",
      base: "/staff",
      role: "staff",
      ...buildDashboardData(list),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/requests", async (req, res, next) => {
  try {
    const filters = {
      q: clean(req.query.q),
      type: clean(req.query.type),
      status: clean(req.query.status),
    };

    const list = await tickets.list({ units: res.locals.staffUnits, ...filters });

    res.render("staff/requests", {
      title: "จัดการคำร้อง",
      active: "requests",
      list,
      TYPES,
      STATUSES,
      filters,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/requests/:id", (req, res) => {
  res.render("staff/request-detail", {
    title: "จัดการคำร้อง",
    active: "requests",
    item: req.staffRequest,
    STATUSES,
    saved: req.query.saved === "1",
  });
});

// ขั้นตอนบันทึกร่วมกันทั้งสอง endpoint: สถานะ + ประวัติ + แจ้งเตือน
async function updateRequest(req, res, next, updateNote) {
  try {
    const item = req.staffRequest;
    const status = clean(req.body.status);

    if (!STATUSES.includes(status)) {
      return res.status(400).type("text").send("สถานะคำร้องไม่ถูกต้อง");
    }

    // endpoint เปลี่ยนสถานะอย่างเดียวต้องไม่ล้าง note
    const note = updateNote ? clean(req.body.note) : item.note || "";

    if (note.length > 5000) {
      return res.status(400).type("text").send("ข้อความเจ้าหน้าที่ต้องไม่เกิน 5000 ตัวอักษร");
    }

    const result = await tickets.update(item.ticketId, { status, note, actorId: req.account.id });

    if (result.statusChanged || result.noteChanged) {
      await events.ticketChanged(result.ticket, result);
    }

    res.redirect(`/staff/requests/${item.id}?saved=1`);
  } catch (error) {
    next(error);
  }
}

router.post("/requests/:id/status", (req, res, next) => updateRequest(req, res, next, false));
router.post("/requests/:id/update", (req, res, next) => updateRequest(req, res, next, true));

module.exports = router;
