# KID-HEN — ระบบร้องเรียน/แจ้งปัญหาในมหาวิทยาลัย (Final)

เว็บให้นักศึกษา KMITL แจ้งปัญหา (อาคาร, ไอที, หลักสูตร, กิจกรรม, ข้อเสนอแนะ) แล้ว Staff ของคณะ/ฝ่ายที่รับผิดชอบติดตามงาน
ทำงานบน AWS Learner Lab ด้วย Terraform (`kidhen-terraform`) · โดเมน **https://kid-hen.app**

> ไฟล์นี้รวมทุกอย่างที่ทำมาตั้งแต่ขั้น 3a ถึงอัปเดตล่าสุด 27 ต.ค. 2569 — ใช้แทน `STEP*_SUMMARY.md`, `STEP*_DEPLOY.md`, `KIDHEN_Test_Accounts.md` และไฟล์ `*.diff` เดิม (ลบออกจาก repo แล้ว)

---

## 1. ระบบทำอะไรได้บ้าง

| บทบาท | ทำได้ |
|---|---|
| **นักศึกษา (User)** | ส่งคำร้อง + แนบรูป ≤ 3 รูป (≤ 5 MB) · ติดตามสถานะ · ดู "ปัญหาที่ถูกรายงานแล้ว" ของคณะตัวเอง + พื้นที่ส่วนกลาง แล้วกด "พบปัญหานี้เหมือนกัน" · กระดิ่งแจ้งเตือน · **อีเมลแจ้งเมื่อคำร้องเปลี่ยนสถานะ** (เปิด/ปิดในโปรไฟล์) · แก้ชื่อ/รูปโปรไฟล์ |
| **Staff** | เห็นเฉพาะคำร้องของคณะ + ฝ่ายที่ดูแล (`user_units`) · เปลี่ยนสถานะ + ตอบข้อความ · Dashboard สถิติ |
| **Admin** | เห็นทุกคำร้อง · จัดการผู้ใช้ (เพิ่ม/แก้บทบาท/คณะ-ฝ่าย/ปิด/ลบ) รวมอีเมลภายนอก เช่น Gmail (เลือกคณะเอง) · ตัวกรองประเภทอีเมล · จัดการ "ปัญหาที่พบบ่อย" ที่ AI สรุป (แก้/ซ่อน/ประมวลผลตอนนี้) · Dashboard |

**เข้าสู่ระบบ:** อีเมล/username + รหัสผ่าน (Cognito) หรือ **Continue with Google** (เฉพาะ `@kmitl.ac.th` หรืออีเมลที่ Admin เพิ่มไว้) · ลืมรหัสผ่าน (รหัส 6 หลักทางอีเมล) · Google ครั้งแรกต้องตั้งรหัสผ่านเพื่อใช้ล็อกอินแบบอีเมลได้ด้วย

---

## 2. สถาปัตยกรรมบน AWS

```
ผู้ใช้ ─ HTTPS ─▶ Route 53 (kid-hen.app) ─▶ ALB (ACM, TLS 1.2/1.3, 80→443)
                                            │
                     ┌──────────────────────┴──────────────────────┐
               AZ us-east-1a                                  AZ us-east-1b
          EC2 Node.js (ASG 2–4)                          EC2 Node.js (ASG 2–4)
                     │  private app subnet ── NAT ── IGW ── internet (GitHub, npm, Gemini)
                     ▼
     RDS MySQL Multi-AZ (private db subnet)    S3 ไฟล์แนบ (pre-signed URL, browser ↔ S3 ตรง)
                     ▲
EC2 ── PutEvents ──▶ EventBridge ──▶ Lambda worker (ใน VPC) ──▶ RDS / Gemini / SNS ──▶ อีเมล
                     (สถานะเปลี่ยน · ประมวลผลตอนนี้ · ตั้งเวลา rate(1 day))
EC2 ◀──▶ Cognito (User Pool + Groups + Google) ── Lambda trigger (pre sign-up / post confirmation)
CloudWatch: log 4 กลุ่ม · alarm 6 ตัว → SNS · dashboard   |   IAM: LabRole / LabInstanceProfile
```

