// service/faculty-access.js — สิทธิ์ของนักศึกษาตามคณะ (ฝั่ง server)
//
// นักศึกษาแจ้งได้เฉพาะ "คณะตัวเอง" (users.faculty_id จากรหัสในอีเมล) หรือ "พื้นที่ส่วนกลาง" (00)
// ไม่เชื่อ facultyId ที่ browser ส่งมา
// แก้ (3c): รับผู้ใช้จาก DB (req.account) ตรง ๆ และใช้รหัสคณะ 2 หลัก

const locations = require("./location");
const { FACULTIES, COMMON_FACULTY, OTHER_FACULTY } = require("./catalog");

function denied(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function studentScope(account) {
  if (!account || account.role !== "USER") {
    throw denied("บัญชีนี้ไม่มีสิทธิ์แจ้งคำร้องนักศึกษา");
  }

  const faculty = FACULTIES.find(
    (item) =>
      item.id === account.faculty_id &&
      item.id !== COMMON_FACULTY &&
      item.id !== OTHER_FACULTY
  );

  if (!faculty) {
    throw denied(
      "บัญชียังไม่มีข้อมูลคณะ (อีเมลไม่ใช่รหัสนักศึกษา 8 หลัก) กรุณาให้ Admin เลือกคณะให้ที่หน้าจัดการผู้ใช้"
    );
  }

  const common = FACULTIES.find((item) => item.id === COMMON_FACULTY);

  // ฟอร์มนักศึกษามีเพียงสองตัวเลือก
  return { faculty, choices: [faculty, common] };
}

function canUse(scope, place) {
  if (!place?.complete) return false;
  return place.facultyId === COMMON_FACULTY || place.facultyId === scope.faculty.id;
}

function assertPlace(account, place) {
  if (!canUse(studentScope(account), place)) {
    throw denied("แจ้งได้เฉพาะคณะของตัวเองหรือพื้นที่ส่วนกลาง");
  }
  return place;
}

function fromStudentForm(account, form) {
  const scope = studentScope(account);
  const facultyId = locations.clean(form.facultyId);

  if (facultyId !== COMMON_FACULTY && facultyId !== scope.faculty.id) {
    throw denied("แจ้งได้เฉพาะคณะของตัวเองหรือพื้นที่ส่วนกลาง");
  }

  const place = locations.fromForm({ ...form, facultyId });
  if (!canUse(scope, place)) throw denied("ไม่มีสิทธิ์แจ้งในคณะนี้");
  return place;
}

module.exports = { studentScope, canUse, assertPlace, fromStudentForm };
