// session-store.js — เก็บ express-session ในตาราง sessions (SQLite ในเครื่อง / RDS MySQL บน AWS)
//
// ทำไม: EC2 หลายเครื่องหลัง ALB ต้องเห็น session เดียวกัน (เดิมเก็บใน memory ของแต่ละเครื่อง
// จึงต้องเปิด sticky session) — ใช้ตาราง sessions ที่มีใน schema.sql อยู่แล้ว ไม่ต้องลงแพ็กเกจเพิ่ม

const session = require("express-session");
const db = require("./db");

const DAY_MS = 24 * 60 * 60 * 1000;

// ล้าง session หมดอายุทุก 15 นาที (ทุกเครื่องทำได้ ไม่ชนกัน: DELETE ซ้ำไม่มีผลเสีย)
const CLEANUP_MS = 15 * 60 * 1000;

class SqlSessionStore extends session.Store {
  constructor({ ttlMs = DAY_MS, cleanupMs = CLEANUP_MS } = {}) {
    super();
    this.ttlMs = ttlMs;

    if (cleanupMs > 0) {
      this.timer = setInterval(() => {
        this.cleanup().catch((error) =>
          console.error("[session] ล้าง session หมดอายุไม่สำเร็จ:", error.message)
        );
      }, cleanupMs);
      this.timer.unref(); // ไม่ขวางการปิดโปรแกรม
    }
  }

  expiresAt(sess) {
    const expires = sess?.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + this.ttlMs;
    return new Date(expires).toISOString();
  }

  get(sid, callback) {
    db.query("SELECT data, expires_at FROM sessions WHERE sid=?", [sid])
      .then((rows) => {
        const row = rows[0];
        if (!row) return callback(null, null);

        if (row.expires_at <= new Date().toISOString()) {
          return this.destroy(sid, () => callback(null, null));
        }

        callback(null, JSON.parse(row.data));
      })
      .catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    const data = JSON.stringify(sess);
    const expires = this.expiresAt(sess);

    // upsert คนละรูปแบบระหว่าง MySQL กับ SQLite
    const sql = db.mysql
      ? "INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) " +
        "ON DUPLICATE KEY UPDATE data=VALUES(data), expires_at=VALUES(expires_at)"
      : "INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) " +
        "ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at";

    db.query(sql, [sid, data, expires])
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    db.query("UPDATE sessions SET expires_at=? WHERE sid=?", [this.expiresAt(sess), sid])
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    db.query("DELETE FROM sessions WHERE sid=?", [sid])
      .then(() => callback(null))
      .catch(callback);
  }

  // ใช้ตอนลบผู้ใช้: เตะทุก session ของคนนั้นออก
  async destroyByUserId(userId) {
    const rows = await db.query("SELECT sid, data FROM sessions");
    for (const row of rows) {
      try {
        if (JSON.parse(row.data)?.user?.id === userId) {
          await db.query("DELETE FROM sessions WHERE sid=?", [row.sid]);
        }
      } catch {
        // ข้อมูลเสีย ข้ามไป
      }
    }
  }

  async cleanup() {
    return db.affected(
      await db.query("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()])
    );
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { SqlSessionStore };
