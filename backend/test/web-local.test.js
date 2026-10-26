// ทดสอบเว็บทั้งแอปในโหมด AUTH_MODE=local (เหมือนรันในเครื่อง) ผ่าน HTTP จริง
//   ล็อกอินด้วย username ทดลอง/อีเมล, สิทธิ์ตาม role, หน้าจัดการผู้ใช้, โปรไฟล์, logout
// ไม่สร้างคำร้อง (ไม่เขียนไฟล์ mock ใน data/db)
// รัน: SQLITE_PATH=:memory: node --no-warnings test/web-local.test.js
process.env.SQLITE_PATH = ":memory:";
process.env.DB_DRIVER = "sqlite";
process.env.AUTH_MODE = "local";
process.env.EVENTS_MODE = "local";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const db = require("../db");
const users = require("../repo/users");
const { seedDevAccounts } = require("../repo/dev-seed");
const app = require("../app");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

let base;

// browser จิ๋ว: เก็บ cookie ต่อคน ไม่ตาม redirect อัตโนมัติ
function browser() {
  let cookie = "";
  async function go(path, { method = "GET", form } = {}) {
    const response = await fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return {
      status: response.status,
      location: response.headers.get("location"),
      body: await response.text(),
    };
  }
  return {
    get: (path) => go(path),
    post: (path, form) => go(path, { method: "POST", form }),
    login: (username, password = "1234") => go("/signin", { method: "POST", form: { username, password } }),
  };
}

