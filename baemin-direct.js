"use strict";

/*
 * Nurion / Baemin direct collector
 *
 * 목적:
 * - 기존 Tampermonkey가 하던 "배민 API 수집 -> Rider Control ingest" 부분만
 *   Render 서버 내부로 옮긴다.
 * - 기존 rider-control API / 프론트 / 데이터 가공 구조는 그대로 사용한다.
 * - 로그인된 관제에서 전달받은 BAEMIN_COOKIE + BAEMIN_CENTER_ID를 사용한다.
 * - 응답 Set-Cookie가 오면 프로세스 메모리의 cookie jar를 갱신한다.
 *
 * 주의:
 * - 최초 배민 로그인/SMS 인증을 자동화하지 않는다.
 * - 쿠키 값은 로그/API에 절대 출력하지 않는다.
 */

const API_BASE = String(
  process.env.BAEMIN_API_BASE ||
  "https://api-deliverycenter.baemin.com"
).replace(/\/$/, "");

const CENTER_ID = String(process.env.BAEMIN_CENTER_ID || "").trim();
const INITIAL_COOKIE = String(process.env.BAEMIN_COOKIE || "").trim();
const CENTER_KEY = String(process.env.BAEMIN_CENTER_KEY || "seocho").trim() || "seocho";
const CENTER_NAME = String(process.env.BAEMIN_CENTER_NAME || "서초").trim() || "서초";

const LIVE_MS = Math.max(
  30_000,
  Number(process.env.BAEMIN_POLL_MS || 30_000) || 30_000
);

const WEEKLY_MS = Math.max(
  30_000,
  Number(process.env.BAEMIN_WEEKLY_MS || 30_000) || 30_000
);

const CENTER_CHECK_MS = Math.max(
  60_000,
  Number(process.env.BAEMIN_CENTER_CHECK_MS || 5 * 60_000) || 5 * 60_000
);

const RUNNER_OFFSET = Number(process.env.BAEMIN_RUNNER_OFFSET || 0) || 0;
const HISTORY_CACHE_MS = Math.max(
  60_000,
  Number(process.env.BAEMIN_HISTORY_CACHE_MS || 5 * 60_000) || 5 * 60_000
);
const HISTORY_ON_START = String(process.env.BAEMIN_HISTORY_ON_START || "1") !== "0";
const DIRECT_ENABLED = String(process.env.BAEMIN_DIRECT_ENABLED || "1") !== "0";
// 장기 이력 백필: 최근 90일 운영 수집과 분리해 오래된 구간만 천천히 채운다.
const HISTORY_BACKFILL_ENABLED = String(process.env.BAEMIN_HISTORY_BACKFILL_ENABLED || "1") !== "0";
const HISTORY_BACKFILL_MONTHS = Math.max(12, Math.min(24, Number(process.env.BAEMIN_HISTORY_BACKFILL_MONTHS || 24) || 24));
const HISTORY_BACKFILL_BATCH_DAYS = Math.max(1, Math.min(5, Number(process.env.BAEMIN_HISTORY_BACKFILL_BATCH_DAYS || 5) || 5));
const HISTORY_BACKFILL_INTERVAL_MS = Math.max(5 * 60_000, Number(process.env.BAEMIN_HISTORY_BACKFILL_INTERVAL_MS || 5 * 60_000) || 5 * 60_000);

const USER_AGENT =
  process.env.BAEMIN_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36";

const cookieJar = new Map();
const historyCache = new Map();

const state = {
  enabled: false,
  configured: false,
  centerKey: CENTER_KEY,
  centerName: CENTER_NAME,
  centerIdConfigured: Boolean(CENTER_ID),
  cookieConfigured: Boolean(INITIAL_COOKIE),
  cookieNames: [],
  liveIntervalMs: LIVE_MS,
  weeklyIntervalMs: WEEKLY_MS,
  startedAt: null,
  authRequired: false,
  lastCenterCheck: null,
  lastLive: null,
  lastWeekly: null,
  lastReject: null,
  lastHistory: null,
  counters: {
    baeminRequests: 0,
    baeminSuccess: 0,
    authFailures: 0,
    liveSyncs: 0,
    weeklySyncs: 0,
    rejectSyncs: 0,
    historySyncs: 0,
    historyBackfillBatches: 0
  }
};

let internalBase = "";
let internalIngestKey = "";
let started = false;
let liveRunning = false;
let weeklyRunning = false;
let historyRunning = false;
let historyBackfillRunning = false;
let historyBackfillComplete = false;
let lastLiveSnapshot = null;
let lastLiveSnapshotAt = 0;

const KOREAN_HOLIDAYS = new Set([
  // 2026년 공식 월력요항 + 기존 운영상 선거일. 공휴일은 일요일 목표를 적용한다.
  "2026-01-01",
  "2026-02-16", "2026-02-17", "2026-02-18",
  "2026-03-01", "2026-03-02",
  "2026-05-05", "2026-05-24", "2026-05-25",
  "2026-06-03", "2026-06-06",
  "2026-08-15", "2026-08-17",
  "2026-09-24", "2026-09-25", "2026-09-26",
  "2026-10-03", "2026-10-05", "2026-10-09",
  "2026-12-25"
]);

