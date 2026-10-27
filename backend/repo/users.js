// repo/users.js — ชั้นเข้าถึงข้อมูลผู้ใช้ใน DB (SQLite ในเครื่อง / MySQL บน AWS)
// แทน data/mockUsers.js ทั้งหมดตั้งแต่ขั้น 3b-2 (ไฟล์ mock ถูกลบแล้ว)

const crypto = require("node:crypto");
const db = require("../db");

const ROLES = ["ADMIN", "STAFF", "USER"];

// รหัสพิเศษใน faculties ที่ไม่ใช่คณะจริง
const COMMON_FACULTY = "00";
const OTHER_FACULTY = "99";

// ดึงรหัสนักศึกษา 8 หลักจากอีเมล เช่น 67070223@kmitl.ac.th → "67070223"
function studentIdFromEmail(email) {
  const local = String(email || "").split("@")[0];
  return /^\d{8}$/.test(local) ? local : null;
}

// รหัสนักศึกษารูปแบบ 6y[xx]yyyy → รหัสคณะ 2 หลัก (ตัวเดียวกับ db.studentClaims)
function facultyIdFromStudentId(studentId) {
  return /^\d{8}$/.test(studentId || "") ? studentId.slice(2, 4) : null;
}

// คืนรหัสคณะเฉพาะที่มีอยู่จริงใน DB และไม่ใช่ 00/99 ไม่เช่นนั้นคืน null
async function facultyFromStudentId(studentId) {
  const id = facultyIdFromStudentId(studentId);
  if (!id || id === COMMON_FACULTY || id === OTHER_FACULTY) return null;

  const rows = await db.query(
    "SELECT id, name FROM faculties WHERE id=?",
    [id]
  );
  return rows[0] || null;
}

// คณะที่ Admin เลือกเอง (นักศึกษาที่อีเมลไม่ใช่รหัส 8 หลัก เช่น Gmail) — ต้องเป็นคณะจริง ไม่ใช่ 00/99
async function manualFaculty(id) {
  const value = String(id || "").trim();
  if (!/^\d{2}$/.test(value) || value === COMMON_FACULTY || value === OTHER_FACULTY) return null;
  const rows = await db.query("SELECT id, name FROM faculties WHERE id=?", [value]);
  return rows[0] || null;
}

// คณะของนักศึกษาจากอีเมล (null = อีเมลไม่ใช่รหัสนักศึกษา → Admin ต้องเลือกเอง)
async function facultyFromEmail(email) {
  return facultyFromStudentId(studentIdFromEmail(email));
}

async function listFaculties() {
  return db.query("SELECT id, name FROM faculties ORDER BY id");
}

async function listDepartments() {
  return db.query("SELECT id, name FROM departments ORDER BY name");
}

