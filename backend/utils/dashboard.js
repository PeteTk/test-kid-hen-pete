// แก้ (3c): ผู้เรียกส่งรายการคำร้องจาก DB (repo/tickets.list) เข้ามาเสมอ
const { TYPES, STATUSES } = require("../service/catalog");


// ของเดิม: เวลาที่ยื่นคำร้องจากรายการแรกในประวัติ
function createdAt(request) {
  return new Date(
    request.history?.[0]?.at || 0
  );
}

function percent(value, max) {
  return max
    ? Math.round((value / max) * 100)
    : 0;
}

// แก้: รับรายการที่ backend กรองสิทธิ์แล้ว
// Admin ไม่ส่ง argument จะใช้คำร้องทั้งหมด
// Staff ส่งเฉพาะรายการของคณะตัวเอง
// แก้ (3b-2): จำนวนผู้ใช้มาจาก DB (async) ผู้เรียกส่งเข้ามาเอง — Staff ไม่ใช้ค่านี้
function buildDashboardData(list = [], { userCount = 0, publishedTopics = 0 } = {}) {
  const total = list.length;

  // แก้: คำนวณสถานะจาก list เท่านั้น
  const byStatus = STATUSES.map(status => {
    const count = list.filter(
      request => request.status === status
    ).length;

    return {
      status,
      count,
      pct: percent(count, total),
    };
  });

  const doneCount =
    byStatus.find(
      item => item.status === "เสร็จสิ้น"
    )?.count || 0;

  // แก้: กราฟประเภทคำร้องใช้ข้อมูลในสิทธิ์เดียวกัน
  const typeCounts = TYPES.map(type => ({
    type,

    count: list.filter(
      request => request.type === type
    ).length,
  }));

  const maxType = Math.max(
    1,
    ...typeCounts.map(item => item.count)
  );

  const byType = typeCounts.map(item => ({
    ...item,
    pct: percent(item.count, maxType),
  }));

  // ของเดิม: ช่วง 7 วันล่าสุดตาม timezone ของ server
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayCounts = Array.from(
    { length: 7 },
    (_, index) => {
      const start = new Date(today);

      start.setDate(
        today.getDate() - (6 - index)
      );

      const end = new Date(start);
      end.setDate(start.getDate() + 1);

      return {
        label:
          `${start.getDate()}/` +
          `${start.getMonth() + 1}`,

        // แก้: นับเฉพาะคำร้องที่ได้รับอนุญาต
        count: list.filter(request => {
          const date = createdAt(request);

          return date >= start && date < end;
        }).length,
      };
    }
  );

  const maxDay = Math.max(
    1,
    ...dayCounts.map(item => item.count)
  );

  const last7 = dayCounts.map(item => ({
    ...item,
    pct: percent(item.count, maxDay),
  }));

  return {
    total,
    byStatus,
    byType,
    last7,

    newThisWeek: dayCounts.reduce(
      (sum, item) => sum + item.count,
      0
    ),

    doneRate: percent(doneCount, total),

    // คง: สองค่านี้ใช้เฉพาะการ์ดของ Admin ใน EJS
    userCount,

    // แก้ (3c): issues.publicTopics() เป็น async แล้ว — Admin route ส่งค่ามาให้
    publishedTopics,

    // แก้: คำร้องล่าสุดต้องมาจาก list ที่กรองแล้วด้วย
    latest: list.slice(0, 6),
  };
}

module.exports = {
  buildDashboardData,
};