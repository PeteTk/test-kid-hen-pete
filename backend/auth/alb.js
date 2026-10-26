// auth/alb.js — อ่านตัวตนผู้ใช้จาก header ที่ ALB ใส่มาหลังล็อกอิน Cognito (โหมด AUTH_MODE=alb)
//
// ตาม diagram: Cognito → ALB (listener 443: authenticate-cognito) → EC2
// ALB ส่ง header มาให้ทุก request:
//   x-amzn-oidc-data        = JWT (ES256) ที่ ALB เซ็นเอง: sub, email, name ...
//   x-amzn-oidc-accesstoken = access token ของ Cognito (RS256): มี claim "cognito:groups"
//
// ต้องตรวจลายเซ็นทั้งคู่ — ถ้าไม่ตรวจ ใครยิงตรงเข้า EC2 แล้วปลอม header ก็จะเป็น Admin ได้
// (EC2 อยู่ private subnet และ SG รับจาก ALB เท่านั้น แต่ตรวจซ้ำอีกชั้นตามคำแนะนำของ AWS)
//
// ไม่ใช้ไลบรารีเพิ่ม: ใช้ node:crypto ตรวจ ES256/RS256 เอง

const crypto = require("node:crypto");

function authError(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

// ALB ใส่ padding "=" ใน JWT (ผิดมาตรฐานเล็กน้อย) — Buffer "base64" รับได้ทั้ง base64 และ base64url
function decodePart(part) {
  return Buffer.from(String(part).replace(/=+$/, ""), "base64");
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw authError("รูปแบบ token ไม่ถูกต้อง");

  let header;
  let payload;
  try {
    header = JSON.parse(decodePart(parts[0]).toString("utf8"));
    payload = JSON.parse(decodePart(parts[1]).toString("utf8"));
  } catch {
    throw authError("อ่าน token ไม่ได้");
  }

  return {
    header,
    payload,
    signed: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: decodePart(parts[2]),
  };
}

function checkExpiry(payload, nowMs, skewSec = 60) {
  const now = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== "number" || payload.exp + skewSec < now) {
    throw authError("token หมดอายุ");
  }
  if (typeof payload.nbf === "number" && payload.nbf - skewSec > now) {
    throw authError("token ยังไม่ถึงเวลาใช้");
  }
}

async function defaultFetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`โหลด ${url} ไม่สำเร็จ (${response.status})`);
  return response.text();
}

// สร้างตัวตรวจ (แยกเป็น factory เพื่อให้ test ใส่ key ปลอมได้โดยไม่ต้องต่อ AWS)
function createAlbVerifier({
  region,
  albArn = "",
  issuer,
  clientId,
  fetchText = defaultFetchText,
  now = () => Date.now(),
}) {
  if (!region) throw new Error("ต้องมี AWS_REGION");
  if (!issuer) throw new Error("ต้องมี COGNITO_ISSUER");
  if (!clientId) throw new Error("ต้องมี COGNITO_CLIENT_ID");

  const albKeys = new Map(); // kid → KeyObject (public key ของ ALB ไม่เปลี่ยนต่อ kid)
  let jwks = new Map(); // kid → KeyObject (ของ Cognito user pool)
  let jwksLoadedAt = 0;

  async function albKey(kid) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(String(kid || ""))) throw authError("kid ไม่ถูกต้อง");
    if (!albKeys.has(kid)) {
      const pem = await fetchText(
        `https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`
      );
      albKeys.set(kid, crypto.createPublicKey(pem));
    }
    return albKeys.get(kid);
  }

  async function cognitoKey(kid) {
    // โหลดใหม่เมื่อไม่พบ kid (Cognito หมุน key) แต่ไม่เกินนาทีละครั้ง
    if (!jwks.has(kid) && now() - jwksLoadedAt > 60_000) {
      const body = JSON.parse(await fetchText(`${issuer}/.well-known/jwks.json`));
      jwks = new Map(
        (body.keys || []).map((jwk) => [jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" })])
      );
      jwksLoadedAt = now();
    }
    const key = jwks.get(kid);
    if (!key) throw authError("ไม่พบ key ของ Cognito");
    return key;
  }

  // x-amzn-oidc-data (ES256, เซ็นโดย ALB)
  async function verifyOidcData(token) {
    const jwt = parseJwt(token);

    if (jwt.header.alg !== "ES256") throw authError("alg ไม่ถูกต้อง");
    if (albArn && jwt.header.signer !== albArn) throw authError("token ไม่ได้มาจาก ALB ของระบบนี้");
    if (jwt.header.client && jwt.header.client !== clientId) throw authError("client ไม่ตรง");

    const ok = crypto.verify(
      "sha256",
      jwt.signed,
      { key: await albKey(jwt.header.kid), dsaEncoding: "ieee-p1363" },
      jwt.signature
    );
    if (!ok) throw authError("ลายเซ็นไม่ถูกต้อง");

    checkExpiry(jwt.payload, now());
    if (jwt.payload.iss && jwt.payload.iss !== issuer) throw authError("issuer ไม่ตรง");
    if (!jwt.payload.sub) throw authError("token ไม่มี sub");

    return jwt.payload;
  }

  // x-amzn-oidc-accesstoken (RS256, เซ็นโดย Cognito)
  async function verifyAccessToken(token) {
    const jwt = parseJwt(token);

    if (jwt.header.alg !== "RS256") throw authError("alg ไม่ถูกต้อง");

    const ok = crypto.verify("sha256", jwt.signed, await cognitoKey(jwt.header.kid), jwt.signature);
    if (!ok) throw authError("ลายเซ็นไม่ถูกต้อง");

    checkExpiry(jwt.payload, now());
    if (jwt.payload.iss !== issuer) throw authError("issuer ไม่ตรง");
    if (jwt.payload.token_use !== "access") throw authError("ไม่ใช่ access token");
    if (jwt.payload.client_id !== clientId) throw authError("client ไม่ตรง");

    return jwt.payload;
  }

  // คืน { sub, email, name, groups } หรือ null ถ้าไม่มี header (ไม่ได้ผ่าน ALB)
  async function identify(headers) {
    const data = headers["x-amzn-oidc-data"];
    if (!data) return null;

    const claims = await verifyOidcData(data);

    const accessToken = headers["x-amzn-oidc-accesstoken"];
    const access = accessToken ? await verifyAccessToken(accessToken) : null;

    // access token ต้องเป็นของคนเดียวกัน
    if (access && access.sub !== claims.sub) throw authError("token ไม่ใช่ผู้ใช้คนเดียวกัน");

    return {
      sub: claims.sub,
      email: String(claims.email || "").toLowerCase(),
      name: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" "),
      groups: access?.["cognito:groups"] || [],
    };
  }

  return { identify, verifyOidcData, verifyAccessToken };
}

// cookie ของ ALB ที่ต้องลบตอน logout (ALB แบ่ง cookie เป็นหลายชิ้นถ้ายาว)
const ALB_COOKIES = [0, 1, 2, 3].map((i) => `AWSELBAuthSessionCookie-${i}`);

// URL ออกจากระบบของ Cognito Hosted UI แล้วกลับมาที่ logoutUri
function cognitoLogoutUrl({ domain, clientId, logoutUri }) {
  const host = String(domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host || !clientId || !logoutUri) return null;

  const query = new URLSearchParams({ client_id: clientId, logout_uri: logoutUri });
  return `https://${host}/logout?${query}`;
}

module.exports = { createAlbVerifier, parseJwt, cognitoLogoutUrl, ALB_COOKIES };
