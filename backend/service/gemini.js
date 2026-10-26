async function generateJSON({
  instructions,
  input,
  schema,
}) {
  // เพิ่ม: อ่าน Key และ Model จาก environment
  const apiKey =
    process.env.GEMINI_API_KEY?.trim();

  const model =
    process.env.GEMINI_MODEL?.trim();

  if (!apiKey) {
    throw new Error(
      "ยังไม่ได้ตั้ง GEMINI_API_KEY ใน backend/.env"
    );
  }

  if (
    !model ||
    !/^gemini-[a-z0-9.-]+$/.test(model)
  ) {
    throw new Error(
      "ตรวจ GEMINI_MODEL ใน backend/.env"
    );
  }

  // เพิ่ม: จำกัดเวลารอ ไม่ให้ API ค้างตลอดไป
  const timeout = Number(
    process.env.AI_TIMEOUT_MS || 60000
  );

  if (
    !Number.isInteger(timeout) ||
    timeout < 1000 ||
    timeout > 120000
  ) {
    throw new Error(
      "AI_TIMEOUT_MS ต้องอยู่ระหว่าง 1000–120000"
    );
  }

  const url =
    "https://generativelanguage.googleapis.com/" +
    `v1beta/models/${model}:generateContent`;

  let response;

  try {
    response = await fetch(url, {
      method: "POST",

      signal: AbortSignal.timeout(timeout),

      // เพิ่ม: ส่ง Key ใน header
      // ไม่ใส่ Key ลงใน URL หรือ frontend
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },

      body: JSON.stringify({
        // เพิ่ม: คำสั่งหลักแยกจากข้อมูลคำร้อง
        systemInstruction: {
          parts: [
            {
              text: instructions,
            },
          ],
        },

        // เพิ่ม: ส่งข้อมูลสำหรับประมวลผล
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify(input),
              },
            ],
          },
        ],

        // เพิ่ม: บังคับรูปแบบ JSON และจำกัด output
        generationConfig: {
          responseMimeType:
            "application/json",

          responseJsonSchema: schema,

          maxOutputTokens: 4096,
          candidateCount: 1,
        },
      }),
    });
  } catch (error) {
    if (
      ["TimeoutError", "AbortError"].includes(
        error.name
      )
    ) {
      throw new Error(
        "Gemini ใช้เวลานานเกินกำหนด กรุณาลองใหม่ภายหลัง"
      );
    }

    throw new Error(
      "เชื่อมต่อ Gemini ไม่สำเร็จ ตรวจอินเทอร์เน็ตของเครื่องที่รัน backend"
    );
  }

  // เพิ่ม: ไม่ retry เองอัตโนมัติ
  // เพื่อไม่วนเรียกซ้ำเมื่อโควตาหมดหรือระบบผิดพลาด
  if (!response.ok) {
    const messages = {
      400:
        "Gemini HTTP 400: ตรวจรูปแบบคำขอและความสามารถของโมเดล",

      401:
        "Gemini HTTP 401: ตรวจ API Key",

      403:
        "Gemini HTTP 403: ตรวจสิทธิ์ API Key และ Project",

      404:
        "Gemini HTTP 404: ไม่พบโมเดลหรือบัญชีนี้ยังเรียกใช้ไม่ได้",

      429:
        "Gemini HTTP 429: โควตาหรืออัตราเรียกใช้เต็ม ตรวจ Usage ใน AI Studio ก่อนลองใหม่",
    };

    throw new Error(
      messages[response.status] ||
        `Gemini HTTP ${response.status}: บริการตอบผิดพลาด`
    );
  }

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error(
      "Gemini ส่ง response ที่อ่านไม่ได้"
    );
  }

  // เพิ่ม: ไม่ใช้ผลที่ถูกบล็อก
  if (body.promptFeedback?.blockReason) {
    throw new Error(
      "Gemini ไม่ประมวลผลข้อความนี้ กรุณาตรวจเนื้อหา"
    );
  }

  const candidate = body.candidates?.[0];

  // เพิ่ม: STOP หมายถึงจบคำตอบตามปกติ
  // หากถูกตัดเพราะ output เต็ม ไม่บันทึกเป็นผลสำเร็จ
  if (
    !candidate ||
    candidate.finishReason !== "STOP"
  ) {
    throw new Error(
      "Gemini ตอบไม่สมบูรณ์หรือถูกบล็อก ยังไม่บันทึกผลนี้"
    );
  }

  // เพิ่ม: อ่านเฉพาะข้อความคำตอบ
  // ไม่เอาส่วน thought มารวมกับ JSON
  const text = (
    candidate.content?.parts || []
  )
    .filter(
      (part) =>
        !part.thought &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      "Gemini ตอบไม่ใช่ JSON ที่สมบูรณ์"
    );
  }

  // เพิ่ม: แสดงเฉพาะจำนวน tokens
  // ไม่แสดง Key หรือเนื้อหาคำร้องลง log
  const usage = body.usageMetadata || {};

  console.log("[Gemini usage]", {
    model,

    inputTokens:
      usage.promptTokenCount || 0,

    outputTokens:
      usage.candidatesTokenCount || 0,

    thinkingTokens:
      usage.thoughtsTokenCount || 0,

    totalTokens:
      usage.totalTokenCount || 0,
  });

  return result;
}

module.exports = {
  generateJSON,
};