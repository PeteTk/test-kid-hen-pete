// auth/cognito.js — ล็อกอินผ่าน Cognito จากหน้าเว็บ KIDHEN เอง (AUTH_MODE=cognito) ไม่แสดงหน้า Hosted UI ของ Cognito
//
//   อีเมล + รหัสผ่าน : เว็บเรียก Cognito API (InitiateAuth / USER_PASSWORD_AUTH + SECRET_HASH) จากฝั่ง server
//                     ครั้งแรกของบัญชีที่ Admin สร้าง (รหัสชั่วคราว) → หน้า "ตั้งรหัสผ่านใหม่" ของเว็บ
//                     ลืมรหัสผ่าน → ForgotPassword / ConfirmForgotPassword (Cognito ส่งรหัสยืนยันทางอีเมล)
//   Google          : พาไป /oauth2/authorize?identity_provider=Google ตรง ๆ (ข้ามหน้าเลือกของ Cognito ไปหน้า Google เลย)
//                     → Google ส่งกลับ /auth/callback → เว็บแลก code เป็น token ด้วย client secret
//   ทุกทาง: ตรวจลายเซ็น ID token (RS256, JWKS ของ user pool) แล้วอ่าน email + "cognito:groups"
//
// API ฝั่งผู้ใช้เหล่านี้ไม่ต้องใช้สิทธิ์ IAM (ไม่พึ่ง LabRole)

const crypto = require("node:crypto");
const { parseJwt } = require("./alb");

function authError(message, code = "AuthError") {
  const error = new Error(message);
  error.status = 401;
  error.code = code;
  return error;
}

// ข้อความภาษาไทยของ error จาก Cognito
function thaiMessage(error) {
  const name = error?.name || error?.code || "";
  const text = String(error?.message || "");

  if (name === "NotAuthorizedException") {
    if (/disabled/i.test(text)) return "บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ";
    if (/attempts exceeded/i.test(text)) return "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่";
    if (/temporary password has expired/i.test(text)) return "รหัสผ่านชั่วคราวหมดอายุ กรุณาให้ Admin ส่งรหัสใหม่";
    return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  }
  if (name === "UserNotFoundException") return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  if (name === "UserNotConfirmedException") return "บัญชียังไม่ได้ยืนยันอีเมล";
  if (name === "InvalidPasswordException") {
    return "รหัสผ่านต้องมีอย่างน้อย 8 ตัว และมีตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก และตัวเลข";
  }
  if (name === "CodeMismatchException") return "รหัสยืนยันไม่ถูกต้อง";
  if (name === "ExpiredCodeException") return "รหัสยืนยันหมดอายุ กรุณาขอรหัสใหม่";
  if (name === "LimitExceededException" || name === "TooManyRequestsException") {
    return "ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่";
  }
  if (name === "InvalidParameterException" && /no registered\/verified email/i.test(text)) {
    return "บัญชีนี้ยังไม่มีอีเมลที่ยืนยันแล้ว กรุณาติดต่อผู้ดูแลระบบ";
  }
  if (name === "PasswordResetRequiredException") return "ต้องตั้งรหัสผ่านใหม่ก่อน";
  return "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่";
}

async function defaultFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
}

