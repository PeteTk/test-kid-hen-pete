// repo/dev-seed.js — บัญชีทดลอง + คำร้องตัวอย่าง สำหรับรันในเครื่องเท่านั้น
//
// ทำงานเฉพาะเมื่อใช้ SQLite และไม่ใช่ production (ไม่สร้างบน MySQL/RDS เด็ดขาด)
// รหัสผ่านทุกบัญชีคือ 1234 เก็บแบบ hash · ล็อกอินด้วย username หรืออีเมลก็ได้
//
// 3c: เพิ่ม "นักศึกษา 1 + Staff 1 ต่อคณะ" ครบทุกคณะ เพื่อทดสอบการเลือกคณะ/สิทธิ์ Staff
//   นักศึกษา  user<รหัสคณะ>  = 67<รหัสคณะ>0001@kmitl.ac.th   เช่น user01 = 67010001@kmitl.ac.th (วิศวะ)
//   Staff     staff<รหัสคณะ> = staff<รหัสคณะ>@kmitl.ac.th   ดูแลทุกฝ่ายของคณะนั้น
//   staff00 = พื้นที่ส่วนกลาง (ทุกฝ่าย)

const db = require("../db");
const users = require("./users");

const DEV_PASSWORD = "1234";

// คณะจริง (ไม่รวม 00 ส่วนกลาง และ 99 อื่น)
const FACULTY_CODES = Object.keys(db.FACULTY_NAMES)
  .filter((code) => code !== "00" && code !== "99")
  .sort();

const ALL_DEPARTMENTS = Object.keys(db.DEPARTMENT_NAMES);

// บัญชีเดิมตั้งแต่ 3b-1 (คงไว้ ใช้ทดสอบต่อได้)
const BASE_ACCOUNTS = [
  { username: "admin", email: "admin@example.com", name: "ผู้ดูแล ระบบ", role: "ADMIN" },
  {
    username: "staff", email: "somchai@example.com", name: "สมชาย ใจดี", role: "STAFF",
    units: [{ faculty_id: "07", department_id: "it" }],
  },
  {
    username: "staff2", email: "wipa@example.com", name: "วิภา ทำงานดี", role: "STAFF",
    units: [{ faculty_id: "07", department_id: "building" }],
  },
  { username: "user", email: "67070999@kmitl.ac.th", name: "สมหญิง เรียนดี", role: "USER" },
  { username: "user2", email: "67010888@kmitl.ac.th", name: "ธนา ขยันเรียน", role: "USER" },
];

const FACULTY_ACCOUNTS = [
  ...FACULTY_CODES.map((code) => ({
    username: `user${code}`,
    email: `67${code}0001@kmitl.ac.th`,
    name: `นักศึกษา ${db.FACULTY_NAMES[code]}`,
    role: "USER",
  })),
  ...["00", ...FACULTY_CODES].map((code) => ({
    username: `staff${code}`,
    email: `staff${code}@kmitl.ac.th`,
    name: `เจ้าหน้าที่ ${db.FACULTY_NAMES[code]}`,
    role: "STAFF",
    units: ALL_DEPARTMENTS.map((department_id) => ({ faculty_id: code, department_id })),
  })),
];

const DEV_ACCOUNTS = [...BASE_ACCOUNTS, ...FACULTY_ACCOUNTS];

function allowed() {
  return !db.mysql && process.env.NODE_ENV !== "production";
}

// บัญชีทดลองบน AWS (RDS): Terraform ตั้ง SEED_TEST_ACCOUNTS=true เมื่อ create_test_accounts = true
// และสร้างบัญชีเดียวกันใน Cognito ให้ (รหัสผ่านอยู่ที่ Cognito — ในตาราง users ไม่ใช้)
// ตารางนี้ต้องมีไว้เพราะ Staff ต้องมี คณะ/ฝ่าย (user_units) ซึ่ง Cognito ไม่มี
function testAccountsEnabled() {
  return allowed() || String(process.env.SEED_TEST_ACCOUNTS || "").toLowerCase() === "true";
}

// "user01" → "67010001@kmitl.ac.th" (เฉพาะเมื่อเปิดบัญชีทดลอง) ไม่พบคืน null
function emailForDevUsername(username) {
  if (!testAccountsEnabled()) return null;
  const key = String(username || "").trim().toLowerCase();
  return DEV_ACCOUNTS.find((a) => a.username === key)?.email ?? null;
}

