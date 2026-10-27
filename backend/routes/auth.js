// routes/auth.js — เข้า/ออกจากระบบ (หน้าเว็บ KIDHEN เสมอ)
//
//   AUTH_MODE=local   : ฟอร์ม /signin ตรวจกับตาราง users (บัญชีทดลองใน SQLite พิมพ์ username ได้ เช่น user / 1234)
//   AUTH_MODE=cognito : ฟอร์ม /signin ส่งอีเมล/รหัสผ่านไป Cognito API จากฝั่ง server
//                       ปุ่ม Google → /auth/google → หน้า Google โดยตรง → /auth/callback
//                       ตั้งรหัสใหม่ครั้งแรก (/signin/new-password) + ลืมรหัสผ่าน (/forgot) อยู่ในเว็บเอง
//                       เข้าด้วย Google ครั้งแรก (ยังไม่มีรหัสผ่าน) → บังคับตั้งรหัสที่ /auth/set-password
//                       เพื่อให้ครั้งต่อไปกรอกอีเมล/รหัสผ่านในหน้าแรกได้ด้วย (service/cognito-password.js)
//   AUTH_MODE=alb     : ALB ล็อกอินให้ก่อน (หน้า Cognito) — /login, /signin แค่ส่งต่อไปหน้าแรกของ role

const express = require("express");
const crypto = require("node:crypto");
const router = express.Router();

const config = require("../config");
const users = require("../repo/users");
const devSeed = require("../repo/dev-seed");
const { HOME, startSession } = require("../auth/session-user");
const { cognitoLogoutUrl, ALB_COOKIES } = require("../auth/alb");
const { cognitoAuth, thaiMessage } = require("../auth/cognito");
const { cognitoPassword } = require("../service/cognito-password");

const MODE = config.auth.mode;
const alb = MODE === "alb";
const cognito = MODE === "cognito";

const BASE_URL = () => config.appBaseUrl.replace(/\/+$/, "");
const CALLBACK = () => `${BASE_URL()}/auth/callback`;

const str = (v) => (typeof v === "string" ? v : "");

// บัญชีทดลอง แสดงใต้ฟอร์ม: ในเครื่อง (local + SQLite) หรือบน AWS เมื่อเปิด SEED_TEST_ACCOUNTS=true
function devHint() {
  const show = (MODE === "local" && devSeed.allowed()) || (cognito && devSeed.testAccountsEnabled());
  return show
    ? devSeed.DEV_ACCOUNTS.map((a) => ({ username: a.username, email: a.email, role: a.role }))
    : [];
}

function view(extra = {}) {
  return {
    error: null,
    notice: null,
    login: "",
    devAccounts: devHint(),
    devPassword: cognito ? "รหัสผ่านดูในเอกสารบัญชีทดลอง" : `รหัสผ่าน ${devSeed.DEV_PASSWORD}`,
    authMode: MODE,
    googleEnabled: cognito,
    ...extra,
  };
}

function goHome(req, res) {
  return res.redirect(HOME[req.session.user.role] || "/login");
}

// ผู้ใช้จาก Cognito → ตาราง users (sync role จากกลุ่ม) → เริ่ม session
async function finishCognitoLogin(req, res, identity, via) {
  const user = await users.syncFromCognito(identity);
  if (!user.active) {
    return res.status(403).render("auth/signin", view({ error: "บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ" }));
  }
  await startSession(req, user, identity.sub, via);
  res.redirect(HOME[user.role]);
}

router.get("/", (req, res) => {
  if (req.session.user) return goHome(req, res);
  res.redirect("/login");
});

router.get("/login", (req, res) => {
  if (req.session.user) return goHome(req, res);
  res.render("auth/login", view({ notice: req.query.out === "1" ? "ออกจากระบบแล้ว" : null }));
});

router.get("/signin", (req, res) => {
  if (alb || req.session.user) return res.redirect("/");
  res.render("auth/signin", view({
    notice: req.query.reset === "1" ? "ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบ" : null,
    error: req.query.error ? str(req.query.error).slice(0, 200) : null,
  }));
});

