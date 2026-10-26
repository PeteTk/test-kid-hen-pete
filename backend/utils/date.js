// แก้ (3c): แสดงเวลาไทยเสมอ (EC2 ตั้ง timezone เป็น UTC)
const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

const PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  year: "numeric", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function bangkok(date) {
  const parts = Object.fromEntries(
    PARTS.formatToParts(new Date(date)).map((p) => [p.type, p.value])
  );
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function formatThaiDate(date) {
  const d = bangkok(date);
  return `${d.day} ${TH_MONTHS[d.month - 1]} ${d.year + 543} ${d.hour}:${d.minute} น.`;
}

// แบบสั้น เช่น 07/09/2569
function formatThaiShortDate(date) {
  const d = bangkok(date);
  return `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year + 543}`;
}

module.exports = { formatThaiDate, formatThaiShortDate, bangkok };
