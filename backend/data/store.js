// แก้: เขียนไฟล์ชั่วคราวก่อน rename
// ลดโอกาสได้ JSON ไม่ครบหากโปรแกรมหยุดระหว่างบันทึก

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DB_DIR = path.join(__dirname, "db");

// แก้: ใช้ค่าเริ่มต้นเฉพาะเมื่อยังไม่มีไฟล์
// ถ้าไฟล์เสีย ให้แจ้ง error แทนการเขียนข้อมูลใหม่ทับ
function load(name, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(DB_DIR, `${name}.json`),
        "utf8"
      )
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw new Error(
      `อ่าน ${name}.json ไม่สำเร็จ ตรวจไฟล์ก่อนรันต่อ`
    );
  }
}

// แก้: บันทึกเป็นไฟล์ชั่วคราวก่อนแทนที่ไฟล์เดิม
function save(name, data) {
  fs.mkdirSync(DB_DIR, {
    recursive: true,
  });

  const target = path.join(
    DB_DIR,
    `${name}.json`
  );

  const temp =
    `${target}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(
      temp,
      JSON.stringify(data, null, 2)
    );

    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) {
      fs.unlinkSync(temp);
    }
  }
}

module.exports = {
  load,
  save,
};