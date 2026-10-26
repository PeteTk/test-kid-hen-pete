// auth/session-user.js — สิ่งที่เก็บใน req.session.user (เก็บน้อยที่สุด: ข้อมูลจริงอ่านจาก DB ทุก request)

// หน้าแรกของแต่ละ role หลัง login
const HOME = {
  ADMIN: "/admin/dashboard",
  STAFF: "/staff/dashboard",
  USER: "/user/home",
};

function sessionUser(user, sub = null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sub, // Cognito sub (โหมด alb) ใช้ดูว่าเปลี่ยนคนล็อกอินหรือยัง
  };
}

// เปลี่ยน session id ทุกครั้งที่ login (กัน session fixation) แล้วบันทึกลงตาราง sessions ก่อน redirect
function startSession(req, user, sub = null) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.user = sessionUser(user, sub);
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

// URL รูปโปรไฟล์จาก avatar_key (ในเครื่อง = /uploads/<key>, ขั้น 3d จะเปลี่ยนเป็น S3)
function avatarUrl(user) {
  const key = user?.avatar_key;
  return key ? `/uploads/${key}` : "";
}

module.exports = { HOME, sessionUser, startSession, avatarUrl };
