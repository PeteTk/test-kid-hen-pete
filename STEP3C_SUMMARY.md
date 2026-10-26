# สรุปขั้น 3c (คำร้อง + แจ้งเตือนลง DB + EventBridge)

ต่อจาก 3b-2 · ทดสอบได้ในเครื่องทั้งหมด (SQLite, ไม่ต้องต่อ AWS) · วิธี deploy: `STEP3C_DEPLOY.md`

## ตามคำตอบที่ตกลงแล้ว
| คำถาม | คำตอบ | ผลในโค้ด |
|---|---|---|
| ขอบเขต | 3c: คำร้อง + แจ้งเตือนลง DB + EventBridge | ลบ `mockRequests.js`, `mockNotifications.js` (และ `mockFaqs.js` ที่ไม่มีใครใช้) — เว็บไม่มีข้อมูล mock เหลือแล้ว |
| บัญชีทดลองทุกคณะ | นักศึกษา 1 + Staff 1 ต่อคณะ | 17 คณะ + Staff ส่วนกลาง + 5 บัญชีเดิม = **40 บัญชี** |
| ข้อมูลเดิมใน JSON | เริ่มใหม่ + คำร้องตัวอย่าง | 6 คำร้องตัวอย่าง (เฉพาะ SQLite ครั้งแรกที่ตารางว่าง) |
| ผู้รับแจ้งเตือนเมื่อสถานะเปลี่ยน | เจ้าของ + Staff คณะ/ฝ่ายตรง + Admin | แก้ทั้งเว็บ (`repo/notifications.js`) และ Lambda (`status.py`) ให้ตรงกัน |

## บัญชีทดลอง (รหัส 1234 ทุกบัญชี, ใช้ username หรืออีเมล)
| username | อีเมล | สิทธิ์ |
|---|---|---|
| `user01` … `user22` | `67<รหัสคณะ>0001@kmitl.ac.th` เช่น `67010001@kmitl.ac.th` | นักศึกษาคณะนั้น (คณะจากรหัสในอีเมล) |
| `staff01` … `staff22` | `staff<รหัสคณะ>@kmitl.ac.th` | Staff คณะนั้น **ทุกฝ่าย** (5 ฝ่าย) |
| `staff00` | `staff00@kmitl.ac.th` | Staff พื้นที่ส่วนกลาง ทุกฝ่าย |
| `admin`, `staff`, `staff2`, `user`, `user2` | เหมือน 3b-2 | `staff` = 07+IT เท่านั้น, `staff2` = 07+อาคาร |

รหัสคณะ: 01 วิศวะ · 02 สถาปัตย์ · 03 ครุศาสตร์ฯ · 04 เกษตร · 05 วิทยาศาสตร์ · 07 IT · 08 อุตสาหกรรมอาหาร · 10 บริหารธุรกิจ · 11 สื่อสารมวลชน · 12 นวัตกรรมการผลิตขั้นสูง · 13 การบิน · 14 ศิลปศาสตร์ · 15 แพทย์ · 16 ศิลปกรรม · 17 ทันตแพทย์ · 21 โคเซ็น · 22 พยาบาล (00 = ส่วนกลาง)

## คำร้องตัวอย่าง
| code | ผู้แจ้ง | คณะ / ประเภท | สถานะ | ไว้ทดสอบ |
|---|---|---|---|---|
| #0001 | user | 07 / ไอทีซัพพอร์ต (Wi-Fi LX 203) | กำลังดำเนินการ | Staff `staff07`/`staff` เห็น, `staff2` (ฝ่ายอาคาร) ไม่เห็น |
| #0002, #0003 | user01, user2 | 01 / อาคาร (แอร์ E12 ห้อง 301) | รอดำเนินการ | อาการ+ห้องเดียวกัน → จัดกลุ่มหัวข้อปัญหา (AI) |
| #0004 | user05 | 05 / ข้อเสนอแนะ (ที่จอดรถ) | เสร็จสิ้น | ประวัติ 3 ขั้น + แจ้งเตือน 2 ครั้ง |
| #0005 | user10 | 00 ส่วนกลาง / อาคาร | รอดำเนินการ | `staff00` เห็น, Staff คณะไม่เห็น |
| #0006 | user | 07 / หลักสูตร | รอดำเนินการ | ฝ่ายวิชาการ |

