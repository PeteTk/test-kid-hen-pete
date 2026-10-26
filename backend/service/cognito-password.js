// service/cognito-password.js — บังคับให้คนที่เข้าด้วย Google ตั้งรหัสผ่านครั้งแรก (AUTH_MODE=cognito)
//
// ปัญหา: บัญชีที่เกิดจาก Google (ผู้ใช้ Cognito ชื่อ Google_xxx) ไม่มีรหัสผ่าน จึงกรอกอีเมล/รหัสในหน้าแรกไม่ได้
// วิธี: หลังล็อกอิน Google ถ้าอีเมลนี้ยังไม่มีบัญชีรหัสผ่านที่ใช้ได้ → หน้า "ตั้งรหัสผ่าน" ของเว็บ แล้ว
//   1) สร้างบัญชีอีเมล/รหัสผ่าน (AdminCreateUser, ไม่ส่งอีเมล) — ถ้ามีอยู่แล้วแต่ยังเป็นรหัสชั่วคราวก็ใช้ตัวเดิม
//   2) ตั้งรหัสผ่านถาวร (AdminSetUserPassword)
//   3) คัดลอกกลุ่ม (role) จากบัญชี Google ไปบัญชีใหม่ ถ้าบัญชีใหม่ยังไม่มีกลุ่ม role
//   4) ลบบัญชี Google_xxx แล้วรวมตัวตน Google เข้ากับบัญชีใหม่ (AdminDeleteUser + AdminLinkProviderForUser)
//      → ต่อไปกด Google หรือกรอกอีเมล/รหัสผ่าน ก็เป็นบัญชีเดียวกัน role เดียวกัน
//   ข้อ 4 ล้มได้โดยไม่เสียหาย: ล็อกอิน Google ครั้งหน้า Lambda pre sign-up จะรวมให้เอง (เพราะมีบัญชีรหัสผ่านแล้ว)
//
// สิทธิ์ที่ใช้: ListUsers, AdminCreateUser, AdminSetUserPassword, AdminListGroupsForUser, AdminAddUserToGroup,
//             AdminDeleteUser, AdminLinkProviderForUser (ตรวจด้วย check_lab_permissions.sh ฝั่ง Terraform)

const ROLE_GROUPS = ["Admin", "Staff", "User"];
// สถานะที่ยังกรอกอีเมล/รหัสผ่านเองไม่ได้ (รหัสชั่วคราวที่ไม่เคยรู้ / ถูกสั่งรีเซ็ต)
const NO_USABLE_PASSWORD = ["FORCE_CHANGE_PASSWORD", "RESET_REQUIRED"];