(async () => {
  await db.init();
  await seedDevAccounts();

  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    await check("/health ตอบ 200 โดยไม่ต้อง login", async () => {
      const r = await browser().get("/health");
      assert.equal(r.status, 200);
    });

    await check("ยังไม่ login → หน้าภายในพากลับ /login, หน้า signin แสดงบัญชีทดลอง", async () => {
      const b = browser();
      assert.equal((await b.get("/user/home")).location, "/login");
      assert.equal((await b.get("/admin/users")).location, "/login");
      assert.match((await b.get("/signin")).body, /บัญชีทดลอง/);
    });

    await check("รหัสผิด / username ไม่มีจริง → 401 พร้อมข้อความ", async () => {
      const b = browser();
      assert.equal((await b.login("user", "0000")).status, 401);
      const r = await b.login("nobody", "1234");
      assert.equal(r.status, 401);
      assert.match(r.body, /ไม่ถูกต้อง/);
    });

    await check("username ทดลอง (user) และอีเมลตัวใหญ่ ใช้ล็อกอินได้ → ไปหน้าแรกตาม role", async () => {
      assert.equal((await browser().login("user")).location, "/user/home");
      assert.equal((await browser().login("STAFF")).location, "/staff/dashboard");
      assert.equal((await browser().login("Admin@Example.com")).location, "/admin/dashboard");
    });

    await check("นักศึกษา: เข้าหน้า user ได้ เข้าหน้า admin/staff ไม่ได้", async () => {
      const b = browser();
      await b.login("user");
      for (const path of ["/user/home", "/user/requests", "/user/requests/new", "/user/issues", "/profile", "/notifications"]) {
        assert.equal((await b.get(path)).status, 200, path);
      }
      assert.equal((await b.get("/admin/users")).location, "/login");
      assert.equal((await b.get("/staff/dashboard")).status, 403);
      // ฟอร์มแจ้งปัญหาเลือกได้เฉพาะคณะตัวเอง (IT) + ส่วนกลาง
      const form = (await b.get("/user/requests/new")).body;
      assert.match(form, /value="07"/);
      assert.match(form, /value="00"/);
      assert.doesNotMatch(form, /value="01"/);
    });

    await check("Staff: dashboard/คำร้องได้ (คณะจาก user_units)", async () => {
      const b = browser();
      await b.login("staff");
      assert.equal((await b.get("/staff/dashboard")).status, 200);
      assert.equal((await b.get("/staff/requests")).status, 200);
      assert.equal((await b.get("/user/home")).location, "/login");
    });

    await check("Admin: หน้าจัดการผู้ใช้แสดงผู้ใช้จาก DB พร้อมคณะ/ฝ่าย", async () => {
      const b = browser();
      await b.login("admin");
      const page = (await b.get("/admin/users")).body;
      assert.match(page, /สมชาย ใจดี/);
      assert.match(page, /คณะเทคโนโลยีสารสนเทศ/);
      assert.match(page, /เทคโนโลยีสารสนเทศ/);
      assert.equal((await b.get("/admin/dashboard")).status, 200);
      assert.match((await b.get("/admin/users?q=wipa")).body, /วิภา/);
    });

    await check("Admin แก้ผู้ใช้: ชื่อ + units ของ Staff, กฎ Staff คณะเดียว, ห้ามลดบทบาทตัวเอง", async () => {
      const b = browser();
      await b.login("admin");
      const wipa = await users.findByEmail("wipa@example.com");
      const admin = await users.findByEmail("admin@example.com");

      let r = await b.post(`/admin/users/${wipa.id}`, {
        name: "วิภา ใหม่", role: "STAFF", "faculty[]": "01", "department[]": "building",
      });
      assert.equal(r.location, `/admin/users/${wipa.id}?saved=1`);
      const after = await users.findById(wipa.id);
      assert.equal(after.name, "วิภา ใหม่");
      assert.deepEqual(after.units, [{ faculty_id: "01", department_id: "building" }]);

      const two = new URLSearchParams([
        ["name", "x"], ["role", "STAFF"],
        ["faculty[]", "01"], ["department[]", "building"],
        ["faculty[]", "07"], ["department[]", "it"],
      ]);
      r = await fetch(`${base}/admin/users/${wipa.id}`, {
        method: "POST", redirect: "manual",
        headers: { cookie: (await loginCookie("admin")), "content-type": "application/x-www-form-urlencoded" },
        body: two.toString(),
      });
      assert.match(await r.text(), /Staff ต้องมีคณะเดียว/);

      r = await b.post(`/admin/users/${admin.id}`, { name: "แอดมิน", role: "USER" });
      assert.match(r.body, /ไม่สามารถลดบทบาทบัญชีของตัวเองได้/);
      assert.equal((await users.findById(admin.id)).role, "ADMIN");
    });

    await check("เปลี่ยน role มีผลทันทีกับ session ที่ล็อกอินอยู่", async () => {
      const student = browser();
      await student.login("user2");
      assert.equal((await student.get("/user/home")).status, 200);

      const b = browser();
      await b.login("admin");
      const user2 = await users.findByEmail("67010888@kmitl.ac.th");
      await b.post(`/admin/users/${user2.id}`, { name: "ธนา", role: "STAFF" });

      // เป็น Staff ที่ยังไม่มีคณะ → หน้า user ไม่ได้, หน้า staff บอกให้ Admin ตั้งคณะ
      assert.equal((await student.get("/user/home")).location, "/login");
      const staffPage = await student.get("/staff/dashboard");
      assert.equal(staffPage.status, 403);
      assert.match(staffPage.body, /ยังไม่มีข้อมูลคณะ/);
    });

    await check("โปรไฟล์: แก้ชื่อตัวเองได้ ชื่อขึ้นใน DB", async () => {
      const b = browser();
      await b.login("user");
      const r = await b.post("/profile", { name: "สมหญิง ใหม่" });
      assert.equal(r.location, "/profile?saved=1");
      assert.equal((await users.findByEmail("67070999@kmitl.ac.th")).name, "สมหญิง ใหม่");
      assert.equal((await b.post("/profile", { name: "" })).status, 200); // แสดงข้อความ error
    });

    await check("Admin ลบผู้ใช้: ลบตัวเองไม่ได้, คนที่ถูกลบหลุดจากระบบทันที", async () => {
      const victim = browser();
      await victim.login("staff2");
      assert.equal((await victim.get("/profile")).status, 200);

      const b = browser();
      await b.login("admin");
      const admin = await users.findByEmail("admin@example.com");
      const wipa = await users.findByEmail("wipa@example.com");

      await b.post(`/admin/users/${admin.id}/delete`, {});
      assert.ok(await users.findById(admin.id));

      await b.post(`/admin/users/${wipa.id}/delete`, {});
      assert.equal(await users.findById(wipa.id), null);
      assert.equal((await victim.get("/profile")).location, "/login");
    });

    await check("logout: session ถูกลบจากตาราง sessions", async () => {
      const b = browser();
      await b.login("admin");
      const before = (await db.query("SELECT COUNT(*) AS n FROM sessions"))[0].n;
      assert.equal((await b.get("/logout")).location, "/login?out=1");
      const after = (await db.query("SELECT COUNT(*) AS n FROM sessions"))[0].n;
      assert.equal(Number(after), Number(before) - 1);
      assert.equal((await b.get("/admin/users")).location, "/login");
    });
  } finally {
    server.close();
    app.locals.sessionStore?.close();
  }

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
  await db.close();
})().catch((error) => {
  console.error("\n✗ ไม่ผ่าน:", error);
  process.exit(1);
});

// ล็อกอินแล้วคืน cookie (ใช้กับ request ที่ต้องส่งฟอร์มเอง)
async function loginCookie(username) {
  const r = await fetch(`${base}/signin`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: "1234" }).toString(),
  });
  return r.headers.get("set-cookie").split(";")[0];
}
