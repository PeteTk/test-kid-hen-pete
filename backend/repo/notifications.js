// repo/notifications.js — แจ้งเตือนในเว็บ (ตาราง notifications) แทน data/mockNotifications.js
//
// ใครเขียน:
//   คำร้องใหม่        → เว็บเขียนเอง (ทั้งในเครื่องและบน AWS)
//   สถานะเปลี่ยน      → บน AWS: Lambda status.py (ผ่าน EventBridge) | ในเครื่อง: statusChanged() ด้านล่าง
// ผู้รับ = เจ้าของคำร้อง + Staff ที่ units ตรง (คณะ + หน่วยงาน) + Admin ที่ active
// ตรรกะ statusChanged() ต้องตรงกับ lambda/worker/status.py ฝั่ง Terraform

const db = require("../db");
const users = require("./users");
const { seqOf } = require("./tickets");

async function insertMany(rows) {
  if (!rows.length) return 0;
  const at = db.now();

  await db.transaction(async (run) => {
    for (const r of rows) {
      await run(
        "INSERT INTO notifications(id,user_id,title,message,status,category,ticket_id,is_read,created_at) " +
          "VALUES(?,?,?,?,?,?,?,0,?)",
        [db.id(), r.userId, String(r.title || "").slice(0, 200), String(r.message || ""),
         r.status || null, r.category || "request", r.ticketId || null, at]
      );
    }
  });

  return rows.length;
}

// ผู้รับของคำร้องหนึ่งรายการ (ไม่ซ้ำ)
async function recipients(ticket, { includeOwner }) {
  const ids = new Set();
  if (includeOwner && ticket.owner) ids.add(ticket.owner);

  const admins = await db.query("SELECT id FROM users WHERE role='ADMIN' AND active=1");
  for (const a of admins) ids.add(a.id);

  for (const s of await users.staffForTicket(ticket.facultyId, ticket.departmentId)) ids.add(s.id);

  return [...ids];
}

// คำร้องใหม่ → Admin + Staff ที่รับผิดชอบ (ไม่แจ้งผู้แจ้งเอง)
async function newTicket(ticket) {
  const to = await recipients(ticket, { includeOwner: false });
  return insertMany(
    to.map((userId) => ({
      userId,
      ticketId: ticket.ticketId,
      title: `มีคำร้องใหม่ ${ticket.code}`,
      message: `${ticket.title} (${ticket.type})`,
      status: ticket.status,
    }))
  );
}

// สถานะ/ข้อความเปลี่ยน (ทำแทน Lambda ตอนรันในเครื่อง) — detail เหมือน event TicketStatusChanged
async function statusChanged(ticket, detail) {
  const to = await recipients(ticket, { includeOwner: true });
  return insertMany(
    to.map((userId) => ({
      userId,
      ticketId: ticket.ticketId,
      title: detail.title,
      message: detail.message,
      status: detail.newStatus,
    }))
  );
}

function toView(row) {
  return {
    id: row.id,
    title: row.title || row.message,
    message: row.title ? row.message : "",
    status: row.status || "",
    category: row.category || "request",
    read: Boolean(Number(row.is_read)),
    requestId: seqOf(row.code),
    createdAt: row.created_at,
  };
}

async function listForUser(userId) {
  const rows = await db.query(
    "SELECT n.*, t.code FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id " +
      "WHERE n.user_id=? ORDER BY n.created_at DESC, n.id",
    [userId]
  );
  return rows.map(toView);
}

async function unreadCount(userId) {
  const rows = await db.query(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND is_read=0",
    [userId]
  );
  return Number(rows[0]?.n ?? 0);
}

// เปิดอ่าน: คืนแจ้งเตือน (เฉพาะของคนนี้) แล้วทำเป็นอ่านแล้ว
async function open(id, userId) {
  const rows = await db.query(
    "SELECT n.*, t.code FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id " +
      "WHERE n.id=? AND n.user_id=?",
    [id, userId]
  );
  if (!rows[0]) return null;

  await db.query("UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?", [id, userId]);
  return toView(rows[0]);
}

module.exports = { newTicket, statusChanged, listForUser, unreadCount, open, recipients };