| ชั้น | บริการ | ทำไม |
|---|---|---|
| ทางเข้า | Route 53 + ACM + ALB | ชื่อคงที่ · HTTPS ฟรีต่ออายุเอง · กระจายงาน 2 AZ + health check `/health` |
| เว็บ | EC2 t3.micro ใน Auto Scaling Group (min 2 / max 4, CPU 60%) | stateless: session, ข้อมูล, ไฟล์ อยู่นอกเครื่องทั้งหมด → เพิ่ม/ลบเครื่องได้ |
| ข้อมูล | RDS MySQL Multi-AZ | ข้อมูลสัมพันธ์กัน + transaction · Standby อีก AZ สลับเองเมื่อล่ม |
| ไฟล์ | S3 (versioning, บังคับ HTTPS, ไม่เปิด public) | browser อัป/ดาวน์โหลดตรง ไฟล์ไม่ผ่าน EC2 |
| ล็อกอิน | Cognito + Google | ไม่เก็บรหัสผ่านเอง · กลุ่ม Admin/Staff/User |
| งานเบื้องหลัง | EventBridge → Lambda | แจ้งเตือน + AI ไม่ทำให้เว็บช้า |
| AI | Gemini `gemini-3.5-flash-lite` (OpenAI-compatible, free tier) | Learner Lab จำกัด Bedrock |
| แจ้งเตือน | SNS 2 topic | ทีม (`kidhen-dev-notifications`) · นักศึกษารายคน (`kidhen-dev-student-notifications` + filter policy `recipient`) |
| เฝ้าระวัง | CloudWatch Logs/Alarms/Dashboard + CloudWatch Agent (RAM/ดิสก์) | log จากทุกเครื่องอยู่ที่เดียว · alarm ส่งอีเมล |

---

## 3. โครงสร้างโฟลเดอร์

```
backend/
  server.js, app.js, config.js (อ่าน env + ตรวจค่า), db.js (SQLite/MySQL + init-db), schema.sql
  auth/      cognito.js (ตรวจ ID token), middleware.js, session-user.js (+ สมัครอีเมลแจ้งเตือนตอน login)
  routes/    auth, user, staff, admin, faq (AI), files (S3 presign), profile, notifications
  repo/      users, tickets, notifications, dev-seed (บัญชีทดลอง)
  service/   storage (S3), events (EventBridge), issues (AI ปัญหาที่พบบ่อย), email-notify (SNS นักศึกษา),
             cognito-groups / cognito-password (Cognito Admin), gemini, location, faculty-access, catalog
  test/      11 ชุด (npm test)
frontend/
  views/     EJS ทุกหน้า (admin/, staff/, user/, auth/, partials/)
  public/    css/output.css (Tailwind build แล้ว), js/s3-upload.js, js/lightbox.js, img/
  src/input.css   (แก้ CSS แล้วรัน npm run build ใน frontend/)
package.json      npm run dev = รัน backend + Tailwind พร้อมกัน
```

---

## 4. ข้อมูลเก็บที่ไหน

| ที่เก็บ | อะไร | อายุ |
|---|---|---|
| **RDS** `users`, `user_units`, `faculties`, `departments` | ผู้ใช้, บทบาท, คณะ, ฝ่ายที่ Staff ดูแล, ตั้งค่าอีเมล (`email_notify`, `email_sub_arn`) | จนกว่าจะ destroy |
| **RDS** `tickets`, `ticket_updates`, `attachments`, `notifications` | คำร้อง, ประวัติสถานะ, รายการรูป (key ของ S3), กระดิ่ง | จนกว่าจะ destroy |
| **RDS** `ai_inputs`, `issues`, `issue_tickets`, `ai_runs` | ข้อมูลที่ส่ง AI (ปิดข้อมูลส่วนตัวแล้ว), หัวข้อปัญหา, การผูกคำร้อง, ประวัติการประมวลผล | จนกว่าจะ destroy |
| **RDS** `sessions` | session ล็อกอิน (ทุก EC2 ใช้ร่วมกัน) | 1 วัน |
| **S3** `requests/<userId>/…`, `avatars/<userId>/…` | รูปแนบ + รูปโปรไฟล์ | ตลอด · เวอร์ชันเก่า 30 วัน |
| **Cognito** | รหัสผ่าน, ตัวตน Google, กลุ่ม | — |
| **CloudWatch Logs** | log เว็บ, การบูต, Lambda | 14 วัน (`log_retention_days`) |
| RDS backup อัตโนมัติ | — | 1 วัน |

