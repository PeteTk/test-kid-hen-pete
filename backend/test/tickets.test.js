// ทดสอบขั้น 3c: คำร้อง + แจ้งเตือนใน DB + EventBridge (client ปลอม) + หัวข้อปัญหาอ่านคำร้องจาก DB
// รัน: SQLITE_PATH=:memory: node --no-warnings test/tickets.test.js
process.env.SQLITE_PATH = ":memory:";
process.env.DB_DRIVER = "sqlite";
process.env.AUTH_MODE = "local";
process.env.EVENTS_MODE = "local";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const db = require("../db");
const users = require("../repo/users");
const tickets = require("../repo/tickets");
const notifications = require("../repo/notifications");
const { seedDevAccounts, seedSampleTickets, emailForDevUsername } = require("../repo/dev-seed");
const { createEvents, describe } = require("../service/events");
const access = require("../service/faculty-access");
const locations = require("../service/location");
const { normalizeText } = require("../utils/text");
const app = require("../app");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

let base;
const user = async (username) => users.findByEmail(emailForDevUsername(username));

function browser() {
  let cookie = "";
  async function go(p, { method = "GET", form, multipart } = {}) {
    let body;
    const headers = cookie ? { cookie } : {};
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    if (multipart) {
      body = new FormData();
      for (const [k, v] of Object.entries(multipart)) body.append(k, v);
    }
    const r = await fetch(base + p, { method, redirect: "manual", headers, body });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, location: r.headers.get("location"), body: await r.text() };
  }
  return {
    get: (p) => go(p),
    post: (p, form) => go(p, { method: "POST", form }),
    multipart: (p, fields) => go(p, { method: "POST", multipart: fields }),
    login: (u) => go("/signin", { method: "POST", form: { username: u, password: "1234" } }),
  };
}


