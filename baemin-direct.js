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
  10_000,
  Number(process.env.BAEMIN_POLL_MS || 10_000) || 10_000
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
    historySyncs: 0
  }
};

let internalBase = "";
let internalIngestKey = "";
let started = false;
let liveRunning = false;
let weeklyRunning = false;
let historyRunning = false;
let lastLiveSnapshot = null;
let lastLiveSnapshotAt = 0;

const KOREAN_HOLIDAYS = new Set([
  "01-01",
  "02-18",
  "03-01",
  "05-05",
  "05-25",
  "06-03",
  "06-06",
  "08-15",
  "08-17",
  "10-03",
  "10-09",
  "12-25"
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
  if (KOREAN_HOLIDAYS.has(businessKey.slice(5))) day = 0;

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

  const riders = list.map(d => ({
    name: mapName(d.name),
    phoneNumber: d.phoneNumber || "",
    userId: d.userId || "",
    status: d.status?.code || "",
    allDayComplete: safe(d.deliveryAcceptanceCount?.allDayComplete),
    foodComplete: safe(d.deliveryAcceptanceCount?.foodComplete),
    foodReject: safe(d.deliveryAcceptanceCount?.foodReject),
    morning: safe(d.deliveryPeakTimeCount?.morning),
    afternoon: safe(d.deliveryPeakTimeCount?.afternoon),
    evening: safe(d.deliveryPeakTimeCount?.evening),
    night: safe(d.deliveryPeakTimeCount?.midnight)
  }));

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
      map = await fetchDateMap(addDaysKey(businessDate, 1));
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
        safe(a.slaOutComplete);

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

      weeklyRankingMap.get(userId).val += safe(
        r.deliveryAcceptanceCount?.allDayComplete
      );
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
    todayRanking.push({
      userId: String(r.userId || ""),
      name: String(r.name || ""),
      val: safe(r.deliveryAcceptanceCount?.allDayComplete),
      food: safe(r.deliveryAcceptanceCount?.foodComplete),
      bmart: safe(r.deliveryAcceptanceCount?.bmartComplete),
      store: safe(r.deliveryAcceptanceCount?.storeComplete),
      out: safe(r.deliveryAcceptanceCount?.slaOutComplete)
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
    totalComplete: safe(a.totalComplete),
    totalReject: safe(a.totalReject),
    totalCancel: safe(a.totalCancel),
    totalRiderFault: safe(a.totalRiderFault),
    food: safe(a.foodComplete),
    bmart: safe(a.bmartComplete),
    store: safe(a.storeComplete),
    out: safe(a.slaOutComplete),
    allDay: safe(a.allDayComplete),
    total: safe(a.totalComplete),
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
      map = await fetchDateMap(addDaysKey(businessDate, 1));
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
      `[BAEMIN LIVE] OK riders=${snapshot.list.length} running=${payload.summary.runCount}`
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
    const payload = await buildHistoryPayload();

    await postInternal(
      `/api/ingest-history/${encodeURIComponent(CENTER_KEY)}`,
      payload
    );

    state.counters.historySyncs++;
    state.lastHistory = {
      at: new Date().toISOString(),
      ok: true,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      dayCount: payload.dayCount,
      rows: payload.rows.length
    };

    console.log(
      `[BAEMIN HISTORY] OK ${payload.fromDate}~${payload.toDate} days=${payload.dayCount} rows=${payload.rows.length}`
    );
  } catch (error) {
    state.lastHistory = summarizeError(error);
    console.error("[BAEMIN HISTORY] FAIL", error.message);
  } finally {
    historyRunning = false;
  }
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

  state.configured = Boolean(CENTER_ID && INITIAL_COOKIE);
  state.enabled = DIRECT_ENABLED && state.configured;
  state.startedAt = new Date().toISOString();

  if (!DIRECT_ENABLED) {
    console.log("[BAEMIN DIRECT] disabled by BAEMIN_DIRECT_ENABLED=0");
    return getBaeminDirectStatus();
  }

  if (!CENTER_ID || !INITIAL_COOKIE) {
    console.log(
      "[BAEMIN DIRECT] 환경변수 미설정 - 기존 Tampermonkey ingest 호환 모드로 실행 " +
      `(CENTER_ID=${Boolean(CENTER_ID)}, COOKIE=${Boolean(INITIAL_COOKIE)})`
    );
    return getBaeminDirectStatus();
  }

  loadCookieHeader(INITIAL_COOKIE);

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
  return getBaeminDirectStatus();
}

function getBaeminDirectStatus() {
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  startBaeminDirectCollector,
  getBaeminDirectStatus,
  // 자동 테스트용. 앱 코드에서는 사용하지 않는다.
  __test: {
    syncLive,
    syncWeeklyReject,
    syncHistory,
    checkCenter,
    getBusinessDateKey,
    startOfWednesdayKey,
    addDaysKey
  }
};
