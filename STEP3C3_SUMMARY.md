# สรุปขั้น 3c-3 + 3b-3 (บัญชีทดลองบน AWS, Google ครั้งแรกต้องตั้งรหัสผ่าน, Admin เพิ่มผู้ใช้)

ต่อจาก 3c-2 · ใช้คู่กับ `kidhen-terraform-3c3.zip`

## 1. บัญชีทดลอง 40 บัญชีบน AWS
ปัญหา: บน AWS กรอก `admin@example.com` ไม่ได้ เพราะบัญชีทดลองมีแค่ใน SQLite ในเครื่อง แต่ AWS ตรวจรหัสที่ Cognito

| ส่วน | ทำอะไร |
|---|---|
| Terraform `create_test_accounts = true` | สร้างบัญชีชุดเดียวกับในเครื่องใน Cognito พร้อม**รหัสผ่านถาวร `Kidhen1234`** (`test_account_password`) + กลุ่ม Admin/Staff/User ไม่ส่งอีเมล |
| user_data | env `SEED_TEST_ACCOUNTS=true` |
| เว็บ `repo/dev-seed.js` | เมื่อ `SEED_TEST_ACCOUNTS=true` สร้างแถวใน RDS ให้ (role + คณะ/ฝ่ายของ Staff) + คำร้องตัวอย่าง 6 รายการถ้าตาราง tickets ว่าง |
| เว็บ `routes/auth.js` | โหมด cognito พิมพ์ username ของบัญชีทดลองได้ (`admin`, `staff01`, `user21` …) และแสดงรายชื่อบัญชีใต้ฟอร์ม (ไม่แสดงรหัสบนหน้าเว็บ) |

ในเครื่อง (SQLite) ยังใช้รหัส `1234` เหมือนเดิม · **ปิด `create_test_accounts = false` ตอนส่งงาน/ใช้จริง**

## 2. เข้าด้วย Google ครั้งแรก → บังคับตั้งรหัสผ่าน
ปัญหา: บัญชีที่เกิดจาก Google (ผู้ใช้ Cognito `Google_xxx`) ไม่มีรหัสผ่าน กรอกอีเมล/รหัสที่หน้าแรกไม่ได้

```
กด Google → /auth/callback → อีเมลนี้มีบัญชีรหัสผ่านที่ใช้ได้ไหม (ListUsers)
   มี → เข้าใช้งานเลย
   ไม่มี / ยังเป็นรหัสชั่วคราว → /auth/set-password (หน้าเว็บ KIDHEN) ยังเข้าใช้งานไม่ได้จนกว่าจะตั้ง
      1) AdminCreateUser (ไม่ส่งอีเมล)   2) AdminSetUserPassword ถาวร
      3) ย้ายกลุ่ม role จาก Google_xxx    4) AdminDeleteUser(Google_xxx) + AdminLinkProviderForUser
   → ครั้งต่อไปเข้าได้ทั้งปุ่ม Google และอีเมล + รหัสผ่าน เป็นบัญชีเดียว role เดียว
```
- ข้อ 4 ล้ม (เช่น LabRole ไม่มีสิทธิ์) ไม่เสียหาย: ตั้งรหัสได้แล้ว และ Lambda pre sign-up จะรวมให้ตอนกด Google ครั้งหน้า
- ตรวจบัญชีไม่ได้ (ListUsers ถูกปฏิเสธ) → ไม่บังคับ ให้เข้าใช้งานตามปกติ + log `[auth] ตรวจบัญชีรหัสผ่านไม่สำเร็จ`
- Admin ตั้งต้นที่ยังไม่เคยตั้งรหัส (รหัสชั่วคราว) แล้วกด Google ก็ถูกถามให้ตั้งรหัสเช่นกัน
- บัญชีที่ Admin ปิดไว้ ไม่ถาม (ถูกปฏิเสธตามเดิม)
- สิทธิ์ที่ใช้มีอยู่ใน `check_lab_permissions.sh` แล้ว (AdminCreateUser, AdminSetUserPassword, AdminDeleteUser, AdminLinkProviderForUser)

## 3. ฝ่ายของนักศึกษา
ตารางจัดการผู้ใช้/หน้าโปรไฟล์: User แสดงฝ่ายเป็น **"นักศึกษา"** (เดิมแสดง "กิจการนักศึกษา" ซึ่งเป็นฝ่ายของ Staff ที่ใช้จับคู่คำร้องเบื้องหลัง)

