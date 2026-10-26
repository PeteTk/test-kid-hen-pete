const express = require("express");
const router = express.Router();
// แก้ (3c): คำร้องจากตาราง tickets
const tickets = require("../repo/tickets");
const { TYPES, STATUSES } = require("../service/catalog");
const { events } = require("../service/events");
const issues = require("../service/issues");
const fs = require("node:fs");
const path = require("node:path");
// แก้ (3b-2): ผู้ใช้มาจากตาราง users
const usersRepo = require("../repo/users");
const { cognitoGroups } = require("../service/cognito-groups");
const { avatarUrl } = require("../auth/session-user");
const { avatarUpload, UPLOAD_ROOT } = require("../utils/upload");
const { buildDashboardData } = require("../utils/dashboard");

// ทุกหน้าในไฟล์นี้ ต้องเป็น ADMIN เท่านั้น
router.use((req, res, next) => {
  if (req.session.user?.role !== "ADMIN") return res.redirect("/login");
  next();
});

// หน้า Dashboard
router.get("/dashboard", async (req, res, next) => {
  try {
    res.render("dashboard", {
      title: "Dashboard",
      active: "dashboard",
      base: "/admin",
      role: "admin",
      // แก้ (3c): คำร้องทั้งหมดจาก DB + จำนวนผู้ใช้จาก DB
      ...buildDashboardData(await tickets.list(), {
        userCount: await usersRepo.count(),
        publishedTopics: (await issues.publicTopics()).length,
      }),
    });
  } catch (error) {
    next(error);
  }
});

// หน้า จัดการคำร้อง (ค้นหา + กรอง) — Admin เห็นทุกคณะ
router.get("/requests", async (req, res, next) => {
  try {
    const str = (v) => (typeof v === "string" ? v : "");
    const filters = { q: str(req.query.q), type: str(req.query.type), status: str(req.query.status) };

    res.render("admin/requests", {
      title: "จัดการคำร้อง",
      active: "requests",
      list: await tickets.list(filters),
      TYPES,
      STATUSES,
      filters,
    });
  } catch (error) {
    next(error);
  }
});

// หน้า ดำเนินการคำร้อง
router.get("/requests/:id", async (req, res, next) => {
  try {
    const item = await tickets.findBySeq(req.params.id);
    if (!item) return res.redirect("/admin/requests");

    res.render("admin/request-detail", {
      title: "จัดการคำร้อง",
      active: "requests",
      item,
      STATUSES,
      saved: req.query.saved === "1",
    });
  } catch (error) {
    next(error);
  }
});

// บันทึกสถานะ ประวัติ และแจ้งเตือน (เหมือนฝั่ง Staff)
async function updateRequest(req, res, next, updateNote) {
  try {
    const item = await tickets.findBySeq(req.params.id);
    if (!item) return res.status(404).type("text").send("ไม่พบคำร้อง");

    const status = typeof req.body.status === "string" ? req.body.status.trim() : "";
    if (!STATUSES.includes(status)) return res.status(400).type("text").send("สถานะไม่ถูกต้อง");

    // endpoint เปลี่ยนสถานะอย่างเดียวต้องไม่ล้าง note
    const note =
      updateNote && typeof req.body.note === "string" ? req.body.note.trim() : item.note || "";

    if (note.length > 5000) {
      return res.status(400).type("text").send("ข้อความต้องไม่เกิน 5000 ตัวอักษร");
    }

    const result = await tickets.update(item.ticketId, { status, note, actorId: req.account.id });
    if (result.statusChanged || result.noteChanged) {
      await events.ticketChanged(result.ticket, result);
    }

    res.redirect(`/admin/requests/${item.id}?saved=1`);
  } catch (error) {
    next(error);
  }
}

router.post("/requests/:id/status", (req, res, next) => updateRequest(req, res, next, false));
router.post("/requests/:id/update", (req, res, next) => updateRequest(req, res, next, true));

// ===================== จัดการผู้ใช้ =====================
// แก้ (3b-2): อ่าน/แก้จากตาราง users + user_units (เดิมใช้ mockUsers)
// โหมด alb: เปลี่ยน role = ย้ายกลุ่มใน Cognito ด้วย (ไม่งั้น login ครั้งหน้า role จะถูก sync กลับ)

// รูปโปรไฟล์ที่ถูกแทนที่: ลบไฟล์เก่าในเครื่อง (ขั้น 3d ย้ายไป S3)
function removeAvatarFile(key) {
  if (typeof key !== "string" || !/^avatars\/[\w.-]+$/.test(key)) return;
  fs.rmSync(path.join(UPLOAD_ROOT, key), { force: true });
}

// หน้า จัดการผู้ใช้ (ค้นหา + กรองบทบาท)
router.get("/users", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const role = typeof req.query.role === "string" ? req.query.role : "";
    const keyword = q.trim().toLowerCase();

    const all = await Promise.all(
      (await usersRepo.list()).map(async (u) => ({ ...u, ...(usersRepo.labels(u)) }))
    );

    const list = all.filter((u) =>
      (!keyword || u.name.toLowerCase().includes(keyword) || u.email.toLowerCase().includes(keyword)) &&
      (!role || u.role === role)
    );

    const stats = {
      total: all.length,
      admin: all.filter((u) => u.role === "ADMIN").length,
      staff: all.filter((u) => u.role === "STAFF").length,
    };

    res.render("admin/users", {
      title: "จัดการผู้ใช้",
      active: "users",
      list,
      ROLES: usersRepo.ROLES,
      stats,
      filters: { q, role },
    });
  } catch (error) {
    next(error);
  }
});

