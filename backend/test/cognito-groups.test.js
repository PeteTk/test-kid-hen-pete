// ทดสอบ service/cognito-groups.js: Admin เพิ่มผู้ใช้ (3b-3) + เปลี่ยน role ด้วย Cognito ปลอม — ไม่ต้องต่อ AWS
// รัน: node --no-warnings test/cognito-groups.test.js
process.env.AUTH_MODE = "local";
delete process.env.NODE_ENV;

const assert = require("node:assert/strict");
const { createCognitoGroups } = require("../service/cognito-groups");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}

function fakePool(initial = {}) {
  const pool = structuredClone(initial); // Username → { email, groups }
  const calls = [];
  async function send(name, input) {
    calls.push([name, input]);
    switch (name) {
      case "AdminCreateUser": {
        if (Object.values(pool).some((u) => u.email === input.Username && !u.federated)) {
          const e = new Error("exists");
          e.name = "UsernameExistsException";
          throw e;
        }
        pool[`uuid-${Object.keys(pool).length + 1}`] = { email: input.Username, groups: [] };
        return { User: {} };
      }
      case "ListUsers": {
        const email = /email = "(.+)"/.exec(input.Filter)[1];
        return { Users: Object.entries(pool).filter(([, u]) => u.email === email).map(([Username]) => ({ Username })) };
      }
      case "AdminListGroupsForUser":
        return { Groups: pool[input.Username].groups.map((GroupName) => ({ GroupName })) };
      case "AdminAddUserToGroup":
        pool[input.Username].groups.push(input.GroupName);
        return {};
      case "AdminRemoveUserFromGroup":
        pool[input.Username].groups = pool[input.Username].groups.filter((g) => g !== input.GroupName);
        return {};
      default:
        throw new Error("unexpected " + name);
    }
  }
  return { pool, calls, send };
}

(async () => {
  await check("createUser: สร้างบัญชี (ส่งอีเมลรหัสชั่วคราว) + ใส่กลุ่มตาม role", async () => {
    const { pool, calls, send } = fakePool();
    const svc = createCognitoGroups({ userPoolId: "p", send });
    assert.deepEqual(await svc.createUser({ email: "New@KMITL.ac.th", name: "ใหม่", role: "STAFF" }), { skipped: false, existed: false });

    const create = calls.find(([n]) => n === "AdminCreateUser")[1];
    assert.equal(create.Username, "new@kmitl.ac.th");
    assert.deepEqual(create.DesiredDeliveryMediums, ["EMAIL"]);
    assert.equal(create.MessageAction, undefined); // ส่งอีเมลจริง
    assert.deepEqual(pool["uuid-1"], { email: "new@kmitl.ac.th", groups: ["Staff"] });
  });

  await check("createUser: มีบัญชีอยู่แล้ว → ไม่สร้างซ้ำ ย้ายกลุ่มทุกบัญชีของอีเมลนี้ (รวม Google ที่ยังไม่ถูกรวม)", async () => {
    const { pool, send } = fakePool({
      n1: { email: "a@kmitl.ac.th", groups: ["User"] },
      Google_1: { email: "a@kmitl.ac.th", groups: ["User"], federated: true },
    });
    const svc = createCognitoGroups({ userPoolId: "p", send });
    assert.deepEqual(await svc.createUser({ email: "a@kmitl.ac.th", name: "A", role: "ADMIN" }), { skipped: false, existed: true });
    assert.deepEqual(pool.n1.groups, ["Admin"]);
    assert.deepEqual(pool.Google_1.groups, ["Admin"]);
  });

  await check("createUser: บัญชี Google อย่างเดียว → สร้างบัญชีรหัสผ่านเพิ่ม + กลุ่มตรงกันทั้งคู่", async () => {
    const { pool, send } = fakePool({ Google_1: { email: "g@kmitl.ac.th", groups: ["User"], federated: true } });
    const svc = createCognitoGroups({ userPoolId: "p", send });
    assert.equal((await svc.createUser({ email: "g@kmitl.ac.th", name: "G", role: "STAFF" })).existed, false);
    assert.deepEqual(pool.Google_1.groups, ["Staff"]);
    assert.deepEqual(pool["uuid-2"].groups, ["Staff"]);
  });

  await check("โหมด local (ไม่มี pool id) → skipped ไม่เรียก AWS · role ผิด → throw", async () => {
    assert.deepEqual(await createCognitoGroups({}).createUser({ email: "x@y.z", role: "USER" }), { skipped: true, existed: false });
    await assert.rejects(createCognitoGroups({ userPoolId: "p", send: async () => ({}) }).createUser({ email: "x@y.z", role: "ROOT" }));
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
})().catch((error) => {
  console.error("\n✗ ไม่ผ่าน:", error);
  process.exit(1);
});
