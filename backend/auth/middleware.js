// auth/middleware.js — ระบุตัวผู้ใช้ทุก request (แทน middleware เดิมใน app.js ที่อ่าน mockUsers)
//
// โหมด local: อ่าน req.session.user.id ที่ได้จากฟอร์ม /signin
// โหมด alb  : ตรวจ header ของ ALB ทุก request; ถ้ายังไม่มี session หรือเปลี่ยนคน
//             = "login" → sync ผู้ใช้/role จาก Cognito ลงตาราง users แล้วเริ่ม session ใหม่
// ทั้งสองโหมด: โหลดผู้ใช้จาก DB ใหม่ทุก request (เปลี่ยน role/ลบบัญชี มีผลทันที)

const users = require("../repo/users");
const notifications = require("../repo/notifications");
const { sessionUser, startSession, avatarUrl } = require("./session-user");

function plain(res, status, message) {
  return res.status(status).type("text").send(message);
}

function createUserMiddleware({ mode, alb }) {
  return async function loadUser(req, res, next) {
    try {
      // /logout ต้องใช้ได้เสมอ แม้ token ของ ALB เสีย/หมดอายุ (ไม่งั้นติดอยู่หน้า 401)
      if (mode === "alb" && req.path === "/logout") return next();

      if (mode === "alb") {
        let identity;
        try {
          identity = await alb.identify(req.headers);
        } catch (error) {
          console.warn("[auth] ตรวจ header ALB ไม่ผ่าน:", error.message);
          return plain(res, 401, "ยืนยันตัวตนไม่สำเร็จ กรุณาออกจากระบบที่ /logout แล้วเข้าใหม่");
        }

        if (!identity) {
          return plain(res, 401, "ต้องเข้าเว็บผ่าน Load Balancer ที่ล็อกอิน Cognito (https://<domain>)");
        }

        if (req.session.user?.sub !== identity.sub) {
          const user = await users.syncFromCognito(identity);
          if (!user.active) {
            return plain(res, 403, "บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ");
          }
          await startSession(req, user, identity.sub);
        }
      }

      let account = null;

      if (req.session.user) {
        account = await users.findById(req.session.user.id);

        // บัญชีถูกลบ/ปิด: session เดิมใช้ต่อไม่ได้
        if (!account || !account.active) {
          return req.session.destroy((error) => {
            if (error) return next(error);
            if (mode === "alb") {
              return plain(res, 403, "บัญชีนี้ถูกปิดการใช้งานหรือถูกลบ กรุณาติดต่อผู้ดูแลระบบ");
            }
            res.redirect("/login");
          });
        }

        // เปลี่ยนชื่อ/role มีผลใน request นี้เลย
        req.session.user = sessionUser(account, req.session.user.sub ?? null);
        req.account = account;
      }

      res.locals.currentUser = req.session.user || null;
      res.locals.currentAvatar = avatarUrl(account);
      res.locals.authMode = mode;

      // แก้ (3c): จำนวนแจ้งเตือนที่ยังไม่อ่านจากตาราง notifications
      res.locals.unreadCount = account ? await notifications.unreadCount(account.id) : 0;

      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createUserMiddleware };
