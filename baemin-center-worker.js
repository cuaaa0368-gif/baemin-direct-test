"use strict";

// 추가 지사 전용 워커.
// 부모(server.js)가 지사별 CENTER_ID/KEY/NAME을 환경변수로 넘긴 뒤
// 기존 baemin-direct.js를 그대로 재사용한다.
const { startBaeminDirectCollector, getBaeminDirectStatus } = require("./baemin-direct");

const port = Number(process.env.NURION_INTERNAL_PORT || process.env.PORT || 8787);
const ingestKey = String(process.env.INGEST_KEY || "change-me-later");

function sendStatus() {
  if (typeof process.send === "function") {
    process.send({ type: "status", status: getBaeminDirectStatus() });
  }
}

startBaeminDirectCollector({ port, ingestKey })
  .then(() => {
    sendStatus();
    setInterval(sendStatus, 30_000);
  })
  .catch(err => {
    console.error("[BAEMIN CENTER WORKER START FAILED]", err.message);
    if (typeof process.send === "function") {
      process.send({ type: "error", message: err.message });
    }
    process.exitCode = 1;
  });