// ---------- รหัสผ่าน (ใช้ scrypt ของ Node ไม่ต้องติดตั้งแพ็กเกจเพิ่ม) ----------
// รูปแบบที่เก็บ: scrypt$<salt hex>$<hash hex>
function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 1) db.fail("ต้องมีรหัสผ่าน");

  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function checkPassword(plain, stored) {
  const [kind, saltHex, hashHex] = String(stored || "").split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex || typeof plain !== "string") return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(plain, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

async function setPassword(userId, plain) {
  const result = await db.query(
    "UPDATE users SET password_hash=? WHERE id=?",
    [hashPassword(plain), userId]
  );
  if (db.affected(result) === 0) db.fail("ไม่พบผู้ใช้", 404);
}

// ตรวจอีเมล + รหัสผ่าน (ใช้กับล็อกอินทดลองในเครื่อง)
// คืนผู้ใช้เมื่อถูกต้องและบัญชียังใช้งานอยู่ ไม่เช่นนั้นคืน null
// ตั้งใจให้เวลาใกล้เคียงกันแม้ไม่พบอีเมล ไม่บอกว่าผิดที่อีเมลหรือรหัสผ่าน
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

async function authenticate(email, password) {
  const rows = await db.query(
    "SELECT * FROM users WHERE email=?",
    [String(email || "").trim().toLowerCase()]
  );
  const row = rows[0];

  const ok = checkPassword(password, row?.password_hash || DUMMY_HASH);
  if (!row || !row.password_hash || !ok || !row.active) return null;

  return withUnits(row);
}

// แนบ units (คู่ คณะ+หน่วยงาน) ให้ผู้ใช้
async function withUnits(user, run = db.query) {
  if (!user) return null;

  let units = [];

  if (user.role === "USER") {
    // นักศึกษา: ใช้คณะจากบัญชี + หน่วยงาน student
    if (user.faculty_id) {
      units = [{ faculty_id: user.faculty_id, department_id: "student" }];
    }
  } else {
    const rows = await run(
      "SELECT faculty_id, department_id FROM user_units WHERE user_id=? " +
        "ORDER BY faculty_id, department_id",
      [user.id]
    );

    // แปลงเป็น object ธรรมดา ให้ SQLite กับ MySQL หน้าตาเหมือนกัน
    units = rows.map((r) => ({
      faculty_id: r.faculty_id,
      department_id: r.department_id,
    }));
  }

  return { ...user, units };
}

async function findById(id) {
  const rows = await db.query("SELECT * FROM users WHERE id=?", [id]);
  return withUnits(rows[0]);
}

async function findByEmail(email) {
  const rows = await db.query(
    "SELECT * FROM users WHERE email=?",
    [String(email || "").trim().toLowerCase()]
  );
  return withUnits(rows[0]);
}

async function list() {
  const rows = await db.query("SELECT * FROM users ORDER BY created_at, email");
  return Promise.all(rows.map((row) => withUnits(row)));
}

// สร้างผู้ใช้ — นักศึกษา: คณะมาจากรหัสในอีเมล
//   facultyId (เฉพาะ Admin เพิ่มผู้ใช้): ใช้เมื่ออีเมลไม่ใช่รหัสนักศึกษาเท่านั้น (อีเมลรหัสนักศึกษาใช้คณะจากรหัสเสมอ)
async function create({ email, name, role = "USER", googleSub = null, passwordHash = null, facultyId: chosen = null }) {
  if (!ROLES.includes(role)) db.fail("role ไม่ถูกต้อง");

  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail) db.fail("ต้องมีอีเมล");

  const cleanName = db.text(name, 1, 150, "ชื่อ");

  let studentId = null;
  let facultyId = null;
  let departmentId = null;

  if (role === "USER") {
    studentId = studentIdFromEmail(cleanEmail);
    const faculty = (await facultyFromStudentId(studentId)) || (await manualFaculty(chosen));
    facultyId = faculty ? faculty.id : null;
    departmentId = "student";
  }

  const userId = db.id();

  await db.query(
    "INSERT INTO users(id,email,name,google_sub,student_id,faculty_id," +
      "department_id,role,password_hash,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)",
    [userId, cleanEmail, cleanName, googleSub, studentId, facultyId,
     departmentId, role, passwordHash, db.now()]
  );

  return findById(userId);
}

