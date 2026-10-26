// แก้: app.js ตั้งค่าเว็บอย่างเดียว
// ย้ายการเปิดพอร์ตไป server.js

const express = require("express");
const session = require("express-session");
const path = require("path");

const config = require("./config");

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const staffRoutes = require("./routes/staff");
const userRoutes = require("./routes/user");
const profileRoutes = require("./routes/profile");
const notificationRoutes = require("./routes/notifications");

const faqRoutes = require("./routes/faq");

const issueRoutes = require("./routes/ai");

// แก้ (3b-2): ผู้ใช้มาจากตาราง users, session เก็บในตาราง sessions
const { SqlSessionStore } = require("./session-store");
const { createUserMiddleware } = require("./auth/middleware");
const { createAlbVerifier } = require("./auth/alb");

const app = express();

// อยู่หลัง ALB (HTTPS จบที่ ALB) → เชื่อ X-Forwarded-Proto เพื่อให้ cookie secure ทำงาน
app.set("trust proxy", 1);

// ค่า environment อ่านและตรวจที่ config.js ที่เดียว
// (รวมการตรวจ SESSION_SECRET ≥ 32 ตัวอักษรใน production ที่เคยอยู่ตรงนี้)

// Health check ให้ ALB ตรวจเว็บได้โดยไม่ต้อง login
// (ประกาศก่อน session/middleware อื่น เพื่อไม่ให้ถูก redirect หรือแตะ session)
// /health = ชื่อที่ Terraform ใช้เป็นค่าเริ่มต้น, /healthz = ชื่อเดิมของเว็บ
app.get(["/health", "/healthz"], (req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.use("/internal/ai", require("./routes/ai-job"));

// ตั้งค่า EJS
app.set("view engine", "ejs");
app.set(
  "views",
  path.join(__dirname, "../frontend/views")
);

// ไฟล์ CSS, รูป และ JavaScript
app.use(
  express.static(
    path.join(__dirname, "../frontend/public")
  )
);

// ของเดิม: อ่านข้อมูลจาก HTML form
app.use(express.urlencoded({ extended: true }));

// แก้ (3b-2): session เก็บในตาราง sessions (EC2 ทุกเครื่องเห็นเหมือนกัน → ปิด sticky ที่ ALB ได้)
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000; // 8 ชม. เท่ากับ session_timeout ของ ALB

const sessionStore = new SqlSessionStore({ ttlMs: SESSION_MAX_AGE });
app.locals.sessionStore = sessionStore;

app.use(
  session({
    name: "kidhen.sid",
    secret: config.sessionSecret,
    store: sessionStore,

    resave: false,
    saveUninitialized: false,
    rolling: true,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // ส่ง cookie เฉพาะ HTTPS เมื่อเว็บเปิดผ่าน https (kid-hen.app) — http://localhost / ALB แบบไม่มี domain ใช้ได้ด้วย
      secure: config.appBaseUrl.startsWith("https://"),
      maxAge: SESSION_MAX_AGE,
    },
  })
);

// แก้ (3b-2): ระบุตัวผู้ใช้จาก DB (local) หรือจาก header ของ ALB/Cognito (alb)
// แล้วเตรียมข้อมูล topbar/sidebar (currentUser, currentAvatar, unreadCount)
const alb =
  config.auth.mode === "alb"
    ? createAlbVerifier({
        region: config.aws.region,
        albArn: config.auth.albArn,
        issuer: config.cognito.issuer,
        clientId: config.cognito.clientId,
      })
    : null;

app.use(createUserMiddleware({ mode: config.auth.mode, alb }));

app.use("/admin/faq", faqRoutes);

app.use("/user/issues", issueRoutes);

app.use("/", authRoutes);
app.use("/admin", adminRoutes);
app.use("/staff", staffRoutes);
app.use("/profile", profileRoutes);
app.use("/notifications", notificationRoutes);
app.use("/user", userRoutes);

app.use((error, req, res, next) => {
  console.error("[HTTP]", error.message);

  if (res.headersSent) {
    return next(error);
  }

  const status = error.status || 500;

  res.status(status).type("text").send(
    status < 500
      ? error.message
      : "ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง"
  );
});

module.exports = app;