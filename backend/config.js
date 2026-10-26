// config.js — จุดเดียวที่อ่านค่า environment ของระบบ
//
// บน AWS: systemd โหลด /etc/kidhen.env ให้เอง (ดู templates/user_data.sh.tpl ฝั่ง Terraform)
// ในเครื่อง: โหลด backend/.env ถ้ามี (ดูตัวอย่างที่ .env.example)
// ค่าที่ตั้งไว้ใน environment จริงจะชนะค่าใน .env เสมอ

const fs = require("node:fs");
const path = require("node:path");

const envPath = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const env = process.env;

// อ่านข้อความ ตัดช่องว่าง ถ้าว่างใช้ค่าสำรอง
function str(name, fallback = "") {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

const production = str("NODE_ENV") === "production";

const config = {
  production,

  port: Number(str("PORT", "3000")),

  // URL ที่ผู้ใช้เข้าเว็บ (ใช้ทำลิงก์/redirect)
  appBaseUrl: str("APP_BASE_URL"),
  healthCheckPath: str("HEALTH_CHECK_PATH", "/health"),

  sessionSecret: str("SESSION_SECRET", "kidhen-dev-secret"),

  // วิธีเข้าสู่ระบบ
  //   local   = ฟอร์มอีเมล/username + รหัสผ่าน จากตาราง users (ในเครื่อง, บัญชีทดลองมีเฉพาะ SQLite)
  //   cognito = หน้า login ของเว็บเอง เรียก Cognito API / Google ผ่าน Cognito (ไม่แสดงหน้า Cognito) — บน AWS
  //   alb     = ALB ล็อกอิน Cognito ให้ก่อน (แสดงหน้า Hosted UI ของ Cognito) แล้วเว็บอ่าน header x-amzn-oidc-*
  auth: {
    mode: str("AUTH_MODE", production ? "alb" : "local"),
    // ARN ของ ALB: ถ้าตั้ง จะตรวจว่า token ถูกเซ็นโดย ALB ตัวนี้เท่านั้น (Terraform ส่งให้)
    albArn: str("ALB_ARN"),
  },

  db: {
    driver: str("DB_DRIVER", "sqlite"), // "mysql" เมื่อใช้ RDS
    host: str("DB_HOST"),
    port: Number(str("DB_PORT", "3306")),
    name: str("DB_NAME"),
    user: str("DB_USER"),
    password: env.DB_PASSWORD ?? "", // ไม่ trim: รหัสผ่านอาจมีช่องว่าง
    ssl: str("DB_SSL") === "true",
    sqlitePath: str("SQLITE_PATH"),
  },

  aws: {
    region: str("AWS_REGION", "us-east-1"),
    s3Bucket: str("S3_BUCKET"),
    snsTopicArn: str("SNS_TOPIC_ARN"),
    // ต้องตรงกับ Source ของ EventBridge rule ใน Terraform (event_source)
    eventSource: str("EVENT_SOURCE", "kidhen.app"),
  },

  // เพิ่ม (3c): สถานะคำร้องเปลี่ยน → eventbridge (PutEvents → Lambda status.py) หรือ local (เขียนแจ้งเตือนเอง)
  events: {
    mode: str("EVENTS_MODE", production ? "eventbridge" : "local"),
  },

  cognito: {
    userPoolId: str("COGNITO_USER_POOL_ID"),
    clientId: str("COGNITO_CLIENT_ID"),
    clientSecret: str("COGNITO_CLIENT_SECRET"),
    domain: str("COGNITO_DOMAIN"),
    issuer: str("COGNITO_ISSUER"),
  },

  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    model: str("GEMINI_MODEL"),
    timeoutMs: Number(str("AI_TIMEOUT_MS", "60000")),
  },
};

