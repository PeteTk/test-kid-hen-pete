# สรุปขั้น 3d — AI ผ่าน Lambda + รูปไป S3 (ตาม diagram ใหม่)

ต่อจาก 3c-3 + 3b-3 · ใช้คู่กับ `kidhen-terraform-3d.zip` · โมเดล AI = **Gemini** (External LLM API) ไม่ใช้ Bedrock

## ภาพรวมตาม diagram
```
นักศึกษาส่งคำร้อง ──> EC2 ──> tickets (RDS)
                        └─> กรองข้อมูลส่วนบุคคล + สกัดอาการ ──> ai_inputs (RDS)
                              ready = {type, placeKey (hash), symptoms}  ← ไม่มีข้อความต้นฉบับ/ชื่อ/สถานที่จริง
                              held  = เรื่องบุคคล/ข้อมูลอ่อนไหว/อาการที่ยังไม่รองรับ/สถานที่ไม่ครบ → ไม่ส่ง AI

EventBridge "Trigger ตามเวลา" (rate 1 day) ─┐
Admin กด "ประมวลผลตอนนี้" (EC2 → PutEvents RunAnalysis) ─┴─> Lambda analyze.py
        ──> Gemini (ผ่าน NAT) จัดกลุ่ม ──> ตรวจผลทั้งชุด ──> issues + issue_tickets + ai_runs (RDS)
        ──> SNS "มีหัวข้อปัญหาที่พบบ่อยใหม่" → อีเมลทีม

User (UC-04)  : หน้า "ปัญหาที่พบบ่อย" อ่าน issues (เผยแพร่ + คณะตัวเอง/ส่วนกลาง) · "แจ้งปัญหานี้ด้วย" ผูกเข้าหัวข้อทันที
Admin (UC-08) : แก้หัวข้อ/สรุป · ซ่อน/เผยแพร่ · ดูคำร้องในหัวข้อ · ดูคำร้องที่เก็บภายใน · สถานะรอบล่าสุด (จาก ai_runs)

รูปแนบ/รูปโปรไฟล์ (UC-02):
  browser ──POST /files/presign──> EC2 เซ็น PUT URL (ชนิด+ขนาด, 5 นาที)
  browser ──PUT ไฟล์ตรง──> S3   (ไฟล์ไม่ผ่าน EC2)
  browser ──ส่งฟอร์ม (key)──> EC2 ตรวจ key เป็นของผู้ใช้นี้ + HeadObject (มีจริง เป็นรูป ขนาดไม่เกิน) → บันทึก
  <img src="/files/<key>"> ──> EC2 ตรวจว่าล็อกอิน ──302──> pre-signed GET ของ S3 (5 นาที)
```
→ ข้อมูลทุกอย่างอยู่ RDS/S3 แล้ว: **ปิด sticky session + ASG 2 เครื่อง (2 AZ)** ได้

## AI: เปลี่ยนอะไร
| เดิม (3c) | 3d |
|---|---|
| EC2 เรียก Gemini เองเมื่อ Admin กดปุ่ม | Lambda เรียก Gemini (ตั้งเวลาวันละครั้ง + ปุ่ม Admin ผ่าน EventBridge) |
| หัวข้อเก็บไฟล์ `data/db/issue-summaries-v2.json` บนดิสก์ EC2 | ตาราง `issues`, `issue_tickets`, `ai_inputs`, `ai_runs` (ใหม่) ใน RDS |
| Lambda `analyze.py` รอ `ai_inputs` ที่ไม่มีใครเขียน | เว็บเขียน `ai_inputs` อัตโนมัติตอนส่ง/แก้คำร้อง (ตัวกรองเดิมของเว็บ) |
| `/internal/ai/batch` (รอ EventBridge เรียก HTTP) | ลบออก |