ตารางที่สร้างไว้แต่ยังไม่ใช้: `routing_rules`, `issue_votes`, `audit_logs`, `invites`, `content_reports`, `outbox` (เตรียมไว้สำหรับฟีเจอร์ต่อไป)

---

## 5. รันในเครื่อง (ไม่ต้องต่อ AWS)

ต้องมี Node.js 22.13 ขึ้นไป (ใช้ `node:sqlite`)
```bash
npm install                      # ที่ root (concurrently)
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
npm run dev                      # http://localhost:3000
```
- ไม่ต้องมี `.env` ก็รันได้ (SQLite + บัญชีทดลองรหัส `1234` + คำร้องตัวอย่าง)
- อยากลอง AI ในเครื่อง: `backend/.env` ใส่ `GEMINI_API_KEY=` (ดู `backend/.env.example`)
- DB เพี้ยน: ลบ `backend/data/kidhen.sqlite*` แล้วรันใหม่

| ตัวแปร | ในเครื่อง | บน AWS (Terraform ตั้งให้) |
|---|---|---|
| `AUTH_MODE` | `local` | `cognito` |
| `EVENTS_MODE` | `local` (เว็บทำเอง) | `eventbridge` |
| `STORAGE_MODE` | `local` (`frontend/public/uploads`) | `s3` |
| `DB_DRIVER` | `sqlite` | `mysql` |

---

## 6. Deploy / อัปเดตบน AWS (VS Code + Git Bash บน Windows)

**ก่อนเริ่มทุกครั้ง**
1. Learner Lab → **Start Lab** (รอวงกลมเขียว) → **AWS Details** → Show → copy ทั้งก้อน
2. `code "C:/Users/<ชื่อ>/.aws/credentials"` → วางทับของเก่า → **Ctrl+S** → `aws sts get-caller-identity --region us-east-1`
3. `export MSYS_NO_PATHCONV=1 AWS_REGION=us-east-1` (กัน Git Bash แปลง `/kidhen/...` เป็น path Windows)

**อัปเดตโค้ดเว็บ**
```bash
cd <repo เว็บ>
cd backend && npm install && npm test && cd ..     # มี dependency ใหม่ → commit package-lock.json ด้วย
git add -A && git commit -m "..." && git push origin main

cd <kidhen-terraform>
# terraform.tfvars: app_revision = "<ค่าใหม่>"   (เปลี่ยนทุกครั้ง)
./build_lambda.sh                                   # เฉพาะเมื่อแก้ lambda/worker/*.py
terraform plan -out p.tfplan                        # ดู destroy ก่อนเสมอ
terraform apply p.tfplan
./rotate_instances.sh                               # เปลี่ยนเครื่อง EC2 ให้ดึงโค้ดใหม่ แบบเว็บไม่ล่ม
```
- **ห้าม** `aws autoscaling start-instance-refresh` (Learner Lab บล็อก 403) → ใช้ `rotate_instances.sh`
- ถ้า plan มี destroy ของ `aws_db_instance`, `aws_lb`, `aws_nat_gateway`, `aws_route53_*` → หยุดก่อน
- Gemini key ใส่ใน `secret.auto.tfvars` (`llm_api_key = "AIza..."`) หรือ `export TF_VAR_llm_api_key=...`

**ค่าใน `terraform.tfvars` ที่ห้ามพลาด**
| ตัวแปร | ค่า | ถ้าผิด |
|---|---|---|
| `enable_nat_gateway` | `true` | false = ลบ NAT → EC2 บูตไม่ขึ้น, Lambda เรียก Gemini/SNS ไม่ได้ |
| `nat_gateway_per_az`, `db_multi_az` | `true` (ส่งงาน/demo) | `false` = ประหยัด ~2.5 USD/วัน ตอนเทส |
| `create_hosted_zone`, `route53_zone_id` | `false`, `Z10333713V8UCQ4888XJS` | zone ที่สร้างเอง name server ไม่เปลี่ยนตอน destroy |
| `llm_model` | `gemini-3.5-flash-lite` | รุ่น 2.5 ตอบ 404 กับ key ใหม่ |
| `create_test_accounts` | `true` ตอนเทส → **`false` ตอนส่งงาน** | อีเมลทดลองอาจเป็นของนักศึกษาจริง |