// ตรวจค่าที่ขาด/ผิดรูปแบบ แล้วรายงานทั้งหมดในครั้งเดียว
// (ถ้าเว็บล้มตอนบูต ดูสาเหตุจาก /var/log/kidhen-app.log ได้ทันที)
function validate(cfg) {
  const errors = [];

  if (
    !Number.isInteger(cfg.port) ||
    cfg.port < 1 ||
    cfg.port > 65535
  ) {
    errors.push("PORT ต้องเป็นตัวเลขระหว่าง 1–65535");
  }

  if (!["local", "eventbridge"].includes(cfg.events.mode)) {
    errors.push('EVENTS_MODE ต้องเป็น "local" หรือ "eventbridge"');
  }

  if (!["local", "cognito", "alb"].includes(cfg.auth.mode)) {
    errors.push('AUTH_MODE ต้องเป็น "local", "cognito" หรือ "alb"');
  }

  // โหมด cognito ต้องรู้ pool/client/domain/issuer และ URL ของเว็บ (ใช้ทำ redirect_uri ของ Google)
  if (cfg.auth.mode === "cognito") {
    const need = {
      COGNITO_USER_POOL_ID: cfg.cognito.userPoolId,
      COGNITO_CLIENT_ID: cfg.cognito.clientId,
      COGNITO_DOMAIN: cfg.cognito.domain,
      COGNITO_ISSUER: cfg.cognito.issuer,
      APP_BASE_URL: cfg.appBaseUrl,
    };
    for (const [name, value] of Object.entries(need)) {
      if (!value) errors.push(`AUTH_MODE=cognito ต้องมี ${name}`);
    }
  }

  // โหมด alb ต้องรู้ issuer/client เพื่อตรวจ token (ใช้ได้ในเครื่องด้วย เช่นทดสอบ header ปลอม)
  if (cfg.auth.mode === "alb") {
    if (!cfg.cognito.issuer) errors.push("AUTH_MODE=alb ต้องมี COGNITO_ISSUER");
    if (!cfg.cognito.clientId) errors.push("AUTH_MODE=alb ต้องมี COGNITO_CLIENT_ID");
  }

  if (!cfg.production) {
    return errors;
  }



  // ----- เฉพาะ production -----
  if (cfg.sessionSecret.length < 32) {
    errors.push("SESSION_SECRET ต้องมีอย่างน้อย 32 ตัวอักษร");
  }

  if (cfg.db.driver !== "mysql") {
    errors.push('DB_DRIVER ต้องเป็น "mysql" (production ห้ามใช้ SQLite)');
  }

  const required = {
    DB_HOST: cfg.db.host,
    DB_NAME: cfg.db.name,
    DB_USER: cfg.db.user,
    DB_PASSWORD: cfg.db.password,
    APP_BASE_URL: cfg.appBaseUrl,
    S3_BUCKET: cfg.aws.s3Bucket,
    COGNITO_USER_POOL_ID: cfg.cognito.userPoolId,
    COGNITO_CLIENT_ID: cfg.cognito.clientId,
  };

  for (const [name, value] of Object.entries(required)) {
    if (!value) errors.push(`ขาด ${name}`);
  }

  return errors;
}

const errors = validate(config);

if (errors.length) {
  throw new Error(
    "ตั้งค่า environment ไม่ครบ:\n - " + errors.join("\n - ")
  );
}

// เตือนค่าที่ไม่บังคับ แต่ฟีเจอร์นั้นจะใช้ไม่ได้ถ้าไม่ตั้ง
if (production) {
  // ตาม diagram ต้องเป็น Cognito → ALB; โหมด local บน RDS ไม่มีบัญชีทดลอง จึงล็อกอินไม่ได้
  // (ยอมให้บูตได้ เพื่อทดสอบ ALB/ASG ตอนยังไม่เปิด domain โดยไม่ให้ health check ล้มวน)
  if (config.auth.mode === "local") {
    console.warn(
      "[config] AUTH_MODE=" + config.auth.mode +
        " บน production: ไม่มีบัญชีทดลองบน RDS จึงล็อกอินไม่ได้ — ใช้ AUTH_MODE=cognito (Terraform ตั้งให้เมื่อเปิด enable_custom_domain)"
    );
  }

  if (!config.aws.snsTopicArn) {
    console.warn("[config] ไม่มี SNS_TOPIC_ARN: จะส่งอีเมลแจ้งเตือนไม่ได้");
  }

  if (!config.gemini.apiKey) {
    console.warn("[config] ไม่มี GEMINI_API_KEY: ฟีเจอร์ AI จะใช้ไม่ได้");
  }
}

module.exports = Object.freeze(config);
