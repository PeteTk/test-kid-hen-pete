# คู่มือ deploy ขั้น 3c (Terraform → เว็บบน AWS Learner Lab)

> แทนคู่มือ 3b-2 (ขั้นตอนเดิมทั้งหมด + ส่วนที่เพิ่มของ 3c: คำร้อง/แจ้งเตือนใน RDS, EventBridge → Lambda → SNS, `app_revision`)

> ใช้เมื่อพร้อมเปิด Learner Lab แล้ว — ก่อนหน้านั้นทดสอบในเครื่องตาม `STEP3C_SUMMARY.md`
> บน AWS (3c-2): ล็อกอินที่ **หน้าเว็บ KIDHEN** (อีเมล/รหัสผ่าน หรือ Google) เว็บคุยกับ Cognito เอง ไม่แสดงหน้า Cognito → ผู้ใช้/role/session/คำร้อง/แจ้งเตือนอยู่ใน RDS → Staff เปลี่ยนสถานะ = เว็บส่ง `TicketStatusChanged` เข้า **EventBridge** → **Lambda** เขียนแจ้งเตือน + ส่ง **SNS**
> ตัวอย่างใช้ domain `kid-hen.app`, region `us-east-1`, prefix ชื่อ `kidhen-dev`

## ภาพรวมลำดับ
```
[A] เตรียมโค้ดเว็บขึ้น GitHub
[B] เปิด Lab + credentials
[C] Hosted Zone ของ kid-hen.app + ตั้ง NS ที่ผู้ขาย domain   ← ทำครั้งเดียว
[D] แก้ terraform.tfvars + ตั้ง secret
[E] terraform init / plan / apply
[F] ตรวจว่าเว็บขึ้น + ล็อกอินครั้งแรก
[G] ตรวจสิทธิ์ของ LabRole (Cognito + EventBridge) + ทดสอบหน้า Admin
[G1] ทดสอบคำร้อง → เปลี่ยนสถานะ → EventBridge → Lambda → แจ้งเตือน/SNS
[G2] อัปเดตโค้ดเว็บ (app_revision)
[H] ปิดงาน (destroy) ก่อนหมด session
```

---

## [A] โค้ดเว็บขึ้น GitHub
EC2 จะ `git clone` เองตอนบูต (`templates/user_data.sh.tpl`) จึงต้องมีโค้ด 3c บน GitHub ก่อน

```bash
cd KidhenProject-main
git checkout -b step3c             # หรือ commit ลง main ตามที่ทีมใช้
git add -A
git commit -m "step 3c: tickets/notifications in DB, EventBridge TicketStatusChanged"
git push origin step3c
```
ตรวจให้แน่ใจ:
- `backend/package-lock.json` ถูก commit (EC2 ใช้ `npm ci`)
- **ไม่มี** `backend/.env`, `*.sqlite`, `backend/data/db/` (มีใน `.gitignore` แล้ว)
- repo ต้องเป็น **public** — user_data ไม่มี credential สำหรับ clone repo private

## [B] เปิด Learner Lab
1. Learner Lab → **Start Lab** (รอไฟเขียว) → **AWS Details** → **AWS CLI: Show**
2. วาง 3 ค่าใน `~/.aws/credentials` ใต้ `[default]` (หมดอายุทุกครั้งที่ session จบ ~4 ชม.)
3. ทดสอบ: `aws sts get-caller-identity` ต้องเห็น `LabRole`

## [C] Hosted Zone ของ kid-hen.app (ทำครั้งเดียว)
`.app` บังคับ HTTPS ในทุก browser อยู่แล้ว (HSTS) — ตรงกับที่ ALB ใช้ ACM

**แนะนำ: สร้าง zone เองนอก Terraform** เพื่อให้ `terraform destroy` ทุกวันไม่ลบ zone (ถ้าลบ name server จะเปลี่ยนทุกครั้ง ต้องไปแก้ที่ผู้ขาย domain ใหม่และรอ DNS อีกรอบ)
```bash
aws route53 create-hosted-zone --name kid-hen.app --caller-reference "kidhen-$(date +%s)" \
  --query '{zone:HostedZone.Id, ns:DelegationSet.NameServers}'
# ได้ zone เช่น /hostedzone/Z0123456789ABC และ name server 4 ตัว
```
1. นำ name server 4 ตัวไปตั้งที่ผู้ขาย domain (หน้า DNS / Nameservers ของ kid-hen.app)
2. รอแล้วตรวจ: `dig NS kid-hen.app +short` ต้องเห็น `awsdns` ครบ 4 ตัว (ปกติ 10 นาที–2 ชม.)
3. ใน `terraform.tfvars`: `create_hosted_zone = false` และ `route53_zone_id = "Z0123456789ABC"`