// แก้ชื่อ / role / active / รูป
// คณะนักศึกษา: อีเมลรหัสนักศึกษา = จากรหัสเสมอ / อีเมลอื่น = facultyId ที่ Admin เลือก (undefined = คงเดิม)
// avatarKey: undefined = ไม่แก้, null = ลบรูป
async function update(userId, { name, role, active, avatarKey, facultyId: chosen } = {}) {
  const current = await findById(userId);
  if (!current) db.fail("ไม่พบผู้ใช้", 404);

  const nextRole = role ?? current.role;
  if (!ROLES.includes(nextRole)) db.fail("role ไม่ถูกต้อง");

  const nextName = name === undefined ? current.name : db.text(name, 1, 150, "ชื่อ");
  const nextActive = active === undefined ? current.active : active ? 1 : 0;
  const nextAvatar = avatarKey === undefined ? current.avatar_key ?? null : avatarKey;

  // เปลี่ยนมาเป็นนักศึกษา: คณะต้องมาจากรหัสในอีเมล (เหมือนตอน create)
  let facultyId = current.faculty_id;
  let studentId = current.student_id;
  let departmentId = current.department_id;

  if (nextRole === "USER") {
    const fromEmail = await facultyFromEmail(current.email);
    const picked = chosen === undefined ? null : await manualFaculty(chosen);
    if (chosen !== undefined && chosen !== "" && !fromEmail && !picked) db.fail("คณะไม่ถูกต้อง");
    studentId = studentIdFromEmail(current.email);
    facultyId = fromEmail?.id ?? picked?.id ?? (current.role === "USER" ? current.faculty_id : null);
    departmentId = "student";
  } else if (nextRole !== "USER" && current.role === "USER") {
    studentId = null;
    facultyId = null;
    departmentId = null;
  }

  await db.transaction(async (run) => {
    await run(
      "UPDATE users SET name=?, role=?, active=?, avatar_key=?, " +
        "student_id=?, faculty_id=?, department_id=? WHERE id=?",
      [nextName, nextRole, nextActive, nextAvatar, studentId, facultyId, departmentId, userId]
    );

    // เปลี่ยนมาเป็นนักศึกษา: ไม่ใช้ units ของ Staff แล้ว
    if (nextRole === "USER") {
      await run("DELETE FROM user_units WHERE user_id=?", [userId]);
    }
  });

  return findById(userId);
}

// ลบผู้ใช้ (ลบ units ก่อนเพราะ FK) — ขั้น 3c เมื่อมีคำร้องใน DB ต้องเปลี่ยนเป็นปิดบัญชี (active=0)
async function remove(userId) {
  return db.transaction(async (run) => {
    await run("DELETE FROM user_units WHERE user_id=?", [userId]);
    return db.affected(await run("DELETE FROM users WHERE id=?", [userId])) > 0;
  });
}

async function count() {
  const rows = await db.query("SELECT COUNT(*) AS n FROM users");
  return Number(rows[0]?.n ?? 0);
}

// ---------- Cognito (โหมด AWS) ----------
// กลุ่ม Cognito → role ในระบบ (มีหลายกลุ่ม ใช้สิทธิ์สูงสุด)
const GROUP_ROLE = { Admin: "ADMIN", Staff: "STAFF", User: "USER" };

function roleFromGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];
  for (const [group, role] of Object.entries(GROUP_ROLE)) {
    if (list.includes(group)) return role;
  }
  return "USER";
}

// เรียกตอน login ผ่าน ALB/Cognito: สร้างผู้ใช้ถ้ายังไม่มี และ sync role จากกลุ่ม Cognito
// Cognito เป็นตัวกำหนด role — หน้า Admin เปลี่ยน role ต้องแก้ทั้ง DB และกลุ่ม Cognito
async function syncFromCognito({ email, name, groups }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail.includes("@")) db.fail("token ไม่มีอีเมล", 401);

  const role = roleFromGroups(groups);
  const existing = await findByEmail(cleanEmail);

  if (!existing) {
    const displayName = String(name || "").trim() || cleanEmail.split("@")[0];
    try {
      return await create({ email: cleanEmail, name: displayName.slice(0, 150), role });
    } catch (error) {
      // EC2 อีกเครื่องสร้างไปพร้อมกัน (UNIQUE email) → อ่านของที่มีอยู่
      const again = await findByEmail(cleanEmail);
      if (!again) throw error;
      return again;
    }
  }

  // บัญชีที่ Admin ปิดไว้: ไม่เปลี่ยนอะไร ให้ผู้เรียกปฏิเสธเอง
  if (!existing.active || existing.role === role) return existing;

  return update(existing.id, { role });
}