function createCognitoPassword({ userPoolId, region, client, send: sendImpl } = {}) {
  const enabled = Boolean(userPoolId);
  let sdk = null;

  async function send(name, input) {
    if (sendImpl) return sendImpl(name, input); // test
    if (!sdk) {
      const lib = require("@aws-sdk/client-cognito-identity-provider");
      sdk = { lib, client: client || new lib.CognitoIdentityProviderClient({ region }) };
    }
    return sdk.client.send(new sdk.lib[`${name}Command`](input));
  }

  // บัญชีอีเมล/รหัสผ่าน (ไม่ใช่ Google) ของอีเมลนี้ ที่ยังเปิดใช้งาน
  async function nativeUser(email) {
    const clean = String(email || "").trim().toLowerCase().replace(/"/g, "");
    const result = await send("ListUsers", { UserPoolId: userPoolId, Filter: `email = "${clean}"` });
    return (result.Users || []).find(
      (u) => u.UserStatus !== "EXTERNAL_PROVIDER" && u.Enabled !== false
    ) || null;
  }

  // identity ที่ได้จาก Google ต้องตั้งรหัสผ่านไหม
  async function needsPassword(identity) {
    if (!enabled || !identity?.federated) return false;
    const native = await nativeUser(identity.email);
    return !native || NO_USABLE_PASSWORD.includes(native.UserStatus);
  }

  async function groupsOf(username) {
    const result = await send("AdminListGroupsForUser", { UserPoolId: userPoolId, Username: username });
    return (result.Groups || []).map((g) => g.GroupName);
  }

  // คืน { linked, groups } — linked=false = ตั้งรหัสได้แล้ว แต่รวมกับ Google ยังไม่สำเร็จ (จะรวมเองครั้งหน้า)
  //   groups = กลุ่มของบัญชีรหัสผ่าน (role ที่ถูกต้อง เช่น Admin สร้างเป็น Staff ไว้ แต่บัญชี Google เป็น User)
  async function setPasswordForGoogleUser(identity, password) {
    if (!enabled) throw new Error("ไม่ได้ตั้งค่า COGNITO_USER_POOL_ID");
    const email = String(identity.email || "").trim().toLowerCase();

    // 1) บัญชีอีเมล/รหัสผ่าน
    let native = await nativeUser(email);
    if (!native) {
      const attrs = [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ];
      if (identity.name) attrs.push({ Name: "name", Value: String(identity.name).slice(0, 150) });
      const created = await send("AdminCreateUser", {
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: attrs,
        MessageAction: "SUPPRESS", // ไม่ส่งอีเมลรหัสชั่วคราว
      });
      native = created.User;
    }
    const nativeName = native.Username;

    // 2) รหัสผ่านถาวร (Cognito ตรวจนโยบายรหัสเอง — ผิดนโยบายจะได้ InvalidPasswordException)
    await send("AdminSetUserPassword", {
      UserPoolId: userPoolId, Username: nativeName, Password: String(password || ""), Permanent: true,
    });

    // 3) + 4) มีบัญชี Google แยกอยู่ (ยังไม่ถูกรวม) → ย้ายกลุ่มแล้วรวม
    const googleName = identity.username;
    if (!googleName || googleName === nativeName) return { linked: true, groups: identity.groups || [] }; // รวมกันอยู่แล้ว

    let groups = identity.groups || [];
    try {
      groups = await groupsOf(nativeName);
      if (!groups.some((g) => ROLE_GROUPS.includes(g))) {
        const fromGoogle = (await groupsOf(googleName)).filter((g) => ROLE_GROUPS.includes(g));
        for (const group of fromGoogle.length ? fromGoogle : ["User"]) {
          await send("AdminAddUserToGroup", { UserPoolId: userPoolId, Username: nativeName, GroupName: group });
          groups = [...groups, group];
        }
      }

      const { provider, userId } = identity.federated || {};
      if (!provider || !userId) return { linked: false, groups };

      // ต้องลบผู้ใช้ Google_xxx ก่อน Cognito ถึงยอมรวมตัวตนเดียวกันเข้าบัญชีอื่น
      await send("AdminDeleteUser", { UserPoolId: userPoolId, Username: googleName });
      await send("AdminLinkProviderForUser", {
        UserPoolId: userPoolId,
        DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: nativeName },
        SourceUser: { ProviderName: provider, ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: userId },
      });
      return { linked: true, groups };
    } catch (error) {
      console.warn("[auth] รวมบัญชี Google กับบัญชีรหัสผ่านไม่สำเร็จ (จะรวมเองตอนล็อกอิน Google ครั้งหน้า):",
        error.name || error.code, error.message);
      return { linked: false, groups };
    }
  }

  return { enabled, needsPassword, setPasswordForGoogleUser };
}

let instance = null;

function cognitoPassword() {
  if (!instance) {
    const config = require("../config");
    instance = createCognitoPassword(
      config.auth.mode === "cognito" ? { userPoolId: config.cognito.userPoolId, region: config.aws.region } : {}
    );
  }
  return instance;
}

function use(fake) {
  instance = fake;
}

module.exports = { createCognitoPassword, cognitoPassword, use };