---

## 7. บัญชีทดลอง (40 บัญชี)

| ที่ไหน | รหัสผ่าน | ล็อกอินด้วย |
|---|---|---|
| ในเครื่อง (SQLite) | `1234` | username หรืออีเมล |
| บน AWS (`create_test_accounts = true`) | `Kidhen1234` | username หรืออีเมล |

| username | อีเมล | สิทธิ์ |
|---|---|---|
| `admin` | admin@example.com | Admin |
| `staff` / `staff2` | somchai@ / wipa@example.com | Staff คณะ 07 ฝ่ายไอที / ฝ่ายอาคาร |
| `user` / `user2` | 67070999@ / 67010888@kmitl.ac.th | นักศึกษาคณะ 07 / 01 |
| `user<รหัสคณะ>` | `67<รหัส>0001@kmitl.ac.th` | นักศึกษาคณะนั้น (เห็นคณะตัวเอง + ส่วนกลาง) |
| `staff<รหัสคณะ>` | `staff<รหัส>@kmitl.ac.th` | Staff ทุกฝ่ายของคณะนั้น · `staff00` = พื้นที่ส่วนกลาง |

รหัสคณะ: 01 วิศวะ · 02 สถาปัตย์ · 03 ครุศาสตร์อุตฯ · 04 เกษตร · 05 วิทยาศาสตร์ · 07 IT · 08 อุตสาหกรรมอาหาร · 10 บริหารธุรกิจ · 11 สื่อสารมวลชน · 12 นวัตกรรมการผลิตขั้นสูง · 13 การบิน · 14 ศิลปศาสตร์ · 15 แพทย์ · 16 ศิลปกรรม · 17 ทันตแพทย์ · 21 โคเซ็น · 22 พยาบาล
Admin ตั้งต้นบน AWS: `67070054`, `67070177`, `67070223`, `67070244`, `67070292` @kmitl.ac.th

---

## 8. AI "ปัญหาที่พบบ่อย"

1. **ตอนส่ง/แก้คำร้อง** เว็บตรวจก่อน (`service/issues.js` → `reviewReport`)
   - **เก็บภายใน ไม่ส่ง AI** (แสดงเหตุผลในหน้า Admin): ผู้ส่งติ๊กเรื่องส่วนตัว/อ่อนไหว · มีคำรุนแรง (คุกคาม, ทุจริต, ทำร้าย, ป่วย ฯลฯ) · สถานที่ไม่ครบ · หัวข้อไม่มีความหมาย
   - **ส่ง AI แค่** `{type, placeKey (sha256 ของคณะ+อาคาร+ห้อง), title}` — `title` ผ่าน `sanitizeTitle()` ปิดอีเมล/เบอร์/รหัสนักศึกษา/ลิงก์/ชื่อที่มีคำนำหน้า · ไม่ส่งรายละเอียด ชื่อผู้แจ้ง ชื่อสถานที่จริง
2. **ประมวลผล** (ตั้งเวลาวันละครั้ง หรือ Admin กด "ประมวลผลตอนนี้") Lambda `analyze.py` ส่งทีละ 10 รายการ (id 1..10 ไม่ใช่ id จริง) + หัวข้อเดิมที่ประเภท+สถานที่ตรงกัน → Gemini **จัดกลุ่มและตั้งชื่อหัวข้อเอง** · ข้อความมั่ว/ทดสอบ → `skip`
3. **ตรวจผลทั้งชุดก่อนบันทึก:** id ครบไม่ซ้ำ · กลุ่มเดียวกันต้องประเภท+สถานที่ตรงกัน · ห้ามข้อมูลติดต่อ/เรื่องอ่อนไหว/"แก้ไขแล้ว"/"3 คน" · ผิดข้อเดียว = ทั้งชุดไม่บันทึก
4. หัวข้อเดิมไม่ทับข้อความที่ Admin แก้ · หัวข้อใหม่เผยแพร่ทันที (Admin ซ่อนได้) · มีหัวข้อใหม่ → อีเมลสรุปถึงทีม

