// ทดสอบบัญชีทดลองในเครื่อง
// รัน: SQLITE_PATH=:memory: node test/dev-seed.test.js
process.env.SQLITE_PATH = ":memory:";
process.env.DB_DRIVER = "sqlite";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const db = require("../db");
const users = require("../repo/users");
const { seedDevAccounts } = require("../repo/dev-seed");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

(async () => {
  await db.init();

  await check("สร้าง 40 บัญชี (5 เดิม + นศ. 17 คณะ + Staff 18), รันซ้ำไม่สร้างซ้ำ", async () => {
    assert.equal((await seedDevAccounts()).created.length, 40);
    assert.equal((await seedDevAccounts()).created.length, 0);
    assert.equal((await users.list()).length, 40);
  });

  await check("3c: นักศึกษา 1 คนต่อคณะ (คณะจากรหัส) + Staff ต่อคณะดูแลทุกฝ่าย", async () => {
    const codes = Object.keys(db.FACULTY_NAMES).filter((c) => c !== "00" && c !== "99");
    assert.equal(codes.length, 17);
    for (const code of codes) {
      const student = await users.findByEmail(`67${code}0001@kmitl.ac.th`);
      assert.equal(student.role, "USER");
      assert.equal(student.faculty_id, code, code);
      const staff = await users.findByEmail(`staff${code}@kmitl.ac.th`);
      assert.equal(staff.role, "STAFF");
      assert.equal(staff.units.length, 5);
      assert.ok(staff.units.every((u) => u.faculty_id === code));
    }
    const central = await users.findByEmail("staff00@kmitl.ac.th");
    assert.ok(central.units.every((u) => u.faculty_id === "00"));
  });

  await check("username ทดลองแปลงเป็นอีเมลได้", async () => {
    const { emailForDevUsername } = require("../repo/dev-seed");
    assert.equal(emailForDevUsername("user21"), "67210001@kmitl.ac.th");
    assert.equal(emailForDevUsername("STAFF00"), "staff00@kmitl.ac.th");
    assert.equal(emailForDevUsername("nobody"), null);
  });

  await check("ล็อกอินด้วยอีเมล + 1234 ได้ทุกบัญชี รหัสผิดไม่ได้", async () => {
    for (const email of [
      "admin@example.com", "somchai@example.com", "wipa@example.com",
      "67070999@kmitl.ac.th", "67010888@kmitl.ac.th",
    ]) {
      assert.ok(await users.authenticate(email, "1234"), email);
      assert.equal(await users.authenticate(email, "0000"), null);
    }
  });

  await check("คณะ/units ถูกต้อง", async () => {
    assert.equal((await users.findByEmail("67070999@kmitl.ac.th")).faculty_id, "07");
    assert.equal((await users.findByEmail("67010888@kmitl.ac.th")).faculty_id, "01");
    assert.deepEqual((await users.findByEmail("somchai@example.com")).units,
      [{ faculty_id: "07", department_id: "it" }]);
    assert.deepEqual((await users.findByEmail("wipa@example.com")).units,
      [{ faculty_id: "07", department_id: "building" }]);
  });

  await check("รหัสผ่านใน DB เป็น hash ไม่ใช่ 1234", async () => {
    const rows = await db.query("SELECT password_hash FROM users");
    for (const r of rows) assert.ok(r.password_hash.startsWith("scrypt$"));
  });

  await check("production: ไม่สร้างบัญชีทดลอง", async () => {
    await db.query("DELETE FROM user_units");
    await db.query("DELETE FROM users");
    process.env.NODE_ENV = "production";
    const r = await seedDevAccounts();
    assert.equal(r.skipped, true);
    assert.equal((await users.list()).length, 0);
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
  await db.close();
})().catch((e) => {
  console.error("\n✗ ล้มเหลว:", e);
  process.exitCode = 1;
});