> ทางเลือก (ตามเอกสารสรุป Terraform ข้อ 17): ปล่อย `create_hosted_zone = true` → `terraform apply -target=aws_route53_zone.main` → `terraform output route53_name_servers` → ตั้ง NS → **`terraform state rm aws_route53_zone.main`** (Terraform เลิกดูแล zone นี้ destroy แล้วไม่ถูกลบ) → ตั้ง `create_hosted_zone = false` + `route53_zone_id` เหมือนวิธีข้างบน
> ถ้า Learner Lab ไม่ให้สร้าง Route 53 / ACM (AccessDenied) ให้ส่ง error มา — ต้องเปลี่ยนแผนไปใช้ Cognito ที่ระดับแอป (ไม่ผ่าน ALB)

## [D] terraform.tfvars + secret
แก้เฉพาะบรรทัดเหล่านี้ (ค่าอื่นตั้งไว้แล้ว):

| ค่า | ตั้งเป็น | หมายเหตุ |
|---|---|---|
| `github_repo_url` | `https://github.com/<org>/KidhenProject.git` | ว่าง = EC2 รันเว็บ placeholder |
| `github_branch` | `step3c` (หรือ `main`) | |
| `app_revision` | `"3c-2"` (ตั้งไว้แล้ว) | เปลี่ยนค่าเมื่อต้องการให้ EC2 ดึงโค้ดใหม่ ดู [G2] |
| `enable_custom_domain` | `true` | มีแล้ว |
| `create_hosted_zone` / `route53_zone_id` | ตามข้อ [C] | |
| `enable_alb_cognito_auth` | `false` (ตั้งไว้แล้ว) | Terraform ส่ง `AUTH_MODE=cognito` ให้เว็บ (หน้า login ของเว็บเอง) · `true` = กลับไปใช้หน้า Cognito ที่ ALB |
| `asg_min_size`, `asg_desired_capacity` | **`1`** จนกว่าจะทำ 3d | คำร้อง/แจ้งเตือนอยู่ RDS แล้ว แต่ **รูปแนบ/รูปโปรไฟล์ และไฟล์หัวข้อปัญหา (AI)** ยังอยู่บนดิสก์ของแต่ละ EC2 |
| `notification_emails` | อีเมลทีม | ได้อีเมล SNS เมื่อสถานะคำร้องเปลี่ยน (ต้องกด Confirm subscription หลัง apply) |
| `db_multi_az`, `nat_gateway_per_az` | `false` ตอนทดสอบ | ประหยัดงบ Lab (Requirement จริง = true) |
| `enable_google_idp` | `false` ถ้ายังไม่มี Google OAuth client | ถ้า `true` ต้อง export ข้างล่าง ไม่งั้น plan ไม่ผ่าน |
| `cognito_domain_prefix` | `kid-hen` | ต้องไม่ซ้ำกับคนอื่นใน us-east-1 ถ้า apply แล้ว error "domain already exists" ให้เปลี่ยน เช่น `kid-hen-67070` |

Secret (ห้ามเขียนลงไฟล์ที่ commit) — ใส่ใน `secret.auto.tfvars` (Terraform อ่านเอง, อยู่ใน `.gitignore`) หรือ export ทุกครั้งที่เปิด terminal:
```hcl
# secret.auto.tfvars
db_password          = "Kidhen2026Pass"
llm_api_key          = "AIza..."
google_client_id     = "xxx.apps.googleusercontent.com"   # เฉพาะเมื่อ enable_google_idp = true
google_client_secret = "GOCSPX-..."                      # rotate ก่อน (ค่าเดิมรั่วแล้ว)
```
หรือ
```bash
export TF_VAR_db_password='Kidhen2026Pass'        # ≥ 8 ตัว ห้ามมี / @ " ช่องว่าง
export TF_VAR_llm_api_key='AIza...'                # ไม่บังคับ
export TF_VAR_google_client_id='xxx.apps.googleusercontent.com'   # เฉพาะเมื่อ enable_google_idp = true
export TF_VAR_google_client_secret='GOCSPX-...'
```