## การเชื่อมกับ Terraform
```
นักศึกษาส่งคำร้อง ──> tickets + ticket_updates + attachments (RDS)
                  └─> เว็บเขียน notifications ให้ Admin + Staff คณะ/ฝ่ายตรง
Staff เปลี่ยนสถานะ ──> tickets/ticket_updates (RDS)
   EVENTS_MODE=eventbridge (AWS) ──PutEvents(Source=kidhen.app, DetailType=TicketStatusChanged)──>
       EventBridge rule ticket-status-changed ──> Lambda status.py ──> notifications (RDS) + SNS อีเมลทีม
   EVENTS_MODE=local (ในเครื่อง) ──> เว็บเขียน notifications เอง (ตรรกะเดียวกับ status.py)
   PutEvents ล้ม ──> เว็บเขียนแจ้งเตือนเองแทน (ผู้ใช้ไม่พลาด แต่ไม่มีอีเมล SNS)
```
detail ที่ส่ง: `{ ticketId, newStatus, statusChanged, title, message }`

## ไฟล์ที่เปลี่ยน
### เว็บ — ใหม่
| ไฟล์ | หน้าที่ |
|---|---|
| `backend/repo/tickets.js` | create (code `#0001` ต่อเนื่อง ลองใหม่ถ้าชนกันหลายเครื่อง), list กรองตาม เจ้าของ / units ของ Staff / ค้นหา / ประเภท / สถานะ ใน SQL, findBySeq, update (+ticket_updates, resolved_at), updateLocation — คืนรูปแบบเดิมที่ view ใช้ (`id` = เลขจาก code, `ticketId` = UUID) |
| `backend/repo/notifications.js` | แจ้งเตือนคำร้องใหม่ / สถานะเปลี่ยน, รายการ, จำนวนยังไม่อ่าน, เปิดอ่าน (เฉพาะของตัวเอง) |
| `backend/service/events.js` | `EVENTS_MODE` eventbridge/local + fallback เมื่อ PutEvents ล้ม |
| `backend/service/catalog.js` | TYPES, STATUSES, ประเภท → หน่วยงาน (`ไอทีซัพพอร์ต`→it, `อาคาร/สถานที่`→building, `กิจกรรม`→activities, `หลักสูตร`→academic, `ข้อเสนอแนะ`→student), รายชื่อคณะจาก DB |
| `backend/utils/text.js` | normalize ข้อความแบบไม่แยกสระอำ (ดูบั๊กด้านล่าง) |
| `backend/test/tickets.test.js` | 13 ข้อ (คำร้อง, สิทธิ์, แจ้งเตือน, EventBridge client ปลอม + fallback, หน้าเว็บ, หัวข้อปัญหาด้วย AI ปลอม) |
| `frontend/views/admin/request-location.ejs` | หน้าแก้สถานที่คำร้อง (route มีอยู่แล้วแต่ไม่มีไฟล์ view) |

### เว็บ — แก้
| ไฟล์ | การเปลี่ยน |
|---|---|
| `db.js`, `schema.sql` | `FACULTY_NAMES`/`DEPARTMENT_NAMES` ชุดเดียวทั้งระบบ; คอลัมน์ใหม่ `tickets.room, place_detail, note, occurred_at`, `notifications.title, status, category` (เพิ่มให้ DB เดิมอัตโนมัติ) |
| `service/location.js` | คณะใช้รหัส 2 หลัก (`00` ส่วนกลาง, `99` อื่น) แทน `it/engineering/...`, ตัด "ชื่อคณะอื่น" (ตาม 3a), เลิกเดาสถานที่จากข้อความเก่า |
| `service/faculty-access.js` | นักศึกษา = คณะตัวเอง + ส่วนกลาง จาก `users.faculty_id` |
| `service/issues.js` | หัวข้อปัญหาอ่าน/สร้างคำร้องจาก DB (async); ไฟล์หัวข้อรุ่นเก่าสำรองแล้วเริ่มใหม่ |
| `routes/user.js`, `staff.js`, `admin.js`, `notifications.js`, `ai.js`, `faq.js`, `ai-job.js` | ใช้ DB; Staff เห็นเฉพาะ (คณะ + ฝ่าย) ตาม units; รูปแนบเก็บ `uploads/requests/` + ตาราง attachments |
| `auth/middleware.js`, `auth/session-user.js` | จำนวนแจ้งเตือนยังไม่อ่านจาก DB; เลิกใช้ username ตัวเชื่อม |
| `repo/dev-seed.js`, `server.js` | บัญชีทุกคณะ + คำร้องตัวอย่าง |
| `utils/date.js` | แสดงเวลาไทย (Asia/Bangkok) แม้ EC2 เป็น UTC |
| `utils/dashboard.js` | รับรายการคำร้อง/จำนวนผู้ใช้/หัวข้อจากผู้เรียก |
| `partials/location-fields.ejs`, `auth/*.ejs` | ตัดช่องชื่อคณะอื่น; รายชื่อบัญชีทดลองเลื่อนดูได้ |
| `package.json`, `.env.example` | `@aws-sdk/client-eventbridge`, `EVENTS_MODE`, `npm test` รวม 5 ชุด |

