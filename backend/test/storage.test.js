// ทดสอบ service/storage.js (3d: S3 pre-signed URL) ด้วย S3 ปลอม — ไม่ต้องต่อ AWS
// รัน: node --no-warnings test/storage.test.js
process.env.AUTH_MODE = "local";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const { createStorage } = require("../service/storage");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

const USER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

function fakeS3(objects = {}) {
  const sent = [];
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  const lib = {
    PutObjectCommand: class extends Command {},
    GetObjectCommand: class extends Command {},
    HeadObjectCommand: class extends Command {},
    DeleteObjectCommand: class extends Command {},
  };
  const client = {
    async send(command) {
      sent.push([command.constructor.name, command.input]);
      if (command instanceof lib.HeadObjectCommand) {
        const o = objects[command.input.Key];
        if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
        return { ContentType: o.type, ContentLength: o.size };
      }
      if (command instanceof lib.DeleteObjectCommand) delete objects[command.input.Key];
      return {};
    },
  };
  const getSignedUrl = async (_client, command, { expiresIn }) =>
    `https://bucket.s3.amazonaws.com/${command.input.Key}?op=${command.constructor.name}&exp=${expiresIn}` +
    (command.input.ContentLength ? `&len=${command.input.ContentLength}&type=${command.input.ContentType}` : "");
  return { sdk: { lib, getSignedUrl, client }, sent, objects };
}

(async () => {
  await check("local: URL /uploads/<key>, key แปลก/.. → ว่าง", async () => {
    const s = createStorage({ mode: "local" });
    assert.equal(s.url("requests/123-456.jpg"), "/uploads/requests/123-456.jpg");
    assert.equal(s.url("avatars/avatar-1-2.png"), "/uploads/avatars/avatar-1-2.png");
    assert.equal(s.url("../etc/passwd"), "");
    assert.equal(s.url("requests/../../x.jpg"), "");
    assert.deepEqual(await s.confirm([], { userId: USER, kind: "requests" }), []);
  });

  await check("s3 presign: เซ็นชนิด+ขนาดไฟล์, key อยู่ใต้ผู้ใช้, จำกัดจำนวน/ขนาด/ชนิด", async () => {
    const { sdk } = fakeS3();
    const s = createStorage({ mode: "s3", bucket: "b", sdk });
    const out = await s.presignUpload({ userId: USER, kind: "requests", files: [{ type: "image/png", size: 1000 }] });
    assert.equal(out.length, 1);
    assert.match(out[0].key, new RegExp(`^requests/${USER}/\\d+-[0-9a-f]{12}\\.png$`));
    assert.match(out[0].url, /op=PutObjectCommand&exp=300&len=1000&type=image\/png/);
    assert.deepEqual(out[0].headers, { "Content-Type": "image/png" });
    assert.equal(s.url(out[0].key), `/files/${out[0].key}`);

    const bad = [
      { kind: "requests", files: [1, 2, 3, 4].map(() => ({ type: "image/png", size: 10 })) },
      { kind: "requests", files: [{ type: "image/png", size: 6 * 1024 * 1024 }] },
      { kind: "avatars", files: [{ type: "image/png", size: 3 * 1024 * 1024 }] },
      { kind: "requests", files: [{ type: "application/pdf", size: 10 }] },
      { kind: "secrets", files: [{ type: "image/png", size: 10 }] },
    ];
    for (const input of bad) await assert.rejects(s.presignUpload({ userId: USER, ...input }), (e) => e.status === 400);
  });

  await check("s3 confirm: ต้องเป็นของผู้ใช้นี้ + มีไฟล์จริง + เป็นรูปขนาดไม่เกิน", async () => {
    const mine = `requests/${USER}/1-aaaaaaaaaaaa.png`;
    const theirs = `requests/${OTHER}/1-bbbbbbbbbbbb.png`;
    const big = `avatars/${USER}/1-cccccccccccc.png`;
    const { sdk } = fakeS3({
      [mine]: { type: "image/png", size: 10 },
      [theirs]: { type: "image/png", size: 10 },
      [big]: { type: "image/png", size: 3 * 1024 * 1024 },
    });
    const s = createStorage({ mode: "s3", bucket: "b", sdk });
    assert.deepEqual(await s.confirm(mine, { userId: USER, kind: "requests" }), [{ key: mine, mime: "image/png", size: 10 }]);
    await assert.rejects(s.confirm([theirs], { userId: USER, kind: "requests" }), /ไม่ถูกต้อง/);
    await assert.rejects(s.confirm([`requests/${USER}/9-dddddddddddd.png`], { userId: USER, kind: "requests" }), /ไม่พบไฟล์/);
    await assert.rejects(s.confirm([big], { userId: USER, kind: "avatars" }), /ไม่ถูกต้อง/);
    await assert.rejects(s.confirm([mine], { userId: USER, kind: "avatars" }), /ไม่ถูกต้อง/);
  });

  await check("s3 ดาวน์โหลด = pre-signed GET 5 นาที · ลบไฟล์ = DeleteObject", async () => {
    const key = `avatars/${USER}/1-aaaaaaaaaaaa.jpg`;
    const { sdk, sent, objects } = fakeS3({ [key]: { type: "image/jpeg", size: 5 } });
    const s = createStorage({ mode: "s3", bucket: "b", sdk });
    assert.match(await s.downloadUrl(key), /op=GetObjectCommand&exp=300$/);
    assert.equal(await s.downloadUrl("../x"), null);
    await s.remove(key);
    assert.equal(objects[key], undefined);
    assert.ok(sent.some(([name, input]) => name === "DeleteObjectCommand" && input.Bucket === "b"));
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
})().catch((error) => {
  console.error("\n✗ ไม่ผ่าน:", error);
  process.exit(1);
});
