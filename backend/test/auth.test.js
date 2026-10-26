// ทดสอบการเข้าสู่ระบบขั้น 3b-2 โดยไม่ต้องต่อ AWS
//   - ตรวจ JWT ของ ALB (ES256) + access token ของ Cognito (RS256) ด้วย key ที่สร้างขึ้นในเครื่อง
//   - middleware โหมด alb: สร้างผู้ใช้/sync role ตอน login, บัญชีที่ปิดใช้งานเข้าไม่ได้
//   - session เก็บในตาราง sessions, role จากกลุ่ม Cognito, ย้ายกลุ่ม Cognito (client ปลอม)
// รัน: SQLITE_PATH=:memory: node --no-warnings test/auth.test.js
process.env.SQLITE_PATH = ":memory:";
process.env.DB_DRIVER = "sqlite";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");

const db = require("../db");
const users = require("../repo/users");
const { createAlbVerifier, cognitoLogoutUrl } = require("../auth/alb");
const { createUserMiddleware } = require("../auth/middleware");
const { SqlSessionStore } = require("../session-store");
const { createCognitoGroups } = require("../service/cognito-groups");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

// ---------- key ปลอม แทน ALB และ Cognito ----------
const REGION = "us-east-1";
const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST";
const CLIENT_ID = "testclient";
const ALB_ARN = "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/kidhen-dev-alb/abc";

const albPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const cognitoPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ALB_KID = "alb-kid-1";
const COGNITO_KID = "cognito-kid-1";

const fetched = [];
async function fetchText(url) {
  fetched.push(url);
  if (url === `https://public-keys.auth.elb.${REGION}.amazonaws.com/${ALB_KID}`) {
    return albPair.publicKey.export({ type: "spki", format: "pem" });
  }
  if (url === `${ISSUER}/.well-known/jwks.json`) {
    const jwk = cognitoPair.publicKey.export({ format: "jwk" });
    return JSON.stringify({ keys: [{ ...jwk, kid: COGNITO_KID, alg: "RS256", use: "sig" }] });
  }
  throw new Error("unexpected url " + url);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

// ALB ใส่ padding "=" ท้ายแต่ละส่วน — จำลองให้เหมือน
function albToken(payload, header = {}) {
  const pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const h = pad(b64({ alg: "ES256", kid: ALB_KID, signer: ALB_ARN, iss: ISSUER, client: CLIENT_ID, exp: nowSec() + 120, ...header }));
  const p = pad(b64({ iss: ISSUER, exp: nowSec() + 120, ...payload }));
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), {
    key: albPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${h}.${p}.${pad(sig.toString("base64url"))}`;
}

function accessToken(payload, { key = cognitoPair.privateKey } = {}) {
  const h = b64({ alg: "RS256", kid: COGNITO_KID });
  const p = b64({
    iss: ISSUER, token_use: "access", client_id: CLIENT_ID, exp: nowSec() + 3600, ...payload,
  });
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${sig.toString("base64url")}`;
}

function headersFor({ sub, email, name = "ทดสอบ", groups = [] }) {
  return {
    "x-amzn-oidc-data": albToken({ sub, email, name }),
    "x-amzn-oidc-accesstoken": accessToken({ sub, "cognito:groups": groups }),
  };
}

const verifier = createAlbVerifier({
  region: REGION, albArn: ALB_ARN, issuer: ISSUER, clientId: CLIENT_ID, fetchText,
});

async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => error.status === 401 && pattern.test(error.message));
}

// ---------- แอปทดสอบ: session ในตาราง sessions + middleware โหมด alb ----------
function testApp() {
  const app = express();
  app.use(session({
    name: "kidhen.sid", secret: "test-secret", resave: false, saveUninitialized: false,
    store: new SqlSessionStore({ cleanupMs: 0 }),
  }));
  app.use(createUserMiddleware({ mode: "alb", alb: verifier }));
  app.get("/whoami", (req, res) => res.json({ session: req.session.user, role: req.account?.role }));
  return app;
}

async function request(base, path, headers = {}, cookie = "") {
  const response = await fetch(base + path, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  const setCookie = response.headers.get("set-cookie");
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* ข้อความธรรมดา */ }
  return {
    status: response.status, json, body,
    cookie: setCookie ? setCookie.split(";")[0] : cookie,
  };
}

