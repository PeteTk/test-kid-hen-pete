// แก้: โหลด fs และ path ก่อนนำไปใช้
const fs = require("node:fs");
const path = require("node:path");

console.log("เริ่มทดสอบ Gemini...");

// โหลด backend/.env
const envPath = path.join(__dirname, "../.env");

if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// แก้: import หลังประกาศ path แล้ว
const geminiPath = path.join(
  __dirname,
  "../service/gemini.js"
);

const { generateJSON } = require(geminiPath);

console.log("กำลังใช้ไฟล์:", geminiPath);
console.log("ชนิด generateJSON:", typeof generateJSON);

async function main() {
  if (typeof generateJSON !== "function") {
    throw new Error(
      "ตรวจ module.exports ใน service/gemini.js"
    );
  }

  console.log("กำลังส่งคำขอไป Gemini...");

  // ใช้ข้อความจำลอง ไม่ใช้คำร้องจริง
  const result = await generateJSON({
    instructions:
      "สรุปข้อความภาษาไทยตามข้อมูลที่ให้ ห้ามเติมข้อเท็จจริง ตอบ JSON ตาม schema",

    input: {
      text: "ข้อมูลจำลอง: ไมโครโฟนห้อง 306 เปิดแล้วไม่มีเสียง",
    },

    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
      },
      required: ["title", "summary"],
    },
  });

  console.log("เชื่อมต่อ Gemini สำเร็จ:");
  console.log(result);
}

// แสดงตำแหน่ง error หากทดสอบไม่สำเร็จ
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});