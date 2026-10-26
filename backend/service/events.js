// service/events.js — แจ้งว่า "สถานะคำร้องเปลี่ยน" (UC-05/07)
//
//   EVENTS_MODE=eventbridge (ค่าเริ่มต้นบน AWS):
//     เว็บ --PutEvents(Source=kidhen.app, DetailType=TicketStatusChanged)--> EventBridge --> Lambda status.py
//     Lambda เขียน notifications + ส่ง SNS ถึงทีม (ตาม diagram)
//   EVENTS_MODE=local (ค่าเริ่มต้นในเครื่อง):
//     เขียน notifications ในเว็บเลย (ตรรกะเดียวกับ status.py) ไม่ต้องต่อ AWS
//
// ถ้า PutEvents ล้ม (เช่น ไม่มีสิทธิ์) → เขียนแจ้งเตือนในเว็บแทน เพื่อไม่ให้ผู้ใช้พลาดแจ้งเตือน

const config = require("../config");
const notifications = require("../repo/notifications");

const DETAIL_TYPE = "TicketStatusChanged";

// ข้อความแจ้งเตือนตามสิ่งที่เปลี่ยน (เหมือนหน้าเว็บเดิม)
function describe(ticket, { statusChanged }) {
  let title;
  if (statusChanged && ticket.status === "เสร็จสิ้น") title = `คำร้อง ${ticket.code} ได้รับการแก้ไขแล้ว`;
  else if (statusChanged) title = `คำร้อง ${ticket.code} ได้รับการอัปเดตสถานะ`;
  else title = `คำร้อง ${ticket.code} มีข้อความจากเจ้าหน้าที่`;

  return {
    ticketId: ticket.ticketId,
    newStatus: ticket.status,
    statusChanged: Boolean(statusChanged),
    title,
    message: `สถานะ: ${ticket.status}` + (ticket.note ? ` · ${ticket.note}` : ""),
  };
}

function createEvents({ mode = config.events.mode, client, source = config.aws.eventSource } = {}) {
  let eventBridge = client || null;

  function api() {
    if (!eventBridge) {
      const { EventBridgeClient } = require("@aws-sdk/client-eventbridge");
      eventBridge = new EventBridgeClient({ region: config.aws.region });
    }
    return eventBridge;
  }

  async function ticketChanged(ticket, change) {
    const detail = describe(ticket, change);

    if (mode === "eventbridge") {
      try {
        const { PutEventsCommand } = require("@aws-sdk/client-eventbridge");
        const result = await api().send(
          new PutEventsCommand({
            Entries: [{ Source: source, DetailType: DETAIL_TYPE, Detail: JSON.stringify(detail) }],
          })
        );
        if (result.FailedEntryCount) {
          throw new Error(result.Entries?.[0]?.ErrorMessage || "PutEvents failed");
        }
        return { via: "eventbridge", detail };
      } catch (error) {
        console.error("[events] ส่ง EventBridge ไม่สำเร็จ เขียนแจ้งเตือนในเว็บแทน:", error.message);
      }
    }

    await notifications.statusChanged(ticket, detail);
    return { via: "local", detail };
  }

  return { ticketChanged, describe };
}

module.exports = { createEvents, events: createEvents(), DETAIL_TYPE, describe };