## [E] Apply
```bash
cd kidhen-terraform
./build_lambda.sh
terraform init           # ครั้งแรก หรือหลังเพิ่ม provider
terraform validate
terraform plan -out kidhen.tfplan
terraform apply kidhen.tfplan  # ~15–25 นาที (RDS + ACM validation นานสุด)
```
ถ้าค้างที่ `aws_acm_certificate_validation` นาน = NS ยังไม่ชี้มาที่ Route 53 (กลับไปข้อ [C])

จดค่าที่ใช้ต่อ:
```bash
terraform output app_url                     # https://kid-hen.app
terraform output cognito_hosted_ui_url
terraform output cognito_google_redirect_uri # ใส่ใน Google Cloud Console (ถ้าเปิด Google)
terraform output asg_name
```

## [F] ตรวจว่าเว็บขึ้น
รอ 3–5 นาทีให้ EC2 บูต (ติดตั้ง Node → clone → `npm ci` → `npm run init-db` → start)

1. **Target health** ต้องเป็น `healthy` (ALB เรียก `GET /health`)
   ```bash
   TG=$(aws elbv2 describe-target-groups --names kidhen-dev-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
   aws elbv2 describe-target-health --target-group-arn "$TG" --query 'TargetHealthDescriptions[].TargetHealth.State'
   ```
2. **Log แอป**: CloudWatch → Log groups → `/kidhen/dev/ec2/app` ต้องเห็น
   `KID-HEN: http://localhost:3000 (DB=mysql, AUTH_MODE=alb)`
   (บน RDS ไม่มีบัญชีทดลอง/คำร้องตัวอย่าง — สร้างเฉพาะ SQLite ในเครื่อง)
   ถ้าไม่ขึ้น ดู `/kidhen/dev/ec2/userdata` (clone/npm/init-db ล้ม)
3. **เข้าเว็บ** `https://kid-hen.app` → หน้า login ของ KIDHEN → Sign in
4. **Admin คนแรก**: อีเมลใน `initial_admin_emails` + รหัสชั่วคราวจากอีเมล Cognito → เว็บพาไปหน้า "ตั้งรหัสผ่านใหม่" (ตัวใหญ่ ตัวเล็ก ตัวเลข ≥ 8 ตัว) → `/admin/dashboard`
   (ถ้าเคยตั้งรหัสแล้วตอนใช้หน้า Cognito ใช้รหัสนั้นได้เลย · ลืม/รหัสชั่วคราวหมดอายุ → "ลืมรหัสผ่าน?")
5. ยืนยันใน DB ว่าเว็บสร้างผู้ใช้ให้แล้ว (เข้า EC2 ผ่าน **Session Manager**):
   ```bash
   sudo -i
   set -a; . /etc/kidhen.env; set +a
   grep -E 'AUTH_MODE|EVENTS_MODE' /etc/kidhen.env     # ต้องเห็น cognito / eventbridge
   cd /opt/kidhen/app/backend
   node -e 'const db=require("./db");db.query("SELECT email,role,active FROM users").then(r=>{console.table(r);return db.close()})'
   ```
6. **นักศึกษา**: ปุ่ม Continue with Google → หน้า Google (อาจเห็นที่อยู่ `kid-hen.auth...amazoncognito.com` แวบเดียวระหว่าง redirect) → กลับมา `/user/home` ได้ role USER + คณะจากรหัส
   ต้องเปิด `enable_google_idp = true` และใส่ `terraform output cognito_google_redirect_uri` ใน Google Cloud Console

