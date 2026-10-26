// service/location.js — สถานที่ของคำร้อง (คณะ + อาคาร + ห้อง + รายละเอียดตำแหน่ง)
//
// แก้ (3c): คณะใช้รหัส 2 หลักชุดเดียวกับตาราง faculties ("00" ส่วนกลาง, "99" อื่น)
// แทนรหัสเดิม it/engineering/science/common/other และตัดช่อง "ชื่อคณะอื่น" ออก (ตกลงใน 3a)
// ใช้ทั้งตอนรับฟอร์ม, เก็บลง tickets (faculty_id, building, room, place_detail) และจัดกลุ่มหัวข้อปัญหา

const { FACULTIES, FACULTY_NAMES } = require("./catalog");
const { normalizeText } = require("../utils/text");

// จัดช่องว่างและแปลงเลขไทย
function clean(value) {
  if (typeof value !== "string") return "";

  return normalizeText(value)
    .replace(/[๐-๙]/g, (character) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(character)))
    .trim()
    .replace(/\s+/g, " ");
}

// ตึก a / อาคาร A / A ให้เป็นรหัสเดียวกัน
function buildingCode(value) {
  return clean(value).replace(/^(?:อาคาร|ตึก)\s*/i, "").toUpperCase();
}

// ห้อง 203 / 203 ให้เป็นรหัสเดียวกัน
function roomCode(value) {
  return clean(value).replace(/^ห้อง\s*/i, "").toUpperCase();
}

function keyPart(value) {
  return clean(value).toLowerCase();
}

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

// แยกข้อความแสดงผลกับ key สำหรับเปรียบเทียบ
function makePlace(fields, strict = true) {
  const facultyId = clean(fields.facultyId);
  const facultyLabel = FACULTY_NAMES[facultyId] || "";

  const building = buildingCode(fields.building);
  const room = roomCode(fields.room);
  const placeDetail = clean(fields.placeDetail);

  if (strict && !facultyLabel) {
    fail("เลือกคณะ/พื้นที่");
  }

  if ([building, room].some((value) => value.length > 100) || placeDetail.length > 200) {
    fail("อาคารและห้องไม่เกิน 100 ตัวอักษร รายละเอียดตำแหน่งไม่เกิน 200");
  }

  if (strict && !building && !room && !placeDetail) {
    fail("ระบุอาคาร ห้อง หรือรายละเอียดตำแหน่งอย่างน้อยหนึ่งอย่าง");
  }

  const label = facultyLabel || "ไม่ระบุคณะ/พื้นที่";
  const complete = Boolean(facultyLabel && (building || room || placeDetail));

  // ห้องเดียวกัน แต่รายละเอียดข้างบันได/หน้าประตู ไม่ทำให้กลายเป็นคนละห้อง
  const key = JSON.stringify([
    facultyId,
    keyPart(building),
    keyPart(room),
    room ? "" : keyPart(placeDetail),
  ]);

  const parts = (detail) =>
    [label, building ? `อาคาร ${building}` : "ไม่ระบุอาคาร", room && `ห้อง ${room}`, detail]
      .filter(Boolean)
      .join(" / ");

  return {
    version: 4,
    facultyId: facultyLabel ? facultyId : "",
    facultyLabel: label,
    building,
    room,
    placeDetail,
    key,
    label: parts(placeDetail),
    // สรุประดับห้อง ไม่เอารายละเอียดจุดย่อยของคนแรกไปเหมารวม
    groupLabel: parts(!room && placeDetail),
    complete,
  };
}

// ค่าจากฟอร์ม (ตรวจครบ)
function fromForm(form) {
  return makePlace(form, true);
}

// คำร้องจาก DB (รูปแบบที่ repo/tickets.js คืน) — ไม่ throw
function forRequest(request) {
  try {
    return makePlace(request.locationInfo || {}, false);
  } catch {
    return makePlace({}, false);
  }
}

module.exports = { FACULTIES, fromForm, forRequest, makePlace, clean };
