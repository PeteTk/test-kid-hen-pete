# สรุปขั้น 3a (ยังไม่แตะ route/โค้ด mock ใดๆ)

## ตามคำตอบที่ตกลงแล้ว
- เลือก "อื่นๆ" ไม่มีช่องพิมพ์ชื่อคณะ (ยังมีช่องอาคาร/ห้อง) → **ตัด `tickets.faculty_other` ออกจากแผน**, `99` = "คณะ/พื้นที่อื่น" ใช้เป็นตัวแทนอย่างเดียว
- `015` รวมเข้า `01` (ไม่มีแถว 015 ใน DB)
- แจ้ง Staff ด้วย คณะ + หน่วยงานตามประเภท → `repo/users.staffForTicket(faculty, department)`
- "ข้อเสนอแนะ" → หน่วยงาน `student` (กิจการนักศึกษา)

## ไฟล์ที่เปลี่ยน
| ไฟล์ | การเปลี่ยน |
|---|---|
| `backend/schema.sql` | เพิ่มตาราง `user_units` (user_id, faculty_id, department_id — ทั้งสามคอลัมน์ NOT NULL เป็น PK) ไม่แก้ตารางเดิม |
| `backend/db.js` | seed คณะเพิ่ม `21` โคเซ็น, `00` พื้นที่ส่วนกลาง, `99` คณะ/พื้นที่อื่น (รวม 19 แถว) |
| `backend/repo/users.js` (ใหม่) | findById/findByEmail/list/create/update/setUnits/staffForTicket + หาคณะจากรหัสนักศึกษา |
| `backend/test/users.repo.test.js` (ใหม่) | ทดสอบ 11 ข้อบน SQLite (ผ่านหมด) |

ไม่แตะ: `data/mock*.js`, `data/store.js`, `data/db/*.json`, routes ทั้งหมด, Terraform/Lambda

## วิธีรันทดสอบ
```
cd backend
npm install
SQLITE_PATH=:memory: node --no-warnings test/users.repo.test.js
```
(ในสภาพแวดล้อมที่ผมใช้ไม่มี `npm install` จึงใช้ stub ของ `dotenv` เฉพาะตอนทดสอบ ไม่ได้รวมในโค้ด)

## ยังไม่ได้ทดสอบ
- MySQL/RDS จริง (SQL เขียนแบบใช้ได้ทั้งสองระบบ แต่ยังไม่ได้รันกับ MySQL)

## เลื่อนไปขั้น 3c
- คอลัมน์ใหม่ใน `tickets`: `room`, `place_detail`