### เว็บ — ลบ
`service/legacy-account.js` (ตัวเชื่อมชั่วคราวของ 3b-2), `service/notifications.js`, `data/mockRequests.js`, `data/mockNotifications.js`, `data/mockFaqs.js`

### Terraform (`kidhen-terraform-3c.zip`)
| ไฟล์ | การเปลี่ยน |
|---|---|
| `lambda/worker/status.py` | ผู้รับ = เจ้าของ + Admin + Staff ที่ `user_units` ตรงคณะ/ฝ่ายของคำร้อง (เดิม Staff ทุกคน); เขียน `title`, `status`, `category` |
| `variables.tf`, `compute.tf`, `user_data.sh.tpl`, `terraform.tfvars` | **`app_revision`** (เอกสารสรุปเขียนว่ามี แต่ใน zip ไม่มี → เพิ่มให้แล้ว) + env `EVENTS_MODE=eventbridge` |
| `check_lab_permissions.sh` | **แก้บั๊ก**: เดิม hard-code `POOL_ID="us-east-1_IQqvXGyLJ"` ทับค่าจริง → อ่านจาก env; เพิ่มตรวจ `events:PutEvents` |
| `terraform.tfvars` | คอมเมนต์ stickiness: ปิดได้หลัง 3d (รูป/หัวข้อยังอยู่บนดิสก์) |
| `KIDHEN_Terraform_Summary.md` | อัปเดตตาม 3c |

## บั๊กเดิมที่เจอและแก้แล้ว
- **Staff เปลี่ยนสถานะเป็น "รอดำเนินการ"/"กำลังดำเนินการ" ไม่ได้** (ได้ 400): `normalize("NFKC")` แยก "ำ" เป็น "ํ"+"า" ทำให้ไม่ตรงกับรายการสถานะ (มีมาตั้งแต่ก่อน 3a) → `utils/text.js`
- `check_lab_permissions.sh` ใช้ pool id ตายตัว (ด้านบน)
- หน้า `/admin/faq/requests/:id/location` render view ที่ไม่มีอยู่

## รันในเครื่อง
```
cd backend
npm install
npm test          # 5 ชุด: 13 + 7 + 17 + 12 + 13 = 62 ข้อ
npm run dev
```
**ถ้าเคยรัน 3b-2 มาแล้ว** ให้ลบ `backend/data/kidhen.sqlite*` ครั้งเดียว เพื่อให้ได้บัญชีทุกคณะ + คำร้องตัวอย่างครบ (ถ้าไม่ลบ ระบบเพิ่มคอลัมน์และบัญชีที่ขาดให้ แต่จะไม่สร้างคำร้องตัวอย่างถ้ามีคำร้องอยู่แล้ว) · โฟลเดอร์ `backend/data/db/` เก่าลบได้ (เหลือใช้แค่ไฟล์หัวข้อปัญหา AI)