router.post("/signin", async (req, res, next) => {
  if (alb) return res.redirect("/");

  let login = str(req.body.username).trim().toLowerCase();
  const password = str(req.body.password);

  try {
    if (cognito) {
      // บัญชีทดลอง (SEED_TEST_ACCOUNTS=true): พิมพ์ username ได้ เช่น admin, staff01
      if (!login.includes("@")) login = devSeed.emailForDevUsername(login) || login;
      if (!login.includes("@")) {
        return res.status(401).render("auth/signin", view({ error: "กรุณากรอกอีเมล", login }));
      }

      let result;
      try {
        result = await cognitoAuth().signIn(login, password);
      } catch (error) {
        if (error.name === "PasswordResetRequiredException") {
          return res.redirect(`/forgot?email=${encodeURIComponent(login)}&required=1`);
        }
        console.warn("[auth] Cognito sign-in:", error.name || error.code, error.message);
        return res.status(401).render("auth/signin", view({ error: thaiMessage(error), login }));
      }

      // บัญชีที่ Admin สร้าง (รหัสชั่วคราว) ต้องตั้งรหัสใหม่ก่อน — ทำในหน้าเว็บ
      if (result.challenge) {
        req.session.pendingChallenge = { ...result.challenge, email: login, at: Date.now() };
        return req.session.save(() => res.redirect("/signin/new-password"));
      }

      return await finishCognitoLogin(req, res, result.identity, "password");
    }

    // ---------- local ----------
    // พิมพ์อีเมล หรือ username ของบัญชีทดลอง (user, staff01, admin ...) ก็ได้
    const email = login.includes("@") ? login : devSeed.emailForDevUsername(login);
    const user = email ? await users.authenticate(email, password) : null;

    if (!user) {
      return res.status(401).render("auth/signin", view({
        error: "อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง",
        login,
      }));
    }

    await startSession(req, user);
    res.redirect(HOME[user.role]);
  } catch (error) {
    next(error);
  }
});

// ---------- ตั้งรหัสผ่านใหม่ครั้งแรก (cognito) ----------
const CHALLENGE_TTL = 3 * 60 * 1000; // Session ของ Cognito ใช้ได้ 3 นาที

function pending(req) {
  const p = req.session.pendingChallenge;
  return p && Date.now() - p.at < CHALLENGE_TTL ? p : null;
}

router.get("/signin/new-password", (req, res) => {
  if (!cognito) return res.redirect("/signin");
  const p = pending(req);
  if (!p) return res.redirect("/signin?error=" + encodeURIComponent("หมดเวลา กรุณาเข้าสู่ระบบอีกครั้ง"));
  res.render("auth/new-password", view({ email: p.email }));
});

router.post("/signin/new-password", async (req, res, next) => {
  if (!cognito) return res.redirect("/signin");
  const p = pending(req);
  if (!p) return res.redirect("/signin?error=" + encodeURIComponent("หมดเวลา กรุณาเข้าสู่ระบบอีกครั้ง"));

  const password = str(req.body.password);
  if (password !== str(req.body.confirm)) {
    return res.status(400).render("auth/new-password", view({ email: p.email, error: "รหัสผ่านทั้งสองช่องไม่ตรงกัน" }));
  }

  try {
    let result;
    try {
      result = await cognitoAuth().completeNewPassword(p, password);
    } catch (error) {
      console.warn("[auth] Cognito new password:", error.name || error.code, error.message);
      return res.status(400).render("auth/new-password", view({ email: p.email, error: thaiMessage(error) }));
    }
    delete req.session.pendingChallenge;
    await finishCognitoLogin(req, res, result.identity, "password");
  } catch (error) {
    next(error);
  }
});

// ---------- ลืมรหัสผ่าน (cognito) ----------
router.get("/forgot", (req, res) => {
  if (!cognito) return res.redirect("/signin");
  res.render("auth/forgot", view({
    step: "request",
    email: str(req.query.email),
    notice: req.query.required === "1" ? "บัญชีนี้ต้องตั้งรหัสผ่านใหม่ ระบบจะส่งรหัสยืนยันไปที่อีเมล" : null,
  }));
});

