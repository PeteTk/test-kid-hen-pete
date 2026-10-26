// routes/auth.js — เข้า/ออกจากระบบ
//
// แก้ (3b-2): ไม่ใช้ mockUsers แล้ว
//   AUTH_MODE=local : ฟอร์ม /signin ตรวจอีเมล + รหัสผ่านกับตาราง users
//                     (บัญชีทดลองใน SQLite พิมพ์ username เดิมได้ เช่น user / 1234)
//   AUTH_MODE=alb   : ALB ล็อกอิน Cognito ให้ก่อนถึงเว็บ (Hosted UI: Google หรืออีเมล/รหัสผ่าน)
//                     หน้า /login, /signin จึงแค่ส่งต่อไปหน้าแรกของ role

const express = require("express");
const router = express.Router();

const config = require("../config");
const users = require("../repo/users");
const devSeed = require("../repo/dev-seed");
const { HOME, startSession } = require("../auth/session-user");
const { cognitoLogoutUrl, ALB_COOKIES } = require("../auth/alb");

const alb = config.auth.mode === "alb";

// บัญชีทดลอง แสดงใต้ฟอร์มเฉพาะตอนพัฒนา (SQLite + ไม่ใช่ production)
function devHint() {
  return !alb && devSeed.allowed()
    ? devSeed.DEV_ACCOUNTS.map((a) => ({ username: a.username, email: a.email, role: a.role }))
    : [];
}

function goHome(req, res) {
  return res.redirect(HOME[req.session.user.role] || "/login");
}

router.get("/", (req, res) => {
  if (req.session.user) return goHome(req, res);
  res.redirect("/login");
});

router.get("/login", (req, res) => {
  if (req.session.user) return goHome(req, res);
  res.render("auth/login", { devAccounts: devHint() });
});

router.get("/signin", (req, res) => {
  if (alb || req.session.user) return res.redirect("/");
  res.render("auth/signin", { error: null, login: "", devAccounts: devHint() });
});

router.post("/signin", async (req, res, next) => {
  if (alb) return res.redirect("/");

  // ป้องกันค่าที่ไม่ใช่ข้อความ
  const login =
    typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";

  try {
    // พิมพ์อีเมล หรือ username ของบัญชีทดลอง (user, staff, admin ...) ก็ได้
    const email = login.includes("@") ? login : devSeed.emailForDevUsername(login);
    const user = email ? await users.authenticate(email, password) : null;

    if (!user) {
      return res.status(401).render("auth/signin", {
        error: "อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง",
        login,
        devAccounts: devHint(),
      });
    }

    await startSession(req, user);
    res.redirect(HOME[user.role]);
  } catch (error) {
    next(error);
  }
});

router.get("/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("kidhen.sid");

    if (!alb) return res.redirect("/login");

    // โหมด alb: ลบ cookie ของ ALB + ออกจาก Cognito ด้วย ไม่งั้น ALB จะพากลับเข้าระบบทันที
    for (const name of ALB_COOKIES) {
      res.cookie(name, "", { expires: new Date(0), path: "/", secure: true, httpOnly: true });
    }

    const url = cognitoLogoutUrl({
      domain: config.cognito.domain,
      clientId: config.cognito.clientId,
      logoutUri: `${config.appBaseUrl.replace(/\/+$/, "")}/login`,
    });

    res.redirect(url || "/login");
  });
});

module.exports = router;
