# สรุปขั้น 3b-1 (เตรียมรหัสผ่าน + บัญชีทดลอง ยังไม่แตะหน้าเว็บ)

## สิ่งที่เพิ่ม (ต่อจาก 3a)
| ไฟล์ | การเปลี่ยน |
|---|---|
| `backend/repo/users.js` | เพิ่ม `hashPassword`, `checkPassword`, `setPassword`, `authenticate(email, password)` (scrypt ของ Node ไม่ต้องติดตั้งแพ็กเกจเพิ่ม, เทียบแบบ timing-safe, บัญชี active=0 ล็อกอินไม่ได้) |
| `backend/repo/dev-seed.js` (ใหม่) | `seedDevAccounts()` สร้าง 5 บัญชีทดลอง รหัสผ่าน 1234 (เก็บ hash) **เฉพาะ SQLite และไม่ใช่ production** รันซ้ำได้ ไม่ทับของที่แก้ไว้ |
| `backend/test/users.repo.test.js` | เพิ่มทดสอบรหัสผ่าน/authenticate (รวม 13 ข้อ) |
| `backend/test/dev-seed.test.js` (ใหม่) | ทดสอบบัญชีทดลอง 5 ข้อ |

## บัญชีทดลอง (ล็อกอินด้วยอีเมล รหัส 1234)
| อีเมล | role | คณะ / units |
|---|---|---|
| admin@example.com | ADMIN | - |
| somchai@example.com | STAFF | (07, it) |
| wipa@example.com | STAFF | (07, building) |
| 67070999@kmitl.ac.th | USER | 07 |
| 67010888@kmitl.ac.th | USER | 01 |

units ของ Staff สองคนเป็นค่าที่ผมกำหนดเอง เพราะข้อมูล mock เดิมมีแค่ "เจ้าหน้าที่" ไม่มีหน่วยงานตามประเภท แก้ได้ที่ `repo/dev-seed.js`

## ยังไม่ได้ทำ (ตั้งใจ)
- `auth.js`, `app.js`, `signin.ejs` ยังเป็นของเดิม ล็อกอิน `user` / `1234` ยังทำงานเหมือนเดิม
- `server.js` ยังไม่เรียก `db.init()` (ตอนนี้ไม่มีส่วนไหนของเว็บใช้ DB) จะเพิ่มตอนสลับ auth

## รันทดสอบ
```
cd backend && npm install
SQLITE_PATH=:memory: node --no-warnings test/users.repo.test.js
SQLITE_PATH=:memory: node --no-warnings test/dev-seed.test.js
```
