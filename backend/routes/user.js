// routes/user.js — หน้านักศึกษา (role USER)
// แก้ (3c): คำร้องอ่าน/เขียนที่ตาราง tickets (เดิม data/mockRequests.js) รูปแนบบันทึกในตาราง attachments

const express = require("express");
const path = require("path");
const fs = require("node:fs");
const multer = require("multer");
const router = express.Router();

const tickets = require("../repo/tickets");
const notifications = require("../repo/notifications");
const { TYPES, STATUSES } = require("../service/catalog");
const { formatThaiDate } = require("../utils/date");
const { UPLOAD_ROOT } = require("../utils/upload");
const access = require("../service/faculty-access");

// ---------- ตั้งค่าอัปโหลดรูป ----------
// ในเครื่อง/EC2: frontend/public/uploads/requests (attachments.object_key = requests/<ไฟล์>) — ขั้น 3d ย้ายไป S3
const REQUEST_DIR = path.join(UPLOAD_ROOT, "requests");
fs.mkdirSync(REQUEST_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: REQUEST_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, "");
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 }, // รูปละไม่เกิน 5MB, สูงสุด 3 รูป
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

// ตรวจทั้งบทบาทและคณะจากบัญชีจริงใน server (req.account โหลดจาก DB ทุก request)
router.use((req, res, next) => {
  if (req.session.user?.role !== "USER") {
    return res.redirect("/login");
  }

  try {
    res.locals.studentScope = access.studentScope(req.account);
  } catch (error) {
    return res.status(403).type("text").send(error.message);
  }

  next();
});

// ---------- หน้าหลัก ----------
router.get("/home", async (req, res, next) => {
  try {
    const myRequests = await tickets.list({ userId: req.account.id });

    const stats = {
      total: myRequests.length,
      pending: myRequests.filter((r) => r.status === "รอดำเนินการ").length,
      inProgress: myRequests.filter((r) => r.status === "กำลังดำเนินการ").length,
      done: myRequests.filter((r) => r.status === "เสร็จสิ้น").length,
    };

    res.render("user/home", {
      title: "หน้าหลัก",
      active: "home",
      myRequests,
      stats,
      sent: req.query.sent === "1",
    });
  } catch (error) {
    next(error);
  }
});

function renderNewForm(res, error = null, values = {}) {
  const studentScope = res.locals.studentScope;

  return res.render("user/request-new", {
    title: "แจ้งปัญหา",
    active: "new",
    TYPES,
    FACULTIES: studentScope.choices,
    studentScope,
    error,
    values: {
      facultyId: studentScope.faculty.id,
      ...values,
    },
  });
}

router.get("/requests/new", (req, res) => renderNewForm(res));

router.post("/requests/new", (req, res, next) => {
  upload.array("images", 3)(req, res, async (error) => {
    if (error) {
      removeUploads(req);
      return renderNewForm(res, "อัปโหลดรูปไม่สำเร็จ: สูงสุด 3 รูป รูปละไม่เกิน 5MB", req.body);
    }

    const type = typeof req.body.type === "string" ? req.body.type.trim() : "";
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    const detail = typeof req.body.detail === "string" ? req.body.detail.trim() : "";
    let place;

    try {
      // ตรวจว่าคณะเป้าหมายอยู่ในสิทธิ์ (คณะตัวเอง/ส่วนกลาง)
      place = access.fromStudentForm(req.account, req.body);
    } catch (error) {
      removeUploads(req);
      res.status(error.status || 400);
      return renderNewForm(res, error.message, req.body);
    }

    if (!TYPES.includes(type) || !title || title.length > 200 || !detail || detail.length > 5000) {
      removeUploads(req);
      return renderNewForm(res, "เลือกประเภท ระบุหัวข้อไม่เกิน 200 และรายละเอียดไม่เกิน 5000 ตัวอักษร", req.body);
    }

    try {
      const ticket = await tickets.create({
        userId: req.account.id,
        place,
        type,
        title,
        detail,
        images: (req.files || []).map((file) => ({
          key: `requests/${file.filename}`,
          mime: file.mimetype,
          size: file.size,
        })),
      });

      // แจ้ง Admin + Staff ที่รับผิดชอบ (คณะ + หน่วยงานตามประเภท) — ล้มก็ไม่ทำให้การส่งคำร้องล้ม
      await notifications.newTicket(ticket).catch((e) =>
        console.error("[notify] แจ้งเตือนคำร้องใหม่ไม่สำเร็จ:", e.message)
      );

      res.redirect("/user/home?sent=1");
    } catch (error) {
      removeUploads(req);
      next(error);
    }
  });
});

// ---------- หน้าสถานะคำร้องของฉัน ----------
router.get("/requests", async (req, res, next) => {
  try {
    const str = (v) => (typeof v === "string" ? v : "");
    const filters = { q: str(req.query.q), type: str(req.query.type), status: str(req.query.status) };

    const list = await tickets.list({ userId: req.account.id, ...filters });

    res.render("user/requests", {
      title: "สถานะคำร้องของฉัน",
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

// ---------- หน้ารายละเอียดคำร้อง ----------
router.get("/requests/:id", async (req, res, next) => {
  try {
    const item = await tickets.findBySeq(req.params.id);
    if (!item || item.owner !== req.account.id) return res.redirect("/user/requests");

    const STEP_STATUS = ["รอดำเนินการ", "กำลังดำเนินการ", "เสร็จสิ้น"];
    const STEP_LABEL = ["ยื่นคำร้อง", "อยู่ระหว่างการดำเนินการ", "เสร็จสิ้น"];
    const current = STEP_STATUS.indexOf(item.status);
    const history = item.history || [];

    const steps = STEP_STATUS.map((s, i) => {
      const entry = [...history].reverse().find((h) => h.status === s);
      return {
        label: STEP_LABEL[i],
        state: i < current ? "done" : i === current ? "current" : "todo",
        time: i <= current && entry ? formatThaiDate(entry.at) : "",
      };
    });

    res.render("user/request-detail", {
      title: "สถานะคำร้องของฉัน",
      active: "requests",
      item,
      steps,
      current,
    });
  } catch (error) {
    next(error);
  }
});

// ลบไฟล์ที่อัปโหลดมาเมื่อฟอร์มไม่ผ่าน
function removeUploads(req) {
  (req.files || []).forEach((file) => {
    fs.rmSync(file.path, { force: true });
  });
}

module.exports = router;
