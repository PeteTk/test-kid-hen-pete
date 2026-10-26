# สรุปขั้น 3b-2 (สลับ login + ผู้ใช้ทั้งหมดไปตาราง users + session ใน DB)

ต่อจาก 3b-1 · ทดสอบได้ในเครื่องทั้งหมด ยังไม่ต้องเปิด AWS · ดูวิธี deploy ล่าสุดที่ `STEP3C_DEPLOY.md`

## ตามคำตอบที่ตกลงแล้ว
| คำถาม | คำตอบ | ผลในโค้ด |
|---|---|---|
| ขอบเขต | ผู้ใช้ทุกจุดย้ายไป DB และในเครื่องยังล็อกอินด้วย username ได้ | ลบ `data/mockUsers.js` + `data/options.js`; ฟอร์ม signin รับ `user` หรืออีเมล |
| role บน AWS | กลุ่ม Cognito, sync ลง DB ทุกครั้งที่ login | `users.syncFromCognito()` + หน้า Admin ย้ายกลุ่ม Cognito ด้วย |
| session | ย้ายไปตาราง `sessions` | `session-store.js` (ไม่ต้องลงแพ็กเกจเพิ่ม ใช้ได้ทั้ง SQLite/MySQL) |
| ชื่อ/รูป | ชื่อช่องเดียว + คอลัมน์ `avatar_key` | หน้าโปรไฟล์/แก้ผู้ใช้เหลือช่อง "ชื่อ-นามสกุล" |
| บัญชีทดลอง | เฉพาะ SQLite/ไม่ใช่ production | เหมือน 3b-1 (MySQL/RDS ไม่สร้างเด็ดขาด) |

## ล็อกอินในเครื่อง (AUTH_MODE=local)
พิมพ์ **username เดิม** หรือ **อีเมล** ก็ได้ รหัสผ่าน `1234` (หน้า Sign in มีรายการให้ดูใต้ฟอร์ม)

| username | อีเมล | role | คณะ / units |
|---|---|---|---|
| admin | admin@example.com | ADMIN | - |
| staff | somchai@example.com | STAFF | 07 + it |
| staff2 | wipa@example.com | STAFF | 07 + building |
| user | 67070999@kmitl.ac.th | USER | 07 (จากรหัส) |
| user2 | 67010888@kmitl.ac.th | USER | 01 (จากรหัส) |

username ใช้ได้เฉพาะบัญชีทดลอง 5 ตัวนี้ คนอื่นใช้อีเมล · ถ้าลบบัญชีทดลองในหน้า Admin เปิดเซิร์ฟเวอร์ใหม่จะถูกสร้างคืน

## ไฟล์ที่เปลี่ยน
### ใหม่
| ไฟล์ | หน้าที่ |
|---|---|
| `backend/auth/alb.js` | ตรวจ `x-amzn-oidc-data` (ES256 เซ็นโดย ALB, เช็ก `signer` = `ALB_ARN`) และ `x-amzn-oidc-accesstoken` (RS256 ของ Cognito: issuer, client_id, token_use, sub ตรงกัน) ด้วย `node:crypto` · cache key · URL logout ของ Cognito |
| `backend/auth/middleware.js` | แทน middleware เดิมใน `app.js`: โหลดผู้ใช้จาก DB ทุก request (เปลี่ยน role/ลบ มีผลทันที) · โหมด alb: ไม่มี session หรือ `sub` เปลี่ยน = login → sync ผู้ใช้/role แล้วเริ่ม session ใหม่ · บัญชี `active=0` เข้าไม่ได้ |
| `backend/auth/session-user.js` | ข้อมูลใน `req.session.user` (`id, email, username, name, role, sub`), `startSession` (regenerate กัน session fixation), `avatarUrl` |
| `backend/session-store.js` | express-session store บนตาราง `sessions` (upsert แยก MySQL/SQLite, ล้างที่หมดอายุทุก 15 นาที, `destroyByUserId`) |
| `backend/service/legacy-account.js` | **ตัวเชื่อมชั่วคราวถึง 3c**: แปลงผู้ใช้ DB → รูปแบบบัญชีเดิม (`username`, `facultyId` แบบ `it/engineering/science/common/other`) ให้คำร้อง/แจ้งเตือน/หัวข้อปัญหาที่ยังเป็น JSON ทำงานต่อ |
| `backend/service/cognito-groups.js` | หน้า Admin เปลี่ยน role → ย้ายกลุ่ม Cognito (ทุกบัญชีที่อีเมลตรง รวม Google ที่ยังไม่ถูกรวม); ลบผู้ใช้ → `AdminDisableUser` · โหมด local ไม่เรียก AWS |
| `backend/test/auth.test.js` | 17 ข้อ: token ปลอม/หมดอายุ/คนละ ALB/คนละ client, middleware โหมด alb ผ่าน HTTP จริง, session store, ย้ายกลุ่ม Cognito (client ปลอม) |
| `backend/test/web-local.test.js` | 12 ข้อ: ทั้งแอปผ่าน HTTP: login username/อีเมล, สิทธิ์ตาม role, จัดการผู้ใช้, โปรไฟล์, ลบผู้ใช้แล้วหลุดทันที, logout |