## [G] สิทธิ์ของ LabRole + ทดสอบหน้า Admin
หน้า Admin เปลี่ยน role = ย้ายกลุ่ม Cognito ด้วย (ไม่งั้น login ครั้งหน้า role จะถูก sync กลับ) และ Staff เปลี่ยนสถานะ = `events:PutEvents` จึงต้องตรวจสิทธิ์ของ LabRole
```bash
# บน EC2 (Session Manager) — คัดลอกสคริปต์จาก repo Terraform ไปวางก่อน
bash check_lab_permissions.sh     # ต้องผ่าน ListUsers, AdminListGroupsForUser, AdminAddUserToGroup,
                                  # AdminRemoveUserFromGroup, AdminDisableUser และ events:PutEvents
# (3c แก้บั๊กเดิม: สคริปต์ hard-code POOL_ID ไว้ ตอนนี้อ่านจาก /etc/kidhen.env หรือ POOL_ID=... แล้ว)
```
ทดสอบ:
1. ให้เพื่อนล็อกอิน 1 ครั้ง (จะเป็น USER) → Admin → จัดการผู้ใช้ → เปลี่ยนเป็น Staff + เลือกคณะ/ฝ่าย → บันทึก
2. ตรวจฝั่ง Cognito:
   ```bash
   POOL=$(terraform output -raw cognito_user_pool_id)
   aws cognito-idp admin-list-groups-for-user --user-pool-id $POOL --username <อีเมลเพื่อน> --query 'Groups[].GroupName'
   ```
   ต้องเห็น `["Staff"]`
3. เพื่อน logout → login ใหม่ → ไป `/staff/dashboard`
4. **Logout**: ปุ่มออกจากระบบ → กลับหน้า login ของเว็บ (ขึ้น "ออกจากระบบแล้ว") · คนที่เข้าด้วย Google ระบบออกจาก session Cognito ให้ด้วย (redirect แวบเดียว)

## [G0] เปลี่ยนจากหน้า Cognito (ALB) มาเป็นหน้า login ของเว็บ — ทำใน Lab ที่เปิดอยู่ได้เลย
```bash
# 1) โค้ดเว็บ 3c-2 ขึ้น GitHub
git add -A && git commit -m "3c-2: web login page with Cognito API" && git push
# 2) Terraform (tfvars ตั้ง enable_alb_cognito_auth = false และ app_revision = "3c-2" ไว้แล้ว)
terraform plan -out kidhen.tfplan     # ควรเห็น: listener 443 เปลี่ยน, launch template เปลี่ยน, App Client เปลี่ยน callback (ไม่ replace)
terraform apply kidhen.tfplan
# 3) รอ ASG เปลี่ยนเครื่อง (~5–8 นาที) แล้วดู log
aws logs tail /kidhen/dev/ec2/app --follow     # ต้องเห็น AUTH_MODE=cognito
```
4) เปิด browser ใหม่ (หรือลบ cookie ของ `kid-hen.app`) → `https://kid-hen.app` ต้องเจอหน้า KIDHEN ไม่ใช่หน้า Cognito

### ทดสอบหน้า login ของเว็บกับ Cognito จริง "จากเครื่องตัวเอง" (ระหว่าง Lab เปิด)
App Client อนุญาต `http://localhost:3000/auth/callback` ไว้แล้ว — ใส่ใน `backend/.env`:
```bash
AUTH_MODE=cognito
AWS_REGION=us-east-1
APP_BASE_URL=http://localhost:3000
COGNITO_USER_POOL_ID=<terraform output -raw cognito_user_pool_id>
COGNITO_CLIENT_ID=<terraform output -raw cognito_client_id>
COGNITO_CLIENT_SECRET=<terraform output -raw cognito_client_secret>
COGNITO_DOMAIN=<terraform output -raw cognito_hosted_ui_domain>
COGNITO_ISSUER=<terraform output -raw cognito_issuer>
```
`npm run dev` → `http://localhost:3000` ล็อกอินด้วยบัญชี Cognito จริง (ข้อมูลอยู่ใน SQLite ในเครื่อง) — หน้า Admin เปลี่ยน role จะเรียก Cognito Admin API จึงต้องมี credentials ของ Lab ใน `~/.aws/credentials`

