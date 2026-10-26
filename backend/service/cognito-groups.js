// service/cognito-groups.js — ให้หน้า Admin เปลี่ยน role/ลบผู้ใช้ ฝั่ง Cognito ด้วย (โหมด AUTH_MODE=alb)
//
// เหตุผล: Cognito เป็นตัวกำหนด role — ทุกครั้งที่ login เว็บจะ sync role จาก "cognito:groups"
// ถ้าแก้แค่ใน DB ครั้งหน้าที่ผู้ใช้ login role จะถูกเขียนทับกลับเป็นค่าเดิม
//
// โหมด local (ในเครื่อง) ไม่เรียก AWS: คืน { skipped: true }
// สิทธิ์ที่ใช้: ListUsers, AdminListGroupsForUser, AdminAddUserToGroup, AdminRemoveUserFromGroup,
//             AdminDisableUser (ตรวจได้ด้วย check_lab_permissions.sh ฝั่ง Terraform)

const config = require("../config");

const ROLE_GROUP = { ADMIN: "Admin", STAFF: "Staff", USER: "User" };

function createCognitoGroups({ userPoolId, region, client } = {}) {
  const enabled = Boolean(userPoolId);
  let sdk = null;

  function api() {
    if (!sdk) {
      // โหลดตอนใช้จริงเท่านั้น (โหมด local ไม่ต้องโหลด AWS SDK)
      const lib = require("@aws-sdk/client-cognito-identity-provider");
      sdk = { lib, client: client || new lib.CognitoIdentityProviderClient({ region }) };
    }
    return sdk;
  }

  async function send(name, input) {
    const { lib, client } = api();
    return client.send(new lib[`${name}Command`](input));
  }

  // ผู้ใช้ Cognito ทุกตัวที่ใช้อีเมลนี้ (บัญชีอีเมล/รหัสผ่าน + Google ที่ยังไม่ถูกรวม)
  async function usersByEmail(email) {
    const clean = String(email || "").trim().toLowerCase().replace(/"/g, "");
    const result = await send("ListUsers", {
      UserPoolId: userPoolId,
      Filter: `email = "${clean}"`,
    });
    return (result.Users || []).map((u) => u.Username);
  }

  async function setRole(email, role) {
    if (!enabled) return { skipped: true, updated: 0 };

    const target = ROLE_GROUP[role];
    if (!target) throw new Error("role ไม่ถูกต้อง");

    const usernames = await usersByEmail(email);

    for (const username of usernames) {
      const current = await send("AdminListGroupsForUser", {
        UserPoolId: userPoolId,
        Username: username,
      });
      const groups = (current.Groups || []).map((g) => g.GroupName);

      // ออกจากกลุ่ม role อื่น (กลุ่มที่ไม่ใช่ role ไม่แตะ)
      for (const group of Object.values(ROLE_GROUP)) {
        if (group !== target && groups.includes(group)) {
          await send("AdminRemoveUserFromGroup", {
            UserPoolId: userPoolId,
            Username: username,
            GroupName: group,
          });
        }
      }

      if (!groups.includes(target)) {
        await send("AdminAddUserToGroup", {
          UserPoolId: userPoolId,
          Username: username,
          GroupName: target,
        });
      }
    }

    // usernames ว่าง = ยังไม่เคยมีบัญชีใน Cognito (เช่นข้อมูลที่สร้างใน DB เอง) — แก้แค่ DB
    return { skipped: false, updated: usernames.length };
  }

  // ลบผู้ใช้จากหน้า Admin: ปิดบัญชี Cognito (ไม่ลบ) กันไม่ให้ล็อกอิน Google แล้วถูกสร้างใหม่
  // เปิดคืนได้ที่ Cognito console → Users → Enable user
  async function disable(email) {
    if (!enabled) return { skipped: true, updated: 0 };

    const usernames = await usersByEmail(email);
    for (const username of usernames) {
      await send("AdminDisableUser", { UserPoolId: userPoolId, Username: username });
    }
    return { skipped: false, updated: usernames.length };
  }

  return { enabled, setRole, disable };
}

// ตัวที่แอปใช้: เปิดเฉพาะโหมด alb
const cognitoGroups = createCognitoGroups(
  config.auth.mode === "alb"
    ? { userPoolId: config.cognito.userPoolId, region: config.aws.region }
    : {}
);

module.exports = { cognitoGroups, createCognitoGroups, ROLE_GROUP };
