// repo/tickets.js — คำร้องในตาราง tickets / ticket_updates / attachments (3c: แทน data/mockRequests.js)
//
// คืนข้อมูลเป็น "รูปแบบคำร้องเดิม" ที่ view และ service/issues.js ใช้อยู่ เพื่อไม่ต้องรื้อหน้าเว็บ:
//   id = ลำดับตัวเลขจาก code (#0007 → 7) ใช้ใน URL /requests/7
//   ticketId = UUID จริงในตาราง (ใช้ใน notifications / EventBridge / Lambda)
//   owner = users.id ของผู้แจ้ง

const db = require("../db");
const { makePlace } = require("../service/location");
const { TYPES, STATUSES, TYPE_DEPARTMENT } = require("../service/catalog");
const { formatThaiShortDate } = require("../utils/date");

const COLUMNS =
  "t.id, t.code, t.user_id, t.faculty_id, t.department_id, t.type, t.category, t.title, " +
  "t.description, t.location, t.building, t.room, t.place_detail, t.status, t.note, " +
  "t.created_at, t.updated_at, t.resolved_at, t.occurred_at";

function seqOf(code) {
  const match = /^#(\d+)$/.exec(String(code || ""));
  return match ? Number(match[1]) : null;
}

function codeOf(seq) {
  return "#" + String(seq).padStart(4, "0");
}

// แถว DB → รูปแบบคำร้องที่หน้าเว็บใช้
function toView(row, { history, images } = {}) {
  const locationInfo = makePlace(
    {
      facultyId: row.faculty_id,
      building: row.building,
      room: row.room,
      placeDetail: row.place_detail,
    },
    false
  );

  return {
    id: seqOf(row.code),
    ticketId: row.id,
    code: row.code,
    title: row.title,
    type: row.type,
    facultyId: row.faculty_id,
    departmentId: row.department_id,
    location: row.location,
    locationInfo,
    detail: row.description,
    status: row.status,
    note: row.note || "",
    owner: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    occurredAt: row.occurred_at || null,
    date: formatThaiShortDate(row.created_at),
    images: images || [],
    // รายการ: ใช้แค่เวลายื่น (dashboard) / หน้ารายละเอียด: ประวัติเต็มจาก ticket_updates
    history: history || [{ status: STATUSES[0], at: row.created_at }],
  };
}

// รหัส #0001 ถัดไป (EC2 หลายเครื่องอาจชนกัน → create() ลองใหม่เมื่อ code ซ้ำ)
async function nextSeq(run) {
  const rows = await run(
    "SELECT MAX(CAST(SUBSTR(code, 2) AS DECIMAL(10,0))) AS n FROM tickets"
  );
  return Number(rows[0]?.n || 0) + 1;
}

function isDuplicate(error) {
  return /UNIQUE|Duplicate entry/i.test(error.message);
}

// สร้างคำร้อง: place มาจาก faculty-access (ตรวจสิทธิ์แล้ว), images = [{ key, mime, size }]
async function create({ userId, place, type, title, detail, images = [], occurredAt = null }) {
  if (!TYPES.includes(type)) db.fail("ประเภทคำร้องไม่ถูกต้อง");
  if (!place?.complete) db.fail("ข้อมูลสถานที่ไม่ครบ");

  const cleanTitle = db.text(title, 1, 200, "หัวข้อ");
  const cleanDetail = db.text(detail, 1, 5000, "รายละเอียด");

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = db.id();
    const at = db.now();

    try {
      await db.transaction(async (run) => {
        const seq = await nextSeq(run);

        await run(
          "INSERT INTO tickets(id,code,user_id,faculty_id,department_id,type,category,title," +
            "description,location,building,room,place_detail,anonymous,tracking_hash,status," +
            "created_at,updated_at,suggestion,note,occurred_at) " +
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)",
          [
            id, codeOf(seq), userId, place.facultyId, TYPE_DEPARTMENT[type], type, type,
            cleanTitle, cleanDetail, place.label, place.building || "", place.room || null,
            place.placeDetail || null, db.hash(id), STATUSES[0], at, at,
            type === "ข้อเสนอแนะ" ? 1 : 0, "", occurredAt,
          ]
        );

        await run(
          "INSERT INTO ticket_updates(id,ticket_id,user_id,status,message,created_at) VALUES(?,?,?,?,?,?)",
          [db.id(), id, userId, STATUSES[0], "ยื่นคำร้อง", at]
        );

        for (const image of images) {
          await run(
            "INSERT INTO attachments(id,user_id,ticket_id,object_key,mime,size,confirmed,created_at) " +
              "VALUES(?,?,?,?,?,?,1,?)",
            [db.id(), userId, id, image.key, String(image.mime).slice(0, 50), image.size, at]
          );
        }
      });

      return findById(id);
    } catch (error) {
      if (attempt < 4 && isDuplicate(error)) continue; // code ชนกับอีกเครื่อง
      throw error;
    }
  }
}