## [G1] ทดสอบคำร้อง → EventBridge → Lambda → แจ้งเตือน/SNS
1. ให้ Admin ตั้งเพื่อนคนหนึ่งเป็น **Staff** + คณะ/ฝ่าย เช่น `07` + `เทคโนโลยีสารสนเทศ` (ข้อ [G])
2. นักศึกษาคณะ 07 แจ้งปัญหา ประเภท **ไอทีซัพพอร์ต** เลือกคณะตัวเอง → Admin และ Staff ข้อ 1 เห็นกระดิ่ง "มีคำร้องใหม่" (เว็บเขียนเอง)
3. Staff → จัดการคำร้อง → เปลี่ยนเป็น **กำลังดำเนินการ** + ข้อความ → บันทึก
4. ตรวจทาง:
   ```bash
   aws logs tail /aws/lambda/kidhen-dev-worker --since 10m      # ต้องเห็น "ticket #0001 -> กำลังดำเนินการ : N notifications"
   ```
   - นักศึกษาเห็นกระดิ่ง "คำร้อง #0001 ได้รับการอัปเดตสถานะ" → กดแล้วไปหน้าคำร้อง
   - อีเมลใน `notification_emails` ที่ Confirm แล้ว ได้อีเมล SNS
5. ถ้า Lambda ไม่มี log แต่กระดิ่งยังขึ้น = PutEvents ล้มแล้วเว็บเขียนแจ้งเตือนเองแทน → ดู log แอป `[events] ส่ง EventBridge ไม่สำเร็จ ...` (มักเป็นสิทธิ์ `events:PutEvents`)

## [G2] อัปเดตโค้ดเว็บโดยไม่ต้อง destroy
EC2 ดึงโค้ดตอนบูตเท่านั้น — push ขึ้น GitHub แล้วให้ ASG สร้างเครื่องใหม่ (เลือกทางใดทางหนึ่ง):
```bash
git push origin step3c

# ทาง 1: เปลี่ยน app_revision ใน terraform.tfvars (เช่น "3c-2") แล้ว
terraform apply

# ทาง 2: ไม่แก้ Terraform
aws autoscaling start-instance-refresh --auto-scaling-group-name kidhen-dev-asg

aws logs tail /kidhen/dev/ec2/app --follow     # รอเห็น "AUTH_MODE=alb"
```
ผู้ใช้/session/คำร้อง/แจ้งเตือนอยู่ใน RDS จึงไม่หายตอนเปลี่ยนเครื่อง — **รูปแนบและหัวข้อปัญหา (AI) บนดิสก์ EC2 หาย** (แก้ใน 3d)

## [H] ปิดงาน
```bash
terraform destroy      # NAT, RDS, ALB คิดเงินรายชั่วโมง
```
- ข้อมูล RDS หายเมื่อ destroy (`db_skip_final_snapshot = true`) → ผู้ใช้จะถูกสร้างใหม่ตอน login ครั้งถัดไป (role จากกลุ่ม Cognito ซึ่งก็ถูกสร้างใหม่เช่นกัน; Admin ตั้งต้นมาจาก `initial_admin_emails`)
- Hosted Zone ที่สร้างเองในข้อ [C] ไม่ถูกลบ (มีค่าใช้จ่าย ~0.5 USD/เดือน)

---