เว็บ (`runBatch` โหมด local) กับ Lambda ใช้ prompt และกฎตรวจชุดเดียวกันทุกตัวอักษร

---

## 9. ความปลอดภัย / PDPA

- ไม่มี AWS access key ในโค้ดหรือไฟล์ config: EC2/Lambda ใช้ IAM role (Learner Lab = LabRole) · `iam.tf` มี policy แบบ least privilege สำหรับบัญชีจริง
- รหัสผ่านอยู่ที่ Cognito · session cookie `httpOnly` + `sameSite=lax` + `secure` (เมื่อเป็น https) · session id เปลี่ยนทุกครั้งที่ login
- S3: pre-signed URL 5 นาที เซ็นชนิด+ขนาดไฟล์ · ตอนบันทึกตรวจว่า key เป็นของผู้ใช้คนนั้น + มีไฟล์จริง (HeadObject) · bucket ไม่เปิด public
- RDS อยู่ private subnet ต่อได้เฉพาะ EC2/Lambda (Security Group) · TLS
- `user_data` ไม่พิมพ์ค่าจาก `/etc/kidhen.env` ลง log แล้ว (`set +x`)
- หน้าเว็บไม่บอกชื่อบริการเบื้องหลัง (EventBridge/Lambda/Gemini) · error แสดงแค่รหัส รายละเอียดอยู่ใน CloudWatch
- **กฎหมาย:** พ.ร.บ.คอมพิวเตอร์ ม.26 ให้เก็บข้อมูลจราจร ≥ 90 วัน → ควรตั้ง `log_retention_days = 90` · PDPA ให้เก็บเท่าที่จำเป็น + แจ้งระยะเวลา → แนะนำรูปแนบ 1 ปี / คำร้อง 2 ปีหลังเสร็จแล้วทำให้ไม่ระบุตัวตน (ยังไม่ได้ทำ)
- ข้อจำกัด: ชื่อคนที่พิมพ์ลอยๆ ไม่มีคำนำหน้า ตัวกรองจับไม่ได้ทั้งหมด · Gemini free tier อาจนำข้อมูลไปปรับปรุงโมเดล (ระบบจริงควรใช้ paid tier หรือ Bedrock)

---

## 10. การทดสอบ

```bash
cd backend && npm test        # 11 ชุด
```
| ชุด | ทดสอบอะไร |
|---|---|
| `users.repo`, `dev-seed`, `auth` | ผู้ใช้, รหัสผ่าน, บัญชีทดลอง, ล็อกอิน local, คณะจากอีเมล / คณะที่ Admin เลือก |
| `web-local`, `tickets` | ทุกหน้าเว็บ, สิทธิ์ตามบทบาท/คณะ, คำร้อง, แจ้งเตือน, AI (AI ปลอม) |
| `cognito`, `cognito-password`, `cognito-groups` | ล็อกอิน Cognito/Google, ตั้งรหัสผ่านครั้งแรก, Admin เพิ่มผู้ใช้ (Cognito ปลอม) |
| `storage` | S3 pre-signed URL + ตรวจ key (S3 ปลอม) |
| `email-notify` | สมัคร/ยกเลิกอีเมล SNS + filter policy (SNS ปลอม) |
| `issues-ai` | ปิดข้อมูลส่วนตัวในหัวข้อ, เหตุผลเก็บภายใน, ตรวจผล AI |

ฝั่ง Lambda (โฟลเดอร์ Terraform): `python3 tests/test_analyze.py`, `python3 tests/test_status.py`

---

## 11. ประวัติการพัฒนา

