// ทดสอบ service/cognito-password.js (บังคับตั้งรหัสผ่านหลังเข้าด้วย Google) ด้วย Cognito ปลอม — ไม่ต้องต่อ AWS
// รัน: node --no-warnings test/cognito-password.test.js
const assert = require("node:assert/strict");
const { createCognitoPassword } = require("../service/cognito-password");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

// ผู้ใช้ใน pool ปลอม: Username → { email, status, groups }
function fakePool(initial) {
  const pool = structuredClone(initial);
  const calls = [];
  let next = 1;
  async function send(name, input) {
    calls.push([name, input]);
    switch (name) {
      case "ListUsers": {
        const email = /email = "(.+)"/.exec(input.Filter)[1];
        return {
          Users: Object.entries(pool)
            .filter(([, u]) => u.email === email)
            .map(([Username, u]) => ({ Username, UserStatus: u.status, Enabled: u.enabled !== false })),
        };
      }
      case "AdminCreateUser": {
        assert.equal(input.MessageAction, "SUPPRESS");
        const Username = `uuid-${next++}`;
        pool[Username] = { email: input.Username, status: "FORCE_CHANGE_PASSWORD", groups: [] };
        return { User: { Username, UserStatus: "FORCE_CHANGE_PASSWORD" } };
      }
      case "AdminSetUserPassword": {
        assert.equal(input.Permanent, true);
        if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(input.Password)) {
          const e = new Error("policy");
          e.name = "InvalidPasswordException";
          throw e;
        }
        pool[input.Username].status = "CONFIRMED";
        pool[input.Username].password = input.Password;
        return {};
      }
      case "AdminListGroupsForUser":
        return { Groups: pool[input.Username].groups.map((GroupName) => ({ GroupName })) };
      case "AdminAddUserToGroup":
        pool[input.Username].groups.push(input.GroupName);
        return {};
      case "AdminDeleteUser":
        delete pool[input.Username];
        return {};
      case "AdminLinkProviderForUser":
        pool[input.DestinationUser.ProviderAttributeValue].linked = input.SourceUser;
        return {};
      default:
        throw new Error("unexpected " + name);
    }
  }
  return { pool, calls, send };
}

const googleIdentity = (email, username = "Google_111", groups = ["User"]) => ({
  sub: "s", email, name: "Test", groups, username, federated: { provider: "Google", userId: "111" },
});