## แก้ปัญหา
| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| Target `unhealthy` วนสร้างเครื่องใหม่ | แอปล้มตอนบูต | ดู `/kidhen/dev/ec2/app` และ `/kidhen/dev/ec2/userdata`; ตรวจ `health_check_path = "/health"` |
| ยังเห็นหน้า Cognito หลัง apply | listener ยังเป็นแบบเดิม หรือ EC2 ยังเป็นโค้ดเก่า (`AUTH_MODE=alb`) | `terraform apply` ให้ครบ, รอ instance refresh, เปิด Incognito |
| ล็อกอินอีเมลแล้ว "อีเมลหรือรหัสผ่านไม่ถูกต้อง" ทั้งที่ถูก | บัญชี Google อย่างเดียว (ไม่มีรหัสผ่าน) หรือ App Client ไม่มี `ALLOW_USER_PASSWORD_AUTH` | ใช้ปุ่ม Google / ตรวจ `explicit_auth_flows` |
| กด Google แล้วขึ้น `redirect_mismatch` | `https://kid-hen.app/auth/callback` ไม่อยู่ใน callback_urls / `APP_BASE_URL` ไม่ตรง | `enable_custom_domain = true` (Terraform เติมให้) และ `APP_BASE_URL=https://kid-hen.app` |
| Google ขึ้น "ใช้ได้เฉพาะบัญชี Google ของสถาบัน" | Lambda pre sign-up ปฏิเสธอีเมลนอก `@kmitl.ac.th` | ตั้งใจ (ตาม `cognito_allowed_email_domains`) |
| (โหมด alb เท่านั้น) `401 Authorization Required` ของ ALB / `ยืนยันตัวตนไม่สำเร็จ` | cookie ALB เก่าค้าง / EC2 โหลด key ไม่ได้ | ลบ cookie หรือใช้ Incognito; `enable_nat_gateway = true` |
| กด Logout แล้ว Cognito error เรื่อง logout_uri | `APP_BASE_URL` ไม่ตรงกับ `logout_urls` | ต้องเป็น `https://kid-hen.app/login` (Terraform ใส่ให้เมื่อ `enable_custom_domain = true`) |
| เปลี่ยน role ในหน้า Admin แล้ว error "เปลี่ยนบทบาทใน Cognito ไม่สำเร็จ" | LabRole ไม่มีสิทธิ์ `cognito-idp:Admin*` | รัน `check_lab_permissions.sh`; ถ้าไม่ผ่านให้ย้ายกลุ่มใน Cognito console แทน (role จะ sync ตอน login ครั้งหน้า) |
| Staff เข้า `/staff/...` ได้ 403 "ยังไม่มีข้อมูลคณะ" | ยังไม่ได้ตั้งคณะ/ฝ่าย | Admin → จัดการผู้ใช้ → เลือกคณะ/ฝ่าย |
| ผู้ใช้ที่ถูกลบล็อกอินไม่ได้อีกเลย | หน้า Admin ลบ = Disable ใน Cognito | Cognito console → Users → Enable user |
| รูปแนบไม่ขึ้น / หัวข้อปัญหาหาย | ASG > 1 เครื่อง หรือเครื่องถูกเปลี่ยน (ไฟล์อยู่บนดิสก์ EC2) | ตั้ง ASG = 1 จนกว่าจะทำ 3d (S3) |
| Staff เปลี่ยนสถานะแล้วไม่มี Lambda log | PutEvents ล้ม (สิทธิ์) หรือ `EVENTS_MODE` ไม่ใช่ eventbridge | ดู log แอป `[events]`; รัน `check_lab_permissions.sh` |
| Lambda log `ticket not found` | event มาจากคนละ DB / ทดสอบด้วย event ปลอม | ปกติสำหรับ event ทดสอบ |
| Lambda error `Unknown column title` | Lambda รันก่อนเว็บ init คอลัมน์ 3c | รอ EC2 บูตเสร็จ (`npm run init-db` เพิ่มคอลัมน์) แล้วเปลี่ยนสถานะใหม่ |

## env ที่เว็บใช้ในขั้นนี้ (Terraform เขียนให้ใน `/etc/kidhen.env`)
| ชื่อ | ใช้ทำอะไร |
|---|---|
| `AUTH_MODE=cognito` | หน้า login ของเว็บ เรียก Cognito API (`InitiateAuth`, ตั้งรหัสใหม่, ลืมรหัส) + Google ผ่าน `/auth/callback` |
| `COGNITO_CLIENT_SECRET` | ทำ `SECRET_HASH` และแลก code ของ Google |
| `EVENTS_MODE=eventbridge` | Staff เปลี่ยนสถานะ → PutEvents (`EVENT_SOURCE`=`kidhen.app`, DetailType `TicketStatusChanged`) |
| `COGNITO_ISSUER`, `COGNITO_CLIENT_ID` | ตรวจ access token (issuer, client_id) และโหลด JWKS |
| `COGNITO_USER_POOL_ID` | ย้ายกลุ่ม/Disable ผู้ใช้จากหน้า Admin |
| `COGNITO_DOMAIN`, `APP_BASE_URL` | URL logout ของ Cognito |
| `SESSION_SECRET` | เซ็น cookie `kidhen.sid` (เท่ากันทุก EC2) |
| `DB_*`, `NODE_EXTRA_CA_CERTS` | RDS MySQL ผ่าน TLS (`users`, `user_units`, `sessions`, `tickets`, `ticket_updates`, `attachments`, `notifications`) |