### แก้
| ไฟล์ | การเปลี่ยน |
|---|---|
| `backend/config.js` | `AUTH_MODE` (`local` ในเครื่อง / `alb` เมื่อ production), `ALB_ARN`; โหมด alb ต้องมี `COGNITO_ISSUER` + `COGNITO_CLIENT_ID`; production ที่ไม่ใช่ alb = เตือน (ยังบูตได้เพื่อไม่ให้ health check ล้มวน) |
| `backend/server.js` | `db.init()` + `seedDevAccounts()` ก่อนเปิดพอร์ต (production: init ชนกันได้ → log แล้วเช็ก `SELECT 1`) |
| `backend/app.js` | session ใช้ `SqlSessionStore`, cookie `kidhen.sid` httpOnly/sameSite=lax/secure (production)/8 ชม., `trust proxy`, ใช้ `auth/middleware.js` |
| `backend/db.js` | `affected()` (SQLite `changes` / MySQL `affectedRows`), `ensureColumn()` เพิ่มคอลัมน์ให้ DB เดิม (รันซ้ำได้, EC2 ชนกันได้) → เพิ่ม `users.avatar_key` |
| `backend/schema.sql` | `users.avatar_key VARCHAR(255)` |
| `backend/repo/users.js` | `update` รับ `avatarKey` และย้ายคณะเมื่อเปลี่ยน USER↔STAFF/ADMIN, `remove`, `count`, `roleFromGroups`, `syncFromCognito`; แก้ `setPassword` ให้ตรวจแถวบน MySQL ได้ |
| `backend/repo/dev-seed.js` | เพิ่ม `username` ให้บัญชีทดลอง, `emailForDevUsername`, `devUsernameForEmail`, export `allowed` |
| `backend/routes/auth.js` | login ด้วย DB (`users.authenticate`), รับ username ทดลอง, logout โหมด alb ลบ cookie ALB + ออกจาก Cognito |
| `backend/routes/admin.js` | จัดการผู้ใช้จาก DB: รายการ/ค้นหา/แก้ชื่อ-role-units-รูป/ลบ; Staff ต้องมีคณะเดียว; เปลี่ยน role = Cognito ก่อนแล้วค่อย DB; dashboard นับผู้ใช้จาก DB |
| `backend/routes/profile.js` | อ่าน/บันทึกชื่อและรูปที่ตาราง users, ลบไฟล์รูปเก่า |
| `backend/routes/staff.js`, `routes/user.js`, `routes/ai.js` | ใช้ `req.legacyAccount` (จาก DB) แทนการหา username ใน mock |
| `backend/service/faculty-access.js` | รับ account แทน username (ไม่อ่าน mock แล้ว) |
| `backend/service/notifications.js` | ผู้รับแจ้งเตือนคำร้องใหม่ (Admin + Staff คณะตรงกัน) มาจาก DB, เป็น async ที่ไม่ทำให้การส่งคำร้องล้ม |
| `backend/service/issues.js` | `support(id, account, form)` |
| `backend/utils/dashboard.js` | รับ `userCount` จากผู้เรียก |
| `backend/utils/upload.js` | ส่งออก `UPLOAD_ROOT`, สร้างโฟลเดอร์ avatars ให้เอง |
| `backend/package.json` | `@aws-sdk/client-cognito-identity-provider`, สคริปต์ `npm test` |
| `backend/.env.example` | `AUTH_MODE`, ค่า Cognito สำหรับโหมด alb |
| `frontend/views/auth/signin.ejs`, `login.ejs` | ช่อง "Email หรือ Username", รายการบัญชีทดลอง (เฉพาะตอนพัฒนา) |
| `frontend/views/profile.ejs`, `admin/user-edit.ejs`, `admin/users.ejs` | ชื่อช่องเดียว, คณะ/ฝ่ายเป็นรหัสใน DB (`01`, `it` …), id เป็น UUID, แสดง "(ปิดใช้งาน)" |
| `frontend/views/partials/topbar.ejs` | รูปสำรองชี้ `/img/avatar.svg` (เดิม `.png` ไม่มีไฟล์) |

### ลบ
`backend/data/mockUsers.js`, `backend/data/options.js` (ไม่มีไฟล์ไหนใช้แล้ว) — ไฟล์ `data/db/users.json` เดิมในเครื่องไม่ถูกอ่านอีก ลบทิ้งได้

### Terraform (ส่งมาใน zip แยก + `terraform-3b2.diff`)
`health_check_path = "/health"`, env `AUTH_MODE` (`alb` เมื่อเปิด domain + ALB auth) และ `ALB_ARN`; `enable_alb_stickiness` ยังเป็น `true` จนถึง 3c