(async () => {
  await db.init();

  // ===== ตัวตรวจ token =====
  await check("token ถูกต้อง → ได้ sub, อีเมล (ตัวเล็ก), ชื่อ, กลุ่ม", async () => {
    const id = await verifier.identify(headersFor({
      sub: "s-1", email: "67070223@KMITL.ac.th", name: "ญาดา", groups: ["Admin"],
    }));
    assert.deepEqual(id, { sub: "s-1", email: "67070223@kmitl.ac.th", name: "ญาดา", groups: ["Admin"] });
  });

  await check("ไม่มี header → null (ไม่ได้ผ่าน ALB)", async () => {
    assert.equal(await verifier.identify({}), null);
  });

  await check("ลายเซ็นถูกแก้ / ALB อื่นเซ็น / หมดอายุ → ปฏิเสธ", async () => {
    const good = albToken({ sub: "s-1", email: "a@b.c" });
    const [h, p, s] = good.split(".");
    const fakePayload = Buffer.from(JSON.stringify({ sub: "s-1", email: "admin@x.y", exp: nowSec() + 99 })).toString("base64url");
    await rejects(verifier.verifyOidcData(`${h}.${fakePayload}.${s}`), /ลายเซ็น/);
    await rejects(verifier.verifyOidcData(albToken({ sub: "x" }, { signer: "arn:other" })), /ALB/);
    await rejects(verifier.verifyOidcData(albToken({ sub: "x", exp: nowSec() - 3600 })), /หมดอายุ/);
    await rejects(verifier.verifyOidcData(albToken({ sub: "x" }, { alg: "HS256" })), /alg/);
  });

  await check("access token: client/issuer/ประเภท/ลายเซ็น/คนละคน → ปฏิเสธ", async () => {
    await rejects(verifier.verifyAccessToken(accessToken({ sub: "s", client_id: "other" })), /client/);
    await rejects(verifier.verifyAccessToken(accessToken({ sub: "s", iss: "https://evil" })), /issuer/);
    await rejects(verifier.verifyAccessToken(accessToken({ sub: "s", token_use: "id" })), /access/);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await rejects(verifier.verifyAccessToken(accessToken({ sub: "s" }, { key: other })), /ลายเซ็น/);
    await rejects(verifier.identify({
      "x-amzn-oidc-data": albToken({ sub: "s-1", email: "a@b.c" }),
      "x-amzn-oidc-accesstoken": accessToken({ sub: "s-2" }),
    }), /คนเดียวกัน/);
  });

  await check("key ของ ALB/Cognito โหลดครั้งเดียวแล้วเก็บ cache", async () => {
    const before = fetched.length;
    await verifier.identify(headersFor({ sub: "s-9", email: "c@d.e" }));
    assert.equal(fetched.length, before);
  });

  await check("role จากกลุ่ม Cognito ใช้สิทธิ์สูงสุด, ไม่มีกลุ่ม = USER", async () => {
    assert.equal(users.roleFromGroups(["User", "Admin"]), "ADMIN");
    assert.equal(users.roleFromGroups(["Staff", "User"]), "STAFF");
    assert.equal(users.roleFromGroups([]), "USER");
    assert.equal(users.roleFromGroups(undefined), "USER");
  });

  await check("logout URL ของ Cognito", async () => {
    assert.equal(
      cognitoLogoutUrl({ domain: "kid-hen.auth.us-east-1.amazoncognito.com", clientId: "c1", logoutUri: "https://kid-hen.app/login" }),
      "https://kid-hen.auth.us-east-1.amazoncognito.com/logout?client_id=c1&logout_uri=https%3A%2F%2Fkid-hen.app%2Flogin"
    );
    assert.equal(cognitoLogoutUrl({ domain: "", clientId: "c1", logoutUri: "x" }), null);
  });

  // ===== middleware โหมด alb ผ่าน HTTP จริง =====
  const server = testApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await check("ไม่มี header ALB → 401", async () => {
      assert.equal((await request(base, "/whoami")).status, 401);
    });

    await check("header ปลอม → 401", async () => {
      const r = await request(base, "/whoami", { "x-amzn-oidc-data": "a.b.c" });
      assert.equal(r.status, 401);
    });

    let cookie;
    await check("login ครั้งแรก: สร้างผู้ใช้ใน DB ตามกลุ่ม Cognito (Admin) + คณะจากรหัสไม่ใช้กับ Admin", async () => {
      const r = await request(base, "/whoami", headersFor({
        sub: "sub-a", email: "67070054@kmitl.ac.th", name: "แอดมิน ตั้งต้น", groups: ["Admin"],
      }));
      assert.equal(r.status, 200);
      assert.equal(r.json.role, "ADMIN");
      assert.equal(r.json.session.email, "67070054@kmitl.ac.th");
      const row = await users.findByEmail("67070054@kmitl.ac.th");
      assert.equal(row.role, "ADMIN");
      assert.equal(row.faculty_id, null);
      cookie = r.cookie;
    });

    await check("ใน session เดิม กลุ่มใน token เปลี่ยนไม่กระทบ (sync เฉพาะตอน login)", async () => {
      const r = await request(base, "/whoami", headersFor({
        sub: "sub-a", email: "67070054@kmitl.ac.th", groups: ["User"],
      }), cookie);
      assert.equal(r.json.role, "ADMIN");
    });

    await check("login ใหม่ (ไม่มี cookie): role ถูก sync จากกลุ่ม Cognito", async () => {
      const r = await request(base, "/whoami", headersFor({
        sub: "sub-a", email: "67070054@kmitl.ac.th", groups: ["Staff"],
      }));
      assert.equal(r.json.role, "STAFF");
      assert.equal((await users.findByEmail("67070054@kmitl.ac.th")).role, "STAFF");
    });

    await check("นักศึกษา login ด้วย Google ครั้งแรก: role USER + คณะจากรหัส", async () => {
      const r = await request(base, "/whoami", headersFor({
        sub: "sub-s", email: "67050111@kmitl.ac.th", groups: ["User"],
      }));
      assert.equal(r.json.role, "USER");
      assert.equal((await users.findByEmail("67050111@kmitl.ac.th")).faculty_id, "05");
    });

    await check("เปลี่ยนคน (sub ต่างจาก session) → เริ่ม session ใหม่เป็นคนใหม่", async () => {
      const r = await request(base, "/whoami", headersFor({
        sub: "sub-s", email: "67050111@kmitl.ac.th", groups: ["User"],
      }), cookie);
      assert.equal(r.json.session.email, "67050111@kmitl.ac.th");
      assert.notEqual(r.cookie, cookie);
    });

    await check("บัญชีที่ปิดใช้งาน (active=0) → 403 ทั้ง login ใหม่และ session เดิม", async () => {
      const first = await request(base, "/whoami", headersFor({ sub: "sub-x", email: "x@kmitl.ac.th" }));
      const user = await users.findByEmail("x@kmitl.ac.th");
      await users.update(user.id, { active: false });
      const again = await request(base, "/whoami", headersFor({ sub: "sub-x", email: "x@kmitl.ac.th" }), first.cookie);
      assert.equal(again.status, 403);
      const fresh = await request(base, "/whoami", headersFor({ sub: "sub-x", email: "x@kmitl.ac.th" }));
      assert.equal(fresh.status, 403);
    });
  } finally {
    server.close();
  }

  // ===== session store =====
  await check("SqlSessionStore: set/get/touch/destroy/หมดอายุ/cleanup/ลบตามผู้ใช้", async () => {
    const store = new SqlSessionStore({ cleanupMs: 0 });
    const call = (fn, ...args) => new Promise((ok, no) => store[fn](...args, (e, v) => (e ? no(e) : ok(v))));
    const future = new Date(Date.now() + 60_000).toISOString();

    await call("set", "s1", { cookie: { expires: future }, user: { id: "u1" } });
    await call("set", "s1", { cookie: { expires: future }, user: { id: "u1" }, n: 2 }); // upsert
    assert.equal((await call("get", "s1")).n, 2);

    await call("set", "old", { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(await call("get", "old"), null);

    await call("set", "s2", { cookie: { expires: future }, user: { id: "u2" } });
    await store.destroyByUserId("u2");
    assert.equal(await call("get", "s2"), null);

    await call("destroy", "s1");
    assert.equal(await call("get", "s1"), null);

    await call("set", "gone", { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
    assert.ok((await store.cleanup()) >= 1);
  });

  // ===== ย้ายกลุ่ม Cognito จากหน้า Admin (client ปลอม) =====
  await check("cognitoGroups.setRole: ออกจากกลุ่ม role เดิม เข้ากลุ่มใหม่ ทุกบัญชีที่อีเมลตรง", async () => {
    const calls = [];
    const groupsOf = { "uuid-native": ["User", "Beta"], "Google_123": ["User"] };
    const client = {
      async send(command) {
        const name = command.constructor.name.replace(/Command$/, "");
        calls.push([name, command.input]);
        if (name === "ListUsers") {
          assert.equal(command.input.Filter, 'email = "67010888@kmitl.ac.th"');
          return { Users: [{ Username: "uuid-native" }, { Username: "Google_123" }] };
        }
        if (name === "AdminListGroupsForUser") {
          return { Groups: groupsOf[command.input.Username].map((g) => ({ GroupName: g })) };
        }
        return {};
      },
    };
    const cg = createCognitoGroups({ userPoolId: "pool", region: REGION, client });
    assert.deepEqual(await cg.setRole("67010888@KMITL.ac.th", "STAFF"), { skipped: false, updated: 2 });

    const changes = calls.filter(([n]) => n.startsWith("AdminAdd") || n.startsWith("AdminRemove"))
      .map(([n, i]) => `${n}:${i.Username}:${i.GroupName}`);
    assert.deepEqual(changes, [
      "AdminRemoveUserFromGroup:uuid-native:User",
      "AdminAddUserToGroup:uuid-native:Staff",
      "AdminRemoveUserFromGroup:Google_123:User",
      "AdminAddUserToGroup:Google_123:Staff",
    ]); // กลุ่ม Beta (ไม่ใช่ role) ไม่ถูกแตะ

    assert.deepEqual(await createCognitoGroups({}).setRole("a@b.c", "ADMIN"), { skipped: true, updated: 0 });
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
  await db.close();
})().catch((error) => {
  console.error("\n✗ ไม่ผ่าน:", error);
  process.exit(1);
});
