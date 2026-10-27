// service/email-notify.js — อีเมลแจ้งสถานะคำร้องถึง "คนร้องเรียน" ผ่าน Amazon SNS
//
// ใช้ SNS topic แยกของนักศึกษา (STUDENT_SNS_TOPIC_ARN, Terraform สร้างให้)
//   - ตอนนักศึกษาล็อกอิน (หรือกดเปิดในหน้าโปรไฟล์) เว็บ Subscribe อีเมลของเขาเข้า topic
//     พร้อม FilterPolicy {"recipient": ["<อีเมลตัวเอง>"]}
//   - AWS ส่งอีเมล "Subscription Confirmation" ให้กดยืนยัน 1 ครั้ง (ก่อนกดจะยังไม่ได้รับอีเมล)
//   - Lambda status.py publish ข้อความพร้อม MessageAttribute recipient = อีเมลเจ้าของคำร้อง
//     → SNS ส่งเฉพาะคนนั้น (คนอื่นใน topic เดียวกันไม่ได้รับ)
// topic ของ Admin/Staff (SNS_TOPIC_ARN) แยกกัน ไม่เกี่ยวกับไฟล์นี้
//
// ไม่สมัครบัญชีทดลอง (create_test_accounts) — อีเมลพวกนั้นอาจเป็นของนักศึกษาจริง

const config = require("../config");

const STATUS = { OFF: "off", NONE: "none", PENDING: "pending", CONFIRMED: "confirmed", UNAVAILABLE: "unavailable" };

function normalize(email) {
  return String(email || "").trim().toLowerCase();
}

function isTestAccount(email) {
  const seed = require("../repo/dev-seed");
  if (!seed.testAccountsEnabled()) return false;
  const target = normalize(email);
  return seed.DEV_ACCOUNTS.some((a) => a.email === target);
}

// sdk (test): { lib: {SubscribeCommand, ...}, send(command) }
function createEmailNotify({ topicArn = config.aws.studentTopicArn, region = config.aws.region, sdk: injected } = {}) {
  let sdk = injected || null;

  function api() {
    if (!sdk) {
      // โหลดเฉพาะตอนใช้ (ในเครื่องไม่มี topic ก็ไม่ต้องมี SDK ตัวนี้)
      const lib = require("@aws-sdk/client-sns");
      const client = new lib.SNSClient({ region });
      sdk = { lib, send: (command) => client.send(command) };
    }
    return sdk;
  }

  const enabled = () => Boolean(topicArn);

  // นักศึกษาเท่านั้น (Staff/Admin ใช้ topic ของทีม) + ไม่ใช่บัญชีทดลอง
  function eligible(user) {
    return enabled() && user?.role === "USER" && Boolean(user.active ?? 1) && !isTestAccount(user.email);
  }

  // สมัคร: คืน ARN ของ subscription (ตอนรอยืนยันก็ได้ ARN เพราะ ReturnSubscriptionArn)
  // ถ้าเคยสมัครอีเมลนี้แล้ว SNS คืน ARN เดิม (และส่งอีเมลยืนยันซ้ำถ้ายังไม่กด)
  async function subscribe(email) {
    const { lib, send: run } = api();
    const endpoint = normalize(email);
    const out = await run(
      new lib.SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "email",
        Endpoint: endpoint,
        ReturnSubscriptionArn: true,
        Attributes: { FilterPolicy: JSON.stringify({ recipient: [endpoint] }) },
      })
    );
    return out.SubscriptionArn || null;
  }

  // สถานะจาก SNS: confirmed | pending | none
  async function status(arn) {
    if (!arn) return STATUS.NONE;
    const { lib, send: run } = api();
    try {
      const out = await run(new lib.GetSubscriptionAttributesCommand({ SubscriptionArn: arn }));
      return out.Attributes?.PendingConfirmation === "true" ? STATUS.PENDING : STATUS.CONFIRMED;
    } catch (error) {
      if (error?.name === "NotFoundException" || error?.name === "InvalidParameterException") return STATUS.NONE;
      throw error;
    }
  }

  // ยกเลิก: subscription ที่ยังไม่ยืนยันลบไม่ได้ (SNS ลบเองภายใน 3 วัน) — Lambda ก็ไม่ส่งให้อยู่แล้วเพราะ email_notify = 0
  async function unsubscribe(arn) {
    if (!arn) return;
    const { lib, send: run } = api();
    try {
      await run(new lib.UnsubscribeCommand({ SubscriptionArn: arn }));
    } catch (error) {
      if (error?.name !== "NotFoundException" && error?.name !== "InvalidParameterException") throw error;
    }
  }

  // ตอนล็อกอิน: สมัครให้อัตโนมัติครั้งแรก (เปิดไว้ + ยังไม่เคยสมัคร) — ไม่สมัครซ้ำทุกครั้ง กันอีเมลยืนยันรัว
  // ถ้าไม่กดยืนยันภายใน 3 วัน SNS ลบเอง → กด "ส่งอีเมลยืนยันอีกครั้ง" ในหน้าโปรไฟล์
  async function ensureSubscribed(user) {
    if (!eligible(user) || Number(user.email_notify ?? 1) !== 1 || user.email_sub_arn) return null;
    const arn = await subscribe(user.email);
    await require("../repo/users").setEmailNotify(user.id, { arn });
    return arn;
  }

  return { enabled, eligible, subscribe, status, unsubscribe, ensureSubscribed };
}

let instance = createEmailNotify();
const emailNotify = new Proxy({}, { get: (_, name) => instance[name] });

// test: เปลี่ยนเป็นตัวปลอม
function use(fake) {
  instance = fake;
}

module.exports = { emailNotify, createEmailNotify, use, STATUS, isTestAccount };