router.post("/forgot", async (req, res) => {
  if (!cognito) return res.redirect("/signin");
  const email = str(req.body.email).trim().toLowerCase();

  try {
    await cognitoAuth().forgotPassword(email);
  } catch (error) {
    // ไม่บอกว่าอีเมลมีจริงหรือไม่ ยกเว้นทำบ่อยเกิน/ไม่มีอีเมลยืนยัน
    if (["LimitExceededException", "TooManyRequestsException", "InvalidParameterException"].includes(error.name)) {
      return res.status(400).render("auth/forgot", view({ step: "request", email, error: thaiMessage(error) }));
    }
    console.warn("[auth] Cognito forgot:", error.name || error.code, error.message);
  }

  res.render("auth/forgot", view({
    step: "confirm",
    email,
    notice: "ถ้ามีบัญชีนี้ ระบบส่งรหัสยืนยัน 6 หลักไปที่อีเมลแล้ว (ตรวจในกล่องจดหมายขยะด้วย)",
  }));
});

router.post("/forgot/confirm", async (req, res) => {
  if (!cognito) return res.redirect("/signin");
  const email = str(req.body.email).trim().toLowerCase();
  const password = str(req.body.password);

  if (password !== str(req.body.confirm)) {
    return res.status(400).render("auth/forgot", view({ step: "confirm", email, error: "รหัสผ่านทั้งสองช่องไม่ตรงกัน" }));
  }

  try {
    await cognitoAuth().confirmForgotPassword(email, str(req.body.code), password);
    res.redirect("/signin?reset=1");
  } catch (error) {
    console.warn("[auth] Cognito confirm forgot:", error.name || error.code, error.message);
    res.status(400).render("auth/forgot", view({ step: "confirm", email, error: thaiMessage(error) }));
  }
});

// ---------- Google (cognito) ----------
router.get("/auth/google", (req, res) => {
  if (!cognito) return res.redirect("/login");

  // กันการปลอมคำตอบ: state สุ่มเก็บใน session แล้วตรวจตอนกลับมา
  req.session.oauthState = crypto.randomBytes(24).toString("hex");
  req.session.save(() =>
    res.redirect(cognitoAuth().googleUrl({ redirectUri: CALLBACK(), state: req.session.oauthState }))
  );
});

router.get("/auth/callback", async (req, res, next) => {
  if (!cognito) return res.redirect("/login");

  const fail = (message) =>
    res.status(401).render("auth/login", view({ error: message }));

  // ปฏิเสธจาก Cognito/Lambda trigger เช่น อีเมลไม่ใช่ @kmitl.ac.th
  if (req.query.error) {
    const detail = str(req.query.error_description);
    console.warn("[auth] Google callback error:", req.query.error, detail);
    // แยกสาเหตุ (เดิมจับ "PreSignUp" ทุกกรณีเป็นเรื่องโดเมน ทำให้ข้อความผิด)
    //   - Lambda pre sign-up ปฏิเสธโดเมน (ข้อความจาก cognito_triggers/app.py)
    //   - ครั้งแรกที่รวมบัญชี Google เข้ากับบัญชีที่ Admin สร้าง Cognito แจ้ง error หนึ่งครั้ง → กดใหม่ก็เข้าได้
    let message = "เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่";
    if (/already found an entry|already exists/i.test(detail)) {
      message = "เชื่อมบัญชี Google กับบัญชีที่ Admin สร้างไว้แล้ว กรุณากด Continue with Google อีกครั้ง";
    } else if (/อนุญาตเฉพาะอีเมล|domain/i.test(detail)) {
      message = "ใช้ได้เฉพาะบัญชี Google ของสถาบัน (@kmitl.ac.th) หรืออีเมลที่ Admin เพิ่มไว้แล้ว";
    }
    return fail(message);
  }

  const state = str(req.query.state);
  const expected = req.session.oauthState;
  delete req.session.oauthState;

  if (!expected || state.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return fail("การเข้าสู่ระบบหมดเวลาหรือไม่ถูกต้อง กรุณากดปุ่ม Google อีกครั้ง");
  }

  try {
    let result;
    try {
      result = await cognitoAuth().exchangeCode({ code: str(req.query.code), redirectUri: CALLBACK() });
    } catch (error) {
      console.warn("[auth] Google token:", error.message);
      return fail("เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่");
    }

    // ครั้งแรกที่เข้าด้วย Google (ยังไม่มีรหัสผ่าน) → บังคับตั้งรหัสก่อนเข้าใช้งาน
    // (บัญชีที่ Admin ปิดไว้ไม่ต้องถาม — finishCognitoLogin ปฏิเสธเอง)
    let mustSetPassword = false;
    try {
      const existing = await users.findByEmail(result.identity.email);
      mustSetPassword = (!existing || existing.active) && await cognitoPassword().needsPassword(result.identity);
    } catch (error) {
      // ตรวจไม่ได้ (เช่น LabRole ไม่มีสิทธิ์ ListUsers) → ไม่ขวางการเข้าใช้งาน
      console.warn("[auth] ตรวจบัญชีรหัสผ่านไม่สำเร็จ:", error.name || error.code, error.message);
    }
    if (mustSetPassword) {
      req.session.pendingGoogle = { identity: result.identity, at: Date.now() };
      return req.session.save(() => res.redirect("/auth/set-password"));
    }

    await finishCognitoLogin(req, res, result.identity, "google");
  } catch (error) {
    next(error);
  }
});