function createCognitoAuth({
  region,
  userPoolId,
  clientId,
  clientSecret = "",
  domain,
  issuer,
  client, // ใส่ client ปลอมตอนทดสอบ
  fetchImpl = defaultFetch,
  now = () => Date.now(),
}) {
  for (const [name, value] of Object.entries({ region, userPoolId, clientId, domain, issuer })) {
    if (!value) throw new Error(`AUTH_MODE=cognito ต้องมี ${name}`);
  }

  const host = String(domain).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let sdk = null;
  let jwks = new Map();
  let jwksLoadedAt = 0;

  function api() {
    if (!sdk) {
      const lib = require("@aws-sdk/client-cognito-identity-provider");
      sdk = { lib, client: client || new lib.CognitoIdentityProviderClient({ region }) };
    }
    return sdk;
  }

  async function send(name, input) {
    const { lib, client } = api();
    return client.send(new lib[`${name}Command`](input));
  }

  // App Client มี secret → ทุกคำขอที่ระบุ username ต้องแนบ SECRET_HASH
  function secretHash(username) {
    if (!clientSecret) return undefined;
    return crypto.createHmac("sha256", clientSecret).update(username + clientId).digest("base64");
  }

  function withSecret(username, params) {
    const hash = secretHash(username);
    return hash ? { ...params, SECRET_HASH: hash } : params;
  }

  // ---------- ตรวจ ID token ----------
  async function key(kid) {
    if (!jwks.has(kid) && now() - jwksLoadedAt > 60_000) {
      const response = await fetchImpl(`${issuer}/.well-known/jwks.json`);
      if (!response.ok) throw new Error(`โหลด JWKS ไม่สำเร็จ (${response.status})`);
      const body = await response.json();
      jwks = new Map(
        (body.keys || []).map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" })])
      );
      jwksLoadedAt = now();
    }
    const found = jwks.get(kid);
    if (!found) throw authError("ไม่พบ key ของ Cognito");
    return found;
  }

  async function verifyIdToken(idToken) {
    const jwt = parseJwt(idToken);
    if (jwt.header.alg !== "RS256") throw authError("alg ไม่ถูกต้อง");
    if (!crypto.verify("sha256", jwt.signed, await key(jwt.header.kid), jwt.signature)) {
      throw authError("ลายเซ็น token ไม่ถูกต้อง");
    }

    const p = jwt.payload;
    const sec = Math.floor(now() / 1000);
    if (typeof p.exp !== "number" || p.exp + 60 < sec) throw authError("token หมดอายุ");
    if (p.iss !== issuer) throw authError("issuer ไม่ตรง");
    if (p.aud !== clientId) throw authError("client ไม่ตรง");
    if (p.token_use !== "id") throw authError("ไม่ใช่ ID token");
    if (!p.email) throw authError("token ไม่มีอีเมล");

    return {
      sub: p.sub,
      email: String(p.email).toLowerCase(),
      name: p.name || [p.given_name, p.family_name].filter(Boolean).join(" "),
      groups: p["cognito:groups"] || [],
    };
  }

  // ---------- อีเมล + รหัสผ่าน ----------
  // คืน { identity } เมื่อสำเร็จ หรือ { challenge: { username, session } } เมื่อต้องตั้งรหัสใหม่
  async function signIn(email, password) {
    const username = String(email || "").trim().toLowerCase();
    const result = await send("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: withSecret(username, { USERNAME: username, PASSWORD: String(password || "") }),
    });

    if (result.AuthenticationResult?.IdToken) {
      return { identity: await verifyIdToken(result.AuthenticationResult.IdToken) };
    }

    if (result.ChallengeName === "NEW_PASSWORD_REQUIRED") {
      // SECRET_HASH ของขั้นถัดไปต้องใช้ username จริงของ Cognito (USER_ID_FOR_SRP) ไม่ใช่อีเมล
      const realUsername = result.ChallengeParameters?.USER_ID_FOR_SRP || username;
      return { challenge: { name: result.ChallengeName, username: realUsername, session: result.Session } };
    }

    throw authError(`ขั้นตอนเพิ่มเติมที่ยังไม่รองรับ: ${result.ChallengeName || "unknown"}`, "UnsupportedChallenge");
  }

  async function completeNewPassword({ username, session }, newPassword) {
    const result = await send("RespondToAuthChallenge", {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: clientId,
      Session: session,
      ChallengeResponses: withSecret(username, { USERNAME: username, NEW_PASSWORD: String(newPassword || "") }),
    });

    if (!result.AuthenticationResult?.IdToken) {
      throw authError("ตั้งรหัสผ่านใหม่ไม่สำเร็จ", "UnsupportedChallenge");
    }
    return { identity: await verifyIdToken(result.AuthenticationResult.IdToken) };
  }

  async function forgotPassword(email) {
    const username = String(email || "").trim().toLowerCase();
    await send("ForgotPassword", {
      ClientId: clientId,
      Username: username,
      ...(clientSecret ? { SecretHash: secretHash(username) } : {}),
    });
  }

  async function confirmForgotPassword(email, code, newPassword) {
    const username = String(email || "").trim().toLowerCase();
    await send("ConfirmForgotPassword", {
      ClientId: clientId,
      Username: username,
      ConfirmationCode: String(code || "").trim(),
      Password: String(newPassword || ""),
      ...(clientSecret ? { SecretHash: secretHash(username) } : {}),
    });
  }

  // ---------- Google (ผ่าน Cognito แต่ไม่แสดงหน้า Cognito) ----------
  function googleUrl({ redirectUri, state }) {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid email profile",
      identity_provider: "Google",
      state,
    });
    return `https://${host}/oauth2/authorize?${query}`;
  }

  async function exchangeCode({ code, redirectUri }) {
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (clientSecret) {
      headers.authorization = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    }

    const response = await fetchImpl(`https://${host}/oauth2/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: String(code || ""),
        redirect_uri: redirectUri,
      }).toString(),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.id_token) {
      throw authError(`แลก code ไม่สำเร็จ: ${body.error || response.status}`, "TokenExchangeFailed");
    }
    return { identity: await verifyIdToken(body.id_token) };
  }

  // ออกจาก session ของ Cognito (สำหรับคนที่เข้าด้วย Google) แล้วกลับหน้า login ของเว็บ — ไม่แสดงหน้า Cognito
  function logoutUrl(logoutUri) {
    const query = new URLSearchParams({ client_id: clientId, logout_uri: logoutUri });
    return `https://${host}/logout?${query}`;
  }

  return {
    signIn, completeNewPassword, forgotPassword, confirmForgotPassword,
    googleUrl, exchangeCode, logoutUrl, verifyIdToken, secretHash,
  };
}

// ตัวที่แอปใช้ (สร้างเมื่อเรียกครั้งแรก) — test เปลี่ยนเป็นตัวปลอมได้ด้วย use()
let instance = null;

function cognitoAuth() {
  if (!instance) {
    const config = require("../config");
    instance = createCognitoAuth({
      region: config.aws.region,
      userPoolId: config.cognito.userPoolId,
      clientId: config.cognito.clientId,
      clientSecret: config.cognito.clientSecret,
      domain: config.cognito.domain,
      issuer: config.cognito.issuer,
    });
  }
  return instance;
}

function use(fake) {
  instance = fake;
}

module.exports = { createCognitoAuth, cognitoAuth, use, thaiMessage };
