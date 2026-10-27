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
const { avatarUpload } = require("../utils/upload");
const { storage } = require("../service/storage");
const { buildDashboardData } = require("../utils/dashboard");
const config = require("../config");

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

// รูปโปรไฟล์ที่ถูกแทนที่ (ในเครื่อง = ไฟล์, 3d บน AWS = object ใน S3)
function removeAvatarFile(key) {
  if (typeof key === "string" && key.startsWith("avatars/")) storage.remove(key);
}

// หน้า จัดการผู้ใช้ (ค้นหา + กรองบทบาท)
router.get("/users", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const role = typeof req.query.role === "string" ? req.query.role : "";
    // ประเภทอีเมล: kmitl = เมลมหาวิทยาลัย / external = อีเมลภายนอก (Gmail ฯลฯ) / nofaculty = นักศึกษาที่ยังไม่มีคณะ
    const emailType = ["kmitl", "external", "nofaculty"].includes(req.query.email) ? req.query.email : "";
    const keyword = q.trim().toLowerCase();

    const all = await Promise.all(
      (await usersRepo.list()).map(async (u) => ({
        ...u,
        ...(usersRepo.labels(u)),
        external: !String(u.email || "").toLowerCase().endsWith("@kmitl.ac.th"),
        missingFaculty: u.role === "USER" && !u.faculty_id,
      }))
    );

    const byEmail = {
      kmitl: (u) => !u.external,
      external: (u) => u.external,
      nofaculty: (u) => u.missingFaculty,
    };

    const list = all.filter((u) =>
      (!keyword || u.name.toLowerCase().includes(keyword) || u.email.toLowerCase().includes(keyword)) &&
      (!role || u.role === role) &&
      (!emailType || byEmail[emailType](u))
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
      filters: { q, role, email: emailType },
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

// ---------- เพิ่มผู้ใช้ (3b-3, UC-09) ----------
// cognito/alb: สร้างบัญชีใน Cognito (ส่งรหัสผ่านชั่วคราวทางอีเมล) + ใส่กลุ่มตาม role แล้วสร้างแถวใน users
// local     : สร้างแถวใน users พร้อมรหัสผ่านที่ Admin กำหนด (ไม่ต่อ AWS)
const LOCAL_AUTH = config.auth.mode === "local";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function renderUserNew(res, form = {}, error = null) {
  const [faculties, departments] = await Promise.all([
    usersRepo.listFaculties(),
    usersRepo.listDepartments(),
  ]);
  res.status(error ? 400 : 200).render("admin/user-new", {
    title: "จัดการผู้ใช้",
    active: "users",
    ROLES: usersRepo.ROLES,
    FACULTIES: faculties,
    DEPARTMENTS: departments,
    localAuth: LOCAL_AUTH,
    STUDENT_FACULTIES: faculties.filter((f) => f.id !== usersRepo.COMMON_FACULTY && f.id !== usersRepo.OTHER_FACULTY),
    form: { email: "", name: "", role: "USER", units: [], studentFaculty: "", ...form },
    error,
  });
}

router.get("/users/new", async (req, res, next) => {
  try {
    await renderUserNew(res);
  } catch (error) {
    next(error);
  }
});

router.post("/users/new", async (req, res, next) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const role = req.body.role;
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const read = readUnits(req.body);
  // นักศึกษาที่อีเมลไม่ใช่รหัส 8 หลัก (เช่น Gmail): Admin เลือกคณะเอง
  const studentFaculty = typeof req.body.student_faculty === "string" ? req.body.student_faculty.trim() : "";
  const form = { email, name, role, units: read.units || [], studentFaculty };
  const fail = (message) => renderUserNew(res, form, message);

  try {
    if (!EMAIL_RE.test(email) || email.length > 254) return await fail("อีเมลไม่ถูกต้อง");
    if (!name || name.length > 150) return await fail("กรุณากรอกชื่อ-นามสกุล (ไม่เกิน 150 ตัวอักษร)");
    if (!usersRepo.ROLES.includes(role)) return await fail("บทบาทไม่ถูกต้อง");
    if (LOCAL_AUTH && password.length < 4) return await fail("กรุณากำหนดรหัสผ่านอย่างน้อย 4 ตัว");

    let facultyId = null;
    if (role === "USER" && !(await usersRepo.facultyFromEmail(email))) {
      const picked = await usersRepo.manualFaculty(studentFaculty);
      if (!picked) return await fail("อีเมลนี้ไม่ใช่รหัสนักศึกษา 8 หลัก กรุณาเลือกคณะของนักศึกษา");
      facultyId = picked.id;
    }

    let units = [];
    if (role !== "USER") {
      if (read.error) return await fail(read.error);
      if (role === "STAFF" && new Set(read.units.map((u) => u.faculty_id)).size !== 1) {
        return await fail("Staff ต้องมีคณะเดียว หรือเลือกพื้นที่ส่วนกลาง");
      }
      units = read.units;
    }

    if (await usersRepo.findByEmail(email)) {
      return await fail("มีผู้ใช้อีเมลนี้อยู่แล้ว — แก้ไขบทบาทได้จากรายการผู้ใช้");
    }

    // Cognito ก่อน: ถ้าสร้างไม่สำเร็จ ไม่สร้างใน DB
    let cognitoResult = { skipped: true };
    try {
      cognitoResult = await cognitoGroups.createUser({ email, name, role });
    } catch (error) {
      console.error("[cognito] เพิ่มผู้ใช้ไม่สำเร็จ:", error.name || "", error.message);
      return await fail("สร้างบัญชีใน Cognito ไม่สำเร็จ: " + (error.message || error.name));
    }

    const user = await usersRepo.create({
      email,
      name,
      role,
      facultyId,
      ...(LOCAL_AUTH ? { passwordHash: usersRepo.hashPassword(password) } : {}),
    });
    if (units.length) await usersRepo.setUnits(user.id, units);

    const created = cognitoResult.skipped ? "local" : cognitoResult.existed ? "existed" : "email";
    res.redirect(`/admin/users/${user.id}?created=${created}`);
  } catch (error) {
    if (error.status === 400) return renderUserNew(res, form, error.message).catch(next);
    next(error);
  }
});

// ---------- แก้ไขข้อมูลผู้ใช้ ----------
async function renderUserEdit(res, target, extra = {}) {
  const [faculties, departments] = await Promise.all([
    usersRepo.listFaculties(),
    usersRepo.listDepartments(),
  ]);

  // นักศึกษา: อีเมลรหัสนักศึกษา = คณะจากรหัส (แสดงอย่างเดียว) / อีเมลอื่น = Admin เลือกคณะ (manualFaculty)
  const fromEmail = target.role === "USER" ? await usersRepo.facultyFromEmail(target.email) : null;
  const autoFaculty = fromEmail ? faculties.find((f) => f.id === fromEmail.id) || fromEmail : null;
  const manualFaculty = target.role === "USER" && !fromEmail ? { current: target.faculty_id || "" } : null;

  res.render("admin/user-edit", {
    title: "จัดการผู้ใช้",
    active: "users",
    target: { ...target, avatar: avatarUrl(target) },
    ROLES: usersRepo.ROLES,
    FACULTIES: faculties,
    DEPARTMENTS: departments,
    autoFaculty,
    manualFaculty,
    STUDENT_FACULTIES: faculties.filter((f) => f.id !== usersRepo.COMMON_FACULTY && f.id !== usersRepo.OTHER_FACULTY),
    error: null,
    saved: false,
    created: null,
    ...extra,
  });
}

// เปิดหน้าแก้ไข
router.get("/users/:id", async (req, res, next) => {
  try {
    const target = await usersRepo.findById(req.params.id);
    if (!target) return res.redirect("/admin/users");
    const CREATED = {
      email: "เพิ่มผู้ใช้แล้ว — Cognito ส่งรหัสผ่านชั่วคราวไปที่อีเมล (ครั้งแรกต้องตั้งรหัสใหม่) หรือกด Continue with Google ด้วยอีเมลนี้",
      existed: "เพิ่มผู้ใช้แล้ว — อีเมลนี้มีบัญชีใน Cognito อยู่แล้ว จึงกำหนดบทบาทให้โดยไม่ส่งอีเมลซ้ำ",
      local: "เพิ่มผู้ใช้แล้ว — เข้าสู่ระบบด้วยอีเมลและรหัสผ่านที่กำหนด",
    };
    await renderUserEdit(res, target, {
      saved: req.query.saved === "1",
      created: CREATED[req.query.created] || null,
    });
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
    // 3d: บน AWS browser อัปโหลดตรงไป S3 (key ขึ้นต้นด้วย avatars/<id ของ Admin ที่อัปโหลด>/)
    let uploadedKey = req.file ? `avatars/${req.file.filename}` : null;
    let keyError = null;
    if (storage.s3 && !err) {
      try {
        const [file] = await storage.confirm(req.body.avatar_keys, { userId: req.account.id, kind: "avatars" });
        uploadedKey = file ? file.key : null;
      } catch (error) {
        keyError = error.message;
      }
    }
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
      if (keyError) return fail(target, keyError);

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

      // นักศึกษาที่อีเมลไม่ใช่รหัส 8 หลัก: คณะที่ Admin เลือก (อีเมลรหัสนักศึกษา repo ใช้คณะจากรหัสเอง)
      const studentFaculty =
        role === "USER" && typeof req.body.student_faculty === "string" ? req.body.student_faculty.trim() : undefined;
      if (role === "USER" && studentFaculty === "" && !(await usersRepo.facultyFromEmail(target.email))) {
        return fail(target, "อีเมลนี้ไม่ใช่รหัสนักศึกษา 8 หลัก กรุณาเลือกคณะของนักศึกษา");
      }

      await usersRepo.update(target.id, {
        name,
        role,
        ...(studentFaculty !== undefined ? { facultyId: studentFaculty } : {}),
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