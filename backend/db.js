require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const mysql = process.env.DB_DRIVER === "mysql";

let pool;
let sqlite;

// เพิ่ม: เลือกฐานข้อมูลตาม .env
// MySQL ใช้กับงานจริง ส่วน SQLite ใช้ทดลองในเครื่อง
if (mysql) {
  pool = require("mysql2/promise").createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    ...(process.env.DB_SSL === "true"
      ? { ssl: { rejectUnauthorized: true } }
      : {})
  });
} else {
  const file =
    process.env.SQLITE_PATH ||
    path.join(__dirname, "data/kidhen.sqlite");

  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), {
      recursive: true
    });
  }

  const { DatabaseSync } = require("node:sqlite");
  sqlite = new DatabaseSync(file);

  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
  `);
}

// เพิ่ม: ฟังก์ชันกลางสำหรับเรียก SQL
// ใช้ ? แทนการนำค่าจากฟอร์มมาต่อ SQL โดยตรง
async function query(sql, args = []) {
  if (mysql) {
    const [rows] = await pool.execute(sql, args);
    return rows;
  }

  const statement = sqlite.prepare(sql);

  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
    return statement.all(...args);
  }

  return statement.run(...args);
}

// เพิ่ม: รวม SQL หลายคำสั่งให้สำเร็จหรือล้มเหลวพร้อมกัน
// execute ที่ส่งให้ callback ใช้ Connection เดียวกัน
async function transaction(work) {
  if (!mysql) {
    sqlite.exec("BEGIN");

    try {
      const result = await work(query);
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  const connection = await pool.getConnection();

  const execute = async (sql, args = []) => {
    const [rows] = await connection.execute(sql, args);
    return rows;
  };

  try {
    await connection.beginTransaction();

    const result = await work(execute);

    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// เพิ่ม (3b-2): จำนวนแถวที่ถูกแก้ ให้ SQLite (changes) กับ MySQL (affectedRows) อ่านแบบเดียวกัน
function affected(result) {
  return Number(result?.changes ?? result?.affectedRows ?? 0);
}

// เพิ่ม (3b-2): เพิ่มคอลัมน์ให้ตารางที่สร้างไว้แล้ว (CREATE TABLE IF NOT EXISTS ไม่แก้ตารางเดิม)
// ใช้กับ DB ในเครื่องที่สร้างตั้งแต่ 3a/3b-1 และ RDS ที่ init ไปแล้ว
async function ensureColumn(table, column, definition) {
  const rows = mysql
    ? await query(
        "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS " +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        [table, column]
      )
    : (await query(`PRAGMA table_info(${table})`)).filter(row => row.name === column);

  if (rows.length) return false;

  try {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // EC2 หลายเครื่องรัน init พร้อมกัน: อีกเครื่องเพิ่มไปก่อนแล้ว
    if (!/duplicate column/i.test(error.message)) throw error;
  }

  return true;
}

// เพิ่ม: ปิด Database เมื่อจบงานใน Terminal
async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

// เพิ่ม: ใช้สถานะชุดเดียวกันทั้งระบบ
const STATUSES = [
  "รอดำเนินการ",
  "กำลังดำเนินการ",
  "เสร็จสิ้น"
];

// เพิ่ม: กำหนดหมวดหมู่ที่ระบบยอมรับ
const CATEGORIES = {
  แจ้งซ่อม: [
    "โปรเจคเตอร์", "แอร์", "คอมพิวเตอร์",
    "Wi-Fi", "ไฟฟ้า", "ประตู", "โต๊ะเก้าอี้"
  ],
  ร้องเรียน: [
    "อาคาร", "อุปกรณ์", "อาจารย์",
    "เจ้าหน้าที่", "ความปลอดภัย",
    "อินเทอร์เน็ต", "โรงอาหาร"
  ],
  // แก้ชั่วคราว: เดิมเขียนชื่อลอยๆ ทำให้ ReferenceError ตอน require("./db")
  // ยังไม่ได้กำหนดหมวดย่อย — รอตัดสินใจตอนต่อ tickets กับ RDS (ขั้น 3)
  ข้อเสนอแนะ: []
};

// เพิ่ม (3c): รายชื่อคณะ/หน่วยงานชุดเดียวทั้งระบบ (seed ลง DB + ฟอร์ม + ตรวจสิทธิ์)
// "00" = พื้นที่ส่วนกลาง, "99" = คณะ/พื้นที่อื่น
const FACULTY_NAMES = Object.freeze({
    "01": "คณะวิศวกรรมศาสตร์",
    "02": "คณะสถาปัตยกรรม",
    "03": "คณะครุศาสตร์อุตสาหกรรมและเทคโนโลยี",
    "04": "คณะเทคโนโลยีการเกษตร",
    "05": "คณะวิทยาศาสตร์",
    "07": "คณะเทคโนโลยีสารสนเทศ",
    "08": "คณะอุตสาหกรรมอาหาร",
    "10": "คณะบริหารธุรกิจ",
    "11": "คณะเทคโนโลยีสื่อสารมวลชน",
    "12": "วิทยาลัยนวัตกรรมการผลิตขั้นสูง",
    "13": "วิทยาลัยอุตสาหกรรมการบินนานาชาติ",
    "14": "คณะศิลปศาสตร์",
    "15": "คณะแพทยศาสตร์",
    "16": "วิทยาลัยศิลปกรรมศาสตร์",
    "17": "คณะทันตแพทยศาสตร์",
    "21": "โคเซ็น",
    "22": "คณะพยาบาลศาสตร์",
    // เพิ่ม: ตัวแทนสำหรับตัวเลือกบนฟอร์มคำร้อง (tickets.faculty_id เป็น NOT NULL + FK)
    "00": "พื้นที่ส่วนกลาง",
    "99": "คณะ/พื้นที่อื่น"
  });

const DEPARTMENT_NAMES = Object.freeze({
  building: "อาคารและสถานที่",
  it: "เทคโนโลยีสารสนเทศ",
  student: "กิจการนักศึกษา",
  activities: "ฝ่ายกิจกรรม",
  academic: "ฝ่ายวิชาการ"
});

// เพิ่ม: สร้าง Error พร้อม HTTP Status
function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

// เพิ่ม: ตรวจความยาวข้อความจากฟอร์ม
function text(value, min, max, label) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  ) {
    fail(`${label}: ต้องมี ${min}–${max} ตัวอักษร`);
  }

  return value.trim();
}

// เพิ่ม: ตรวจคะแนนก่อนบันทึก
function rating(value) {
  const number = Number(value);

  if (
    !Number.isInteger(number) ||
    number < 1 ||
    number > 5
  ) {
    fail("คะแนนต้องเป็น 1–5");
  }

  return number;
}

// เพิ่ม: ตรวจฟอร์มส่งคำร้องที่ Backend
// แม้ Browser มี required อยู่แล้ว ก็ยังต้องตรวจซ้ำ
function ticketInput(body) {
  if (!CATEGORIES[body.type]?.includes(body.category)) {
    fail("ประเภท/หมวดหมู่ไม่ถูกต้อง");
  }

  if (!["สูง", "กลาง", "ต่ำ"].includes(body.urgency)) {
    fail("ความเร่งด่วนไม่ถูกต้อง");
  }

  return {
    type: body.type,
    category: body.category,
    title: text(body.title, 5, 200, "หัวข้อ"),
    description: text(body.description, 10, 10000, "รายละเอียด"),
    location: text(body.location, 2, 200, "สถานที่"),
    building: text(body.building, 2, 120, "อาคาร"),
    urgency: body.urgency,
    anonymous: body.anonymous === "on" ? 1 : 0,
    feedback_score:
      body.type === "ความคิดเห็น"
        ? rating(body.feedback_score)
        : null
  };
}

// เพิ่ม: เรียกใช้หลังตรวจ Google Token แล้วเท่านั้น
// ไม่รับ faculty_id ที่ผู้ใช้ส่งมาเองจากหน้าเว็บ
function studentClaims(payload, domains) {
  if (
    !payload.email_verified ||
    !domains.includes(payload.hd) ||
    !payload.sub
  ) {
    fail("ต้องใช้บัญชี Google Workspace ของมหาวิทยาลัย", 403);
  }

  const match = /^(\d{8})@/i.exec(payload.email || "");

  if (!match) {
    fail("อีเมลนักศึกษาต้องมีรหัส 8 หลัก", 403);
  }

  return {
    student_id: match[1],
    faculty_id: match[1].slice(2, 4)
  };
}

// เพิ่ม: สร้าง ID และวันเวลาแบบเดียวกันทุกไฟล์
const id = crypto.randomUUID;
const now = () => new Date().toISOString();

// เพิ่ม: เก็บ Hash แทนรหัสติดตามจริง
const hash = value =>
  crypto.createHash("sha256").update(value).digest("hex");

// เพิ่ม: ช่วยปิดบังอีเมลและเลขส่วนตัว
// ยังต้องให้ Admin ตรวจชื่อคนและข้อมูลที่อาจระบุตัวบุคคลได้
function redact(value) {
  return String(value)
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[อีเมล]")
    .replace(/\b\d{8,13}\b/g, "[รหัส/โทรศัพท์]")
    .replace(/(?:\+66|0)[\d\s-]{8,14}/g, "[โทรศัพท์]");
}

// ย้าย: SQL เดิมใน db.js ไปอ่านจาก schema.sql
async function init() {
  const schema = fs.readFileSync(
    path.join(__dirname, "schema.sql"),
    "utf8"
  );

  for (const sql of schema.split(";")) {
    if (sql.trim()) await query(sql);
  }

  // ข้อมูลเริ่มต้นตามรหัสคณะ (ย้ายไปเป็นค่าคงที่ FACULTY_NAMES ด้านบน)
  const faculties = FACULTY_NAMES;

  for (const [facultyId, name] of Object.entries(faculties)) {
    const rows = await query(
      "SELECT id FROM faculties WHERE id=?",
      [facultyId]
    );

    if (!rows.length) {
      await query(
        "INSERT INTO faculties(id,name) VALUES(?,?)",
        [facultyId, name]
      );
    }
  }

  // เพิ่ม (3b-2): รูปโปรไฟล์ เก็บเป็น key (ในเครื่อง = path ใต้ /uploads, ขั้น 3d = object key ใน S3)
  await ensureColumn("users", "avatar_key", "VARCHAR(255)");

  // เพิ่ม: อีเมลแจ้งสถานะคำร้องถึงคนร้องเรียน (SNS topic ของนักศึกษา) — 1 = รับ (ค่าเริ่มต้น), 0 = ปิด
  // email_sub_arn = subscription ใน SNS (ใช้ดูว่ายืนยันแล้วหรือยัง / ยกเลิก)
  await ensureColumn("users", "email_notify", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("users", "email_sub_arn", "VARCHAR(255)");

  // เพิ่ม (3c): คำร้องเก็บตำแหน่งแยกช่อง + ข้อความเจ้าหน้าที่ล่าสุด + เวลาที่พบปัญหา
  await ensureColumn("tickets", "room", "VARCHAR(100)");
  await ensureColumn("tickets", "place_detail", "VARCHAR(200)");
  await ensureColumn("tickets", "note", "TEXT");
  await ensureColumn("tickets", "occurred_at", "VARCHAR(30)");

  // เพิ่ม (3c): แจ้งเตือนแสดงหัวข้อ/สถานะในกระดิ่ง (Lambda status.py เขียนคอลัมน์เดียวกัน)
  await ensureColumn("notifications", "title", "VARCHAR(200)");
  await ensureColumn("notifications", "status", "VARCHAR(30)");
  await ensureColumn("notifications", "category", "VARCHAR(20)");

  // เพิ่ม (3d): ปัญหาที่พบบ่อยย้ายจากไฟล์ JSON บน EC2 มาที่ตาราง issues / issue_tickets / ai_inputs
  // (Lambda analyze.py อ่าน ai_inputs แล้วเขียน issues ตาม diagram)
  await ensureColumn("issues", "type", "VARCHAR(50)");
  await ensureColumn("issues", "place_key", "VARCHAR(64)");
  await ensureColumn("issues", "symptoms", "TEXT");
  await ensureColumn("issues", "label_key", "VARCHAR(64)");
  await ensureColumn("issues", "location_info", "TEXT");
  await ensureColumn("issues", "updated_at", "VARCHAR(30)");
  await ensureColumn("issue_tickets", "hash", "VARCHAR(64)");
  await ensureColumn("ai_inputs", "hash", "VARCHAR(64)");
  await ensureColumn("ai_inputs", "state", "VARCHAR(10)");
  await ensureColumn("ai_inputs", "reason", "VARCHAR(200)");
  await ensureColumn("ai_inputs", "label_key", "VARCHAR(64)");
  await ensureColumn("ai_inputs", "location_label", "VARCHAR(200)");
  await ensureColumn("ai_inputs", "location_info", "TEXT");

  const departments = DEPARTMENT_NAMES;

  for (const [departmentId, name] of Object.entries(departments)) {
    const rows = await query(
      "SELECT id FROM departments WHERE id=?",
      [departmentId]
    );

    if (!rows.length) {
      await query(
        "INSERT INTO departments(id,name) VALUES(?,?)",
        [departmentId, name]
      );
    }
  }
}

module.exports = {
  query, transaction, close, init, mysql, affected, ensureColumn,
  FACULTY_NAMES, DEPARTMENT_NAMES,
  STATUSES, CATEGORIES, fail, text, rating,
  ticketInput, studentClaims, id, now, hash, redact
};

// เพิ่ม: เรียก npm run init-db ได้โดยไม่ต้องมี scripts/ อีกโฟลเดอร์
if (require.main === module) {
  init()
    .then(() => console.log("Database ready"))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(close);
}