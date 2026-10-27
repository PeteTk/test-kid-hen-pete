// ทดสอบการเตรียมข้อมูลให้ AI สรุป "ปัญหาที่พบบ่อย" (ส่งเฉพาะหัวข้อที่ปิดข้อมูลส่วนตัว) + ตรวจผล AI
// รัน: node --no-warnings test/issues-ai.test.js   (ไม่ต้องต่อ AWS / Gemini)
process.env.AUTH_MODE = "local";
process.env.SQLITE_PATH = ":memory:";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const issues = require("../service/issues");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("  ✓", name);
}

const PLACE = { facultyId: "01", building: "E12", room: "301" };
const request = (over = {}) => ({
  id: 1, type: "อาคาร/สถานที่", title: "ลิฟต์ตึก E12 ค้างบ่อย", detail: "ลิฟต์ค้างชั้น 3",
  locationInfo: PLACE, isPrivate: false, isSensitive: false, ...over,
});

check("ปิดอีเมล เบอร์ รหัสนักศึกษา ลิงก์ และชื่อที่มีคำนำหน้า", () => {
  const out = issues.sanitizeTitle(
    "แจ้ง อาจารย์สมชาย 67070223 โทร 081-234-5678 a.b@kmitl.ac.th https://x.co/a คุณวิภา ห้อง 301"
  );
  assert.doesNotMatch(out, /สมชาย|วิภา|67070223|081|kmitl|x\.co/);
  assert.match(out, /\[บุคคล\].*\[ตัวเลข\].*\[เบอร์\].*\[อีเมล\].*\[ลิงก์\].*ห้อง 301/);
  assert.equal(issues.sanitizeTitle("คุณภาพน้ำดื่มไม่ดี"), "คุณภาพน้ำดื่มไม่ดี"); // ไม่ใช่ชื่อคน
  assert.ok(issues.sanitizeTitle("ก".repeat(400)).length <= 150);
});

check("เรื่องทั่วไปที่ไม่มีในรายการอาการเดิม → ส่ง AI ได้ (เฉพาะหัวข้อ ไม่ส่งรายละเอียด)", () => {
  const { report, reason } = issues.reviewReport(request());
  assert.equal(reason, undefined);
  assert.deepEqual(Object.keys(report).sort(), ["id", "placeKey", "title", "type"]);
  assert.equal(report.title, "ลิฟต์ตึก E12 ค้างบ่อย");
  assert.equal(report.placeKey.length, 64); // hash ไม่ใช่ชื่อสถานที่
  // คำทั่วไปที่เดิมทำให้ถูกเก็บภายใน
  assert.ok(issues.reviewReport(request({ title: "ที่นั่งในห้องสมุดไม่พอสำหรับนักศึกษา" })).report);
});

check("เก็บภายในพร้อมเหตุผล: ติ๊กส่วนตัว / เนื้อหาอ่อนไหว / สถานที่ไม่ครบ / หัวข้อไม่ชัดเจน", () => {
  assert.match(issues.reviewReport(request({ isPrivate: true })).reason, /ส่วนตัว/);
  assert.match(issues.reviewReport(request({ detail: "ถูกคุกคามในห้องเรียน" })).reason, /อ่อนไหว/);
  assert.match(issues.reviewReport(request({ locationInfo: { facultyId: "01" } })).reason, /สถานที่/);
  assert.match(issues.reviewReport(request({ title: "1234567" })).reason, /ไม่ชัดเจน/);
});

const r1 = { id: 1, type: "A", placeKey: "p1", title: "ลิฟต์ค้าง" };
const r2 = { id: 2, type: "A", placeKey: "p1", title: "ลิฟต์เสีย" };
const r3 = { id: 3, type: "A", placeKey: "p2", title: "ลิฟต์ค้าง" };
const g = (ids, over = {}) => ({ topicId: null, title: "ลิฟต์ขัดข้อง", summary: "พบลิฟต์ค้าง", ids, ...over });

check("ตรวจผล AI: ผ่านเมื่อครบทุก id (กลุ่ม + skip)", () => {
  issues.validateGroups({ groups: [g([1, 2]), g([3])], skip: [] }, [r1, r2, r3], []);
  issues.validateGroups({ groups: [g([1])], skip: [2] }, [r1, r2], []);
  issues.validateGroups({ groups: [], skip: [1] }, [r1], []);
});

check("ตรวจผล AI: ไม่ผ่านเมื่อรวมต่างสถานที่ / ซ้ำ / ไม่ครบ / ข้อความผิดกฎ / อ้างหัวข้อผิด", () => {
  assert.throws(() => issues.validateGroups({ groups: [g([1, 3])], skip: [] }, [r1, r3], []), /สถานที่/);
  assert.throws(() => issues.validateGroups({ groups: [g([1])], skip: [1] }, [r1], []), /ซ้ำ/);
  assert.throws(() => issues.validateGroups({ groups: [g([1])], skip: [] }, [r1, r2], []), /ไม่ครบ/);
  assert.throws(() => issues.validateGroups({ groups: [g([1], { title: "ติดต่อ 0812345678" })], skip: [] }, [r1], []), /กฎ/);
  assert.throws(() => issues.validateGroups({ groups: [g([1], { summary: "แจ้ง 5 คน" })], skip: [] }, [r1], []), /กฎ/);
  const other = { id: "t1", type: "A", placeKey: "p2" };
  assert.throws(() => issues.validateGroups({ groups: [g([1], { topicId: "t1" })], skip: [] }, [r1], [other]), /หัวข้อเดิม/);
  issues.validateGroups({ groups: [g([3], { topicId: "t1" })], skip: [] }, [r3], [other]);
});

console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