// ลบผู้ใช้
router.post("/users/:id/delete", async (req, res, next) => {
  try {
    const target = await usersRepo.findById(req.params.id);

    // ห้ามลบบัญชีที่กำลังใช้งานอยู่ (กันลบตัวเองแล้วเข้าระบบไม่ได้)
    if (target && target.id !== req.session.user.id) {
      await cognitoGroups.disable(target.email); // โหมด local = ข้าม
      await usersRepo.remove(target.id);
      await req.app.locals.sessionStore?.destroyByUserId(target.id);
      removeAvatarFile(target.avatar_key);
    }

    res.redirect("/admin/users");
  } catch (error) {
    next(error);
  }
});

// ---------- แก้ไขข้อมูลผู้ใช้ ----------
async function renderUserEdit(res, target, extra = {}) {
  const [faculties, departments] = await Promise.all([
    usersRepo.listFaculties(),
    usersRepo.listDepartments(),
  ]);

  // นักศึกษา: คณะจากรหัสในอีเมล (แสดงอย่างเดียว)
  const autoFaculty =
    target.role === "USER"
      ? faculties.find((f) => f.id === target.faculty_id) || { id: "-", name: "ไม่พบรหัสคณะในอีเมล" }
      : null;

  res.render("admin/user-edit", {
    title: "จัดการผู้ใช้",
    active: "users",
    target: { ...target, avatar: avatarUrl(target) },
    ROLES: usersRepo.ROLES,
    FACULTIES: faculties,
    DEPARTMENTS: departments,
    autoFaculty,
    error: null,
    saved: false,
    ...extra,
  });
}

// เปิดหน้าแก้ไข
router.get("/users/:id", async (req, res, next) => {
  try {
    const target = await usersRepo.findById(req.params.id);
    if (!target) return res.redirect("/admin/users");
    await renderUserEdit(res, target, { saved: req.query.saved === "1" });
  } catch (error) {
    next(error);
  }
});

// อ่านคู่ คณะ/ฝ่าย จากฟอร์ม (faculty[] / department[] เป็นรหัสใน DB)
function readUnits(body) {
  const faculties = [].concat(body.faculty || []);
  const departments = [].concat(body.department || []);

  const rows = faculties.map((f, i) => ({
    faculty_id: String(f || "").trim(),
    department_id: String(departments[i] || "").trim(),
  }));

  if (rows.some((u) => Boolean(u.faculty_id) !== Boolean(u.department_id))) {
    return { error: "เลือกทั้งคณะและฝ่ายในแต่ละแถว" };
  }

  return { units: rows.filter((u) => u.faculty_id && u.department_id) };
}

// กด บันทึกข้อมูล
router.post("/users/:id", (req, res, next) => {
  avatarUpload.single("avatar")(req, res, async (err) => {
    // ไฟล์ที่เพิ่งอัปโหลด: ถ้าบันทึกไม่สำเร็จต้องลบทิ้ง
    const uploadedKey = req.file ? `avatars/${req.file.filename}` : null;
    const fail = async (target, message) => {
      removeAvatarFile(uploadedKey);
      await renderUserEdit(res, target, { error: message });
    };

    try {
      const target = await usersRepo.findById(req.params.id);
      if (!target) {
        removeAvatarFile(uploadedKey);
        return res.redirect("/admin/users");
      }

      if (err) {
        return fail(target, "อัปโหลดรูปไม่สำเร็จ: ต้องเป็นไฟล์รูป และไม่เกิน 2MB");
      }

      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      const role = req.body.role;
      const isSelf = target.id === req.session.user.id;

      if (!name || name.length > 150) {
        return fail(target, "กรุณากรอกชื่อ-นามสกุล (ไม่เกิน 150 ตัวอักษร)");
      }
      if (!usersRepo.ROLES.includes(role)) {
        return fail(target, "บทบาทไม่ถูกต้อง");
      }
      if (isSelf && role !== "ADMIN") {
        return fail(target, "ไม่สามารถลดบทบาทบัญชีของตัวเองได้");
      }

      // คณะ/ฝ่าย: เฉพาะ Staff/Admin ที่ฟอร์มแสดงช่องเลือก (นักศึกษาใช้คณะจากรหัส)
      let units = null;
      if (role !== "USER" && target.role !== "USER") {
        const read = readUnits(req.body);
        if (read.error) return fail(target, read.error);

        const staffFaculties = new Set(read.units.map((u) => u.faculty_id));
        if (role === "STAFF" && staffFaculties.size !== 1) {
          return fail(target, "Staff ต้องมีคณะเดียว หรือเลือกพื้นที่ส่วนกลาง");
        }
        units = read.units;
      }

      // Cognito ก่อน: ถ้าย้ายกลุ่มไม่สำเร็จ ไม่แก้ DB (ข้อมูลสองฝั่งไม่ต่างกัน)
      if (role !== target.role) {
        try {
          await cognitoGroups.setRole(target.email, role);
        } catch (error) {
          console.error("[cognito] เปลี่ยนกลุ่มไม่สำเร็จ:", error.message);
          return fail(target, "เปลี่ยนบทบาทใน Cognito ไม่สำเร็จ: " + error.message);
        }
      }

      await usersRepo.update(target.id, {
        name,
        role,
        ...(uploadedKey ? { avatarKey: uploadedKey } : {}),
      });

      if (units) {
        await usersRepo.setUnits(target.id, units);
      }

      if (uploadedKey) removeAvatarFile(target.avatar_key);

      res.redirect(`/admin/users/${target.id}?saved=1`);
    } catch (error) {
      removeAvatarFile(uploadedKey);
      if (error.status === 400) {
        const target = await usersRepo.findById(req.params.id).catch(() => null);
        if (target) return renderUserEdit(res, target, { error: error.message }).catch(next);
      }
      next(error);
    }
  });
});

module.exports = router;