// ทดสอบ service/email-notify.js (อีเมลแจ้งสถานะคำร้องถึงคนร้องเรียนผ่าน SNS) ด้วย SNS ปลอม — ไม่ต้องต่อ AWS
// รัน: node --no-warnings test/email-notify.test.js
process.env.AUTH_MODE = "local";
delete process.env.NODE_ENV;
delete process.env.SEED_TEST_ACCOUNTS;

const assert = require("node:assert/strict");
const { createEmailNotify, STATUS } = require("../service/email-notify");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

const TOPIC = "arn:aws:sns:us-east-1:111122223333:kidhen-dev-student-notifications";

function fakeSns() {
  const subs = {}; // arn -> { endpoint, filter, pending }
  const sent = [];
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  const lib = {
    SubscribeCommand: class extends Command {},
    GetSubscriptionAttributesCommand: class extends Command {},
    UnsubscribeCommand: class extends Command {},
  };
  async function send(command) {
    sent.push([command.constructor.name, command.input]);
    const input = command.input;
    if (command instanceof lib.SubscribeCommand) {
      const arn = `${TOPIC}:${input.Endpoint}`;
      subs[arn] = subs[arn] || { endpoint: input.Endpoint, filter: JSON.parse(input.Attributes.FilterPolicy), pending: true };
      return { SubscriptionArn: arn };
    }
    const sub = subs[input.SubscriptionArn];
    if (!sub) throw Object.assign(new Error("not found"), { name: "NotFoundException" });
    if (command instanceof lib.GetSubscriptionAttributesCommand) {
      return { Attributes: { PendingConfirmation: String(sub.pending) } };
    }
    if (command instanceof lib.UnsubscribeCommand) {
      delete subs[input.SubscriptionArn];
      return {};
    }
    throw new Error("unexpected command");
  }
  return { sdk: { lib, send }, subs, sent };
}

const student = { id: "u1", role: "USER", active: 1, email: "67079999@kmitl.ac.th", email_notify: 1, email_sub_arn: null };

(async () => {
  await check("สมัครแบบกรองผู้รับ = อีเมลตัวเอง (คนอื่นใน topic ไม่ได้รับ)", async () => {
    const fake = fakeSns();
    const notify = createEmailNotify({ topicArn: TOPIC, sdk: fake.sdk });
    const arn = await notify.subscribe(" 67079999@KMITL.ac.th ");
    const [name, input] = fake.sent[0];
    assert.equal(name, "SubscribeCommand");
    assert.equal(input.Protocol, "email");
    assert.equal(input.Endpoint, "67079999@kmitl.ac.th");
    assert.equal(input.ReturnSubscriptionArn, true);
    assert.deepEqual(JSON.parse(input.Attributes.FilterPolicy), { recipient: ["67079999@kmitl.ac.th"] });
    assert.ok(arn);
  });

  await check("สถานะ: รอยืนยัน → ยืนยันแล้ว → ยกเลิกแล้ว", async () => {
    const fake = fakeSns();
    const notify = createEmailNotify({ topicArn: TOPIC, sdk: fake.sdk });
    assert.equal(await notify.status(null), STATUS.NONE);
    const arn = await notify.subscribe(student.email);
    assert.equal(await notify.status(arn), STATUS.PENDING);
    fake.subs[arn].pending = false; // นักศึกษากด Confirm subscription
    assert.equal(await notify.status(arn), STATUS.CONFIRMED);
    await notify.unsubscribe(arn);
    assert.equal(await notify.status(arn), STATUS.NONE); // ลบแล้ว / ลิงก์หมดอายุ
  });

  await check("ใช้ได้เฉพาะนักศึกษาที่ active และต้องมี topic", async () => {
    const notify = createEmailNotify({ topicArn: TOPIC, sdk: fakeSns().sdk });
    assert.equal(notify.eligible(student), true);
    assert.equal(notify.eligible({ ...student, role: "STAFF" }), false);
    assert.equal(notify.eligible({ ...student, role: "ADMIN" }), false);
    assert.equal(notify.eligible({ ...student, active: 0 }), false);
    assert.equal(createEmailNotify({ topicArn: "", sdk: fakeSns().sdk }).eligible(student), false);
  });

  await check("ไม่สมัครบัญชีทดลองเมื่อเปิดบัญชีทดลอง (อีเมลอาจเป็นของนักศึกษาจริง)", async () => {
    process.env.SEED_TEST_ACCOUNTS = "true";
    try {
      const notify = createEmailNotify({ topicArn: TOPIC, sdk: fakeSns().sdk });
      assert.equal(notify.eligible({ ...student, email: "67070999@kmitl.ac.th" }), false); // user
      assert.equal(notify.eligible({ ...student, email: "67010001@kmitl.ac.th" }), false); // user01
      assert.equal(notify.eligible(student), true); // อีเมลจริงที่ไม่ใช่บัญชีทดลอง
    } finally {
      delete process.env.SEED_TEST_ACCOUNTS;
    }
  });

  await check("ensureSubscribed: สมัครครั้งแรกเท่านั้น และไม่สมัครเมื่อปิดไว้", async () => {
    const fake = fakeSns();
    const notify = createEmailNotify({ topicArn: TOPIC, sdk: fake.sdk });
    assert.equal(await notify.ensureSubscribed({ ...student, email_sub_arn: "arn:old" }), null);
    assert.equal(await notify.ensureSubscribed({ ...student, email_notify: 0 }), null);
    assert.equal(fake.sent.length, 0);
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