- กฎเหมือนเดิมทุกข้อ: จัดกลุ่มเฉพาะ ประเภท + สถานที่ + อาการตรงกัน, ข้อความสรุปห้ามมีข้อมูลบุคคล/จำนวนคน/"แก้แล้ว", คำร้องเปลี่ยนระหว่างรอ AI = ไม่บันทึก
- id ที่ส่ง Gemini เป็นเลขลำดับในชุด (1..10) ไม่ใช่ id จริง
- หัวข้อใหม่เผยแพร่ทันที (เหมือนเดิม) — Admin แก้/ซ่อนได้ และ AI ไม่ทับข้อความที่ Admin แก้
- ส่ง RunAnalysis ไม่ได้ (เช่น ไม่มีสิทธิ์ PutEvents) → เว็บประมวลผลเองแทน (EC2 มี `GEMINI_API_KEY`)
- ในเครื่อง (`EVENTS_MODE=local`): ปุ่มประมวลผลรันในเว็บ ใช้ `GEMINI_API_KEY` ใน `.env` เหมือนเดิม
- ข้อมูลหัวข้อในไฟล์ JSON เดิมไม่ย้ายมา (กดประมวลผลใหม่ครั้งเดียวก็ได้หัวข้อจากคำร้องใน DB)

## S3: เปลี่ยนอะไร
- `STORAGE_MODE=s3` (Terraform ตั้งให้) / `local` (ในเครื่อง — multer ลง `frontend/public/uploads` เหมือนเดิม)
- key: `requests/<userId>/<เวลา>-<สุ่ม>.<นามสกุล>`, `avatars/<userId>/...` · รับ jpg/png/gif/webp/heic · คำร้อง ≤ 3 รูป รูปละ ≤ 5MB · โปรไฟล์ ≤ 2MB
- ไฟล์ใหม่ `frontend/public/js/s3-upload.js` — ใส่เฉพาะโหมด s3 ในหน้าแจ้งปัญหา / โปรไฟล์ / Admin แก้ผู้ใช้
- รูปโปรไฟล์เก่าที่ถูกแทนที่ → ลบใน S3 (DeleteObject)
- ⚠️ **ต้องรัน `npm install` ในเครื่องแล้ว commit `package-lock.json`** (เพิ่ม `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) — ถ้าไม่ commit EC2 จะ `npm ci` ไม่ผ่านแล้วถอยไปใช้ `npm install` (ยังขึ้นได้ แต่ช้ากว่า)

## Terraform (`kidhen-terraform-3d.zip`)
| ไฟล์ | การเปลี่ยน |
|---|---|
| `notifications.tf` | EventBridge rule `run-analysis` (DetailType `RunAnalysis`) → Lambda + permission |
| `lambda/worker/analyze.py` | เขียนใหม่: อ่าน `ai_inputs` ready → Gemini → ตรวจผล → `issues`/`issue_tickets`/`ai_runs` → SNS · ไม่สมัคร SNS ให้บัญชีทดลอง |
| `lambda/worker/app.py` | `RunAnalysis` → analyze |
| `templates/user_data.sh.tpl` | `STORAGE_MODE=s3` |
| `terraform.tfvars` | `asg_min_size`/`asg_desired_capacity` = 2, `enable_alb_stickiness = false`, `app_revision = "3d"` |
| `compute.tf`, `variables.tf` | instance refresh healthy 100%/200% (สร้างเครื่องใหม่ก่อนลบเครื่องเก่า), grace 600 วินาที |
| `check_lab_permissions.sh` | ตรวจ `s3:PutObject/HeadObject/GetObject/DeleteObject` |
| `tests/test_analyze.py` | ทดสอบ analyze.py ด้วย SQLite + AI ปลอม (`python3 tests/test_analyze.py`) |

## ไฟล์เว็บที่เปลี่ยน
- **ใหม่:** `backend/service/storage.js`, `backend/routes/files.js`, `frontend/public/js/s3-upload.js`, `backend/test/storage.test.js`
- **เขียนใหม่:** `backend/service/issues.js` (DB แทนไฟล์ JSON, `syncTicket`/`syncAll`/`requestRun`)
- **แก้:** `schema.sql` (`ai_runs`), `db.js` (คอลัมน์ใหม่ใน `issues`, `issue_tickets`, `ai_inputs` — เพิ่มให้ DB เดิมอัตโนมัติ), `service/events.js` (`runAnalysis`), `routes/faq.js`, `routes/user.js`, `routes/profile.js`, `routes/admin.js`, `repo/tickets.js`, `auth/session-user.js`, `app.js`, `server.js`, `config.js` (`STORAGE_MODE`), `package.json`, `.env.example`, views `admin/faq.ejs`, `user/issues.ejs`, `user/request-new.ejs`, `profile.ejs`, `admin/user-edit.ejs`, `test/tickets.test.js`
- **ลบ:** `routes/ai-job.js`, `data/store.js`, `worker/maintenance.js` (ไฟล์ว่าง)

## ทดสอบแล้ว
- เว็บ + Lambda ใช้ตารางเดียวกันจริง: เว็บ (SQLite) เตรียม `ai_inputs` จากคำร้องตัวอย่าง → **Lambda `analyze.py` ของจริง** (Python) อ่าน/เขียน DB เดียวกัน → เว็บอ่านหัวข้อได้ถูกต้อง (4 หัวข้อ, แอร์ห้อง 301 = 2 คำร้อง)
- `service/issues.js` ในเว็บ: จัดกลุ่ม, รอบสองไม่เรียก AI, แจ้งปัญหาใต้หัวข้อ, แก้/ซ่อนหัวข้อ, ย้ายสถานที่แล้วหลุดจากหัวข้อ, ไม่มีข้อความต้นฉบับใน `ai_inputs`
- `tests/test_analyze.py` 5 ข้อ, `test/storage.test.js` 4 ข้อ, `test/cognito-password.test.js` 6 ข้อ, `test/cognito-groups.test.js` 4 ข้อ — ผ่าน
- view ที่แก้ render ได้ด้วยข้อมูลจริง · `tofu validate` (OpenTofu + AWS provider 5.80) ผ่าน · user_data render ได้
- **ยังไม่ได้รัน `npm test` ชุดเต็ม** (เครื่องที่เขียนโหลดแพ็กเกจ npm ไม่ได้) — รันในเครื่องก่อน push
- ยังไม่ได้ทดสอบกับ S3 / EventBridge / Gemini ของจริง

## deploy
```bash
# เว็บ
cd backend && npm install && npm test        # อัปเดต package-lock.json + รันเทสต์
cd .. && git add -A && git commit -m "3d: AI via Lambda + issues in RDS, S3 pre-signed uploads" && git push

# Terraform
./build_lambda.sh
terraform validate
terraform plan -out kidhen.tfplan     # ควรเห็น: rule run-analysis, Lambda เปลี่ยน code, launch template, ASG 2, target group stickiness
terraform apply kidhen.tfplan
```
### ตรวจหลัง apply
1. `aws logs tail /kidhen/dev/ec2/app --follow` → ต้องเห็นเว็บขึ้นทั้ง 2 เครื่อง
2. บน EC2: `bash check_lab_permissions.sh` → S3 + `events:PutEvents` ต้องผ่าน
3. นักศึกษาแจ้งปัญหา + แนบรูป → เปิดคำร้องเห็นรูป (URL รูปเป็น `/files/...` แล้วเด้งไป `...s3.amazonaws.com...`)
4. Admin → จัดการปัญหาที่พบบ่อย → ประมวลผลตอนนี้ → "ส่งงานให้ Lambda แล้ว" → `aws logs tail /aws/lambda/kidhen-dev-worker --since 5m` → รีเฟรชหน้า เห็นหัวข้อ + รอบล่าสุด "โดย admin"
5. นักศึกษาคณะเดียวกันเห็นหัวข้อในหน้า "ปัญหาที่พบบ่อย"

### ถ้ามีปัญหา
| อาการ | สาเหตุ | แก้ |
|---|---|---|
| เลือกรูปแล้วส่งไม่ได้ "อัปโหลดรูปไป S3 ไม่สำเร็จ" | CORS (`s3_cors_allowed_origins` ไม่มีโดเมนเว็บ) หรือ LabRole ไม่มีสิทธิ์ S3 | ตรวจ tfvars + `check_lab_permissions.sh` |
| รูปไม่ขึ้น (403 จาก S3) | URL หมดอายุ (5 นาที) / สิทธิ์ GetObject | รีเฟรชหน้า / ตรวจสิทธิ์ |
| กดประมวลผลแล้วรอบล่าสุด "ไม่สำเร็จ: ยังไม่ได้ตั้ง llm_api_key" | ไม่ได้ใส่ `TF_VAR_llm_api_key` | ใส่ใน `secret.auto.tfvars` แล้ว apply |
| รอบล่าสุดไม่เปลี่ยนเลย | PutEvents ไม่ผ่าน → เว็บประมวลผลเอง (ดู log แอป `[AI]`) หรือ Lambda error | `aws logs tail /aws/lambda/kidhen-dev-worker` |
| Lambda error `no such column` / `Unknown column label_key` | Lambda รันก่อนเว็บเพิ่มคอลัมน์ | รอ EC2 บูตเสร็จ (`init-db`) แล้วกดใหม่ |