// ---------- ตั้งรหัสผ่านครั้งแรกหลังเข้าด้วย Google (cognito) ----------
const GOOGLE_PENDING_TTL = 15 * 60 * 1000;

function pendingGoogle(req) {
  const p = req.session.pendingGoogle;
  return p && Date.now() - p.at < GOOGLE_PENDING_TTL ? p : null;
}

router.get("/auth/set-password", (req, res) => {
  if (!cognito) return res.redirect("/login");
  const p = pendingGoogle(req);
  if (!p) return res.redirect("/login");
  res.render("auth/set-password", view({ email: p.identity.email }));
});

router.post("/auth/set-password", async (req, res, next) => {
  if (!cognito) return res.redirect("/login");
  const p = pendingGoogle(req);
  if (!p) {
    return res.status(401).render("auth/login", view({ error: "หมดเวลา กรุณากดปุ่ม Google อีกครั้ง" }));
  }

  const password = str(req.body.password);
  const again = (status, error) =>
    res.status(status).render("auth/set-password", view({ email: p.identity.email, error }));

  if (password !== str(req.body.confirm)) return again(400, "รหัสผ่านทั้งสองช่องไม่ตรงกัน");

  try {
    let result;
    try {
      result = await cognitoPassword().setPasswordForGoogleUser(p.identity, password);
    } catch (error) {
      console.warn("[auth] ตั้งรหัสผ่านบัญชี Google:", error.name || error.code, error.message);
      if (error.name === "InvalidPasswordException" || error.name === "InvalidParameterException") {
        return again(400, thaiMessage({ name: "InvalidPasswordException" }));
      }
      return again(500, "ตั้งรหัสผ่านไม่สำเร็จ กรุณาลองใหม่หรือติดต่อผู้ดูแลระบบ");
    }

    delete req.session.pendingGoogle;
    // role ตามกลุ่มของบัญชีรหัสผ่าน (เช่น Admin เพิ่มไว้เป็น Staff แต่บัญชี Google เดิมเป็น User)
    const groups = Array.isArray(result?.groups) && result.groups.length ? result.groups : p.identity.groups;
    await finishCognitoLogin(req, res, { ...p.identity, groups }, "google");
  } catch (error) {
    next(error);
  }
});

// ---------- ออกจากระบบ: กลับหน้า login ของเว็บเสมอ ----------
router.get("/logout", (req, res, next) => {
  const via = req.session.user?.via;

  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("kidhen.sid");

    if (cognito) {
      // เข้าด้วย Google: ต้องออกจาก session ของ Cognito ด้วย ไม่งั้นกด Google ครั้งหน้าจะเข้าเลยโดยไม่ถาม
      // (Cognito แค่ redirect กลับมา ไม่แสดงหน้าใด ๆ)
      if (via === "google") return res.redirect(cognitoAuth().logoutUrl(`${BASE_URL()}/login`));
      return res.redirect("/login?out=1");
    }

    if (!alb) return res.redirect("/login?out=1");

    // โหมด alb: ลบ cookie ของ ALB + ออกจาก Cognito ด้วย ไม่งั้น ALB จะพากลับเข้าระบบทันที
    for (const name of ALB_COOKIES) {
      res.cookie(name, "", { expires: new Date(0), path: "/", secure: true, httpOnly: true });
    }

    const url = cognitoLogoutUrl({
      domain: config.cognito.domain,
      clientId: config.cognito.clientId,
      logoutUri: `${BASE_URL()}/login`,
    });

    res.redirect(url || "/login");
  });
});

module.exports = router;
