// service/storage.js — ไฟล์แนบคำร้อง + รูปโปรไฟล์ (3d)
//
//   STORAGE_MODE=s3 (บน AWS, Terraform ตั้งให้) — ตาม diagram "Upload / Download ด้วย Pre-signed URL จากเว็บ"
//     อัปโหลด : browser ขอ URL ที่ POST /files/presign → เว็บเซ็น PUT (ชนิดไฟล์ + ขนาดตายตัว, 5 นาที)
//               → browser PUT ไฟล์ตรงไป S3 (ไม่ผ่าน EC2) → ส่งฟอร์มพร้อม key → เว็บตรวจ key (เจ้าของ + HeadObject) แล้วบันทึก
//     ดาวน์โหลด: <img src="/files/<key>"> → เว็บตรวจว่าล็อกอินแล้ว → redirect ไป pre-signed GET (5 นาที)
//     EC2 กี่เครื่องก็เห็นไฟล์ชุดเดียวกัน → ปิด sticky session / ใช้ ASG 2 เครื่องได้
//   STORAGE_MODE=local (ในเครื่อง) — multer เขียนลง frontend/public/uploads เหมือนเดิม
//
// key: requests/<userId>/<เวลา>-<สุ่ม>.<นามสกุล> | avatars/<userId>/<เวลา>-<สุ่ม>.<นามสกุล>
// (ข้อมูลเดิมก่อน 3d เป็น requests/<ไฟล์>, avatars/<ไฟล์> ยังแสดงได้ในโหมด local)

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const config = require("../config");

const UPLOAD_ROOT = path.join(__dirname, "../../frontend/public/uploads");
const URL_TTL = 300; // วินาที

// ชนิดไฟล์ที่รับ + ขนาดสูงสุด + จำนวนสูงสุดต่อฟอร์ม (ตรงกับ multer ในโหมด local)
const KINDS = {
  requests: { maxSize: 5 * 1024 * 1024, maxFiles: 3 },
  avatars: { maxSize: 2 * 1024 * 1024, maxFiles: 1 },
};
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic" };

// key ที่เว็บสร้าง (หรือข้อมูลเดิมก่อน 3d) — ห้าม .. / ตัวอักษรแปลก
const KEY_RE = /^(requests|avatars)\/(?:[0-9a-f-]{36}\/)?[\w-]+(?:\.[a-z0-9]{1,5})?$/i;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function createStorage({ mode = config.storage.mode, bucket = config.aws.s3Bucket, region = config.aws.region, client, sdk: injected } = {}) {
  const s3 = mode === "s3";
  let sdk = injected || null; // test: { lib, getSignedUrl, client }

  function api() {
    if (!sdk) {
      // โหลดเฉพาะโหมด s3 (ในเครื่องไม่ต้องมี AWS SDK ตัวนี้)
      const lib = require("@aws-sdk/client-s3");
      const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
      sdk = { lib, getSignedUrl, client: client || new lib.S3Client({ region }) };
    }
    return sdk;
  }

  const validKey = (key) => typeof key === "string" && KEY_RE.test(key) && !key.includes("..");

  // URL ที่ใส่ใน <img src>
  function url(key) {
    if (!validKey(key)) return "";
    return s3 ? `/files/${key}` : `/uploads/${key}`;
  }

  // ---------- อัปโหลด (s3) ----------
  async function presignUpload({ userId, kind, files }) {
    if (!s3) fail("STORAGE_MODE ไม่ใช่ s3");
    const rule = KINDS[kind];
    if (!rule) fail("ชนิดไฟล์ไม่ถูกต้อง");
    if (!/^[0-9a-f-]{36}$/i.test(String(userId || ""))) fail("ไม่พบผู้ใช้", 401);
    if (!Array.isArray(files) || !files.length || files.length > rule.maxFiles) {
      fail(`แนบได้สูงสุด ${rule.maxFiles} ไฟล์`);
    }

    const { lib, getSignedUrl, client: s3client } = api();
    const out = [];

    for (const file of files) {
      const type = String(file?.type || "").toLowerCase();
      const size = Number(file?.size);
      if (!EXT[type]) fail("ต้องเป็นไฟล์รูป (jpg, png, gif, webp, heic)");
      if (!Number.isInteger(size) || size < 1 || size > rule.maxSize) {
        fail(`รูปละไม่เกิน ${rule.maxSize / 1024 / 1024}MB`);
      }

      const key = `${kind}/${userId}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${EXT[type]}`;
      // ContentType + ContentLength อยู่ในลายเซ็น → browser ส่งไฟล์ชนิด/ขนาดอื่นไม่ได้
      const command = new lib.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: type, ContentLength: size });
      const putUrl = await getSignedUrl(s3client, command, { expiresIn: URL_TTL });
      out.push({ key, url: putUrl, headers: { "Content-Type": type } });
    }

    return out;
  }

  // ตรวจ key ที่ส่งมากับฟอร์ม: ต้องเป็นของผู้ใช้คนนี้ + มีไฟล์จริงใน S3 + ชนิด/ขนาดถูก
  async function confirm(keys, { userId, kind }) {
    const rule = KINDS[kind];
    const list = [].concat(keys || []).filter((k) => typeof k === "string" && k);
    if (!list.length) return [];
    if (!s3) fail("STORAGE_MODE ไม่ใช่ s3");
    if (list.length > rule.maxFiles) fail(`แนบได้สูงสุด ${rule.maxFiles} ไฟล์`);

    const { lib, client: s3client } = api();
    const out = [];

    for (const key of list) {
      if (!validKey(key) || !key.startsWith(`${kind}/${userId}/`)) fail("ไฟล์แนบไม่ถูกต้อง");
      let head;
      try {
        head = await s3client.send(new lib.HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        fail("ไม่พบไฟล์ที่อัปโหลด กรุณาเลือกรูปใหม่");
      }
      const mime = String(head.ContentType || "");
      const size = Number(head.ContentLength || 0);
      if (!mime.startsWith("image/") || size < 1 || size > rule.maxSize) fail("ไฟล์แนบไม่ถูกต้อง");
      out.push({ key, mime, size });
    }

    return out;
  }

  // ---------- ดาวน์โหลด (s3) ----------
  async function downloadUrl(key) {
    if (!s3 || !validKey(key)) return null;
    const { lib, getSignedUrl, client: s3client } = api();
    return getSignedUrl(s3client, new lib.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: URL_TTL });
  }

  // ลบไฟล์ (รูปโปรไฟล์ที่ถูกแทนที่ / ฟอร์มที่บันทึกไม่สำเร็จ) — ล้มก็ไม่เป็นไร
  async function remove(key) {
    if (!validKey(key)) return;
    if (!s3) {
      fs.rmSync(path.join(UPLOAD_ROOT, key), { force: true });
      return;
    }
    try {
      const { lib, client: s3client } = api();
      await s3client.send(new lib.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      console.warn("[s3] ลบไฟล์ไม่สำเร็จ:", key, error.message);
    }
  }

  return { mode, s3, url, presignUpload, confirm, downloadUrl, remove, validKey, KINDS };
}

let instance = createStorage();

const storage = new Proxy(
  {},
  { get: (_, name) => instance[name] }
);

// test: เปลี่ยนเป็นตัวปลอม
function use(fake) {
  instance = fake;
}

module.exports = { storage, createStorage, use, UPLOAD_ROOT, KINDS };