const NAME_MAP = {
  "JINXING": "김철",
  "LIU DONGRI": "류동일",
  "LIXIANGYU": "이상우",
  "LI XIANGYU": "이상우",
  "ZHANG WEI": "장위",
  "왕수얜": "김수연",
  "SHENXIANGJI": "선상지",
  "LISHENGTAI": "이성태",
  "XUJIE": "서지",
  "CAI XIHU": "강시후",
  "CUITAIGUANG": "최태광",
  "ANCHENGGUO": "김민준",
  "BIAN DONGXIAN": "박지훈",
  "CUIMINGYUE": "이도윤",
  "GAOPENG": "정우진",
  "HEJINHUA": "김성현",
  "HELIMING": "김성지",
  "HONG MEI": "박서준",
  "JIANG CHENG ZHE": "김도윤",
  "JIN SHUNAI": "최성민",
  "JIN ZHONGGUO": "박준영",
  "JINGUIYU": "이준혁",
  "LI SHENGHU": "정민호",
  "LI XIANGGUO": "김영준",
  "LIHONGGUANG": "박민석",
  "NAN HAOYONG": "최동훈",
  "PIAORENZHE": "김상우",
  "PIAOZHENSHI": "이재훈",
  "QUANJUN": "박준서",
  "SHENCHANGCHUN": "김성훈",
  "WEN GUANGJIE": "정지훈",
  "YIN WENXUE": "김현수",
  "ZHANGQIAN": "이도현",
  "CUISHIDONG": "이상훈",
  "JIN YONGZHE": "김태훈",
  "LIUSONGHE": "박성민",
  "QUAN ZAIGEN": "장효식",
  "ZHENG HUAFEN": "박지헌",
  "ZHIFENGBO": "김준호",
  "XUAN YU": "현우",
  "ZHOUYUAN": "이준호"
};

function safe(n) {
  return Number(n) || 0;
}

// 과거 배민 응답은 slaOutComplete에 -totalComplete 형태의 보정값을 넣기도 했다.
// 누리온에서 시간외 완료는 0 이상의 실제 완료건수만 인정한다.
function safeOut(n) {
  return Math.max(0, safe(n));
}

function mapName(name) {
  if (!name) return name;
  const key = String(name).replace(/\s+/g, " ").trim().toUpperCase();
  return NAME_MAP[key] || name;
}

function loadCookieHeader(header) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) cookieJar.set(name, value);
  }
  refreshCookieNames();
}