### เช็กมือ (แนะนำ)
1. `user01` → แจ้งปัญหา: ตัวเลือกคณะมีแค่ **วิศวะ + ส่วนกลาง** → ส่งประเภทไอทีซัพพอร์ต พร้อมรูป
2. `staff01` → กระดิ่ง "มีคำร้องใหม่" → เปิดคำร้อง → เปลี่ยนเป็น กำลังดำเนินการ + ข้อความ
3. `staff07` → ต้อง **ไม่เห็น** คำร้องนั้น (คนละคณะ) · `admin` เห็นทุกคำร้อง
4. `user01` → กระดิ่ง "ได้รับการอัปเดตสถานะ" → กดแล้วไปหน้าคำร้อง เห็นข้อความเจ้าหน้าที่ + ขั้นตอน
5. ลองนักศึกษาคณะอื่น เช่น `user21` (โคเซ็น) → ตัวเลือกคณะเป็น โคเซ็น + ส่วนกลาง; `staff00` เห็นเฉพาะคำร้องส่วนกลาง
6. Admin → จัดการปัญหาที่พบบ่อย → ประมวลผล (ต้องมี `GEMINI_API_KEY` ใน `.env`) → #0002 + #0003 ถูกรวมเป็นหัวข้อเดียว → `user01` เห็นในหน้าปัญหาที่ถูกรายงาน

## ทดสอบแล้ว
- `npm test` ผ่าน 62 ข้อ
- รันเว็บจริง SQLite: ทุกหน้า 3 role, ส่งคำร้อง+รูป, สิทธิ์ข้ามคณะ (403/404), เปลี่ยนสถานะ, กดแจ้งเตือน, ค้นหา/กรอง, หน้า FAQ + รายละเอียดหัวข้อ
- **MySQL 8 จริง**: DB ที่สร้างด้วยโค้ด 3b-2 → init 3c เพิ่มคอลัมน์ให้เอง → สร้าง/ค้นหา/อัปเดตคำร้อง, แจ้งเตือน; รันเว็บบน MySQL ทุกหน้า 200
- **Lambda `status.py` ของจริง** (Python + PyMySQL) กับ MySQL เดียวกัน ด้วย event รูปแบบ EventBridge: เขียนแจ้งเตือนให้ เจ้าของ + Admin + staff01 (ไม่รวม staff07 คณะอื่น) → เว็บอ่านขึ้นกระดิ่งพร้อมลิงก์คำร้อง

## ยังไม่ได้ทดสอบ
- EventBridge/SNS ของจริง (ทดสอบด้วย client ปลอม + เรียก Lambda handler ตรง) · `terraform validate` (sandbox โหลด Terraform ไม่ได้ — ตรวจแล้วว่าตัวแปรใน template ตรงกับ `templatefile` ครบ)

## ข้อจำกัดที่รู้ (เลื่อนไปขั้นถัดไป)
- **รูปแนบ/รูปโปรไฟล์ อยู่บนดิสก์ EC2** และ **หัวข้อปัญหา (AI ในเว็บ) อยู่ในไฟล์ `data/db/issue-summaries-v2.json`** → ใช้ ASG = 1 เครื่องจนกว่าจะทำ 3d
- หัวข้อปัญหามี 2 ระบบซ้อนกัน: AI ในเว็บ (Gemini จากเว็บ, ไฟล์ JSON) กับ Lambda `analyze.py` (ตาราง `issues` + `ai_inputs` ที่ Admin ต้องตรวจก่อน) — ต้องเลือกทางเดียวใน 3d (เสนอใช้ Lambda ตาม diagram แล้วให้หน้าเว็บอ่านตาราง `issues`)
- เปลี่ยนแค่ข้อความ (สถานะเดิม) ก็ส่ง `TicketStatusChanged` เพื่อให้ผู้แจ้งได้แจ้งเตือน (detail มี `statusChanged: false`)
- ยังไม่มีปุ่ม "เพิ่มผู้ใช้" ของ Admin (3b-3)

## ถัดไป (เสนอ)
- **3d** — รูปไป S3 (presigned URL), หัวข้อปัญหาย้ายไปตาราง `issues` ใช้ Lambda `analyze.py` + หน้า Admin ตรวจ `ai_inputs` → ปิด stickiness และกลับไป ASG 2 เครื่อง
- **3b-3** — Admin เพิ่มผู้ใช้ (Cognito `AdminCreateUser`)
