# KID-HEN — บัญชีทดลอง (3c-3)

| ที่ไหน | รหัสผ่าน | ล็อกอินด้วย |
|---|---|---|
| ในเครื่อง (`npm run dev`, SQLite) | **`1234`** | username หรืออีเมล |
| บน AWS (3c-3, `create_test_accounts = true`) | **`Kidhen1234`** | username หรืออีเมล |

รวม **40 บัญชี** · บน AWS ใช้บัญชี Cognito จริงได้ด้วย: Admin ตั้งต้น `67070054`, `67070177`, `67070223`, `67070244`, `67070292` @kmitl.ac.th หรือ Continue with Google (ครั้งแรกต้องตั้งรหัสผ่าน แล้วครั้งต่อไปกรอกอีเมล + รหัสนั้นได้)

> ปิดบัญชีทดลองบน AWS ตอนส่งงาน: `create_test_accounts = false` แล้ว `terraform apply`
> ในเครื่อง ถ้าบัญชีรายคณะล็อกอินไม่ได้ (DB ยังเป็นของ 3b-2) → ลบ `backend/data/kidhen.sqlite*` แล้ว `npm run dev` ใหม่

## บัญชีหลัก (5)
| username | อีเมล | สิทธิ์ |
|---|---|---|
| `admin` | admin@example.com | Admin |
| `staff` | somchai@example.com | Staff คณะ 07 IT — เฉพาะฝ่ายไอที |
| `staff2` | wipa@example.com | Staff คณะ 07 IT — เฉพาะฝ่ายอาคาร |
| `user` | 67070999@kmitl.ac.th | นักศึกษาคณะ 07 |
| `user2` | 67010888@kmitl.ac.th | นักศึกษาคณะ 01 |

## บัญชีรายคณะ (35)
- นักศึกษา: `user<รหัส>` → `67<รหัส>0001@kmitl.ac.th` (เห็นคณะตัวเอง + ส่วนกลาง)
- Staff: `staff<รหัส>` → `staff<รหัส>@kmitl.ac.th` (ทุกฝ่ายของคณะนั้น)

| รหัส | คณะ | นักศึกษา | อีเมลนักศึกษา | Staff | อีเมล Staff |
|---|---|---|---|---|---|
| 00 | พื้นที่ส่วนกลาง | – | – | `staff00` | staff00@kmitl.ac.th |
| 01 | วิศวกรรมศาสตร์ | `user01` | 67010001@kmitl.ac.th | `staff01` | staff01@kmitl.ac.th |
| 02 | สถาปัตยกรรมฯ | `user02` | 67020001@kmitl.ac.th | `staff02` | staff02@kmitl.ac.th |
| 03 | ครุศาสตร์อุตสาหกรรมฯ | `user03` | 67030001@kmitl.ac.th | `staff03` | staff03@kmitl.ac.th |
| 04 | เกษตร | `user04` | 67040001@kmitl.ac.th | `staff04` | staff04@kmitl.ac.th |
| 05 | วิทยาศาสตร์ | `user05` | 67050001@kmitl.ac.th | `staff05` | staff05@kmitl.ac.th |
| 07 | เทคโนโลยีสารสนเทศ | `user07` | 67070001@kmitl.ac.th | `staff07` | staff07@kmitl.ac.th |
| 08 | อุตสาหกรรมอาหาร | `user08` | 67080001@kmitl.ac.th | `staff08` | staff08@kmitl.ac.th |
| 10 | บริหารธุรกิจ | `user10` | 67100001@kmitl.ac.th | `staff10` | staff10@kmitl.ac.th |
| 11 | สื่อสารมวลชน | `user11` | 67110001@kmitl.ac.th | `staff11` | staff11@kmitl.ac.th |
| 12 | นวัตกรรมการผลิตขั้นสูง | `user12` | 67120001@kmitl.ac.th | `staff12` | staff12@kmitl.ac.th |
| 13 | การบิน | `user13` | 67130001@kmitl.ac.th | `staff13` | staff13@kmitl.ac.th |
| 14 | ศิลปศาสตร์ | `user14` | 67140001@kmitl.ac.th | `staff14` | staff14@kmitl.ac.th |
| 15 | แพทยศาสตร์ | `user15` | 67150001@kmitl.ac.th | `staff15` | staff15@kmitl.ac.th |
| 16 | ศิลปกรรม | `user16` | 67160001@kmitl.ac.th | `staff16` | staff16@kmitl.ac.th |
| 17 | ทันตแพทยศาสตร์ | `user17` | 67170001@kmitl.ac.th | `staff17` | staff17@kmitl.ac.th |
| 21 | โคเซ็น | `user21` | 67210001@kmitl.ac.th | `staff21` | staff21@kmitl.ac.th |
| 22 | พยาบาลศาสตร์ | `user22` | 67220001@kmitl.ac.th | `staff22` | staff22@kmitl.ac.th |
