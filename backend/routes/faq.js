// แก้: ไม่มี prepare/approve แล้ว
// Admin ดูผล แก้สรุป และซ่อนย้อนหลังได้

const router =
  require("express").Router();

const {
  randomUUID,
} = require("node:crypto");

const issues = require(
  "../service/issues"
);

// แก้ (3c): คำร้องจากตาราง tickets
const { TYPES } = require("../service/catalog");
const tickets = require("../repo/tickets");

// เพิ่ม: ใช้ตัวแปลงสถานที่กลาง
const locations = require("../service/location");

// เพิ่ม: แสดงเวลาไทยแม้ server อยู่ต่างประเทศ
const formatThaiDate = (date) =>
  new Date(date).toLocaleString(
    "th-TH",
    {
      timeZone: "Asia/Bangkok",
    }
  );

// ของเดิม: ตรวจสิทธิ์ที่ backend
router.use((req, res, next) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (
    req.session.user.role !==
      "ADMIN"
  ) {
    return res.sendStatus(403);
  }

  req.session.aiCsrf ||=
    randomUUID();

  if (
    req.method !== "GET" &&
    req.body._csrf !==
      req.session.aiCsrf
  ) {
    return res.sendStatus(403);
  }

  Object.assign(res.locals, {
    title:
      "จัดการปัญหาที่พบบ่อย",

    active: "faq",

    aiCsrf:
      req.session.aiCsrf,

    flash:
      req.session.faqFlash ||
      null,

    formatThaiDate,
  });

  delete req.session.faqFlash;

  next();
});

// แก้: แสดงหัวข้อจริง ไม่แสดงร่างรออนุมัติ
router.get("/", async (req, res) => {
  const filters =
    Object.fromEntries(
      ["q", "type", "status"].map(
        (key) => [
          key,

          typeof req.query[key] ===
            "string"
            ? req.query[key]
            : "",
        ]
      )
    );

  const data =
    await issues.dashboard();

  const list =
    data.topics.filter(
      (topic) =>
        (
          !filters.q ||
          topic.title.includes(
            filters.q.trim()
          )
        ) &&
        (
          !filters.type ||
          topic.type ===
            filters.type
        ) &&
        (
          !filters.status ||
          (
            topic.published
              ? "published"
              : "hidden"
          ) === filters.status
        )
    );

  res.render("admin/faq", {
    ...data,
    list,
    filters,
    TYPES,
  });
});

// แก้ (3d): ส่ง RunAnalysis เข้า EventBridge → Lambda analyze.py (โหมด local: ประมวลผลในเว็บ)
// เริ่มงานแล้วกลับหน้ารายการ ไม่ให้ browser รอ
router.post("/run", async (req, res) => {
  try {
    const { via } = await issues.requestRun({ by: req.session.user.id });
    req.session.faqFlash = {
      error: false,
      text:
        via === "eventbridge"
          ? "เริ่มประมวลผลแล้ว รอประมาณ 1–2 นาทีแล้วกดรีเฟรช"
          : "เริ่มประมวลผลแล้ว กดรีเฟรชเพื่อตรวจผล",
    };
  } catch (error) {
    req.session.faqFlash = { error: true, text: error.message };
  }

  res.redirect("/admin/faq");
});

// แก้: ดูหัวข้อและคำร้องที่เกี่ยวข้อง
router.get(
  "/topics/:id",
  async (req, res) => {
    try {
      res.render(
        "admin/faq-detail",
        await issues.detail(
          req.params.id
        )
      );
    } catch {
      res
        .status(404)
        .type("text")
        .send("ไม่พบหัวข้อ");
    }
  }
);

// เพิ่ม: ลดโค้ดจัดการผล POST ซ้ำ
function action(fn) {
  return async (req, res) => {
    try {
      await fn(req);

      req.session.faqFlash = {
        error: false,
        text: "บันทึกแล้ว",
      };
    } catch (error) {
      req.session.faqFlash = {
        error: true,
        text: error.message,
      };
    }

    res.redirect("/admin/faq");
  };
}

// เพิ่ม: แก้ข้อความย้อนหลัง
router.post(
  "/topics/:id/save",

  action((req) =>
    issues.editTopic(
      req.params.id,
      req.body
    )
  )
);

// เพิ่ม: ซ่อน/เผยแพร่ ไม่ลบประวัติ
router.post(
  "/topics/:id/visibility",

  action((req) => {
    if (
      !["true", "false"].includes(
        req.body.published
      )
    ) {
      throw new Error(
        "ค่าการเผยแพร่ไม่ถูกต้อง"
      );
    }

    return issues.setPublished(
      req.params.id,

      req.body.published ===
        "true"
    );
  })
);

// เพิ่ม: เปิดหน้าแก้สถานที่คำร้องเก่า เฉพาะ Admin
router.get("/requests/:id/location", async (req, res) => {
  const item = await tickets.findBySeq(req.params.id);

  if (!item) {
    return res.status(404).send("ไม่พบคำร้อง");
  }

  res.render("admin/request-location", {
    item,
    FACULTIES: locations.FACULTIES,
    placeValues: locations.forRequest(item),
  });
});

// เพิ่ม: ใช้ middleware Admin และ CSRF ที่มีอยู่แล้ว
router.post(
  "/requests/:id/location",
  action(req => {
    return issues.updateLocation(
      req.params.id,
      req.body
    );
  })
);

// เพิ่ม: ไม่ปล่อย URL รุ่นเก่าไปเข้า FAQ routes เดิม
router.use((req, res) => {
  res
    .status(404)
    .type("text")
    .send(
      "ไม่พบหน้าจัดการสรุป"
    );
});

module.exports = router;