async function imagesOf(ticketId) {
  const rows = await db.query(
    "SELECT object_key FROM attachments WHERE ticket_id=? ORDER BY created_at, object_key",
    [ticketId]
  );
  // 3d: ในเครื่อง /uploads/<key> · บน AWS /files/<key> (redirect ไป pre-signed URL ของ S3)
  const { storage } = require("../service/storage");
  return rows.map((r) => storage.url(r.object_key)).filter(Boolean);
}

async function historyOf(ticketId) {
  const rows = await db.query(
    "SELECT status, message, created_at FROM ticket_updates WHERE ticket_id=? ORDER BY created_at, id",
    [ticketId]
  );
  return rows.map((r) => ({ status: r.status, message: r.message, at: r.created_at }));
}

async function detailed(row) {
  if (!row) return null;
  return toView(row, { history: await historyOf(row.id), images: await imagesOf(row.id) });
}

async function findById(ticketId) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM tickets t WHERE t.id=?`, [ticketId]);
  return detailed(rows[0]);
}

// /requests/7 → #0007
async function findBySeq(seq) {
  if (!Number.isSafeInteger(Number(seq)) || Number(seq) < 1) return null;
  const rows = await db.query(`SELECT ${COLUMNS} FROM tickets t WHERE t.code=?`, [codeOf(Number(seq))]);
  return detailed(rows[0]);
}

// รายการคำร้อง (ใหม่ก่อน) กรองตามสิทธิ์ใน SQL
//   userId: ของนักศึกษาคนนั้น | units: [{faculty_id, department_id}] ของ Staff | ไม่ส่ง = ทั้งหมด (Admin)
//   q / type / status: ตัวกรองบนหน้าเว็บ
async function list({ userId, units, q, type, status } = {}) {
  const where = [];
  const args = [];

  if (userId) {
    where.push("t.user_id=?");
    args.push(userId);
  }

  if (units) {
    if (!units.length) return [];
    where.push("(" + units.map(() => "(t.faculty_id=? AND t.department_id=?)").join(" OR ") + ")");
    for (const u of units) args.push(u.faculty_id, u.department_id);
  }

  if (type) {
    where.push("t.type=?");
    args.push(type);
  }

  if (status) {
    where.push("t.status=?");
    args.push(status);
  }

  const keyword = String(q || "").trim().toLowerCase();
  if (keyword) {
    where.push("(LOWER(t.title) LIKE ? OR t.code LIKE ?)");
    args.push(`%${keyword}%`, `%${keyword}%`);
  }

  const rows = await db.query(
    `SELECT ${COLUMNS} FROM tickets t` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY t.created_at DESC, t.code DESC",
    args
  );

  return rows.map((row) => toView(row));
}

// Staff/Admin เปลี่ยนสถานะ/ข้อความ — บันทึกประวัติใน ticket_updates
async function update(ticketId, { status, note, actorId }) {
  if (!STATUSES.includes(status)) db.fail("สถานะคำร้องไม่ถูกต้อง");
  if (typeof note !== "string" || note.length > 5000) db.fail("ข้อความเจ้าหน้าที่ต้องไม่เกิน 5000 ตัวอักษร");

  const current = await findById(ticketId);
  if (!current) db.fail("ไม่พบคำร้อง", 404);

  const statusChanged = current.status !== status;
  const noteChanged = current.note !== note;
  if (!statusChanged && !noteChanged) return { ticket: current, statusChanged, noteChanged };

  const at = db.now();

  await db.transaction(async (run) => {
    await run(
      "UPDATE tickets SET status=?, note=?, updated_at=?, resolved_at=? WHERE id=?",
      [status, note, at, status === "เสร็จสิ้น" ? at : null, ticketId]
    );
    await run(
      "INSERT INTO ticket_updates(id,ticket_id,user_id,status,message,created_at) VALUES(?,?,?,?,?,?)",
      [db.id(), ticketId, actorId, status, note || (statusChanged ? `เปลี่ยนสถานะเป็น ${status}` : ""), at]
    );
  });

  return { ticket: await findById(ticketId), statusChanged, noteChanged };
}

// Admin แก้สถานที่ (หน้า FAQ) — ไม่เปลี่ยนสถานะ/เนื้อหา
async function updateLocation(ticketId, place) {
  if (!place?.complete) db.fail("ข้อมูลสถานที่ไม่ครบ");
  await db.query(
    "UPDATE tickets SET faculty_id=?, location=?, building=?, room=?, place_detail=?, updated_at=? WHERE id=?",
    [place.facultyId, place.label, place.building || "", place.room || null, place.placeDetail || null, db.now(), ticketId]
  );
  return findById(ticketId);
}

async function count() {
  const rows = await db.query("SELECT COUNT(*) AS n FROM tickets");
  return Number(rows[0]?.n ?? 0);
}

module.exports = {
  create, findById, findBySeq, list, update, updateLocation, count, seqOf, codeOf, toView,
};
