// service/cognito-groups.js — ให้หน้า Admin เปลี่ยน role/ลบผู้ใช้ ฝั่ง Cognito ด้วย (AUTH_MODE=cognito หรือ alb)
//
// เหตุผล: Cognito เป็นตัวกำหนด role — ทุกครั้งที่ login เว็บจะ sync role จาก "cognito:groups"
// ถ้าแก้แค่ใน DB ครั้งหน้าที่ผู้ใช้ login role จะถูกเขียนทับกลับเป็นค่าเดิม
//
// โหมด local (ในเครื่อง) ไม่เรียก AWS: คืน { skipped: true }
// สิทธิ์ที่ใช้: ListUsers, AdminListGroupsForUser, AdminAddUserToGroup, AdminRemoveUserFromGroup,
//             AdminDisableUser, AdminCreateUser (3b-3) (ตรวจได้ด้วย check_lab_permissions.sh ฝั่ง Terraform)

const config = require("../config");

const ROLE_GROUP = { ADMIN: "Admin", STAFF: "Staff", USER: "User" };

function createCognitoGroups({ userPoolId, region, client, send: sendImpl } = {}) {
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
    if (sendImpl) return sendImpl(name, input); // test
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

  // 3b-3: Admin เพิ่มผู้ใช้ — สร้างบัญชีอีเมล/รหัสผ่านใน Cognito + ใส่กลุ่มตาม role
  // Cognito ส่งรหัสผ่านชั่วคราวทางอีเมลให้ (ครั้งแรกเว็บพาไปหน้า "ตั้งรหัสผ่านใหม่")
  // หรือกด Google ด้วยอีเมลเดียวกัน → ถูกขอให้ตั้งรหัส แล้วรวมเป็นบัญชีเดียว
  // คืน { skipped, existed } — existed = มีบัญชีรหัสผ่านใน Cognito อยู่แล้ว (แค่ย้ายกลุ่ม ไม่ส่งอีเมลซ้ำ)
  async function createUser({ email, name, role }) {
    if (!enabled) return { skipped: true, existed: false };
    if (!ROLE_GROUP[role]) throw new Error("role ไม่ถูกต้อง");

    const clean = String(email || "").trim().toLowerCase();
    let existed = false;

    try {
      const attrs = [
        { Name: "email", Value: clean },
        { Name: "email_verified", Value: "true" },
      ];
      if (name) attrs.push({ Name: "name", Value: String(name).slice(0, 150) });
      await send("AdminCreateUser", {
        UserPoolId: userPoolId,
        Username: clean,
        UserAttributes: attrs,
        DesiredDeliveryMediums: ["EMAIL"],
      });
    } catch (error) {
      if (error.name !== "UsernameExistsException") throw error;
      existed = true;
    }

    // ย้าย/ใส่กลุ่มให้ทุกบัญชีของอีเมลนี้ (รวมบัญชี Google ที่ยังไม่ถูกรวม)
    await setRole(clean, role);
    return { skipped: false, existed };
  }

  return { enabled, setRole, disable, createUser };
}

// ตัวที่แอปใช้: เปิดเฉพาะโหมด alb
const cognitoGroups = createCognitoGroups(
  config.auth.mode !== "local" // alb และ cognito: role มาจากกลุ่ม Cognito
    ? { userPoolId: config.cognito.userPoolId, region: config.aws.region }
    : {}
);

module.exports = { cognitoGroups, createCognitoGroups, ROLE_GROUP };