## รันทดสอบ
```
cd backend
npm install
npm test            # 4 ชุด: 13 + 5 + 17 + 12 = 47 ข้อ (ใช้ SQLite :memory: ไม่แตะไฟล์ DB จริง)
npm run dev         # หรือจากโฟลเดอร์บนสุด: npm install && npm run dev (รวม Tailwind)
```
เปิด http://localhost:3000 → Sign in → `user` / `1234`

### เช็กมือในเครื่อง (แนะนำ 10 นาที)
1. `user` → แจ้งปัญหา (เลือกได้แค่ IT + ส่วนกลาง) → ส่ง → `staff` และ `staff2` และ `admin` ได้แจ้งเตือน
2. `admin` → จัดการผู้ใช้ → แก้ `staff2` เป็นคณะ 01 + building → บันทึก → `staff2` เห็นเฉพาะคำร้องวิศวะ
3. `admin` เปลี่ยน `user2` เป็น Staff → ถ้า `user2` ล็อกอินค้างอยู่ จะเข้าหน้า user ไม่ได้ทันที → ตั้งคณะให้แล้วจึงเข้า staff ได้
4. โปรไฟล์: แก้ชื่อ + อัปโหลดรูป → รูปขึ้นที่มุมขวาบน
5. ปิดเซิร์ฟเวอร์แล้วเปิดใหม่ → ยังล็อกอินอยู่ (session ใน DB)

## ทดสอบแล้ว
- `npm test` ผ่านทั้ง 47 ข้อ
- รันเว็บจริงบน SQLite: ทุกหน้าของ 3 role ตอบ 200 / redirect ถูก, ส่งคำร้อง + แจ้งเตือน, แก้/ลบผู้ใช้, อัปโหลดรูป, session อยู่รอดหลังรีสตาร์ต
- **MySQL 8.0 จริง** (ติดตั้งในเครื่องทดสอบ): `init` ซ้ำ + เพิ่มคอลัมน์ให้ตารางที่สร้างตั้งแต่ 3b-1, `syncFromCognito`, units, รูป, `setPassword`, `remove`, session store (upsert/touch/cleanup), รันเว็บบน MySQL แล้ว login ได้ — ปิดข้อ "ยังไม่ได้ทดสอบ MySQL" ของ 3a
- โหมด `AUTH_MODE=alb` ในเครื่อง: ไม่มี header → 401, header ปลอม → 401, `/health` → 200

## ยังไม่ได้ทดสอบ
- ALB + Cognito ของจริง (ต้องเปิด Learner Lab + domain) — key/รูปแบบ header จำลองตามเอกสาร AWS รวมถึง padding `=` ที่ ALB ใส่มา
- Cognito Admin API จริง (ทดสอบกับ client ปลอม) — สิทธิ์ใน LabRole ตรวจด้วย `check_lab_permissions.sh`
- `terraform validate` (sandbox โหลด Terraform ไม่ได้) — การแก้มีแค่ตัวแปร 2 ตัวใน `templatefile` และค่าใน tfvars

## ข้อจำกัดที่รู้แล้ว (ตั้งใจเลื่อน)
- **คำร้อง/แจ้งเตือน/หัวข้อปัญหายังเป็นไฟล์ JSON บนดิสก์ของแต่ละ EC2** → ถ้า deploy ตอนนี้ให้ใช้ EC2 เครื่องเดียว (`asg_min_size = asg_desired_capacity = 1`) ไม่งั้นแต่ละเครื่องเห็นคำร้องไม่ตรงกัน → ขั้น 3c
- owner ของข้อมูล mock = username ทดลอง หรืออีเมล (ผู้ใช้จริงบน AWS) ผ่าน `legacy-account.js` → 3c เปลี่ยนเป็น `user_id`
- รูปโปรไฟล์ยังเก็บใน `frontend/public/uploads/avatars` ของเครื่อง → 3d ย้าย S3 (`avatar_key` เตรียมไว้แล้ว)
- ลบผู้ใช้ = ลบแถวจริง (ยังไม่มีคำร้องใน DB อ้างถึง) → 3c เปลี่ยนเป็นปิดบัญชีถ้ามีคำร้อง; บน AWS บัญชี Cognito ถูก Disable (เปิดคืนที่ Cognito console)
- ยังไม่มีปุ่ม "เพิ่มผู้ใช้" ในหน้า Admin (บน AWS ผู้ใช้ถูกสร้างตอน login ครั้งแรก; Admin ตั้งต้น 5 คนมาจาก `initial_admin_emails`) → 3b-3 ถ้าต้องการ (`AdminCreateUser` + ส่งรหัสชั่วคราว)
- ยังไม่มี rate limit ที่ฟอร์ม `/signin` (ใช้เฉพาะในเครื่อง; บน AWS Cognito จัดการ)

## ถัดไป (เสนอ)
- **3c** — tickets/ticket_updates/notifications ลง DB (owner = user_id, คณะรหัส 2 หลัก, คอลัมน์ `room`, `place_detail`), ส่ง EventBridge `TicketStatusChanged`, ลบ `legacy-account.js`, แล้วปิด stickiness
- **3d** — รูปโปรไฟล์/ไฟล์แนบไป S3