| ขั้น | ทำอะไร |
|---|---|
| **3a** | ตาราง `user_units` (Staff ดูแลคณะ+ฝ่าย), คณะ 00 ส่วนกลาง / 21 โคเซ็น / 99 อื่นๆ, `repo/users.js` |
| **3b-1** | รหัสผ่าน scrypt, `authenticate()`, บัญชีทดลอง 5 บัญชี (SQLite) |
| **3b-2** | ล็อกอินจากตาราง `users` แทน mock, session เก็บใน DB, รูปโปรไฟล์, sync role จาก Cognito, ทดสอบกับ MySQL จริง |
| **3b-3** | Admin เพิ่มผู้ใช้ (สร้างใน Cognito + ส่งรหัสชั่วคราวทางอีเมล) |
| **3c** | คำร้อง/ประวัติ/แจ้งเตือนลง DB (ลบ mock ทั้งหมด), EventBridge `TicketStatusChanged` → Lambda, บัญชีทดลอง 40 บัญชี |
| **3c-2** | หน้า login ของเว็บเองคุยกับ Cognito (ไม่แสดง Hosted UI), ลืมรหัสผ่าน, Google ผ่านหน้าเว็บ |
| **3c-3** | บัญชีทดลองบน AWS (`Kidhen1234`), Google ครั้งแรกต้องตั้งรหัสผ่าน, ฝ่ายของนักศึกษา = "นักศึกษา" |
| **3d** | AI ย้ายไป Lambda + Gemini (ตาม diagram), หัวข้อปัญหาลง RDS, รูปไป S3 ด้วย pre-signed URL, ASG 2 เครื่อง (ปิด stickiness), lightbox ดูรูปแนบ |
| **27 ต.ค. 2569** | ดูตารางด้านล่าง |

**อัปเดต 27 ต.ค. 2569**
| เรื่อง | สาเหตุ | ที่แก้ |
|---|---|---|
| AI สรุปเองจากหัวข้อ | เดิมรองรับแค่ 11 อาการ คำร้องอื่นถูกเก็บภายใน | ส่ง `title` ที่ปิดข้อมูลส่วนตัว · AI ตั้งชื่อเอง + `skip` · เหตุผลรายคำร้อง |
| อีเมลถึงคนร้องเรียน | เดิมมีแค่กระดิ่ง | SNS topic นักศึกษา + filter policy · การ์ดเปิด/ปิดในโปรไฟล์ |
| Admin เพิ่มอีเมลภายนอก | Gmail ไม่มีคณะ ใช้งานไม่ได้ | Admin เลือกคณะ · ตัวกรองประเภทอีเมล + ป้าย "ภายนอก"/"ยังไม่มีคณะ" |
| Google กับอีเมลที่ Admin เพิ่ม | Lambda ส่งชื่อ provider `google` ผิดตัว → ถูกบล็อกโดเมน | แปลงเป็น `Google` · ข้อความ error บอกสาเหตุถูก |
| Gemini 404 | รุ่น 2.5 ใช้ไม่ได้กับ key ใหม่ | `gemini-3.5-flash-lite` · error แนบข้อความจาก Gemini |
| หน้า FAQ บอกชื่อบริการ | — | ใช้คำกลาง · error แสดงแค่รหัส |
| Dashboard ตอนไม่ fullscreen | ล็อกความสูงเท่าจอ กราฟล้นการ์ด | เลิกล็อก · แท่งกราฟสูงตายตัว |
| เปลี่ยนเครื่อง EC2 | `StartInstanceRefresh` ถูกบล็อก (403) | `rotate_instances.sh` (พัก auto scaling ระหว่างทำ) |
| Cognito user error 400 | Terraform พยายามลบ attribute `identities` | `ignore_changes = [attributes]` |
| เว็บล่ม | `enable_nat_gateway = false` ลบ NAT + route | กลับเป็น `true` |
| โดเมน NXDOMAIN | name server ที่ name.com ไม่ตรง zone | ใช้ zone ที่สร้างเอง |
| รหัสผ่านหลุดใน log | `set -x` ตอนอ่าน env | `set +x` |
| RDS ยังไม่ Multi-AZ | RDS ที่ import มาเป็นเครื่องเดียว | apply แปลงเป็น Multi-AZ |

---

