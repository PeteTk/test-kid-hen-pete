-- เพิ่ม: คณะของผู้แจ้ง ใช้ CHAR(2) เพื่อเก็บ 01, 07
CREATE TABLE IF NOT EXISTS faculties (
  id CHAR(2) PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE
);

-- เพิ่ม: หน่วยงานที่รับผิดชอบแก้ปัญหา แยกจากคณะผู้แจ้ง
CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE
);

-- เพิ่ม: บัญชีจริง แทน MOCK_ACCOUNTS ใน auth.js เดิม
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  google_sub VARCHAR(190) UNIQUE,
  student_id CHAR(8),
  faculty_id CHAR(2),
  department_id VARCHAR(36),
  role VARCHAR(20) NOT NULL DEFAULT 'USER',
  password_hash VARCHAR(255),
  mfa_secret VARCHAR(100),
  avatar_key VARCHAR(255),
  active INTEGER NOT NULL DEFAULT 1,
  created_at VARCHAR(30) NOT NULL,
  FOREIGN KEY (faculty_id) REFERENCES faculties(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- เพิ่ม: คู่ คณะ + หน่วยงาน ที่ Staff/Admin รับผิดชอบ (ได้หลายคู่ตามที่ Admin กำหนด)
-- นักศึกษาไม่ต้องมีแถวที่นี่ ใช้ users.faculty_id ที่คำนวณจากรหัสในอีเมล
CREATE TABLE IF NOT EXISTS user_units (
  user_id VARCHAR(36) NOT NULL,
  faculty_id CHAR(2) NOT NULL,
  department_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (user_id, faculty_id, department_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (faculty_id) REFERENCES faculties(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- เพิ่ม: Admin เปลี่ยนกฎส่งเรื่องได้โดยไม่แก้โค้ด
CREATE TABLE IF NOT EXISTS routing_rules (
  id VARCHAR(36) PRIMARY KEY,
  faculty_id CHAR(2) NOT NULL,
  category VARCHAR(80) NOT NULL,
  department_id VARCHAR(36) NOT NULL,
  UNIQUE (faculty_id, category),
  FOREIGN KEY (faculty_id) REFERENCES faculties(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- เพิ่ม: คำร้องจริง แทน Array ใน mockRequests.js
CREATE TABLE IF NOT EXISTS tickets (
  id VARCHAR(36) PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  user_id VARCHAR(36) NOT NULL,
  faculty_id CHAR(2) NOT NULL,
  department_id VARCHAR(36),
  type VARCHAR(30) NOT NULL,
  category VARCHAR(80) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(200) NOT NULL,
  building VARCHAR(120) NOT NULL,
  anonymous INTEGER NOT NULL DEFAULT 0,
  tracking_hash VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  updated_at VARCHAR(30) NOT NULL,
  resolved_at VARCHAR(30),
  suggestion INTEGER NOT NULL DEFAULT 0,
  room VARCHAR(100),
  place_detail VARCHAR(200),
  note TEXT,
  occurred_at VARCHAR(30),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (faculty_id) REFERENCES faculties(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- เพิ่ม: เก็บความคืบหน้า ไม่เขียนทับรายละเอียดเดิมของคำร้อง
CREATE TABLE IF NOT EXISTS ticket_updates (
  id VARCHAR(36) PRIMARY KEY,
  ticket_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  status VARCHAR(30) NOT NULL,
  message TEXT NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

-- เพิ่ม: เก็บข้อมูลอ้างอิงไฟล์ใน S3 ไม่เก็บรูปลงฐานข้อมูล
CREATE TABLE IF NOT EXISTS attachments (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  ticket_id VARCHAR(36),
  object_key VARCHAR(255) NOT NULL UNIQUE,
  mime VARCHAR(50) NOT NULL,
  size INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at VARCHAR(30) NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

-- เพิ่ม: ปัญหาสาธารณะ มีสถานะร่าง/เผยแพร่
CREATE TABLE IF NOT EXISTS issues (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  summary TEXT NOT NULL,
  location VARCHAR(200) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'รอตรวจสอบ',
  clarification TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL,
  created_at VARCHAR(30) NOT NULL
);

-- เพิ่ม: เชื่อมหลายคำร้องเข้ากับปัญหากลาง
CREATE TABLE IF NOT EXISTS issue_tickets (
  issue_id VARCHAR(36) NOT NULL,
  ticket_id VARCHAR(36) NOT NULL UNIQUE,
  PRIMARY KEY (issue_id, ticket_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

-- เพิ่ม: หนึ่งบัญชียืนยันปัญหาเดียวกันได้หนึ่งครั้ง
CREATE TABLE IF NOT EXISTS issue_votes (
  issue_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  location VARCHAR(200) NOT NULL,
  happened_at VARCHAR(30),
  detail TEXT NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (issue_id, user_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

-- เพิ่ม: แจ้งเตือนที่แสดงในเว็บ
CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  message TEXT NOT NULL,
  ticket_id VARCHAR(36),
  is_read INTEGER NOT NULL DEFAULT 0,
  title VARCHAR(200),
  status VARCHAR(30),
  category VARCHAR(20),
  created_at VARCHAR(30) NOT NULL
);

-- เพิ่ม: ประวัติการเปิดดูและแก้ไข
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36),
  action VARCHAR(80) NOT NULL,
  target_id VARCHAR(36),
  created_at VARCHAR(30) NOT NULL
);

-- เพิ่ม: เชิญบุคลากร แทนการเปิดให้เลือกบทบาทเองตอนสมัคร
CREATE TABLE IF NOT EXISTS invites (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(150) NOT NULL,
  role VARCHAR(20) NOT NULL,
  faculty_id CHAR(2),
  department_id VARCHAR(36),
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at VARCHAR(30) NOT NULL,
  used_at VARCHAR(30),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- เพิ่ม: รายงานปัญหาสาธารณะที่มีเนื้อหาไม่เหมาะสม
CREATE TABLE IF NOT EXISTS content_reports (
  id VARCHAR(36) PRIMARY KEY,
  issue_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  reason TEXT NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id)
);

-- แก้: เก็บ Session ใน Database แทนหน่วยความจำของ EC2 เครื่องเดียว
CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR(128) PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at VARCHAR(30) NOT NULL
);

-- เพิ่ม: เก็บงานรอส่งไป SQS/Email เพื่อไม่ให้ผู้ใช้รอระหว่างส่งฟอร์ม
CREATE TABLE IF NOT EXISTS outbox (
  id VARCHAR(36) PRIMARY KEY,
  kind VARCHAR(30) NOT NULL,
  payload TEXT NOT NULL,
  created_at VARCHAR(30) NOT NULL,
  sent_at VARCHAR(30)
);

-- เพิ่ม: ข้อความที่ Admin ตรวจข้อมูลส่วนบุคคลแล้วก่อนส่ง AI
CREATE TABLE IF NOT EXISTS ai_inputs (
  ticket_id VARCHAR(36) PRIMARY KEY,
  sanitized_text TEXT NOT NULL,
  reviewed_by VARCHAR(36) NOT NULL,
  reviewed_at VARCHAR(30) NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);