// server.js เป็นจุดเริ่มต้นโปรแกรมเพียงจุดเดียว

// config.js โหลด .env และตรวจค่า environment ก่อนอย่างอื่น
// ถ้าตั้งค่าไม่ครบใน production จะ throw ที่นี่ พร้อมรายการที่ขาด
const config = require("./config");
const db = require("./db");
const { seedDevAccounts, seedSampleTickets } = require("./repo/dev-seed");
const app = require("./app");

// เพิ่ม (3b-2): เตรียมฐานข้อมูลก่อนเปิดพอร์ต (ตอนนี้ login/ผู้ใช้/session อยู่ใน DB แล้ว)
async function prepareDatabase() {
  try {
    // สร้างตาราง + ข้อมูลตั้งต้น + เพิ่มคอลัมน์ใหม่ (รันซ้ำได้)
    await db.init();
  } catch (error) {
    // บน AWS user_data รัน `npm run init-db` ไปแล้ว; EC2 หลายเครื่องบูตพร้อมกันอาจชนกันตอน seed
    // → ไม่ถือเป็นเรื่องร้ายแรง แต่ต้องต่อ DB ได้
    if (!config.production) throw error;
    console.warn("[db] init ไม่สำเร็จ (อาจมีเครื่องอื่นทำไปแล้ว):", error.message);
    await db.query("SELECT 1");
  }

  // บัญชีทดลอง 40 บัญชี: ในเครื่อง (SQLite) หรือบน RDS เมื่อ SEED_TEST_ACCOUNTS=true
  // (บน AWS รหัสผ่านอยู่ที่ Cognito ซึ่ง Terraform สร้างให้ — ตารางนี้เก็บ role + คณะ/ฝ่ายของ Staff)
  const seeded = await seedDevAccounts();
  if (seeded.created.length) {
    console.log(`[seed] สร้างบัญชีทดลอง ${seeded.created.length} บัญชี ดูรายชื่อที่หน้า Sign in`);
  }

  // คำร้องตัวอย่าง (3c) — ครั้งแรกที่ตาราง tickets ยังว่าง
  const samples = await seedSampleTickets();
  if (samples.created) console.log(`[dev] สร้างคำร้องตัวอย่าง ${samples.created} รายการ`);

  // 3d: เตรียม ai_inputs ให้คำร้องที่ยังไม่มี (เช่น คำร้องตัวอย่าง / คำร้องก่อน 3d) — ทำเบื้องหลัง
  require("./service/issues").syncAll().catch((error) =>
    console.warn("[AI] เตรียม ai_inputs ไม่สำเร็จ:", error.message)
  );
}

async function start() {
  await prepareDatabase();

  const server = app.listen(config.port, () => {
    console.log(
      `KID-HEN: http://localhost:${config.port} ` +
        `(DB=${db.mysql ? "mysql" : "sqlite"}, AUTH_MODE=${config.auth.mode})`
    );
  });

  // แสดงข้อผิดพลาด เช่น พอร์ตถูกใช้อยู่
  server.on("error", (error) => {
    console.error("เริ่มระบบไม่สำเร็จ:", error.message);

    process.exit(1);
  });
}

start().catch((error) => {
  console.error("เริ่มระบบไม่สำเร็จ (ฐานข้อมูล):", error.message);
  process.exit(1);
});
