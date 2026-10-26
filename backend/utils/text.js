// utils/text.js — จัดรูปข้อความจากฟอร์ม
//
// แก้ (3c): NFKC แยก "ำ" (U+0E33) เป็น "ํ" + "า" ทำให้ "กำลังดำเนินการ" ไม่เท่ากับค่าในระบบ
// (บั๊กเดิม: Staff เปลี่ยนสถานะเป็น "รอดำเนินการ"/"กำลังดำเนินการ" ไม่ได้) → ใช้ NFKC แล้วรวมสระอำกลับ
function normalizeText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/ํา/g, "ำ")
    : "";
}

module.exports = { normalizeText };
