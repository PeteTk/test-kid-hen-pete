// ทดสอบ AUTH_MODE=cognito (ล็อกอินที่หน้าเว็บเอง ไม่ผ่านหน้า Cognito) ด้วย Cognito ปลอม — ไม่ต้องต่อ AWS
//   อีเมล/รหัสผ่าน (SECRET_HASH), ตั้งรหัสใหม่ครั้งแรก, ลืมรหัสผ่าน, Google (state + แลก code), ตรวจ ID token, logout
// รัน: SQLITE_PATH=:memory: node --no-warnings test/cognito.test.js
process.env.SQLITE_PATH = ":memory:";
process.env.DB_DRIVER = "sqlite";
process.env.AUTH_MODE = "cognito";
process.env.EVENTS_MODE = "local";
process.env.AWS_REGION = "us-east-1";
process.env.COGNITO_USER_POOL_ID = "us-east-1_TEST";
process.env.COGNITO_CLIENT_ID = "client123";
process.env.COGNITO_CLIENT_SECRET = "secret456";
process.env.COGNITO_DOMAIN = "kid-hen.auth.us-east-1.amazoncognito.com";
process.env.COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST";
process.env.APP_BASE_URL = "http://127.0.0.1";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const db = require("../db");
const users = require("../repo/users");
const cognito = require("../auth/cognito");
const app = require("../app");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