## 12. แก้ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / ทางแก้ |
|---|---|
| อัปรูปไม่ได้ แต่หน้าเว็บเปิดได้ | ไม่ได้ Start Lab (LabRole ถูกจำกัด) → Start Lab |
| เครื่องใหม่ unhealthy, Session Manager "not connected" | ไม่มี NAT/route ออกเน็ต → เช็ก `enable_nat_gateway = true` แล้ว apply |
| `aws logs tail` ขึ้น `logGroupName` error | Git Bash แปลง path → `export MSYS_NO_PATHCONV=1` |
| `NoCredentials` | ไฟล์ credentials ว่าง/เปิดผิดที่ → `code "C:/Users/<ชื่อ>/.aws/credentials"` แล้ว Ctrl+S |
| เว็บขึ้น `DNS_PROBE_FINISHED_NXDOMAIN` | `nslookup -type=NS kid-hen.app 8.8.8.8` ต้องตรงกับ name server ของ zone · `ipconfig /flushdns` |
| ประมวลผล AI "ไม่สำเร็จ (รหัส 404)" | ชื่อโมเดลผิด → `llm_model` · ดูรายละเอียด: `aws logs tail /aws/lambda/kidhen-dev-worker --since 30m` |
| ล็อกอิน Google ด้วย Gmail ที่ Admin เพิ่มไม่ได้ | ครั้งแรกกดซ้ำ 1 ครั้ง · อีเมลต้องตรงกับบัญชี Google ทุกตัวอักษร · ดู `/aws/lambda/kidhen-dev-cognito-triggers` |
| นักศึกษาขึ้น "บัญชียังไม่มีข้อมูลคณะ" | อีเมลไม่ใช่รหัส 8 หลัก → Admin เลือกคณะในหน้าแก้ไขผู้ใช้ |
| ดูข้อมูลในตาราง RDS | EC2 → Connect → Session Manager → `sudo dnf install -y mariadb105` → `sudo bash -c 'set -a; . /etc/kidhen.env; MYSQL_PWD="$DB_PASSWORD" mysql --ssl -h "$DB_HOST" -u "$DB_USER" "$DB_NAME"'` (ใช้แค่ SELECT) |

---

## 13. ค่าใช้จ่ายที่คาด (us-east-1)

ราคาต่อหน่วยตรวจกับข้อมูลราคาของ AWS Pricing Calculator (calculator.aws, us-east-1, on-demand) เมื่อ 27 ต.ค. 2569 · 1 เดือน = 730 ชั่วโมง · หน่วย USD/เดือน — ปริมาณการใช้ (GB, LCU, จำนวนอีเมล) เป็นค่าประมาณ ยอดจริงดูที่หน้า Learner Lab ("Used $X of $50", อัปเดตช้าหลายชั่วโมง)

**แบบเต็ม** = ตาม diagram (`nat_gateway_per_az = true`, `db_multi_az = true`) · **แบบประหยัด** = NAT 1 ตัว + RDS เครื่องเดียว