// เรียกซ้ำได้ ข้ามบัญชีที่มีอยู่แล้ว (ไม่เขียนทับรหัสผ่านหรือ units ที่แก้ไว้)
async function seedDevAccounts() {
  if (!testAccountsEnabled()) return { skipped: true, created: [] };

  const created = [];
  // ใช้ hash เดียวกันทุกบัญชี (บัญชีทดลอง) เพื่อให้เปิดเซิร์ฟเวอร์เร็ว
  const passwordHash = users.hashPassword(DEV_PASSWORD);

  for (const account of DEV_ACCOUNTS) {
    if (await users.findByEmail(account.email)) continue;

    try {
      const user = await users.create({
        email: account.email,
        name: account.name,
        role: account.role,
        passwordHash,
      });

      if (account.units) await users.setUnits(user.id, account.units);
      created.push(account.email);
    } catch (error) {
      // RDS: EC2 อีกเครื่องสร้างไปพร้อมกัน (UNIQUE email) → ข้าม
      if (allowed()) throw error;
      console.warn(`[seed] ข้าม ${account.email}:`, error.message);
    }
  }

  return { skipped: false, created };
}

// ---------- คำร้องตัวอย่าง (สร้างครั้งเดียวเมื่อยังไม่มีคำร้องเลย) ----------
// มีหลายคณะ/หลายประเภท/หลายสถานะ + คำร้องอาการเดียวกันห้องเดียวกัน 2 รายการ (ทดสอบจัดกลุ่ม AI)
const SAMPLE_TICKETS = [
  {
    by: "user", type: "ไอทีซัพพอร์ต", title: "Wi-Fi หลุดบ่อยในห้องเรียน",
    detail: "Wi-Fi หลุดทุก 5 นาทีระหว่างเรียน", place: { facultyId: "07", building: "LX", room: "203" },
    then: [{ by: "staff07", status: "กำลังดำเนินการ", note: "ส่งช่างตรวจ access point แล้ว" }],
  },
  {
    by: "user01", type: "อาคาร/สถานที่", title: "แอร์ไม่เย็นห้อง 301",
    detail: "แอร์ห้อง 301 ไม่เย็นตั้งแต่สัปดาห์ก่อน", place: { facultyId: "01", building: "E12", room: "301" },
  },
  {
    by: "user2", type: "อาคาร/สถานที่", title: "เครื่องปรับอากาศห้อง 301 ไม่เย็น",
    detail: "แอร์ไม่เย็นจนเรียนไม่ได้", place: { facultyId: "01", building: "E12", room: "301" },
  },
  {
    by: "user05", type: "ข้อเสนอแนะ", title: "ขอเพิ่มพื้นที่จอดรถ",
    detail: "ที่จอดรถหน้าคณะเต็มตั้งแต่ 8 โมง ขอเพิ่มพื้นที่จอดรถ", place: { facultyId: "05", placeDetail: "ลานจอดรถหน้าคณะ" },
    then: [
      { by: "staff05", status: "กำลังดำเนินการ", note: "รับเรื่องแล้ว" },
      { by: "staff05", status: "เสร็จสิ้น", note: "เปิดลานจอดรถด้านหลังเพิ่มแล้ว" },
    ],
  },
  {
    by: "user10", type: "อาคาร/สถานที่", title: "หลอดไฟทางเดินดับ",
    detail: "หลอดไฟทางเดินหน้าหอประชุมดับหลายดวง", place: { facultyId: "00", building: "หอประชุม", placeDetail: "ทางเดินหน้าหอประชุม" },
  },
  {
    by: "user", type: "หลักสูตร", title: "สอบถามการเทียบโอนรายวิชา",
    detail: "ต้องการทราบขั้นตอนการเทียบโอนรายวิชาเลือกเสรี", place: { facultyId: "07", placeDetail: "สำนักงานคณะ" },
  },
];

async function seedSampleTickets() {
  if (!testAccountsEnabled()) return { skipped: true, created: 0 };

  const rows = await db.query("SELECT COUNT(*) AS n FROM tickets");
  if (Number(rows[0].n) > 0) return { skipped: true, created: 0 };

  // require ตรงนี้ เพื่อเลี่ยง require วนกันตอนโหลด
  const tickets = require("./tickets");
  const notifications = require("./notifications");
  const { makePlace } = require("../service/location");
  const { describe } = require("../service/events");

  const byName = async (username) => users.findByEmail(emailForDevUsername(username));

  for (const sample of SAMPLE_TICKETS) {
    const owner = await byName(sample.by);
    if (!owner) continue; // บัญชีทดลองยังสร้างไม่ครบ
    let ticket = await tickets.create({
      userId: owner.id,
      place: makePlace(sample.place, true),
      type: sample.type,
      title: sample.title,
      detail: sample.detail,
    });
    await notifications.newTicket(ticket);

    for (const step of sample.then || []) {
      const actor = await byName(step.by);
      if (!actor) break;
      const result = await tickets.update(ticket.ticketId, {
        status: step.status, note: step.note, actorId: actor.id,
      });
      ticket = result.ticket;
      await notifications.statusChanged(ticket, describe(ticket, result));
    }
  }

  return { skipped: false, created: SAMPLE_TICKETS.length };
}

module.exports = {
  seedDevAccounts, seedSampleTickets, allowed, testAccountsEnabled, emailForDevUsername,
  DEV_ACCOUNTS, BASE_ACCOUNTS, FACULTY_ACCOUNTS, DEV_PASSWORD,
};