(async () => {
  await db.init();
  await seedDevAccounts();

  await check("normalizeText: NFKC แต่ไม่แยกสระอำ (บั๊กสถานะเดิม)", async () => {
    assert.equal(normalizeText("กำลังดำเนินการ"), "กำลังดำเนินการ");
    assert.equal(normalizeText("ＡＢＣ１２"), "ABC12");
    assert.equal(locations.clean("อาคาร  ๑๒"), "อาคาร 12");
  });

  await check("คำร้องตัวอย่าง: 6 รายการ หลายคณะ/สถานะ + แจ้งเตือน, รันซ้ำไม่สร้างซ้ำ", async () => {
    assert.equal((await seedSampleTickets()).created, 6);
    assert.equal((await seedSampleTickets()).created, 0);
    const all = await tickets.list();
    assert.equal(all.length, 6);
    assert.deepEqual([...new Set(all.map((t) => t.facultyId))].sort(), ["00", "01", "05", "07"]);
    assert.ok(all.some((t) => t.status === "เสร็จสิ้น"));
    // เจ้าของ #0004 ได้แจ้งเตือน 2 ครั้ง (กำลังดำเนินการ, เสร็จสิ้น)
    const owner = await user("user05");
    const mine = await notifications.listForUser(owner.id);
    assert.equal(mine.length, 2);
    assert.equal(mine.every((n) => n.requestId === 4), true);
  });

  await check("สิทธิ์นักศึกษา: คณะตัวเอง + ส่วนกลางเท่านั้น, ไม่มีคณะ = ปฏิเสธ", async () => {
    const s = await user("user21");
    const scope = access.studentScope(s);
    assert.deepEqual(scope.choices.map((c) => c.id), ["21", "00"]);
    assert.throws(() => access.fromStudentForm(s, { facultyId: "07", room: "1" }), /เฉพาะคณะ/);
    assert.equal(access.fromStudentForm(s, { facultyId: "00", room: "1" }).facultyId, "00");
    const noFaculty = await users.create({ email: "x@kmitl.ac.th", name: "x", role: "USER" });
    assert.throws(() => access.studentScope(noFaculty), /ไม่มีข้อมูลคณะ/);
  });

  await check("tickets.create: code ต่อเนื่อง, หน่วยงานตามประเภท, ประวัติ, รูปแนบ", async () => {
    const s = await user("user11");
    const t = await tickets.create({
      userId: s.id,
      place: locations.fromForm({ facultyId: "11", building: "a", room: "ห้อง 101" }),
      type: "กิจกรรม",
      title: "ขอจัดกิจกรรม",
      detail: "ขอใช้ห้องจัดกิจกรรมชมรม",
      images: [{ key: "requests/x.png", mime: "image/png", size: 10 }],
    });
    assert.equal(t.code, "#0007");
    assert.equal(t.id, 7);
    assert.equal(t.departmentId, "activities");
    assert.equal(t.locationInfo.building, "A");
    assert.equal(t.locationInfo.room, "101");
    assert.deepEqual(t.images, ["/uploads/requests/x.png"]);
    assert.equal(t.history.length, 1);
    assert.equal((await tickets.findBySeq(7)).ticketId, t.ticketId);
    assert.equal(await tickets.findBySeq("abc"), null);
  });

  await check("แจ้งเตือนคำร้องใหม่: Admin + Staff คณะ/ฝ่ายตรง ไม่รวม Staff คณะอื่นและผู้แจ้ง", async () => {
    const t = (await tickets.list({ q: "#0007" }))[0];
    await notifications.newTicket(t);
    const staff11 = await user("staff11");
    const staff07 = await user("staff07");
    const admin = await user("admin");
    const owner = await user("user11");
    assert.equal((await notifications.listForUser(staff11.id)).filter((n) => n.requestId === 7).length, 1);
    assert.equal((await notifications.listForUser(admin.id)).filter((n) => n.requestId === 7).length, 1);
    assert.equal((await notifications.listForUser(staff07.id)).filter((n) => n.requestId === 7).length, 0);
    assert.equal((await notifications.listForUser(owner.id)).length, 0);
  });

  await check("tickets.update: บันทึก ticket_updates, resolved_at, ไม่เปลี่ยน = ไม่บันทึก", async () => {
    const t = await tickets.findBySeq(7);
    const staff = await user("staff11");
    const r1 = await tickets.update(t.ticketId, { status: "เสร็จสิ้น", note: "เรียบร้อย", actorId: staff.id });
    assert.equal(r1.statusChanged, true);
    assert.equal(r1.ticket.history.length, 2);
    const row = (await db.query("SELECT resolved_at FROM tickets WHERE id=?", [t.ticketId]))[0];
    assert.ok(row.resolved_at);
    const r2 = await tickets.update(t.ticketId, { status: "เสร็จสิ้น", note: "เรียบร้อย", actorId: staff.id });
    assert.equal(r2.statusChanged || r2.noteChanged, false);
    await assert.rejects(tickets.update(t.ticketId, { status: "x", note: "", actorId: staff.id }), /สถานะ/);
  });

  await check("EventBridge: ส่ง PutEvents ตามรูปแบบที่ Terraform รอ และไม่เขียนแจ้งเตือนเอง", async () => {
    const sent = [];
    const client = { async send(cmd) { sent.push(cmd.input); return { FailedEntryCount: 0, Entries: [{}] }; } };
    const ev = createEvents({ mode: "eventbridge", client, source: "kidhen.app" });
    const t = await tickets.findBySeq(7);
    const before = (await db.query("SELECT COUNT(*) AS n FROM notifications"))[0].n;

    const r = await ev.ticketChanged(t, { statusChanged: true });
    assert.equal(r.via, "eventbridge");
    const entry = sent[0].Entries[0];
    assert.equal(entry.Source, "kidhen.app");
    assert.equal(entry.DetailType, "TicketStatusChanged");
    const detail = JSON.parse(entry.Detail);
    assert.equal(detail.ticketId, t.ticketId);
    assert.equal(detail.newStatus, "เสร็จสิ้น");
    assert.match(detail.title, /ได้รับการแก้ไขแล้ว/);
    assert.equal((await db.query("SELECT COUNT(*) AS n FROM notifications"))[0].n, before);
  });

  await check("EventBridge ล้ม → เขียนแจ้งเตือนในเว็บแทน (เจ้าของ + Staff + Admin)", async () => {
    const client = { async send() { throw new Error("AccessDenied"); } };
    const ev = createEvents({ mode: "eventbridge", client });
    const t = await tickets.findBySeq(7);
    const owner = await user("user11");
    const origError = console.error;
    console.error = () => {};
    try {
      const r = await ev.ticketChanged(t, { statusChanged: true });
      assert.equal(r.via, "local");
    } finally {
      console.error = origError;
    }
    const mine = await notifications.listForUser(owner.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "เสร็จสิ้น");
    assert.match(describe(t, { statusChanged: false }).title, /มีข้อความจากเจ้าหน้าที่/);
  });

  // ===== ผ่านหน้าเว็บ =====
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    await check("เว็บ: นักศึกษาวิศวะส่งคำร้อง + รูป → Staff วิศวะเห็น, Staff IT ไม่เห็น", async () => {
      const s = browser();
      await s.login("user01");
      const png = new Blob([Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary")], { type: "image/gif" });
      const r = await s.multipart("/user/requests/new", {
        type: "ไอทีซัพพอร์ต", title: "โปรเจคเตอร์ไม่ติด", detail: "โปรเจคเตอร์ห้อง 402 เปิดไม่ติด",
        facultyId: "01", building: "E12", room: "402", images: new File([png], "a.gif", { type: "image/gif" }),
      });
      assert.equal(r.location, "/user/home?sent=1");
      const t = await tickets.findBySeq(8);
      assert.equal(t.facultyId, "01");
      assert.equal(t.departmentId, "it");
      assert.equal(t.images.length, 1);
      fs.rmSync(path.join(__dirname, "../../frontend/public", t.images[0]), { force: true });

      const eng = browser();
      await eng.login("staff01");
      assert.equal((await eng.get("/staff/requests/8")).status, 200);
      assert.match((await eng.get("/notifications")).body, /มีคำร้องใหม่ #0008/);

      const it = browser();
      await it.login("staff07");
      assert.equal((await it.get("/staff/requests/8")).status, 404);
      assert.doesNotMatch((await it.get("/staff/requests")).body, /#0008/);
    });

    await check("เว็บ: ส่งคำร้องคณะอื่นไม่ได้ (403) และไม่มีคำร้องถูกสร้าง", async () => {
      const s = browser();
      await s.login("user01");
      const before = await tickets.count();
      const r = await s.post("/user/requests/new", {
        type: "ไอทีซัพพอร์ต", title: "x", detail: "y", facultyId: "07", building: "A",
      });
      assert.equal(r.status, 403);
      assert.equal(await tickets.count(), before);
    });

    await check("เว็บ: Staff เปลี่ยนสถานะ (ภาษาไทยมีสระอำ) → เจ้าของได้แจ้งเตือน → กดแล้วไปหน้าคำร้อง", async () => {
      const eng = browser();
      await eng.login("staff01");
      const r = await eng.post("/staff/requests/8/update", { status: "กำลังดำเนินการ", note: "ส่งช่างแล้ว" });
      assert.equal(r.location, "/staff/requests/8?saved=1");
      assert.equal((await tickets.findBySeq(8)).status, "กำลังดำเนินการ");

      const s = browser();
      await s.login("user01");
      const page = (await s.get("/notifications")).body;
      assert.match(page, /คำร้อง #0008 ได้รับการอัปเดตสถานะ/);
      const id = /\/notifications\/([0-9a-f-]{36})/.exec(page)[1];
      assert.equal((await s.get(`/notifications/${id}`)).location, "/user/requests/8");
      assert.match((await s.get("/user/requests/8")).body, /ส่งช่างแล้ว/);

      // นักศึกษาคนอื่นเปิดคำร้องนี้ไม่ได้ / เปิดแจ้งเตือนของคนอื่นไม่ได้
      const other = browser();
      await other.login("user");
      assert.equal((await other.get("/user/requests/8")).location, "/user/requests");
      assert.equal((await other.get(`/notifications/${id}`)).location, "/notifications");
    });

    await check("เว็บ: Admin เห็นทุกคณะ ค้นหา/กรองได้, dashboard นับจาก DB", async () => {
      const a = browser();
      await a.login("admin");
      const all = (await a.get("/admin/requests")).body;
      for (const code of ["#0001", "#0005", "#0008"]) assert.match(all, new RegExp(code));
      const done = (await a.get("/admin/requests?status=" + encodeURIComponent("เสร็จสิ้น"))).body;
      assert.match(done, /#0004/);
      assert.doesNotMatch(done, /#0001/);
      assert.equal((await a.get("/admin/dashboard")).status, 200);
    });

    await check("หัวข้อปัญหา (AI ปลอม): จัดกลุ่ม #0002+#0003 จาก DB → นศ.วิศวะเห็น → สนับสนุนแล้วได้คำร้องใหม่", async () => {
      const issues = require("../service/issues");

      const fakeAI = async ({ input }) => {
        const groups = new Map();
        for (const r of input.reports) {
          const key = JSON.stringify([r.type, r.placeKey, [...r.symptoms].sort()]);
          if (!groups.has(key)) groups.set(key, { title: r.symptoms[0], ids: [] });
          groups.get(key).ids.push(r.id);
        }
        return {
          groups: [...groups.values()].map(({ title, ids }) => ({
            topicId: null, title, summary: `พบรายงาน${title}`, ids,
          })),
        };
      };

      const result = await issues.runBatch(fakeAI);
      assert.ok(result.processed >= 2);
      // 3d: หัวข้ออยู่ใน RDS/SQLite (ตาราง issues) + ประวัติใน ai_runs + ไม่มีข้อความต้นฉบับใน ai_inputs
      const run = await db.query("SELECT success, processed FROM ai_runs ORDER BY started_at DESC LIMIT 1");
      assert.equal(Number(run[0].success), 1);
      for (const row of await db.query("SELECT sanitized_text FROM ai_inputs WHERE state='ready'")) {
        assert.doesNotMatch(row.sanitized_text, /แอร์|E12|301|ไม่เย็น/);
      }
      // รอบสอง: ไม่มีอะไรใหม่ → ไม่เรียก AI
      let called = false;
      assert.equal((await issues.runBatch(async () => { called = true; })).processed, 0);
      assert.equal(called, false);

      const topics = await issues.publicTopics();
      const aircon = topics.find((t) => t.count === 2);
      assert.ok(aircon, "ต้องมีหัวข้อที่รวม 2 คำร้อง");
      assert.equal(aircon.locationInfo.facultyId, "01");

      const s = browser();
      await s.login("user01");
      assert.match((await s.get("/user/issues")).body, /เครื่องปรับอากาศขัดข้อง/);

      const it = browser();
      await it.login("user"); // คณะ IT ไม่เห็นหัวข้อของวิศวะ
      assert.doesNotMatch((await it.get("/user/issues")).body, /เครื่องปรับอากาศขัดข้อง/);

      // user01 เป็นเจ้าของ #0002 อยู่แล้ว (ยังไม่เสร็จ) → แจ้งซ้ำในหัวข้อนี้ไม่ได้
      const form = { facultyId: "01", building: "E12", room: "301", detail: "แอร์ไม่เย็นเหมือนกัน", occurredAt: "2026-10-26T09:00" };
      await assert.rejects(issues.support(aircon.id, await user("user01"), form), /ยังไม่เสร็จ/);

      // นศ.วิศวะอีกคน → ได้คำร้องใหม่ผูกกับหัวข้อทันที
      const another = await users.create({ email: "67019999@kmitl.ac.th", name: "วิศวะ อีกคน", role: "USER" });
      const before = await tickets.count();
      const id = await issues.support(aircon.id, another, form);
      assert.equal(await tickets.count(), before + 1);
      assert.equal((await issues.publicTopics()).find((t) => t.id === aircon.id).count, 3);
      assert.equal((await tickets.findBySeq(id)).owner, another.id);

      // จุดที่พบต้องตรงกับหัวข้อ
      await assert.rejects(issues.support(aircon.id, another, { ...form, room: "999" }), /ไม่ตรงกับหัวข้อ/);
      assert.ok(id > 8);

      // Admin: แก้ข้อความ / ซ่อน → นักศึกษาไม่เห็น
      await issues.editTopic(aircon.id, { title: "แอร์ห้อง 301 ไม่เย็น", summary: "พบแอร์ไม่เย็น" });
      assert.equal((await issues.detail(aircon.id)).item.title, "แอร์ห้อง 301 ไม่เย็น");
      assert.equal((await issues.detail(aircon.id)).reports.length, 3);
      await issues.setPublished(aircon.id, false);
      assert.equal((await issues.publicTopics()).some((t) => t.id === aircon.id), false);
      const dash = await issues.dashboard();
      assert.equal(dash.running, false);
      assert.equal(dash.lastRun.success, true);
      assert.ok(Array.isArray(dash.held));
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
