// s3-upload.js — อัปโหลดรูปตรงไป S3 ด้วย pre-signed URL (3d, ใช้เมื่อ STORAGE_MODE=s3)
// ฟอร์มที่มี <input type="file" data-s3-kind="requests|avatars">:
//   กดส่ง → ขอ URL จาก /files/presign → PUT ไฟล์ไป S3 → ใส่ <input hidden name="<ชื่อเดิม>_keys"> → ส่งฟอร์ม (ไม่มีไฟล์ผ่าน EC2)
(() => {
  document.querySelectorAll("form").forEach((form) => {
    const inputs = [...form.querySelectorAll('input[type="file"][data-s3-kind]')];
    if (!inputs.length) return;

    let busy = false;
    let ready = false;

    form.addEventListener("submit", async (event) => {
      if (ready || event.defaultPrevented) return; // รอบที่สอง (หลังอัปโหลด) ส่งตามปกติ
      const withFiles = inputs.filter((input) => input.files && input.files.length);
      if (!withFiles.length) return;

      event.preventDefault();
      if (busy) return;
      busy = true;

      const button = event.submitter || form.querySelector('[type="submit"]');
      const label = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "กำลังอัปโหลดรูป...";
      }
      const added = [];

      try {
        for (const input of withFiles) {
          const files = [...input.files];
          const response = await fetch("/files/presign", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: input.dataset.s3Kind,
              files: files.map((file) => ({ type: file.type, size: file.size })),
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !Array.isArray(data.uploads)) throw new Error(data.error || "อัปโหลดรูปไม่สำเร็จ");

          for (let i = 0; i < files.length; i++) {
            const upload = data.uploads[i];
            const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: files[i] });
            if (!put.ok) throw new Error("อัปโหลดรูปไป S3 ไม่สำเร็จ กรุณาลองใหม่");

            const hidden = document.createElement("input");
            hidden.type = "hidden";
            hidden.name = `${input.name}_keys`;
            hidden.value = upload.key;
            form.appendChild(hidden);
            added.push(hidden);
          }
          input.disabled = true; // ไม่ส่งไฟล์ซ้ำผ่านเว็บ
        }

        ready = true;
        if (button) button.disabled = false;
        if (form.requestSubmit) form.requestSubmit(button || undefined);
        else form.submit();
      } catch (error) {
        added.forEach((el) => el.remove());
        withFiles.forEach((input) => (input.disabled = false));
        if (button) {
          button.disabled = false;
          button.textContent = label;
        }
        busy = false;
        window.alert(error.message);
      }
    });
  });
})();