// กำหนดคู่ คณะ+หน่วยงาน ของ Staff/Admin ทั้งชุด (แทนที่ของเดิม ซ้ำให้เหลือคู่เดียว)
// ตรวจกับ faculties/departments ใน DB ก่อนบันทึก
async function setUnits(userId, units) {
  const user = await findById(userId);
  if (!user) db.fail("ไม่พบผู้ใช้", 404);
  if (user.role === "USER") db.fail("นักศึกษาไม่ใช้ units คณะมาจากรหัสนักศึกษา");

  const faculties = new Set((await listFaculties()).map((f) => f.id));
  const departments = new Set((await listDepartments()).map((d) => d.id));

  const seen = new Set();
  const clean = [];

  for (const unit of units || []) {
    const facultyId = String(unit?.faculty_id ?? "").trim();
    const departmentId = String(unit?.department_id ?? "").trim();

    if (!faculties.has(facultyId)) db.fail(`ไม่พบคณะ ${facultyId}`);
    if (!departments.has(departmentId)) db.fail(`ไม่พบหน่วยงาน ${departmentId}`);

    const key = `${facultyId}|${departmentId}`;
    if (!seen.has(key)) {
      seen.add(key);
      clean.push([facultyId, departmentId]);
    }
  }

  await db.transaction(async (run) => {
    await run("DELETE FROM user_units WHERE user_id=?", [userId]);

    for (const [facultyId, departmentId] of clean) {
      await run(
        "INSERT INTO user_units(user_id,faculty_id,department_id) VALUES(?,?,?)",
        [userId, facultyId, departmentId]
      );
    }
  });

  return findById(userId);
}

// Staff ที่ต้องแจ้งเมื่อมีคำร้อง: คณะ + หน่วยงานตรงกัน และบัญชียังใช้งานอยู่
async function staffForTicket(facultyId, departmentId) {
  return db.query(
    "SELECT u.id, u.email, u.name FROM users u " +
      "JOIN user_units x ON x.user_id = u.id " +
      "WHERE u.role='STAFF' AND u.active=1 AND x.faculty_id=? AND x.department_id=? " +
      "ORDER BY u.email",
    [facultyId, departmentId]
  );
}

// ข้อความ คณะ / ฝ่าย สำหรับแสดงผล (หน้าโปรไฟล์/ตารางผู้ใช้) จาก units
function labels(user) {
  const units = user?.units || [];
  const faculty = [...new Set(units.map((u) => db.FACULTY_NAMES[u.faculty_id]).filter(Boolean))];
  const department = [...new Set(units.map((u) => db.DEPARTMENT_NAMES[u.department_id]).filter(Boolean))];
  return {
    facultyLabel: faculty.join(", ") || "-",
    // นักศึกษาแสดงฝ่ายเป็น "นักศึกษา" (unit "student" = ฝ่ายกิจการนักศึกษาของ Staff ใช้ภายในเพื่อจับคู่คำร้องเท่านั้น)
    departmentLabel: user?.role === "USER" ? "นักศึกษา" : department.join(", ") || "-",
  };
}

// อีเมลแจ้งสถานะคำร้อง: enabled = เปิด/ปิด, arn = subscription ใน SNS (undefined = ไม่แก้)
async function setEmailNotify(userId, { enabled, arn } = {}) {
  const current = await findById(userId);
  if (!current) db.fail("ไม่พบผู้ใช้", 404);
  const nextEnabled = enabled === undefined ? Number(current.email_notify ?? 1) : enabled ? 1 : 0;
  const nextArn = arn === undefined ? current.email_sub_arn ?? null : arn;
  await db.query("UPDATE users SET email_notify=?, email_sub_arn=? WHERE id=?", [nextEnabled, nextArn, userId]);
  return findById(userId);
}

module.exports = {
  labels,
  ROLES, COMMON_FACULTY, OTHER_FACULTY,
  studentIdFromEmail, facultyIdFromStudentId, facultyFromStudentId, facultyFromEmail, manualFaculty,
  listFaculties, listDepartments,
  hashPassword, checkPassword, setPassword, authenticate,
  findById, findByEmail, list, count, create, update, remove, setUnits, staffForTicket, setEmailNotify,
  GROUP_ROLE, roleFromGroups, syncFromCognito,
};