function buildCookieHeader() {
  return [...cookieJar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function getBaeminCookieHeader() {
  return buildCookieHeader();
}

function updateBaeminSession(cookieHeader) {
  const cookie = String(cookieHeader || "").trim();

  if (!cookie) {
    throw new Error("적용할 배민 세션 쿠키가 없습니다.");
  }

  loadCookieHeader(cookie);
  state.authRequired = false;

  return {
    ok: true,
    cookieNames: [...cookieJar.keys()].sort()
  };
}

function refreshCookieNames() {
  state.cookieNames = [...cookieJar.keys()].sort();
}

function parseOneSetCookie(raw) {
  const parts = String(raw || "")
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);

  if (!parts.length) return null;

  const first = parts[0];
  const i = first.indexOf("=");
  if (i <= 0) return null;

  const name = first.slice(0, i).trim();
  const value = first.slice(i + 1);

  let expired = false;

  for (const attr of parts.slice(1)) {
    const lower = attr.toLowerCase();
    if (lower === "max-age=0" || lower.startsWith("max-age=0")) {
      expired = true;
    }
    if (lower.startsWith("expires=")) {
      const date = new Date(attr.slice(8));
      if (!Number.isNaN(date.getTime()) && date.getTime() <= Date.now()) {
        expired = true;
      }
    }
  }

  return { name, value, expired };
}

function mergeSetCookies(response) {
  let values = [];

  try {
    if (typeof response.headers.getSetCookie === "function") {
      values = response.headers.getSetCookie();
    }
  } catch {}

  if (!values.length) {
    const one = response.headers.get("set-cookie");
    if (one) values = [one];
  }

  const changed = [];

  for (const raw of values) {
    const parsed = parseOneSetCookie(raw);
    if (!parsed?.name) continue;

    if (parsed.expired) {
      cookieJar.delete(parsed.name);
      changed.push(`${parsed.name}(deleted)`);
    } else {
      cookieJar.set(parsed.name, parsed.value);
      changed.push(parsed.name);
    }
  }

  if (changed.length) refreshCookieNames();
  return changed;
}

function kstParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

function formatDateUTC(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseDateKey(key) {
  const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`잘못된 날짜: ${key}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function addDaysKey(key, days) {
  const d = parseDateKey(key);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return formatDateUTC(d);
}

function compareDateKey(a, b) {
  return String(a).localeCompare(String(b));
}

function getBusinessDateKey(now = new Date()) {
  const p = kstParts(now);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (p.hour < 6) d.setUTCDate(d.getUTCDate() - 1);
  return formatDateUTC(d);
}

function startOfWednesdayKey(key) {
  const d = parseDateKey(key);
  const diff = (d.getUTCDay() - 3 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return formatDateUTC(d);
}

function dateKeysBetween(start, end) {
  const out = [];
  let cur = start;
  while (compareDateKey(cur, end) <= 0) {
    out.push(cur);
    cur = addDaysKey(cur, 1);
  }
  return out;
}

function koreanWeekday(key) {
  return [
    "일요일",
    "월요일",
    "화요일",
    "수요일",
    "목요일",
    "금요일",
    "토요일"
  ][parseDateKey(key).getUTCDay()];
}

function getGoal(type) {
  const businessKey = getBusinessDateKey();
  const date = parseDateKey(businessKey);
  let day = date.getUTCDay();

  if (businessKey === "2026-07-17") day = 6;
  if (KOREAN_HOLIDAYS.has(businessKey)) day = 0;

  const goals = {
    morning: { monThu: 19, fri: 21, sat: 27, sun: 29 },
    afternoon: { monThu: 18, fri: 21, sat: 22, sun: 22 },
    evening: { monThu: 30, fri: 32, sat: 36, sun: 35 },
    night: { monThu: 23, fri: 26, sat: 25, sun: 24 }
  };

  const g = goals[type];
  if (!g) return 0;

  let goal;
  if ([1, 2, 3, 4].includes(day)) goal = g.monThu;
  else if (day === 5) goal = g.fri;
  else if (day === 6) goal = g.sat;
  else goal = g.sun;

  return goal * 10;
}

function requestHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "center-id": CENTER_ID,
    cookie: buildCookieHeader(),
    origin: "https://deliverycenter.baemin.com",
    referer: "https://deliverycenter.baemin.com/",
    "user-agent": USER_AGENT
  };
}

async function callBaeminPost(path, body) {
  const startedAt = Date.now();
  state.counters.baeminRequests++;

  const headers = {
    ...requestHeaders()
  };

  const options = {
    method: "POST",
    headers,
    redirect: "manual"
  };

  // /phone-verification 은 body 없이 호출
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, options);
  } catch (error) {
    const e = new Error(`배민 API 연결 실패: ${error.message}`);
    e.cause = error;
    throw e;
  }

  // /login 성공 시 새 CENTER_SESSION도 기존 cookieJar에 자동 반영
  const changedCookies = mergeSetCookies(response);

  const text = await response.text();
  let responseBody = null;

  try {
    responseBody = text ? JSON.parse(text) : null;
  } catch {}

  const result = {
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    body: responseBody,
    textLength: text.length,
    location: response.headers.get("location") || null,
    changedCookies
  };

  if (response.ok) {
    state.counters.baeminSuccess++;
  } else if (response.status === 401 || response.status === 403) {
    state.counters.authFailures++;
    state.authRequired = true;
  }

  return result;
}

async function requestPhoneVerification() {
  const result = await callBaeminPost(
    "/phone-verification",
    undefined
  );

  if (!result.ok) {
    throw httpError("인증번호 발송 실패", result);
  }

  return result;
}

async function submitPhoneVerification(verificationCode) {
  const code = String(verificationCode || "").trim();

  if (!/^\d{6}$/.test(code)) {
    throw new Error("인증번호는 6자리 숫자여야 합니다.");
  }

  const result = await callBaeminPost(
    "/login",
    {
      verificationCode: code
    }
  );

  if (!result.ok) {
    throw httpError("문자인증 로그인 실패", result);
  }

  // /login 응답의 Set-Cookie가 mergeSetCookies()를 통해
  // cookieJar에 반영된 뒤에만 인증 성공 처리
  state.authRequired = false;

  return result;
}

async function callBaemin(path) {
  const startedAt = Date.now();
  state.counters.baeminRequests++;

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers: requestHeaders(),
      redirect: "manual"
    });
  } catch (error) {
    const e = new Error(`배민 API 연결 실패: ${error.message}`);
    e.cause = error;
    throw e;
  }

  const changedCookies = mergeSetCookies(response);

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}

  const result = {
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    body,
    textLength: text.length,
    location: response.headers.get("location") || null,
    changedCookies
  };

  if (response.ok) {
    state.counters.baeminSuccess++;
    state.authRequired = false;
  } else if (response.status === 401 || response.status === 403) {
    state.counters.authFailures++;
    state.authRequired = true;
  }

  return result;
}

function httpError(label, result) {
  const error = new Error(`${label}: HTTP ${result.status}`);
  error.status = result.status;
  error.authRequired = result.status === 401 || result.status === 403;
  return error;
}

async function requireJson(path, label) {
  const result = await callBaemin(path);
  if (!result.ok) throw httpError(label, result);
  if (!result.body || typeof result.body !== "object") {
    throw new Error(`${label}: JSON 응답 없음`);
  }
  return { result, body: result.body };
}

async function fetchDeliveryAll({ allowRecent = true } = {}) {
  if (
    allowRecent &&
    lastLiveSnapshot &&
    Date.now() - lastLiveSnapshotAt < 3_000
  ) {
    return lastLiveSnapshot;
  }

  let page = 0;
  let totalPage = 1;
  const list = [];
  let total = {};

  while (page < totalPage) {
    const { body } = await requireJson(
      `/v4/management/delivery-status?page=${page}&size=100`,
      `delivery-status page=${page}`
    );

    if (Array.isArray(body.data)) list.push(...body.data);
    if (page === 0) total = body.deliveryStatusTotalResponse || {};

    const pages = Number(body.totalPage);
    totalPage = Number.isFinite(pages) && pages > 0 ? pages : 1;
    page++;
  }

  const snapshot = { list, total };
  lastLiveSnapshot = snapshot;
  lastLiveSnapshotAt = Date.now();
  return snapshot;
}

async function fetchTodayMap({ allowRecent = true } = {}) {
  const { list } = await fetchDeliveryAll({ allowRecent });
  const map = new Map();

  for (const row of list) {
    const userId = String(row?.userId || "").trim();
    if (userId) map.set(userId, row);
  }

  return map;
}

async function fetchDateMap(apiDate) {
  const cached = historyCache.get(apiDate);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.map;
  }

  let page = 0;
  let totalPage = 1;
  const all = [];
  let complete = true;

  while (page < totalPage) {
    const result = await callBaemin(
      `/v4/management/rider-delivery-status?page=${page}&size=100&fromDate=${encodeURIComponent(apiDate)}&toDate=${encodeURIComponent(apiDate)}`
    );

    // 인증 만료는 숨기면 안 된다. 전체 수집기를 인증 필요 상태로 올린다.
    if (result.status === 401 || result.status === 403) {
      throw httpError(
        `rider-delivery-status ${apiDate} page=${page}`,
        result
      );
    }

    // 기존 Tampermonkey fetchDateMap과 동일한 동작:
    // 특정 날짜 조회가 400 등으로 아직 제공되지 않으면 그 날짜만 빈 map으로 처리하고
    // 주간/거절/90일 전체 동기화는 계속 진행한다.
    if (!result.ok) {
      complete = false;
      console.warn(
        `[BAEMIN DATE] SKIP ${apiDate} page=${page} HTTP ${result.status}`
      );
      break;
    }

    const body = result.body;
    if (!body || typeof body !== "object") {
      complete = false;
      console.warn(
        `[BAEMIN DATE] SKIP ${apiDate} page=${page} JSON 없음`
      );
      break;
    }

    if (Array.isArray(body.data)) all.push(...body.data);

    const pages = Number(body.totalPage);
    totalPage = Number.isFinite(pages) && pages > 0 ? pages : 1;
    page++;
  }

  const map = new Map();
  for (const row of all) {
    const userId = String(row?.userId || "").trim();
    if (userId) map.set(userId, row);
  }

  // 날짜 조회 가능 여부를 다음 점검시간에 추측 없이 확인하기 위한 최소 진단 로그.
  // 개인정보/인증정보는 기록하지 않는다.
  console.log(`[BAEMIN DATE] ${complete ? "OK" : "INCOMPLETE"} apiDate=${apiDate} riders=${map.size}`);

  // 정상 완료한 과거 날짜만 장기 캐시한다.
  // 400으로 아직 제공되지 않은 날짜는 다음 주기에서 다시 확인할 수 있게 캐시하지 않는다.
  if (complete) {
    historyCache.set(apiDate, {
      map,
      expiresAt: Date.now() + HISTORY_CACHE_MS
    });
  }

  return map;
}

async function postInternal(route, payload) {
  const response = await fetch(`${internalBase}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-key": internalIngestKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`내부 ingest 실패 ${route}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  return response;
}

async function postInternalJson(route, payload = {}) {
  const response = await postInternal(route, payload);
  return response.json();
}

const waitMs = ms => new Promise(resolve => setTimeout(resolve, ms));


function buildLivePayload(snapshot) {
  const { list, total } = snapshot;

  const peaks = {
    morning: 0,
    afternoon: 0,
    evening: 0,
    night: 0
  };

  for (const d of list) {
    const p = d.deliveryPeakTimeCount || {};
    peaks.morning += safe(p.morning);
    peaks.afternoon += safe(p.afternoon);
    peaks.evening += safe(p.evening);
    peaks.night += safe(p.midnight);
  }

  const completed = safe(total?.totalFoodCompleted);
  const rejected = safe(total?.totalFoodRejected);
  const canceled = safe(total?.totalFoodCanceled);
  const riderFault = safe(total?.totalFoodRiderFault);
  const denominator = completed + rejected + canceled + riderFault;

  const riders = list.map(d => {
    const a = d.deliveryAcceptanceCount || {};
    const p = d.deliveryPeakTimeCount || {};
    const foodComplete = safe(a.foodComplete);
    const bmartComplete = safe(a.bmartComplete);
    const storeComplete = safe(a.storeComplete);
    const slaOutComplete = safeOut(a.slaOutComplete);
    const nurionTotal = foodComplete + bmartComplete + storeComplete + slaOutComplete;
    return {
      name: mapName(d.name),
      phoneNumber: d.phoneNumber || "",
      userId: d.userId || "",
      status: d.status?.code || "",
      // 누리온의 모든 '총 완료'는 4개 유형 합산을 단일 기준으로 사용한다.
      allDayComplete: nurionTotal,
      sourceAllDayComplete: safe(a.allDayComplete),
      foodComplete,
      bmartComplete,
      storeComplete,
      slaOutComplete,
      foodReject: safe(a.foodReject),
      deliveryPeakTimeCount: { ...p },
      hourlyCompleted: Array.isArray(d.hourlyCompleted) ? d.hourlyCompleted : [],
      morning: safe(p.morning),
      afternoon: safe(p.afternoon),
      evening: safe(p.evening),
      night: safe(p.midnight)
    };
  });

  const ranking = riders
    .filter(r => r.allDayComplete > 0)
    .sort((a, b) => b.allDayComplete - a.allDayComplete)
    .map(r => ({ name: r.name, val: r.allDayComplete }));

  const eveningRanking = riders
    .filter(r => r.evening > 0)
    .sort((a, b) => b.evening - a.evening)
    .slice(0, 10)
    .map(r => ({ name: r.name, val: r.evening }));

  const realRunCount = list.filter(d => d.status?.code === "DELIVERING").length;

  return {
    centerName: CENTER_NAME,
    sentAt: new Date().toISOString(),
    summary: {
      runCount: realRunCount + RUNNER_OFFSET,
      completed,
      rejectRate: denominator
        ? (((rejected + canceled + riderFault) / denominator) * 100).toFixed(2)
        : "0.00"
    },
    peaks,
    goals: {
      morning: getGoal("morning"),
      afternoon: getGoal("afternoon"),
      evening: getGoal("evening"),
      night: getGoal("night")
    },
    ranking,
    eveningRanking,
    riders
  };
}

async function collectWeekMaps() {
  const today = getBusinessDateKey();
  const wed = startOfWednesdayKey(today);
  const days = [];

  for (const businessDate of dateKeysBetween(wed, today)) {
    let map;

    if (businessDate === today) {
      map = await fetchTodayMap({ allowRecent: true });
    } else {
      map = await fetchDateMap(businessDate);
    }

    days.push({
      date: businessDate,
      weekday: koreanWeekday(businessDate),
      map
    });
  }

  return { today, wed, days };
}

function buildWeeklyPayload(week) {
  const weeklyMap = new Map();

  function ensureRider(r) {
    if (!r) return null;
    const userId = String(r.userId || "").trim();
    if (!userId) return null;

    if (!weeklyMap.has(userId)) {
      weeklyMap.set(userId, {
        userId,
        name: String(r.name || "").trim(),
        days: {},
        weeklyTotal: 0
      });
    }

    return weeklyMap.get(userId);
  }

  for (const day of week.days) {
    day.map.forEach(r => {
      const item = ensureRider(r);
      if (!item) return;

      const a = r.deliveryAcceptanceCount || {};
      const total =
        safe(a.foodComplete) +
        safe(a.bmartComplete) +
        safe(a.storeComplete) +
        safeOut(a.slaOutComplete);

      item.days[day.weekday] = total;
      item.weeklyTotal += total;
    });
  }

  const weeklyDetails = [...weeklyMap.values()]
    .sort((a, b) => b.weeklyTotal - a.weeklyTotal);

  const weeklyRankingMap = new Map();

  for (const day of week.days) {
    day.map.forEach(r => {
      const userId = String(r.userId || "").trim();
      const name = String(r.name || "").trim();
      if (!userId) return;

      if (!weeklyRankingMap.has(userId)) {
        weeklyRankingMap.set(userId, { userId, name, val: 0 });
      }

      // 주간 상세와 TOP5가 서로 다른 기준을 쓰면 몇 건씩 오차가 생긴다.
      // 누리온의 "전체 완료" 기준(음식+B마트+스토어+시간외)으로 하나로 통일한다.
      const a = r.deliveryAcceptanceCount || {};
      weeklyRankingMap.get(userId).val +=
        safe(a.foodComplete) +
        safe(a.bmartComplete) +
        safe(a.storeComplete) +
        safeOut(a.slaOutComplete);
    });
  }

  const weeklyRanking = [...weeklyRankingMap.values()]
    .sort((a, b) => b.val - a.val)
    .slice(0, 5);

  const todayMap = week.days.length
    ? week.days[week.days.length - 1].map
    : new Map();

  const todayRanking = [];

  todayMap.forEach(r => {
    const a = r.deliveryAcceptanceCount || {};
    const food = safe(a.foodComplete);
    const bmart = safe(a.bmartComplete);
    const store = safe(a.storeComplete);
    const out = safeOut(a.slaOutComplete);
    todayRanking.push({
      userId: String(r.userId || ""),
      name: String(r.name || ""),
      val: food + bmart + store + out,
      food, bmart, store, out
    });
  });

  todayRanking.sort((a, b) => b.val - a.val);

  const todayTop7 = todayRanking.slice(0, 7);
  const todayDetails = todayRanking.map(r => ({ ...r }));

  const eveningRanking = [];

  todayMap.forEach(r => {
    eveningRanking.push({
      userId: String(r.userId || ""),
      name: String(r.name || ""),
      val: safe(r.deliveryPeakTimeCount?.evening)
    });
  });

  eveningRanking.sort((a, b) => b.val - a.val);

  return {
    centerName: CENTER_NAME,
    weekStart: week.wed,
    weeklyDetails,
    weeklyRanking,
    todayRanking: todayTop7,
    todayDetails,
    eveningRanking: eveningRanking.slice(0, 10)
  };
}

function rejectExcludeDates() {
  const values = String(process.env.BAEMIN_REJECT_EXCLUDE_DATES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return new Set(values);
}

function buildRejectPayload(week) {
  const excludes = rejectExcludeDates();
  const riders = new Map();
  const dailyRejectData = [];

  function addRider(r) {
    if (!r) return null;
    const userId = String(r.userId || "").trim();
    if (!userId) return null;

    if (!riders.has(userId)) {
      riders.set(userId, {
        userId,
        name: String(r.name || "").trim(),
        complete: 0,
        reject: 0,
        cancel: 0,
        rejectCancel: 0
      });
    }

    return riders.get(userId);
  }

  for (const day of week.days) {
    // 기존 Tampermonkey와 동일: 제외일은 "과거 날짜"에만 적용하고 오늘은 포함.
    if (day.date !== week.today && excludes.has(day.date)) continue;

    day.map.forEach(r => {
      const item = addRider(r);
      if (!item) return;

      const complete = safe(r.deliveryAcceptanceCount?.foodComplete);
      const reject = safe(r.deliveryAcceptanceCount?.foodReject);
      const cancel = safe(r.deliveryAcceptanceCount?.foodCancel);

      dailyRejectData.push({
        date: day.date,
        userId: String(r.userId || "").trim(),
        name: String(r.name || "").trim(),
        complete,
        reject,
        cancel
      });

      item.complete += complete;
      item.reject += reject;
      item.cancel += cancel;
      item.rejectCancel += reject + cancel;
    });
  }

  const list = [...riders.values()].map(r => {
    const total = r.complete + r.rejectCancel;
    return {
      ...r,
      rejectRate: total > 0
        ? Number(((r.rejectCancel / total) * 100).toFixed(1))
        : 0
    };
  });

  return {
    centerName: CENTER_NAME,
    type: "weeklyReject",
    weekStart: week.wed,
    riderCount: list.length,
    riders: list,
    dailyRejectData,
    sentAt: new Date().toISOString()
  };
}

function historyRow(businessDate, r) {
  const a = r.deliveryAcceptanceCount || {};
  const p = r.deliveryPeakTimeCount || {};

  return {
    date: businessDate,
    userId: String(r.userId || "").trim(),
    name: String(r.name || "").trim(),
    deliveryAcceptanceCount: { ...a },
    deliveryPeakTimeCount: { ...p },
    totalComplete: safe(a.foodComplete) + safe(a.bmartComplete) + safe(a.storeComplete) + safeOut(a.slaOutComplete),
    totalReject: safe(a.totalReject),
    totalCancel: safe(a.totalCancel),
    totalRiderFault: safe(a.totalRiderFault),
    food: safe(a.foodComplete),
    bmart: safe(a.bmartComplete),
    store: safe(a.storeComplete),
    out: safeOut(a.slaOutComplete),
    allDay: safe(a.foodComplete) + safe(a.bmartComplete) + safe(a.storeComplete) + safeOut(a.slaOutComplete),
    total: safe(a.foodComplete) + safe(a.bmartComplete) + safe(a.storeComplete) + safeOut(a.slaOutComplete),
    morning: safe(p.morning),
    afternoon: safe(p.afternoon),
    evening: safe(p.evening),
    midnight: safe(p.midnight),
    reject: safe(a.totalReject),
    cancel: safe(a.totalCancel),
    riderFault: safe(a.totalRiderFault),
    hourlyCompleted: Array.isArray(r.hourlyCompleted) ? r.hourlyCompleted : []
  };
}

function buildDailyDetailPayload(week) {
  const rows = [];
  for (const day of week.days) {
    day.map.forEach(r => rows.push(historyRow(day.date, r)));
  }
  return {
    centerKey: CENTER_KEY,
    centerName: CENTER_NAME,
    fromDate: week.wed,
    toDate: week.today,
    dayCount: week.days.length,
    rows,
    generatedAt: new Date().toISOString()
  };
}

async function buildHistoryPayload() {
  const today = getBusinessDateKey();
  const fromDate = addDaysKey(today, -89);
  const rows = [];
  const days = dateKeysBetween(fromDate, today);

  let index = 0;

  for (const businessDate of days) {
    let map;

    if (businessDate === today) {
      map = await fetchTodayMap({ allowRecent: true });
    } else {
      map = await fetchDateMap(businessDate);
    }

    map.forEach(r => rows.push(historyRow(businessDate, r)));

    index++;
    if (index === 1 || index % 10 === 0 || index === days.length) {
      console.log(
        `[BAEMIN HISTORY] ${index}/${days.length} ${businessDate} rows=${rows.length}`
      );
    }
  }

  return {
    centerKey: CENTER_KEY,
    centerName: CENTER_NAME,
    fromDate,
    toDate: today,
    dayCount: days.length,
    rows,
    generatedAt: new Date().toISOString()
  };
}

function summarizeError(error) {
  return {
    at: new Date().toISOString(),
    ok: false,
    status: Number(error?.status) || 0,
    authRequired: Boolean(error?.authRequired),
    message: String(error?.message || error || "오류")
  };
}

async function checkCenter() {
  try {
    const result = await callBaemin("/v2/center");

    state.lastCenterCheck = {
      at: new Date().toISOString(),
      ok: result.ok,
      status: result.status,
      durationMs: result.durationMs,
      changedCookieNames: result.changedCookies
    };

    console.log(
      `[BAEMIN CENTER] ${result.status} ${result.ok ? "OK" : "FAIL"} ${result.durationMs}ms` +
      (result.changedCookies.length
        ? ` Set-Cookie=${result.changedCookies.join(",")}`
        : "")
    );

    return result.ok;
  } catch (error) {
    state.lastCenterCheck = summarizeError(error);
    console.error("[BAEMIN CENTER]", error.message);
    return false;
  }
}

async function syncLive() {
  if (liveRunning || !state.enabled) return;
  liveRunning = true;

  try {
    const snapshot = await fetchDeliveryAll({ allowRecent: false });
    const payload = buildLivePayload(snapshot);

    await postInternal(
      `/api/ingest/${encodeURIComponent(CENTER_KEY)}`,
      payload
    );

    state.counters.liveSyncs++;
    state.lastLive = {
      at: new Date().toISOString(),
      ok: true,
      riders: snapshot.list.length,
      runCount: payload.summary.runCount
    };

    console.log(
      `[BAEMIN LIVE] OK riders=${snapshot.list.length} running=${payload.summary.runCount} ` +
      `peaks=${payload.peaks.morning}/${payload.peaks.afternoon}/${payload.peaks.evening}/${payload.peaks.night} ` +
      `goals=${payload.goals.morning}/${payload.goals.afternoon}/${payload.goals.evening}/${payload.goals.night}`
    );
  } catch (error) {
    state.lastLive = summarizeError(error);
    console.error("[BAEMIN LIVE] FAIL", error.message);
  } finally {
    liveRunning = false;
  }
}

async function syncWeeklyReject() {
  if (weeklyRunning || !state.enabled) return;
  weeklyRunning = true;

  try {
    const week = await collectWeekMaps();
    const weeklyPayload = buildWeeklyPayload(week);
    const rejectPayload = buildRejectPayload(week);
    const dailyDetailPayload = buildDailyDetailPayload(week);

    await postInternal(
      `/api/ingest-weekly/${encodeURIComponent(CENTER_KEY)}`,
      weeklyPayload
    );

    state.counters.weeklySyncs++;
    state.lastWeekly = {
      at: new Date().toISOString(),
      ok: true,
      weekStart: week.wed,
      riders: weeklyPayload.weeklyDetails.length,
      weeklyRanking: weeklyPayload.weeklyRanking.length,
      todayRanking: weeklyPayload.todayRanking.length,
      eveningRanking: weeklyPayload.eveningRanking.length
    };

    await postInternal(
      `/api/ingest-reject/${encodeURIComponent(CENTER_KEY)}`,
      rejectPayload
    );

    await postInternal(
      `/api/ingest-daily-detail/${encodeURIComponent(CENTER_KEY)}`,
      dailyDetailPayload
    );

    state.counters.rejectSyncs++;
    state.lastReject = {
      at: new Date().toISOString(),
      ok: true,
      weekStart: week.wed,
      riders: rejectPayload.riders.length,
      rows: rejectPayload.dailyRejectData.length
    };

    console.log(
      `[BAEMIN WEEKLY] OK week=${week.wed} riders=${weeklyPayload.weeklyDetails.length} ` +
      `top=${weeklyPayload.weeklyRanking.length}/${weeklyPayload.todayRanking.length}/${weeklyPayload.eveningRanking.length}`
    );
    console.log(
      `[BAEMIN REJECT] OK riders=${rejectPayload.riders.length} rows=${rejectPayload.dailyRejectData.length}`
    );
    console.log(
      `[LOGIN READY] rider default login source ready: ${rejectPayload.riders.length} riders`
    );
  } catch (error) {
    const info = summarizeError(error);
    state.lastWeekly = info;
    state.lastReject = info;
    console.error("[BAEMIN WEEKLY/REJECT] FAIL", error.message);
  } finally {
    weeklyRunning = false;
  }
}

async function syncHistory() {
  if (historyRunning || !state.enabled) return;
  historyRunning = true;

  try {
    // Render 프록시의 요청 본문 한도를 넘지 않도록 90일 전체를 한 번에
    // 보내지 않고 날짜 단위로 묶어 분할 전송한다.
    const today = getBusinessDateKey();
    const fromDate = addDaysKey(today, -89);
    const days = dateKeysBetween(fromDate, today);
    const HISTORY_BATCH_DAYS = Math.max(
      1,
      Math.min(10, Number(process.env.BAEMIN_HISTORY_BATCH_DAYS || 5) || 5)
    );

    let totalRows = 0;
    let batchRows = [];
    let batchStartDate = null;
    let batchNumber = 0;
    const totalBatches = Math.ceil(days.length / HISTORY_BATCH_DAYS);

    for (let i = 0; i < days.length; i++) {
      const businessDate = days[i];
      let map;

      if (businessDate === today) {
        map = await fetchTodayMap({ allowRecent: true });
      } else {
        map = await fetchDateMap(businessDate);
      }

      if (!batchStartDate) batchStartDate = businessDate;
      map.forEach(r => batchRows.push(historyRow(businessDate, r)));
      totalRows += map.size;

      const isBatchEnd = ((i + 1) % HISTORY_BATCH_DAYS === 0) || i === days.length - 1;
      if (!isBatchEnd) continue;

      batchNumber++;
      const finalBatch = i === days.length - 1;
      const batchEndDate = businessDate;

      await postInternal(
        `/api/ingest-history/${encodeURIComponent(CENTER_KEY)}`,
        {
          centerKey: CENTER_KEY,
          centerName: CENTER_NAME,
          // 전체 90일 창을 보내야 서버가 기존 메모리에서 창 밖 데이터만 제거한다.
          fromDate,
          toDate: today,
          dayCount: days.length,
          rows: batchRows,
          generatedAt: new Date().toISOString(),
          batchNumber,
          totalBatches,
          batchFromDate: batchStartDate,
          batchToDate: batchEndDate,
          finalBatch
        }
      );

      console.log(
        `[BAEMIN HISTORY BATCH] ${batchNumber}/${totalBatches} ${batchStartDate}~${batchEndDate} rows=${batchRows.length}`
      );

      batchRows = [];
      batchStartDate = null;
    }

    state.counters.historySyncs++;
    state.lastHistory = {
      at: new Date().toISOString(),
      ok: true,
      fromDate,
      toDate: today,
      dayCount: days.length,
      rows: totalRows,
      batches: totalBatches
    };

    console.log(
      `[BAEMIN HISTORY] OK ${fromDate}~${today} days=${days.length} rows=${totalRows} batches=${totalBatches}`
    );
  } catch (error) {
    state.lastHistory = summarizeError(error);
    console.error("[BAEMIN HISTORY] FAIL", error.message);
  } finally {
    historyRunning = false;
  }
}

async function syncHistoryBackfillBatch() {
  if (!HISTORY_BACKFILL_ENABLED || historyBackfillComplete || !state.enabled) return;
  // 실시간/주간/90일 작업과 겹치면 운영 수집을 우선한다.
  if (historyBackfillRunning || historyRunning || weeklyRunning || liveRunning) return;
  historyBackfillRunning = true;
  try {
    const plan = await postInternalJson(
      `/api/history-backfill-plan/${encodeURIComponent(CENTER_KEY)}`,
      { months: HISTORY_BACKFILL_MONTHS, batchDays: HISTORY_BACKFILL_BATCH_DAYS }
    );
    if (plan.busy) return;
    if (plan.done) {
      historyBackfillComplete = true;
      console.log(`[HISTORY BACKFILL] DONE center=${CENTER_KEY} target=${plan.targetFrom || ""}~${plan.targetTo || ""}`);
      return;
    }

    const fromDate = String(plan.fromDate || "");
    const toDate = String(plan.toDate || "");
    const days = dateKeysBetween(fromDate, toDate);
    const rows = [];
    console.log(`[HISTORY BACKFILL] START center=${CENTER_KEY} ${fromDate}~${toDate} days=${days.length}`);

    for (let i = 0; i < days.length; i++) {
      const businessDate = days[i];
      // 백필 도중 30초 운영 작업이 시작되면 다음 날짜 호출 전에 양보한다.
      while (weeklyRunning || liveRunning || historyRunning) await waitMs(750);
      const map = await fetchDateMap(businessDate);
      map.forEach(r => rows.push(historyRow(businessDate, r)));
      // 배민 API와 기존 30초 운영 루프에 부담을 주지 않도록 날짜 호출 사이를 띄운다.
      if (i < days.length - 1) await waitMs(250);
    }

    const saved = await postInternalJson(
      `/api/ingest-history-backfill/${encodeURIComponent(CENTER_KEY)}`,
      { centerKey: CENTER_KEY, centerName: CENTER_NAME, fromDate, toDate, dayCount: days.length, rows, generatedAt: new Date().toISOString() }
    );
    state.counters.historyBackfillBatches++;
    state.lastHistoryBackfill = { at: new Date().toISOString(), ok: true, fromDate, toDate, days: days.length, rows: rows.length, remainingDays: saved.remainingDays };
    console.log(`[HISTORY BACKFILL] SAVED center=${CENTER_KEY} ${fromDate}~${toDate} days=${days.length} rows=${rows.length} remaining=${saved.remainingDays ?? "?"}`);
    if (saved.done) historyBackfillComplete = true;
  } catch (error) {
    state.lastHistoryBackfill = summarizeError(error);
    console.error(`[HISTORY BACKFILL] FAIL center=${CENTER_KEY}`, error.message);
  } finally {
    historyBackfillRunning = false;
  }
}

function scheduleHistoryBackfill() {
  if (!HISTORY_BACKFILL_ENABLED) return;
  // 지사별 시작 시점을 결정적으로 분산한다. 재배포 직후 90일 startup sync가 먼저 끝날 시간을 준다.
  const spread = Array.from(CENTER_KEY).reduce((n, ch) => (n + ch.charCodeAt(0)) % 120, 0) * 1000;
  const firstDelay = 3 * 60_000 + spread;
  setTimeout(() => {
    syncHistoryBackfillBatch().catch(error => console.error('[HISTORY BACKFILL STARTUP]', error.message));
    setInterval(() => {
      syncHistoryBackfillBatch().catch(error => console.error('[HISTORY BACKFILL TIMER]', error.message));
    }, HISTORY_BACKFILL_INTERVAL_MS);
  }, firstDelay);
}

function msUntilNextKstHour(hour) {
  const now = Date.now();
  const p = kstParts(new Date(now));

  // KST를 UTC timestamp로 변환하기 위해 9시간을 뺀다.
  let target = Date.UTC(p.year, p.month - 1, p.day, hour - 9, 0, 0, 0);
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target - now;
}

function scheduleDailyHistory() {
  const delay = msUntilNextKstHour(10);
  const target = new Date(Date.now() + delay);

  console.log(
    `[BAEMIN HISTORY] next daily sync=${target.toISOString()} (10:00 KST)`
  );

  setTimeout(async () => {
    await syncHistory();
    scheduleDailyHistory();
  }, delay);
}

async function startBaeminDirectCollector({ port, ingestKey }) {
  if (started) return getBaeminDirectStatus();
  started = true;

  internalBase = `http://127.0.0.1:${Number(port)}`;
  internalIngestKey = String(ingestKey || "");

  const currentCookie = buildCookieHeader() || INITIAL_COOKIE;
  state.configured = Boolean(CENTER_ID && currentCookie);
  state.cookieConfigured = Boolean(currentCookie);
  state.enabled = DIRECT_ENABLED && state.configured;
  state.startedAt = new Date().toISOString();

  if (!DIRECT_ENABLED) {
    console.log("[BAEMIN DIRECT] disabled by BAEMIN_DIRECT_ENABLED=0");
    return getBaeminDirectStatus();
  }

  if (!CENTER_ID || !currentCookie) {
    console.log(
      "[BAEMIN DIRECT] 환경변수 미설정 - 기존 Tampermonkey ingest 호환 모드로 실행 " +
      `(CENTER_ID=${Boolean(CENTER_ID)}, COOKIE=${Boolean(currentCookie)})`
    );
    return getBaeminDirectStatus();
  }

  // 서버가 DB에서 복원한 세션을 먼저 적용했다면 그것을 우선한다.
  // 복원된 세션이 없을 때만 Render BAEMIN_COOKIE를 초기값으로 사용한다.
  if (!buildCookieHeader()) loadCookieHeader(INITIAL_COOKIE);

  console.log(
    `[BAEMIN DIRECT] START center=${CENTER_KEY}/${CENTER_NAME} interval=${LIVE_MS}ms`
  );
  console.log(`[BAEMIN DIRECT] cookie names=${state.cookieNames.join(",")}`);

  await checkCenter();
  await syncLive();

  // 앱 로그인/랭킹/거절률 데이터를 빠르게 준비.
  setTimeout(() => {
    syncWeeklyReject().catch(error =>
      console.error("[BAEMIN WEEKLY STARTUP]", error.message)
    );
  }, 1_500);

  // 상세정보(90일)는 큰 작업이므로 기본 데이터 뒤에 시작.
  if (HISTORY_ON_START) {
    setTimeout(() => {
      syncHistory().catch(error =>
        console.error("[BAEMIN HISTORY STARTUP]", error.message)
      );
    }, 8_000);
  }

  setInterval(() => {
    syncLive().catch(error =>
      console.error("[BAEMIN LIVE TIMER]", error.message)
    );
  }, LIVE_MS);

  setInterval(() => {
    syncWeeklyReject().catch(error =>
      console.error("[BAEMIN WEEKLY TIMER]", error.message)
    );
  }, WEEKLY_MS);

  setInterval(() => {
    checkCenter().catch(error =>
      console.error("[BAEMIN CENTER TIMER]", error.message)
    );
  }, CENTER_CHECK_MS);

  scheduleDailyHistory();
  scheduleHistoryBackfill();
  return getBaeminDirectStatus();
}

function getBaeminDirectStatus() {
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  startBaeminDirectCollector,
  getBaeminDirectStatus,
  requestPhoneVerification,
  submitPhoneVerification,
  updateBaeminSession,
  getBaeminCookieHeader,
  // 자동 테스트용. 앱 코드에서는 사용하지 않는다.
  __test: {
    syncLive,
    syncWeeklyReject,
    syncHistory,
    syncHistoryBackfillBatch,
    checkCenter,
    getBusinessDateKey,
    startOfWednesdayKey,
    addDaysKey
  }
};