(async () => {
  await check("needsPassword: ไม่มีบัญชีรหัส / รหัสชั่วคราว → ต้องตั้ง · มีรหัสแล้ว / ไม่ใช่ Google → ไม่ต้อง", async () => {
    const { send } = fakePool({
      Google_1: { email: "a@kmitl.ac.th", status: "EXTERNAL_PROVIDER", groups: ["User"] },
      n2: { email: "b@kmitl.ac.th", status: "FORCE_CHANGE_PASSWORD", groups: ["Admin"] },
      n3: { email: "c@kmitl.ac.th", status: "CONFIRMED", groups: ["Staff"] },
    });
    const svc = createCognitoPassword({ userPoolId: "p", send });
    assert.equal(await svc.needsPassword(googleIdentity("a@kmitl.ac.th")), true);
    assert.equal(await svc.needsPassword(googleIdentity("b@kmitl.ac.th", "n2")), true);
    assert.equal(await svc.needsPassword(googleIdentity("c@kmitl.ac.th", "n3")), false);
    assert.equal(await svc.needsPassword({ email: "a@kmitl.ac.th", federated: null }), false);
    assert.equal(await createCognitoPassword({}).needsPassword(googleIdentity("a@kmitl.ac.th")), false);
  });

  await check("บัญชี Google ล้วน → สร้างบัญชีรหัส + ตั้งรหัส + ย้ายกลุ่ม + ลบ Google_xxx + รวมตัวตน", async () => {
    const { pool, calls, send } = fakePool({
      Google_111: { email: "a@kmitl.ac.th", status: "EXTERNAL_PROVIDER", groups: ["Staff"] },
    });
    const svc = createCognitoPassword({ userPoolId: "p", send });
    assert.deepEqual(await svc.setPasswordForGoogleUser(googleIdentity("a@kmitl.ac.th"), "Abcd1234"), { linked: true, groups: ["Staff"] });

    assert.equal(pool.Google_111, undefined);
    assert.deepEqual(pool["uuid-1"], {
      email: "a@kmitl.ac.th", status: "CONFIRMED", password: "Abcd1234", groups: ["Staff"],
      linked: { ProviderName: "Google", ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: "111" },
    });
    const order = calls.map(([n]) => n);
    assert.ok(order.indexOf("AdminDeleteUser") < order.indexOf("AdminLinkProviderForUser"));
  });

  await check("บัญชีที่ Admin สร้าง (รหัสชั่วคราว) และรวมกับ Google แล้ว → ตั้งรหัสอย่างเดียว ไม่สร้าง/ลบอะไร", async () => {
    const { pool, calls, send } = fakePool({
      n2: { email: "b@kmitl.ac.th", status: "FORCE_CHANGE_PASSWORD", groups: ["Admin"] },
    });
    const svc = createCognitoPassword({ userPoolId: "p", send });
    await svc.setPasswordForGoogleUser(googleIdentity("b@kmitl.ac.th", "n2", ["Admin"]), "Abcd1234");
    assert.equal(pool.n2.status, "CONFIRMED");
    assert.deepEqual(pool.n2.groups, ["Admin"]);
    assert.deepEqual(calls.map(([n]) => n), ["ListUsers", "AdminSetUserPassword"]);
  });

  await check("Admin เพิ่มเป็น Staff ไว้ แต่บัญชี Google แยกเป็น User → ใช้กลุ่มของบัญชีรหัสผ่าน (Staff)", async () => {
    const { pool, send } = fakePool({
      n5: { email: "s@kmitl.ac.th", status: "FORCE_CHANGE_PASSWORD", groups: ["Staff"] },
      Google_111: { email: "s@kmitl.ac.th", status: "EXTERNAL_PROVIDER", groups: ["User"] },
    });
    const svc = createCognitoPassword({ userPoolId: "p", send });
    const r = await svc.setPasswordForGoogleUser(googleIdentity("s@kmitl.ac.th", "Google_111", ["User"]), "Abcd1234");
    assert.deepEqual(r, { linked: true, groups: ["Staff"] });
    assert.deepEqual(pool.n5.groups, ["Staff"]);
    assert.equal(pool.Google_111, undefined);
  });

  await check("รหัสผิดนโยบาย → throw InvalidPasswordException (ไม่ลบบัญชี Google)", async () => {
    const { pool, send } = fakePool({
      Google_111: { email: "a@kmitl.ac.th", status: "EXTERNAL_PROVIDER", groups: ["User"] },
    });
    const svc = createCognitoPassword({ userPoolId: "p", send });
    await assert.rejects(svc.setPasswordForGoogleUser(googleIdentity("a@kmitl.ac.th"), "short"), { name: "InvalidPasswordException" });
    assert.ok(pool.Google_111);
  });

  await check("ลบ/รวมไม่ได้ (เช่น LabRole ไม่มีสิทธิ์) → ตั้งรหัสสำเร็จ แต่ linked=false (รวมเองตอน Google ครั้งหน้า)", async () => {
    const pool = fakePool({ Google_111: { email: "a@kmitl.ac.th", status: "EXTERNAL_PROVIDER", groups: ["User"] } });
    const send = async (name, input) => {
      if (name === "AdminDeleteUser") {
        const e = new Error("not authorized");
        e.name = "AccessDeniedException";
        throw e;
      }
      return pool.send(name, input);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const svc = createCognitoPassword({ userPoolId: "p", send });
      assert.deepEqual(await svc.setPasswordForGoogleUser(googleIdentity("a@kmitl.ac.th"), "Abcd1234"), { linked: false, groups: ["User"] });
    } finally {
      console.warn = warn;
    }
    assert.equal(pool.pool["uuid-1"].status, "CONFIRMED");
    assert.deepEqual(pool.pool["uuid-1"].groups, ["User"]);
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
})().catch((error) => {
  console.error("\n✗ ไม่ผ่าน:", error);
  process.exit(1);
});