| บริการ | ราคาต่อหน่วย | ที่ระบบใช้ | แบบเต็ม | แบบประหยัด |
|---|---|---|---|---|
| **NAT Gateway** | 0.045/ชม./ตัว + 0.045/GB ที่ผ่าน | 2 ตัว (1 ตัว) · ~5 GB/เดือน (git clone, npm, Gemini) | 65.93 | 33.08 |
| **RDS MySQL** db.t3.micro | 0.017/ชม. · Multi-AZ คิด 2 เท่า | 1 เครื่อง + Standby (ไม่มี Standby) | 24.82 | 12.41 |
| RDS storage gp3 | 0.115/GB-เดือน · Multi-AZ 2 เท่า | 20 GB · backup 1 วัน (ฟรีไม่เกินขนาด DB) | 4.60 | 2.30 |
| **ALB** | 0.0225/ชม. + 0.008/LCU-ชม. | 1 ตัว · traffic น้อย ~0.2 LCU | 17.60 | 17.60 |
| **EC2** t3.micro | 0.0104/ชม./เครื่อง | 2 เครื่อง (ASG min) | 15.18 | 15.18 |
| EBS gp3 (ดิสก์ EC2) | 0.08/GB-เดือน | 20 GB × 2 | 3.20 | 3.20 |
| **Public IPv4** | 0.005/ชม./IP | ALB 2 + NAT EIP 2 (1) · EC2 ไม่มี public IP | 14.60 | 10.95 |
| CloudWatch Logs | 0.50/GB รับเข้า + 0.03/GB-เดือน เก็บ | ~1 GB/เดือน · เก็บ 14 วัน | 0.53 | 0.53 |
| CloudWatch Alarms / Metrics / Dashboard | ฟรี 10 alarm · 10 custom metric · 3 dashboard | 6 alarm · 4 metric (RAM+ดิสก์ × 2 เครื่อง) · 1 dashboard | 0 | 0 |
| Route 53 | 0.50/zone · alias ไป ALB ไม่คิด query | 1 zone (`Z1033…`) | 0.50 | 0.50 |
| S3 | 0.023/GB-เดือน + 0.005/1,000 PUT | รูปแนบ < 1 GB | 0.03 | 0.03 |
| Lambda (worker + cognito_triggers) | ฟรี 1 ล้าน request + 400,000 GB-วินาที/เดือน | หลักร้อยครั้ง/เดือน | 0 | 0 |
| EventBridge | custom event 1.00/ล้าน · rule ตั้งเวลาฟรี | หลักร้อย event/เดือน | 0 | 0 |
| SNS | อีเมลฟรี 1,000 ฉบับ/เดือน แล้ว 2.00/100,000 | หลักสิบ–ร้อยฉบับ | 0 | 0 |
| Cognito | ฟรีถึง 10,000 ผู้ใช้ active/เดือน | ~50 บัญชี | 0 | 0 |
| ACM, IAM, VPC, Subnet, Route table, Security Group, IGW, S3 Gateway Endpoint | ไม่คิดเงิน | — | 0 | 0 |
| Data transfer ออก internet | ฟรี 100 GB/เดือน แล้ว 0.09/GB | หน้าเว็บ + รูป < 1 GB | 0 | 0 |
| Gemini API | free tier (ไม่ผูก billing) | `gemini-3.5-flash-lite` วันละรอบ | 0 | 0 |
| **รวม AWS / เดือน** | | | **≈ 147** | **≈ 96** |
| **รวม / วัน** | | | **≈ 4.8** | **≈ 3.2** |
| **งบ Learner Lab 50 USD อยู่ได้** | | | **≈ 10 วัน** | **≈ 16 วัน** |

- **ของที่แพงคือของที่เปิดตลอด 24 ชม.** NAT + RDS + ALB + EC2 + IPv4 = 99% ของบิล ไม่ขึ้นกับจำนวนคนใช้ และคิดเงินแม้ไม่ได้กด Start Lab
- **NAT แพงสุด (45%)** เพราะคิดรายชั่วโมงต่อตัว ตัวเลือกประหยัดกว่าคือ NAT ตัวเดียว (เสีย HA ถ้า AZ นั้นล่ม) หรือ VPC endpoint แทน NAT (ใช้ไม่ได้กับ GitHub/npm/Gemini)
- **ช่วงที่แพงขึ้นชั่วคราว:** `rotate_instances.sh` เปิด 4 เครื่องไม่กี่นาที (เศษสตางค์) · ASG ขยายเต็ม 4 เครื่องทั้งเดือน = +18.38
- **ถ้า Learner Lab ไม่ให้ free tier:** Lambda/SNS/EventBridge/S3 ที่ปริมาณนี้ยังไม่ถึง 1 USD/เดือน · CloudWatch alarm 6 ตัว = 0.60 · custom metric 4 ตัว = 1.20

นอก AWS: โดเมน `kid-hen.app` ที่ name.com ต่ออายุ 26.99 USD/ปี (≈ 2.25/เดือน)

- **แบบประหยัด** = `nat_gateway_per_az = false` + `db_multi_az = false` (ห้ามแตะ `enable_nat_gateway`) แล้วเปลี่ยนกลับเป็น `true` ก่อน demo
- **ไม่ใช้หลายวัน** → `terraform destroy` (ข้อมูล RDS/S3 หาย, zone ที่สร้างเองไม่หาย) แล้ว apply ใหม่ก่อน demo (~20–30 นาที)
- ถ้าใช้จริงทั้งมหาวิทยาลัย ค่าที่เพิ่มตามการใช้งานคือ EC2 ที่ ASG เพิ่ม (สูงสุด 4 เครื่อง ≈ +18 USD/เดือน), พื้นที่ RDS/S3 และ SNS อีเมลเกิน 1,000 ฉบับ/เดือน (2 USD ต่อ 100,000 ฉบับ)

---

