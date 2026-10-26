// lightbox.js — กดรูปแนบแล้วดูรูปใหญ่ในหน้าเดิม (ไม่เปิดแท็บใหม่)
// ใช้กับ <a data-lightbox="กลุ่ม" href="รูป"> · ปิด: ปุ่ม ✕ / คลิกพื้นหลัง / Esc · หลายรูป: ‹ › หรือปุ่มลูกศรซ้าย-ขวา
// ไม่พึ่ง class ของ Tailwind (สไตล์อยู่ในไฟล์นี้) · ถ้า JavaScript ไม่ทำงาน ลิงก์ยังเปิดรูปได้ตามปกติ
(() => {
  const links = [...document.querySelectorAll("a[data-lightbox]")];
  if (!links.length) return;

  const css = (el, styles) => Object.assign(el.style, styles);
  const button = (text, label, styles) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    css(b, {
      position: "absolute", border: "0", borderRadius: "9999px", cursor: "pointer",
      background: "rgba(255,255,255,0.9)", color: "#111", fontSize: "22px", lineHeight: "1",
      width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center",
      ...styles,
    });
    return b;
  };

  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "รูปภาพแนบ");
  css(overlay, {
    position: "fixed", inset: "0", zIndex: "1000", display: "none",
    alignItems: "center", justifyContent: "center", padding: "56px 16px",
    background: "rgba(0,0,0,0.85)",
  });

  const img = document.createElement("img");
  img.alt = "รูปภาพแนบ";
  css(img, { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "8px", background: "#fff" });

  const counter = document.createElement("p");
  css(counter, { position: "absolute", bottom: "16px", left: "0", right: "0", textAlign: "center", color: "#fff", fontSize: "14px", margin: "0" });

  const close = button("✕", "ปิด", { top: "12px", right: "12px" });
  const prev = button("‹", "รูปก่อนหน้า", { left: "12px", top: "50%", transform: "translateY(-50%)" });
  const next = button("›", "รูปถัดไป", { right: "12px", top: "50%", transform: "translateY(-50%)" });

  overlay.append(img, close, prev, next, counter);
  document.body.appendChild(overlay);

  let group = [];
  let index = 0;
  let lastFocus = null;

  function show(i) {
    index = (i + group.length) % group.length;
    img.src = group[index].href;
    const many = group.length > 1;
    prev.style.display = next.style.display = many ? "flex" : "none";
    counter.textContent = many ? `${index + 1} / ${group.length}` : "";
  }

  function open(link) {
    group = links.filter((l) => l.dataset.lightbox === link.dataset.lightbox);
    lastFocus = document.activeElement;
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
    show(group.indexOf(link));
    close.focus();
  }

  function hide() {
    overlay.style.display = "none";
    document.body.style.overflow = "";
    img.removeAttribute("src");
    if (lastFocus) lastFocus.focus();
  }

  links.forEach((link) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      open(link);
    })
  );
  close.addEventListener("click", hide);
  prev.addEventListener("click", (e) => { e.stopPropagation(); show(index - 1); });
  next.addEventListener("click", (e) => { e.stopPropagation(); show(index + 1); });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (overlay.style.display === "none") return;
    if (event.key === "Escape") hide();
    else if (event.key === "ArrowLeft" && group.length > 1) show(index - 1);
    else if (event.key === "ArrowRight" && group.length > 1) show(index + 1);
  });
})();
