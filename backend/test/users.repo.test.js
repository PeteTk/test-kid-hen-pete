// ทดสอบ repo/users.js บน SQLite ในหน่วยความจำ
// รัน: SQLITE_PATH=:memory: node test/users.repo.test.js
process.env.SQLITE_PATH = ":memory:";
process.env.DB_DRIVER = "sqlite";

const assert = require("node:assert/strict");
const db = require("../db");
const users = require("../repo/users");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

(async () => {
  await db.init();
  // init ซ้ำต้องไม่พัง (idempotent)
  await db.init();

  await check("faculties: 16 เดิม + 21 + 00 + 99 = 19 แถว, ไม่มี 015", async () => {
    const f = await users.listFaculties();
    assert.equal(f.length, 19);
    const ids = f.map((x) => x.id);
    for (const id of ["00", "21", "99", "01", "11", "12"]) assert.ok(ids.includes(id), id);
    assert.ok(!ids.includes("015"));
  });

  await check("departments: 5 หน่วยงานครบ", async () => {
    const d = (await users.listDepartments()).map((x) => x.id).sort();
    assert.deepEqual(d, ["academic", "activities", "building", "it", "student"]);
  });

  await check("หาคณะจากรหัสนักศึกษา (07→IT, 01→วิศวะ, 21→โคเซ็น, 015 ไม่แยก)", async () => {
    assert.equal((await users.facultyFromStudentId("67070223")).id, "07");
    assert.equal((await users.facultyFromStudentId("67010888")).id, "01");
    assert.equal((await users.facultyFromStudentId("67210001")).name, "โคเซ็น");
    assert.equal((await users.facultyFromStudentId("67015123")).id, "01");
    assert.equal(await users.facultyFromStudentId("67990001"), null); // 99 ไม่ใช่คณะจริง
    assert.equal(await users.facultyFromStudentId("67090001"), null); // 09 ไม่มี
    assert.equal(await users.facultyFromStudentId("abc"), null);
  });

  let student, staff, admin;

  await check("สร้างนักศึกษา: คณะ/รหัสมาจากอีเมล, units = คณะ + student", async () => {
    student = await users.create({ email: "67070223@kmitl.ac.th", name: "สมหญิง เรียนดี" });
    assert.equal(student.student_id, "67070223");
    assert.equal(student.faculty_id, "07");
    assert.equal(student.department_id, "student");
    assert.deepEqual(student.units, [{ faculty_id: "07", department_id: "student" }]);
  });

  await check("อีเมลซ้ำ (ตัวพิมพ์ต่าง) ถูกปฏิเสธ", async () => {
    await assert.rejects(() => users.create({ email: "67070223@KMITL.ac.th", name: "ซ้ำ" }));
  });

  await check("สร้าง Staff / Admin แล้วยังไม่มี units", async () => {
    staff = await users.create({ email: "somchai@example.com", name: "สมชาย ใจดี", role: "STAFF" });
    admin = await users.create({ email: "admin@example.com", name: "ผู้ดูแลระบบ", role: "ADMIN" });
    assert.deepEqual(staff.units, []);
    assert.equal(staff.faculty_id, null);
  });

  await check("setUnits: หลายคู่, ตัดคู่ซ้ำ, แทนที่ของเดิม", async () => {
    let s = await users.setUnits(staff.id, [
      { faculty_id: "07", department_id: "it" },
      { faculty_id: "07", department_id: "it" },
      { faculty_id: "01", department_id: "building" },
    ]);
    assert.equal(s.units.length, 2);
    s = await users.setUnits(staff.id, [{ faculty_id: "00", department_id: "building" }]);
    assert.deepEqual(s.units, [{ faculty_id: "00", department_id: "building" }]);
  });

  await check("setUnits: คณะ/หน่วยงานที่ไม่มี และนักศึกษา ถูกปฏิเสธ (ของเดิมไม่หาย)", async () => {
    await assert.rejects(() => users.setUnits(staff.id, [{ faculty_id: "55", department_id: "it" }]));
    await assert.rejects(() => users.setUnits(staff.id, [{ faculty_id: "07", department_id: "xx" }]));
    await assert.rejects(() => users.setUnits(student.id, [{ faculty_id: "07", department_id: "it" }]));
    assert.equal((await users.findById(staff.id)).units.length, 1);
  });

  await check("staffForTicket: ตรงทั้งคณะ+หน่วยงาน, ไม่ตรงไม่ได้, ปิดบัญชีแล้วไม่ได้", async () => {
    await users.setUnits(staff.id, [
      { faculty_id: "07", department_id: "it" },
      { faculty_id: "07", department_id: "student" }, // ข้อเสนอแนะ → กิจการนักศึกษา
    ]);
    assert.equal((await users.staffForTicket("07", "it")).length, 1);
    assert.equal((await users.staffForTicket("07", "student")).length, 1);
    assert.equal((await users.staffForTicket("07", "building")).length, 0);
    assert.equal((await users.staffForTicket("01", "it")).length, 0);

    await users.update(staff.id, { active: false });
    assert.equal((await users.staffForTicket("07", "it")).length, 0);
    await users.update(staff.id, { active: true });
    assert.equal((await users.staffForTicket("07", "it")).length, 1);
  });

  await check("update: เปลี่ยน Staff → USER ล้าง units, role แปลก ๆ ถูกปฏิเสธ", async () => {
    await assert.rejects(() => users.update(staff.id, { role: "GOD" }));
    const u = await users.update(staff.id, { role: "USER" });
    assert.equal(u.role, "USER");
    const rows = await db.query("SELECT * FROM user_units WHERE user_id=?", [staff.id]);
    assert.equal(rows.length, 0);
  });

  await check("findByEmail / list", async () => {
    assert.equal((await users.findByEmail(" ADMIN@example.com ")).role, "ADMIN");
    assert.equal(await users.findByEmail("nobody@x.com"), null);
    assert.equal((await users.list()).length, 3);
  });


  await check("รหัสผ่าน: hash ไม่ซ้ำกัน, ตรวจถูก/ผิด, ไม่เก็บข้อความจริง", async () => {
    const a = users.hashPassword("1234");
    const b = users.hashPassword("1234");
    assert.notEqual(a, b);
    assert.ok(!a.includes("1234") || a.startsWith("scrypt$"));
    assert.equal(users.checkPassword("1234", a), true);
    assert.equal(users.checkPassword("12345", a), false);
    assert.equal(users.checkPassword("1234", "plaintext"), false);
    assert.equal(users.checkPassword("1234", null), false);
  });

  await check("authenticate: ถูก/ผิดรหัส, ไม่มีอีเมล, ไม่มีรหัสผ่าน, ปิดบัญชี", async () => {
    await users.setPassword(admin.id, "secret-pass");
    assert.equal((await users.authenticate(" ADMIN@example.com", "secret-pass")).role, "ADMIN");
    assert.equal(await users.authenticate("admin@example.com", "wrong"), null);
    assert.equal(await users.authenticate("nobody@example.com", "secret-pass"), null);
    assert.equal(await users.authenticate("67070223@kmitl.ac.th", ""), null); // ยังไม่มี hash
    await users.update(admin.id, { active: false });
    assert.equal(await users.authenticate("admin@example.com", "secret-pass"), null);
    await users.update(admin.id, { active: true });
    await assert.rejects(() => users.setPassword("no-such-id", "x"));
  });

  await check("Admin เพิ่มนักศึกษาอีเมลอื่น (เช่น Gmail): เลือกคณะเอง / อีเมลรหัสนักศึกษาใช้คณะจากรหัสเสมอ", async () => {
    const gmail = await users.create({ email: "somsri@gmail.com", name: "สมศรี", role: "USER", facultyId: "07" });
    assert.equal(gmail.faculty_id, "07");
    assert.equal(gmail.student_id, null);
    // อีเมลรหัสนักศึกษา: ไม่สนค่าที่ส่งมา
    const real = await users.create({ email: "67010555@kmitl.ac.th", name: "วิศวะ", role: "USER", facultyId: "07" });
    assert.equal(real.faculty_id, "01");
    // 00/99 หรือรหัสมั่ว ไม่รับ / ไม่ส่ง = ไม่มีคณะ (เหมือนสมัครเอง)
    assert.equal((await users.create({ email: "a@gmail.com", name: "a", role: "USER", facultyId: "00" })).faculty_id, null);
    assert.equal((await users.create({ email: "b@gmail.com", name: "b", role: "USER" })).faculty_id, null);
    // แก้ภายหลัง: เปลี่ยนคณะได้เฉพาะอีเมลที่ไม่ใช่รหัส / ไม่ส่ง = คงเดิม / ค่าผิด = error
    assert.equal((await users.update(gmail.id, { facultyId: "01" })).faculty_id, "01");
    assert.equal((await users.update(gmail.id, { name: "สมศรี ใหม่" })).faculty_id, "01");
    await assert.rejects(() => users.update(gmail.id, { facultyId: "99" }), /คณะไม่ถูกต้อง/);
    assert.equal((await users.update(real.id, { facultyId: "07" })).faculty_id, "01");
    assert.equal(await users.facultyFromEmail("somsri@gmail.com"), null);
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
  await db.close();
})().catch(async (e) => {
  console.error("\n✗ ล้มเหลว:", e);
  process.exitCode = 1;
});
