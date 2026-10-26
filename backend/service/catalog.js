// service/catalog.js — ค่าคงที่ของคำร้อง (3c: ย้ายมาจาก data/mockRequests.js)

const { FACULTY_NAMES, DEPARTMENT_NAMES } = require("../db");

// ประเภทคำร้องบนฟอร์ม → หน่วยงานที่รับผิดชอบ (tickets.department_id)
// ตามที่ตกลงใน 3a: "ข้อเสนอแนะ" → กิจการนักศึกษา
const TYPE_DEPARTMENT = Object.freeze({
  "กิจกรรม": "activities",
  "ไอทีซัพพอร์ต": "it",
  "หลักสูตร": "academic",
  "อาคาร/สถานที่": "building",
  "ข้อเสนอแนะ": "student",
});

const TYPES = Object.freeze(Object.keys(TYPE_DEPARTMENT));
const STATUSES = Object.freeze(["รอดำเนินการ", "กำลังดำเนินการ", "เสร็จสิ้น"]);

const COMMON_FACULTY = "00";
const OTHER_FACULTY = "99";

// รายการคณะสำหรับฟอร์ม/ตัวกรอง: [{ id: "01", label: "คณะวิศวกรรมศาสตร์" }, ...] เรียงตามรหัส
const FACULTIES = Object.freeze(
  Object.entries(FACULTY_NAMES)
    .map(([id, label]) => Object.freeze({ id, label }))
    .sort((a, b) => a.id.localeCompare(b.id))
);

module.exports = {
  TYPES, STATUSES, TYPE_DEPARTMENT, FACULTIES, FACULTY_NAMES, DEPARTMENT_NAMES,
  COMMON_FACULTY, OTHER_FACULTY,
};