const ISSUER = process.env.COGNITO_ISSUER;
const CLIENT = "client123";
const SECRET = "secret456";
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function idToken(claims, { key = pair.privateKey } = {}) {
  const h = b64({ alg: "RS256", kid: "k1" });
  const p = b64({
    iss: ISSUER, aud: CLIENT, token_use: "id", exp: Math.floor(Date.now() / 1000) + 3600, ...claims,
  });
  const s = crypto.sign("sha256", Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${s}`;
}

const expectedHash = (username) =>
  crypto.createHmac("sha256", SECRET).update(username + CLIENT).digest("base64");

// ---------- Cognito ปลอม ----------
// บัญชี: อีเมล → { password, groups, temp (ต้องตั้งรหัสใหม่), sub }
const accounts = {
  "67070054@kmitl.ac.th": { password: "Admin1234", groups: ["Admin"], sub: "sub-admin" },
  "staff01@kmitl.ac.th": { password: "Temp1234", groups: ["Staff"], sub: "sub-staff", temp: true },
  "off@kmitl.ac.th": { password: "Off12345", groups: ["User"], sub: "sub-off", disabled: true },
};
const calls = [];
const codes = new Map(); // code ของ Google → id token

function cognitoError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const fakeClient = {
  async send(command) {
    const name = command.constructor.name.replace(/Command$/, "");
    const input = command.input;
    calls.push([name, input]);

    if (name === "InitiateAuth") {
      const { USERNAME, PASSWORD, SECRET_HASH } = input.AuthParameters;
      assert.equal(SECRET_HASH, expectedHash(USERNAME), "SECRET_HASH ของ InitiateAuth");
      const a = accounts[USERNAME];
      if (!a || a.password !== PASSWORD) throw cognitoError("NotAuthorizedException", "Incorrect username or password.");
      if (a.disabled) throw cognitoError("NotAuthorizedException", "User is disabled.");
      if (a.temp) {
        return { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "sess-1", ChallengeParameters: { USER_ID_FOR_SRP: a.sub } };
      }
      return { AuthenticationResult: { IdToken: idToken({ sub: a.sub, email: USERNAME, "cognito:groups": a.groups }) } };
    }

    if (name === "RespondToAuthChallenge") {
      const { USERNAME, NEW_PASSWORD, SECRET_HASH } = input.ChallengeResponses;
      assert.equal(USERNAME, "sub-staff", "ใช้ USER_ID_FOR_SRP");
      assert.equal(SECRET_HASH, expectedHash("sub-staff"));
      assert.equal(input.Session, "sess-1");
      if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(NEW_PASSWORD)) {
        throw cognitoError("InvalidPasswordException", "Password does not conform to policy");
      }
      accounts["staff01@kmitl.ac.th"] = { ...accounts["staff01@kmitl.ac.th"], temp: false, password: NEW_PASSWORD };
      return { AuthenticationResult: { IdToken: idToken({ sub: "sub-staff", email: "staff01@kmitl.ac.th", "cognito:groups": ["Staff"] }) } };
    }

    if (name === "ForgotPassword") {
      assert.equal(input.SecretHash, expectedHash(input.Username));
      return {};
    }

    if (name === "ConfirmForgotPassword") {
      assert.equal(input.SecretHash, expectedHash(input.Username));
      if (input.ConfirmationCode !== "123456") throw cognitoError("CodeMismatchException");
      accounts[input.Username] = { ...accounts[input.Username], password: input.Password };
      return {};
    }

    throw new Error("unexpected " + name);
  },
};

async function fakeFetch(url, options = {}) {
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

  if (url === `${ISSUER}/.well-known/jwks.json`) {
    return json(200, { keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] });
  }

  if (url === "https://kid-hen.auth.us-east-1.amazoncognito.com/oauth2/token") {
    assert.equal(options.headers.authorization, "Basic " + Buffer.from(`${CLIENT}:${SECRET}`).toString("base64"));
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("redirect_uri"), `${process.env.APP_BASE_URL}/auth/callback`);
    const token = codes.get(form.get("code"));
    return token ? json(200, { id_token: token }) : json(400, { error: "invalid_grant" });
  }

  throw new Error("unexpected url " + url);
}

const auth = cognito.createCognitoAuth({
  region: "us-east-1", userPoolId: "us-east-1_TEST", clientId: CLIENT, clientSecret: SECRET,
  domain: process.env.COGNITO_DOMAIN, issuer: ISSUER, client: fakeClient, fetchImpl: fakeFetch,
});
cognito.use(auth);

let base;
function browser() {
  let cookie = "";
  async function go(path, { method = "GET", form } = {}) {
    const headers = cookie ? { cookie } : {};
    let body;
    if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const r = await fetch(base + path, { method, redirect: "manual", headers, body });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, location: r.headers.get("location"), body: await r.text() };
  }
  return { get: (p) => go(p), post: (p, form) => go(p, { method: "POST", form }) };
}

(async () => {
  await db.init();

  // ===== ตัว auth/cognito.js =====
  await check("SECRET_HASH = HMAC-SHA256(secret, username + clientId) base64", async () => {
    assert.equal(auth.secretHash("a@b.c"), expectedHash("a@b.c"));
  });

  await check("ID token: ถูกต้อง → อีเมล/กลุ่ม, ผิด aud/iss/ประเภท/หมดอายุ/ลายเซ็น → ปฏิเสธ", async () => {
    const id = await auth.verifyIdToken(idToken({ sub: "s", email: "X@KMITL.ac.th", "cognito:groups": ["Staff"] }));
    assert.deepEqual(id, { sub: "s", email: "x@kmitl.ac.th", name: "", groups: ["Staff"] });

    const bad = [
      idToken({ sub: "s", email: "a@b.c", aud: "other" }),
      idToken({ sub: "s", email: "a@b.c", iss: "https://evil" }),
      idToken({ sub: "s", email: "a@b.c", token_use: "access" }),
      idToken({ sub: "s", email: "a@b.c", exp: Math.floor(Date.now() / 1000) - 3600 }),
      idToken({ sub: "s", email: "a@b.c" }, { key: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }),
    ];
    for (const token of bad) await assert.rejects(auth.verifyIdToken(token), (e) => e.status === 401);
  });

  await check("URL Google ข้ามหน้า Cognito (identity_provider=Google) และ logout กลับหน้าเว็บ", async () => {
    const url = new URL(auth.googleUrl({ redirectUri: "https://kid-hen.app/auth/callback", state: "abc" }));
    assert.equal(url.host, "kid-hen.auth.us-east-1.amazoncognito.com");
    assert.equal(url.pathname, "/oauth2/authorize");
    assert.equal(url.searchParams.get("identity_provider"), "Google");
    assert.equal(url.searchParams.get("state"), "abc");
    const out = new URL(auth.logoutUrl("https://kid-hen.app/login"));
    assert.equal(out.searchParams.get("logout_uri"), "https://kid-hen.app/login");
  });

  await check("ข้อความ error เป็นภาษาไทย", async () => {
    assert.match(cognito.thaiMessage(cognitoError("NotAuthorizedException", "User is disabled.")), /ปิดการใช้งาน/);
    assert.match(cognito.thaiMessage(cognitoError("InvalidPasswordException")), /8 ตัว/);
    assert.match(cognito.thaiMessage(cognitoError("CodeMismatchException")), /รหัสยืนยัน/);
  });

  // ===== ผ่านหน้าเว็บ =====
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    await check("หน้า login/signin ของเว็บ: ปุ่ม Google ชี้ /auth/google, ไม่มีบัญชีทดลอง, มีลืมรหัสผ่าน", async () => {
      const b = browser();
      const login = await b.get("/login");
      assert.equal(login.status, 200);
      assert.match(login.body, /href="\/auth\/google"/);
      assert.doesNotMatch(login.body, /บัญชีทดลอง/);
      assert.match((await b.get("/signin")).body, /href="\/forgot"/);
    });

    await check("อีเมล + รหัสผ่าน: Admin จากกลุ่ม Cognito → สร้างผู้ใช้ใน DB → /admin/dashboard", async () => {
      const b = browser();
      const r = await b.post("/signin", { username: "67070054@KMITL.ac.th", password: "Admin1234" });
      assert.equal(r.location, "/admin/dashboard");
      assert.equal((await users.findByEmail("67070054@kmitl.ac.th")).role, "ADMIN");
      assert.equal((await b.get("/admin/dashboard")).status, 200);
      // logout (รหัสผ่าน) → กลับหน้า login ของเว็บ ไม่ไป Cognito
      assert.equal((await b.get("/logout")).location, "/login?out=1");
      assert.equal((await b.get("/admin/dashboard")).location, "/login");
    });

    await check("รหัสผิด / บัญชีปิด / ไม่ใช่อีเมล → อยู่หน้าเว็บพร้อมข้อความไทย", async () => {
      const b = browser();
      let r = await b.post("/signin", { username: "67070054@kmitl.ac.th", password: "wrong" });
      assert.equal(r.status, 401);
      assert.match(r.body, /อีเมลหรือรหัสผ่านไม่ถูกต้อง/);
      r = await b.post("/signin", { username: "off@kmitl.ac.th", password: "Off12345" });
      assert.match(r.body, /ปิดการใช้งาน/);
      r = await b.post("/signin", { username: "user01", password: "1234" });
      assert.match(r.body, /กรุณากรอกอีเมล/);
    });

    await check("รหัสชั่วคราว → หน้าตั้งรหัสใหม่ของเว็บ → รหัสไม่ตรง/ไม่ผ่านนโยบาย → สำเร็จเข้า Staff", async () => {
      const b = browser();
      const r = await b.post("/signin", { username: "staff01@kmitl.ac.th", password: "Temp1234" });
      assert.equal(r.location, "/signin/new-password");
      assert.match((await b.get("/signin/new-password")).body, /staff01@kmitl\.ac\.th/);

      let x = await b.post("/signin/new-password", { password: "NewPass123", confirm: "Other123" });
      assert.match(x.body, /ไม่ตรงกัน/);
      x = await b.post("/signin/new-password", { password: "short", confirm: "short" });
      assert.match(x.body, /8 ตัว/);
      x = await b.post("/signin/new-password", { password: "NewPass123", confirm: "NewPass123" });
      assert.equal(x.location, "/staff/dashboard");
      assert.equal((await users.findByEmail("staff01@kmitl.ac.th")).role, "STAFF");

      // ไม่มี challenge ค้าง → กลับหน้า signin
      assert.match((await browser().get("/signin/new-password")).location, /^\/signin\?error=/);
    });

    await check("ลืมรหัสผ่าน: ขอรหัส → รหัสผิด → ถูก → เข้าด้วยรหัสใหม่ได้", async () => {
      const b = browser();
      let r = await b.post("/forgot", { email: "67070054@kmitl.ac.th" });
      assert.match(r.body, /รหัสยืนยัน/);
      r = await b.post("/forgot/confirm", { email: "67070054@kmitl.ac.th", code: "000000", password: "Brand1234", confirm: "Brand1234" });
      assert.match(r.body, /รหัสยืนยันไม่ถูกต้อง/);
      r = await b.post("/forgot/confirm", { email: "67070054@kmitl.ac.th", code: "123456", password: "Brand1234", confirm: "Brand1234" });
      assert.equal(r.location, "/signin?reset=1");
      assert.match((await b.get("/signin?reset=1")).body, /ตั้งรหัสผ่านใหม่แล้ว/);
      assert.equal((await b.post("/signin", { username: "67070054@kmitl.ac.th", password: "Brand1234" })).location, "/admin/dashboard");
    });

    await check("Google: /auth/google → state → callback แลก code → นักศึกษา USER + คณะจากรหัส → logout ผ่าน Cognito กลับ /login", async () => {
      const b = browser();
      const start = await b.get("/auth/google");
      const url = new URL(start.location);
      assert.equal(url.searchParams.get("identity_provider"), "Google");
      const state = url.searchParams.get("state");

      codes.set("code-ok", idToken({ sub: "Google_1", email: "67050001@kmitl.ac.th", name: "นศ. วิทย์", "cognito:groups": ["User"] }));
      const cb = await b.get(`/auth/callback?code=code-ok&state=${state}`);
      assert.equal(cb.location, "/user/home");
      const me = await users.findByEmail("67050001@kmitl.ac.th");
      assert.equal(me.role, "USER");
      assert.equal(me.faculty_id, "05");

      const out = await b.get("/logout");
      const logout = new URL(out.location);
      assert.equal(logout.pathname, "/logout");
      assert.equal(logout.searchParams.get("logout_uri"), `${process.env.APP_BASE_URL}/login`);
    });

    await check("Google: state ผิด/ไม่มี, code ผิด, อีเมลนอกสถาบัน → ไม่เข้า + ข้อความไทย", async () => {
      const b = browser();
      let r = await b.get("/auth/callback?code=code-ok&state=forged");
      assert.equal(r.status, 401);
      assert.match(r.body, /หมดเวลาหรือไม่ถูกต้อง/);

      const start = await b.get("/auth/google");
      const state = new URL(start.location).searchParams.get("state");
      r = await b.get(`/auth/callback?code=nope&state=${state}`);
      assert.match(r.body, /Google ไม่สำเร็จ/);

      r = await b.get("/auth/callback?error=access_denied&error_description=" +
        encodeURIComponent("PreSignUp failed with error อนุญาตเฉพาะอีเมล @kmitl.ac.th."));
      assert.match(r.body, /@kmitl\.ac\.th/);
    });
  } finally {
    server.close();
    app.locals.sessionStore?.close();
  }

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
  await db.close();
})().catch((error) => {
  console.error("\n✗ ไม่ผ่าน:", error);
  process.exit(1);
});
