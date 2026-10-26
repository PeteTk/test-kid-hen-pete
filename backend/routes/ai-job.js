// เพิ่ม: รับคำสั่งจาก EventBridge เพื่อเริ่ม engine AI เดิม
const express = require("express");

const {
  createHash,
  timingSafeEqual,
} = require("node:crypto");

const issues = require("../service/issues");

const router = express.Router();

// เพิ่ม: ตรวจ API Key ที่ EventBridge แนบมา
// ไม่ใช้ session หรือบัญชี Admin สำหรับเรียกงานนี้
router.use((req, res, next) => {
  const expected =
    process.env.EVENTBRIDGE_API_KEY?.trim();

  if (!expected || expected.length < 32) {
    return res.status(503).json({
      error: "EventBridge key is not configured",
    });
  }

  const supplied =
    req.get("X-EventBridge-Key") || "";

  // เพิ่ม: แปลงเป็น hash ขนาดเท่ากันก่อนเปรียบเทียบ
  const digest = value =>
    createHash("sha256")
      .update(value)
      .digest();

  if (
    !timingSafeEqual(
      digest(expected),
      digest(supplied)
    )
  ) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  next();
});

// เพิ่ม: อ่าน JSON เฉพาะ endpoint ของงาน AI
router.use(
  express.json({
    limit: "16kb",
  })
);

router.post("/batch", async (req, res, next) => {
  try {
    const event = req.body;
    const scheduledTime =
      event?.detail?.scheduledTime;

    // เพิ่ม: รับเฉพาะรูปแบบ event ที่ตั้งไว้ใน AWS
    if (
      event?.source !== "kidhen.scheduler" ||
      event?.["detail-type"] !== "KidhenWeeklyAI" ||
      typeof scheduledTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(scheduledTime) ||
      !Number.isFinite(Date.parse(scheduledTime))
    ) {
      return res.status(400).json({
        error: "Invalid schedule event",
      });
    }

    // เพิ่ม: ใช้เวลารอบเป็น ID
    // หาก AWS ส่งรอบเดิมซ้ำ จะไม่เรียก Gemini ซ้ำ
    const jobId =
      "weekly:" +
      new Date(scheduledTime).toISOString();

    const data = issues.read();

    data.eventBridgeJobs ||= {};

    const existing =
      data.eventBridgeJobs[jobId];

    if (existing) {
      return res.status(200).json({
        jobId,
        duplicate: true,
        status: existing.status,
      });
    }

    if ((await issues.dashboard()).running) {
      // เพิ่ม: ให้ EventBridge ลองส่งใหม่ตาม retry policy
      return res.status(429).json({
        error: "AI is busy",
      });
    }

    // เพิ่ม: บันทึกการรับงานก่อนเริ่ม
    data.eventBridgeJobs[jobId] = {
      status: "accepted",
      acceptedAt: new Date().toISOString(),
    };

    issues.write(data);

    // เพิ่ม: เรียกประมวลผลเดิม ไม่มี timer หรือ cron
    const work = issues.runBatch();

    work.then(
      result => {
        const latest = issues.read();

        latest.eventBridgeJobs[jobId] = {
          ...latest.eventBridgeJobs[jobId],
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          ...result,
        };

        issues.write(latest);
      },

      error => {
        const latest = issues.read();

        latest.eventBridgeJobs[jobId] = {
          ...latest.eventBridgeJobs[jobId],
          status: "failed",
          finishedAt: new Date().toISOString(),
        };

        issues.write(latest);

        console.error(
          "[EventBridge AI]",
          error.message
        );
      }
    ).catch(error => {
      console.error(
        "[EventBridge AI result]",
        error.message
      );
    });

    // เพิ่ม: ตอบรับทันที ไม่รอ Gemini ทำงานเสร็จ
    res.status(202).json({
      jobId,
      status: "accepted",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;