## 4. Admin เพิ่มผู้ใช้ (3b-3, UC-09)
จัดการผู้ใช้ → **+ เพิ่มผู้ใช้** (`/admin/users/new`): อีเมล, ชื่อ-นามสกุล, บทบาท, คณะ/ฝ่าย (Staff/Admin)

| โหมด | ผล |
|---|---|
| AWS (`AUTH_MODE=cognito`) | `AdminCreateUser` → **Cognito ส่งรหัสผ่านชั่วคราวทางอีเมล** + ใส่กลุ่มตาม role → สร้างแถวใน `users` + `user_units` · ผู้ใช้เข้าครั้งแรกด้วยรหัสชั่วคราว → หน้า "ตั้งรหัสผ่านใหม่" หรือกด Google ด้วยอีเมลเดียวกัน → หน้า "ตั้งรหัสผ่าน" แล้วรวมเป็นบัญชีเดียว (role ตามที่ Admin กำหนด) |
| ในเครื่อง (`local`) | สร้างแถวใน `users` พร้อมรหัสผ่านที่ Admin กรอก |

- ตรวจ: อีเมลถูกรูปแบบ, ชื่อ ≤ 150 ตัว, Staff ต้องมีคณะเดียว, อีเมลซ้ำใน DB → แจ้งให้ไปแก้จากรายการแทน
- อีเมลที่มีบัญชีใน Cognito อยู่แล้ว (เช่น เคยกด Google) → ไม่ส่งอีเมลซ้ำ แค่ย้ายกลุ่มทุกบัญชีของอีเมลนั้น
- นักศึกษา: คณะจากรหัสในอีเมลเหมือนเดิม · สร้างใน Cognito ไม่สำเร็จ = ไม่สร้างใน DB
- แก้เพิ่ม: Google ครั้งแรกของคนที่ Admin เพิ่มไว้ (บัญชี Google แยกอยู่กลุ่ม User) → ใช้ role ของบัญชีที่ Admin สร้าง ไม่ใช่ User
- หน้าแก้ไขผู้ใช้: นักศึกษาแสดงฝ่าย "นักศึกษา"

## ไฟล์ที่เปลี่ยน
**เว็บ (3b-3):** `frontend/views/admin/user-new.ejs` (ใหม่), `backend/routes/admin.js` (`/admin/users/new`), `backend/service/cognito-groups.js` (`createUser`), `frontend/views/admin/users.ejs` (ปุ่ม), `user-edit.ejs`, `backend/test/cognito-groups.test.js` (ใหม่ 4 ข้อ), `backend/test/web-local.test.js` (+1 ข้อ)

**เว็บ (3c-3):** `backend/service/cognito-password.js` (ใหม่), `backend/test/cognito-password.test.js` (ใหม่ 5 ข้อ), `frontend/views/auth/set-password.ejs` (ใหม่), `backend/auth/cognito.js` (identity มี `username`, `federated`), `backend/routes/auth.js`, `backend/repo/dev-seed.js`, `backend/repo/users.js`, `backend/server.js`, `backend/test/cognito.test.js` (+2 ข้อ), `frontend/views/auth/signin.ejs`, `login.ejs`, `backend/package.json`, `backend/.env.example`

**Terraform:** `variables.tf` (`create_test_accounts`, `test_account_password`), `cognito.tf` (`aws_cognito_user.test` + `aws_cognito_user_in_group.test`), `compute.tf` + `templates/user_data.sh.tpl` (`SEED_TEST_ACCOUNTS`), `terraform.tfvars` (`create_test_accounts = true`, `github_repo_url`, ASG = 1)

## ทดสอบแล้ว / ยังไม่ได้ทดสอบ
- `test/cognito-password.test.js` 6 ข้อ + `test/cognito-groups.test.js` 4 ข้อ ผ่าน (Cognito ปลอม)
- **ยังไม่ได้รัน `npm test` ชุดเต็ม** (เครื่องที่เขียนโหลดแพ็กเกจ npm ไม่ได้) — รัน `npm test` ในเครื่องก่อน push
- ยังไม่ได้ทดสอบกับ Cognito จริง และยังไม่ได้รัน `terraform validate`

## deploy
```bash
# เว็บ
npm test && git add -A && git commit -m "3c-3 + 3b-3: test accounts on AWS, Google first login sets password, admin add user" && git push
# Terraform (ถ้ายังไม่มีระบบ: apply ปกติ · app_revision ตั้งเป็น "3c-3" แล้ว)
terraform plan -out kidhen.tfplan    # ควรเห็น aws_cognito_user.test x40 + aws_cognito_user_in_group.test x40
terraform apply kidhen.tfplan
```
