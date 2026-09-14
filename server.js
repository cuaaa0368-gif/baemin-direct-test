const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const {
  startBaeminDirectCollector,
  getBaeminDirectStatus,
  requestPhoneVerification,
  submitPhoneVerification,
  updateBaeminSession,
  getBaeminCookieHeader,
  __test: baeminDirectTest
} = require("./baemin-direct");
const { fork } = require("child_process");

// 추가 지사 목록. Render 환경변수 BAEMIN_EXTRA_CENTERS 하나만 수정하면 된다.
// 형식: key|이름|Center-Id,key|이름|Center-Id
// 예: gangnamb|강남B|DP2609083866,songpa|송파|DPxxxxxxxxxx
const DEFAULT_EXTRA_CENTERS = "gangnamb|강남B|DP2609083866";
const extraCenterWorkers = new Map();

function parseExtraCenters(raw) {
  const seen = new Set();
  return String(raw || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
    .map(item => {
      const [key, name, centerId] = item.split("|").map(v => String(v || "").trim());
      return { key, name, centerId };
    })
    .filter(c => {
      if (!c.key || !c.name || !c.centerId || seen.has(c.key)) return false;
      seen.add(c.key);
      return true;
    });
}

function startExtraCenterCollectors(sharedCookie = "") {
  const configuredRaw = String(process.env.BAEMIN_EXTRA_CENTERS || "").trim();
  // 기본 강남B를 유지하면서 Render에 추가한 지사를 병합한다.
  // 같은 key가 있으면 Render 환경변수 쪽 설정을 우선한다.
  const merged = new Map();
  for (const c of parseExtraCenters(DEFAULT_EXTRA_CENTERS)) merged.set(c.key, c);
  for (const c of parseExtraCenters(configuredRaw)) merged.set(c.key, c);
  const list = Array.from(merged.values());

  for (const center of list) {
    const child = fork(path.join(__dirname, "baemin-center-worker.js"), [], {
      env: {
        ...process.env,
        BAEMIN_CENTER_ID: center.centerId,
        BAEMIN_CENTER_KEY: center.key,
        BAEMIN_CENTER_NAME: center.name,
        BAEMIN_COOKIE: String(sharedCookie || process.env.BAEMIN_COOKIE || ""),
        NURION_INTERNAL_PORT: String(PORT)
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });

    const entry = {
      key: center.key,
      name: center.name,
      centerId: center.centerId,
      pid: child.pid,
      child,
      pendingHistoryFinish: null,
      lastSessionUpdate: null,
      status: { starting: true }
    };
    extraCenterWorkers.set(center.key, entry);

    child.on("message", msg => {
      if (msg?.type === "status") entry.status = msg.status;
      if (msg?.type === "error") entry.status = { error: msg.message };
      if (msg?.type === "baemin-session-update-result") {
        entry.lastSessionUpdate = {
          ok: Boolean(msg.ok),
          message: String(msg.message || ""),
          at: new Date().toISOString()
        };
      }
      if (msg?.type === "history-sync-result" && entry.pendingHistoryFinish) {
        const done = entry.pendingHistoryFinish;
        entry.pendingHistoryFinish = null;
        done(Boolean(msg.ok), msg.message || "");
      }
    });
    child.on("exit", (code, signal) => {
      entry.status = { stopped: true, code, signal };
      console.error(`[BAEMIN EXTRA CENTER STOP] ${center.key}/${center.name} code=${code} signal=${signal || ""}`);
    });

    console.log(`[BAEMIN EXTRA CENTER START] ${center.key}/${center.name} centerId=${center.centerId}`);
  }
}

function broadcastBaeminSessionToWorkers(cookieHeader = getBaeminCookieHeader()) {
  const cookie = String(cookieHeader || "").trim();
  if (!cookie) throw new Error("전파할 배민 세션 쿠키가 없습니다.");

  let sent = 0;
  for (const entry of extraCenterWorkers.values()) {
    if (!entry.child || !entry.child.connected) continue;
    entry.child.send({ type: "baemin-session-update", cookie });
    sent++;
  }

  console.log(`[BAEMIN SESSION] shared session sent to ${sent} worker(s)`);
  return sent;
}

function getExtraCenterStatuses() {
  return Array.from(extraCenterWorkers.values()).map(v => ({
    key: v.key, name: v.name, centerId: v.centerId, pid: v.pid, status: v.status, lastSessionUpdate: v.lastSessionUpdate
  }));
}

function getSelectableCenters() {
  const primaryKey = String(process.env.BAEMIN_CENTER_KEY || "seocho").trim() || "seocho";
  const primaryName = String(process.env.BAEMIN_CENTER_NAME || "서초").trim() || "서초";
  const byKey = new Map([[primaryKey, { key: primaryKey, name: primaryName }]]);

  for (const c of parseExtraCenters(DEFAULT_EXTRA_CENTERS)) byKey.set(c.key, { key: c.key, name: c.name });
  for (const c of parseExtraCenters(process.env.BAEMIN_EXTRA_CENTERS || "")) byKey.set(c.key, { key: c.key, name: c.name });
  for (const [key, d] of centers) {
    if (!byKey.has(key)) byKey.set(key, { key, name: d?.centerName || key });
  }
  return Array.from(byKey.values());
}

function isSelectableCenterKey(key) {
  return getSelectableCenters().some(c => c.key === String(key || "").trim());
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  // Supabase Session Pooler의 연결 한도를 여러 Render 서비스가 함께 사용한다.
  // 이 프로세스가 연결을 독점하지 않도록 작은 풀로 제한한다.
  max: Math.max(1, Number(process.env.DB_POOL_MAX || 2) || 2),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000
});

pool.query("SELECT NOW()")
  .then(() => console.log("[DB] PostgreSQL connected"))
  .catch(err => console.error("[DB] PostgreSQL connection failed:", err.message));

const app = express();

// =========================================================
// 장기 개인 이력 저장소 (상용 구조)
// - 최근 90일 메모리 캐시와 별개로 DB를 영구 기준으로 사용한다.
// - center_key는 당시 소속을 보존하고, 개인 조회는 identity 기준으로 지사 경계를 넘는다.
// =========================================================
const historyArchiveReady = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nurion_rider_history (
      stat_date DATE NOT NULL,
      center_key TEXT NOT NULL,
      rider_user_id TEXT NOT NULL,
      rider_name TEXT,
      total_complete INTEGER NOT NULL DEFAULT 0,
      food_complete INTEGER NOT NULL DEFAULT 0,
      bmart_complete INTEGER NOT NULL DEFAULT 0,
      store_complete INTEGER NOT NULL DEFAULT 0,
      out_complete INTEGER NOT NULL DEFAULT 0,
      morning_complete INTEGER NOT NULL DEFAULT 0,
      afternoon_complete INTEGER NOT NULL DEFAULT 0,
      evening_complete INTEGER NOT NULL DEFAULT 0,
      midnight_complete INTEGER NOT NULL DEFAULT 0,
      reject_count INTEGER NOT NULL DEFAULT 0,
      cancel_count INTEGER NOT NULL DEFAULT 0,
      rider_fault_count INTEGER NOT NULL DEFAULT 0,
      hourly_completed JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (stat_date, center_key, rider_user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nurion_history_rider_date ON nurion_rider_history (rider_user_id, stat_date DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nurion_history_center_date ON nurion_rider_history (center_key, stat_date DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rider_identity_aliases (
      identity_key TEXT NOT NULL,
      center_key TEXT NOT NULL,
      rider_user_id TEXT NOT NULL,
      rider_name TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (identity_key, center_key, rider_user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rider_identity_alias_user ON rider_identity_aliases (rider_user_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nurion_history_backfill_state (
      center_key TEXT PRIMARY KEY,
      target_from DATE NOT NULL,
      target_to DATE NOT NULL,
      next_to DATE,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      batches_completed INTEGER NOT NULL DEFAULT 0,
      rows_saved BIGINT NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // v2: 과거 slaOutComplete 음수 보정값을 시간외 완료로 잘못 합산하던 장기이력을 1회 초기화한다.
  // 운영 통계/계정/설정/identity alias는 건드리지 않는다. 재배포 후에도 반복 초기화되지 않도록 migration marker를 남긴다.
  await pool.query(`CREATE TABLE IF NOT EXISTS nurion_history_migrations (migration_key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const historyNormV2 = await pool.query(`SELECT 1 FROM nurion_history_migrations WHERE migration_key='history_slaout_nonnegative_v2'`);
  if (!historyNormV2.rowCount) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM nurion_rider_history');
      await client.query('DELETE FROM nurion_history_backfill_state');
      await client.query(`INSERT INTO nurion_history_migrations (migration_key) VALUES ('history_slaout_nonnegative_v2')`);
      await client.query('COMMIT');
      console.log('[HISTORY MIGRATION] v2 reset complete - archive/backfill state cleared once');
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      throw err;
    } finally {
      client.release();
    }
  }
  console.log('[HISTORY DB] archive tables ready');
})().catch(err => {
  console.error('[HISTORY DB INIT FAILED]', err.message);
  return false;
});

const PORT = process.env.PORT || 8787;
const INGEST_KEY = process.env.INGEST_KEY || "change-me-later";

/*
 * 로그인 토큰 서명용 비밀키
 * Render에서는 LOGIN_SECRET 환경변수를 설정하는 것을 권장.
 * 설정하지 않은 동안은 INGEST_KEY를 사용.
 */
const LOGIN_SECRET = process.env.LOGIN_SECRET || INGEST_KEY;

// =========================================================
// 배민 공용 세션 영구 저장
// - DB에는 평문 쿠키를 저장하지 않고 AES-256-GCM으로 암호화한다.
// - 별도 환경변수를 늘리지 않기 위해 기존 LOGIN_SECRET에서 암호화 키를 파생한다.
// =========================================================
const BAEMIN_SESSION_KEY = crypto
  .createHash("sha256")
  .update(`nurion-baemin-session:${LOGIN_SECRET}`)
  .digest();

const baeminSessionStoreReady = pool.query(`
  CREATE TABLE IF NOT EXISTS nurion_baemin_session (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    encrypted_cookie TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(err => {
  console.error("[BAEMIN SESSION DB INIT FAILED]", err.message);
  throw err;
});

function encryptBaeminCookie(cookieHeader) {
  const cookie = String(cookieHeader || "").trim();
  if (!cookie) throw new Error("저장할 배민 세션 쿠키가 없습니다.");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", BAEMIN_SESSION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(cookie, "utf8"),
    cipher.final()
  ]);

  return {
    encryptedCookie: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

function decryptBaeminCookie(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    BAEMIN_SESSION_KEY,
    Buffer.from(String(row.iv || ""), "base64")
  );
  decipher.setAuthTag(Buffer.from(String(row.auth_tag || ""), "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(String(row.encrypted_cookie || ""), "base64")),
    decipher.final()
  ]).toString("utf8");
}

async function saveBaeminSessionToDB(cookieHeader) {
  const encrypted = encryptBaeminCookie(cookieHeader);
  await baeminSessionStoreReady;
  await pool.query(
    `
      INSERT INTO nurion_baemin_session (id, encrypted_cookie, iv, auth_tag, updated_at)
      VALUES (1, $1, $2, $3, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        encrypted_cookie = EXCLUDED.encrypted_cookie,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        updated_at = NOW()
    `,
    [encrypted.encryptedCookie, encrypted.iv, encrypted.authTag]
  );
  console.log("[BAEMIN SESSION DB] saved");
}

async function loadBaeminSessionFromDB() {
  try {
    await baeminSessionStoreReady;
    const result = await pool.query(
      `SELECT encrypted_cookie, iv, auth_tag, updated_at FROM nurion_baemin_session WHERE id = 1`
    );
    if (!result.rows.length) return null;

    const cookie = decryptBaeminCookie(result.rows[0]);
    if (!cookie) return null;

    console.log("[BAEMIN SESSION DB] restored");
    return { cookie, updatedAt: result.rows[0].updated_at };
  } catch (err) {
    console.error("[BAEMIN SESSION DB RESTORE FAILED]", err.message);
    return null;
  }
}

let baeminAuthLastSendAt = 0;
const BAEMIN_AUTH_SEND_COOLDOWN_MS = 60_000;



/* =========================================================
   메모리 데이터
========================================================= */

const centers = new Map();
const rejectCenters = new Map();
const historyCenters = new Map();

// 지사별 90일 데이터: 매일 최초 접속 시 최대 1회만 즉시 갱신한다.
// 10:00 정기 갱신은 baemin-direct.js에서 별도로 계속 유지된다.
const firstAccessHistoryRunning = new Set();

function calendarDateKeyKst(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
}

function historyLoadedToday(centerKey) {
  const receivedAt = historyCenters.get(String(centerKey || ""))?.receivedAt;
  if (!receivedAt) return false;
  return calendarDateKeyKst(new Date(receivedAt)) === calendarDateKeyKst();
}

function triggerFirstAccessHistory(centerKey) {
  const key = String(centerKey || "").trim();
  if (!key || historyLoadedToday(key) || firstAccessHistoryRunning.has(key)) return;

  firstAccessHistoryRunning.add(key);
  console.log(`[90DAY FIRST ACCESS] START center=${key}`);

  const finish = (ok, message = "") => {
    firstAccessHistoryRunning.delete(key);
    console.log(`[90DAY FIRST ACCESS] ${ok ? "DONE" : "FAIL"} center=${key}${message ? ` ${message}` : ""}`);
  };

  const extra = extraCenterWorkers.get(key);
  if (extra?.child?.connected) {
    extra.pendingHistoryFinish = finish;
    extra.child.send({ type: "sync-history" });
    return;
  }

  const primaryKey = String(process.env.BAEMIN_CENTER_KEY || "seocho").trim() || "seocho";
  if (key === primaryKey) {
    Promise.resolve(baeminDirectTest.syncHistory())
      .then(() => {
        const ok = historyLoadedToday(key);
        finish(ok, ok ? "" : "no successful history ingest");
      })
      .catch(err => finish(false, err.message));
    return;
  }

  finish(false, "collector not found");
}

const dailyDetailCenters = new Map();


/* =========================================================
   운영 설정
   - 세트수: centerKey별 독립 영구 저장
   - 요일 기준: 전체 지사 공통, 해당 영업일(06:00~다음 05:59)에만 유지
========================================================= */
const operationalSettings = new Map();
let globalDayOverride = { overrideDayType: null, overrideBusinessDate: null };
let operationalSettingsReady = false;

function normalizeSetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

async function initOperationalSettingsDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nurion_operational_settings (
        setting_key TEXT PRIMARY KEY,
        set_count NUMERIC(8,2),
        override_day_type TEXT,
        override_business_date DATE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await pool.query(`
      SELECT setting_key, set_count, override_day_type,
             override_business_date::text AS override_business_date
      FROM nurion_operational_settings
    `);
    for (const row of result.rows) {
      if (row.setting_key === "global:day") {
        globalDayOverride = {
          overrideDayType: row.override_day_type || null,
          overrideBusinessDate: row.override_business_date || null
        };
        continue;
      }
      if (!String(row.setting_key).startsWith("center:")) continue;
      const centerKey = String(row.setting_key).slice(7);
      const setCount = normalizeSetCount(row.set_count);
      if (centerKey && setCount != null) operationalSettings.set(centerKey, { setCount });
    }
    operationalSettingsReady = true;
    console.log(`[OPERATION SETTINGS DB LOADED] centers=${operationalSettings.size}`);
  } catch (err) {
    console.error("[OPERATION SETTINGS DB LOAD FAILED]", err.message);
  }
}

async function saveCenterSetCountToDB(centerKey, setCount) {
  await pool.query(`
    INSERT INTO nurion_operational_settings(setting_key, set_count, updated_at)
    VALUES ($1,$2,NOW())
    ON CONFLICT (setting_key) DO UPDATE SET
      set_count=EXCLUDED.set_count,
      updated_at=NOW()
  `, [`center:${centerKey}`, setCount]);
}

async function saveGlobalDayOverrideToDB(dayType, businessDate) {
  await pool.query(`
    INSERT INTO nurion_operational_settings
      (setting_key, override_day_type, override_business_date, updated_at)
    VALUES ('global:day',$1,$2,NOW())
    ON CONFLICT (setting_key) DO UPDATE SET
      override_day_type=EXCLUDED.override_day_type,
      override_business_date=EXCLUDED.override_business_date,
      updated_at=NOW()
  `, [dayType, businessDate]);
}

function activeGlobalDayOverride() {
  const businessDate = businessDateKeyKst();
  const active =
    globalDayOverride.overrideBusinessDate === businessDate &&
    ["weekday", "saturday", "sunday"].includes(globalDayOverride.overrideDayType);
  return {
    overrideDayType: active ? globalDayOverride.overrideDayType : null,
    overrideBusinessDate: active ? globalDayOverride.overrideBusinessDate : null,
    manualActive: active
  };
}

function getOperationalSetting(centerKey) {
  const key = String(centerKey || "").trim();
  const saved = operationalSettings.get(key) || {};
  const day = activeGlobalDayOverride();
  return {
    centerKey: key,
    setCount: normalizeSetCount(saved.setCount) ?? 10,
    overrideDayType: day.overrideDayType,
    overrideBusinessDate: day.overrideBusinessDate,
    manualActive: day.manualActive
  };
}

function goalBaseForBusinessDate(businessDate, overrideDayType = null) {
  const [y, m, d] = String(businessDate).split("-").map(Number);
  let day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  if (overrideDayType === "saturday") day = 6;
  else if (overrideDayType === "sunday") day = 0;
  else if (overrideDayType === "weekday") {
    if (day === 0 || day === 6) day = 1;
  }
  return day;
}

const GOAL_BASES = {
  morning:   { monThu: 19, fri: 21, sat: 27, sun: 29 },
  afternoon: { monThu: 18, fri: 21, sat: 22, sun: 22 },
  evening:   { monThu: 30, fri: 32, sat: 36, sun: 35 },
  night:     { monThu: 23, fri: 26, sat: 25, sun: 24 }
};

function goalsForCenter(centerKey) {
  const setting = getOperationalSetting(centerKey);
  const businessDate = businessDateKeyKst();
  const [y, m, d] = businessDate.split("-").map(Number);
  const actualDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const holidayDates = new Set([
    "2026-01-01","2026-02-16","2026-02-17","2026-02-18","2026-03-01","2026-03-02",
    "2026-05-05","2026-05-24","2026-05-25","2026-06-03","2026-06-06","2026-08-15",
    "2026-08-17","2026-09-24","2026-09-25","2026-09-26","2026-10-03","2026-10-05",
    "2026-10-09","2026-12-25"
  ]);

  let day;
  if (setting.manualActive) day = goalBaseForBusinessDate(businessDate, setting.overrideDayType);
  else if (businessDate === "2026-07-17") day = 6;
  else if (holidayDates.has(businessDate)) day = 0;
  else day = actualDay;

  const pick = base => {
    if ([1,2,3,4].includes(day)) return base.monThu;
    if (day === 5) return base.fri;
    if (day === 6) return base.sat;
    return base.sun;
  };

  const goals = {};
  for (const [key, base] of Object.entries(GOAL_BASES)) {
    goals[key] = Math.round(pick(base) * setting.setCount * 100) / 100;
  }

  let basisLabel;
  if ([1,2,3,4].includes(day)) basisLabel = "평일 기준";
  else if (day === 5) basisLabel = "금요일 기준";
  else if (day === 6) basisLabel = "토요일 기준";
  else basisLabel = "일요일 기준";

  return {
    goals,
    state: {
      businessDate,
      setCount: setting.setCount,
      manualActive: setting.manualActive,
      overrideDayType: setting.overrideDayType,
      basisLabel
    }
  };
}

function saveOperationalSetting(centerKey, setting) {
  const key = String(centerKey || "").trim();
  operationalSettings.set(key, { setCount: normalizeSetCount(setting?.setCount) ?? 10 });
}

/* =========================================================
   실시간 누적값 안정화
   - 같은 영업일의 누적 완료/피크/시간대 값은 감소하지 않는다.
   - 06:00 영업일 전환 시에는 새 날짜로 정상 초기화한다.
========================================================= */
function businessDateKeyKst(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  const d = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  if (Number(parts.hour) < 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDaysKeyServer(dateKey, delta) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Number(delta || 0));
  return d.toISOString().slice(0, 10);
}

function dateKeySpanDays(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00Z`).getTime();
  const b = new Date(`${toDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function monotonicNumber(previous, incoming) {
  const a = nonNegativeNumber(previous);
  const b = nonNegativeNumber(incoming);
  if (a == null) return b == null ? 0 : b;
  if (b == null) return a;
  return Math.max(a, b);
}

function mergePeak(previous = {}, incoming = {}) {
  const out = { ...previous, ...incoming };
  for (const key of ["morning", "afternoon", "evening", "midnight"]) {
    if (previous?.[key] != null || incoming?.[key] != null) {
      out[key] = monotonicNumber(previous?.[key], incoming?.[key]);
    } else {
      delete out[key];
    }
  }
  return out;
}

function mergeHourly(previous, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return Array.isArray(previous) ? previous : [];
  if (!Array.isArray(previous) || !previous.length) return incoming;
  const len = Math.max(previous.length, incoming.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    const a = previous[i], b = incoming[i];
    if (typeof a === "number" || typeof b === "number") {
      out[i] = monotonicNumber(a, b);
      continue;
    }
    if (a && typeof a === "object" || b && typeof b === "object") {
      const merged = { ...(a || {}), ...(b || {}) };
      for (const key of ["count", "complete", "completed", "value", "total"]) {
        if ((a && a[key] != null) || (b && b[key] != null)) merged[key] = monotonicNumber(a?.[key], b?.[key]);
      }
      out[i] = merged;
      continue;
    }
    out[i] = b ?? a;
  }
  return out;
}

function mergeLiveRiders(previousRows, incomingRows, sameBusinessDay) {
  if (!sameBusinessDay) return Array.isArray(incomingRows) ? incomingRows : [];
  const byId = new Map();
  for (const row of Array.isArray(previousRows) ? previousRows : []) {
    const id = String(row?.userId || "").trim();
    if (id) byId.set(id, { ...row });
  }
  for (const row of Array.isArray(incomingRows) ? incomingRows : []) {
    const id = String(row?.userId || "").trim();
    if (!id) continue;
    const prev = byId.get(id) || {};
    const merged = { ...prev, ...row };
    for (const key of ["allDayComplete", "foodComplete", "bmartComplete", "storeComplete", "slaOutComplete", "foodReject", "morning", "afternoon", "evening", "night"]) {
      merged[key] = monotonicNumber(prev[key], row[key]);
    }
    merged.deliveryPeakTimeCount = mergePeak(prev.deliveryPeakTimeCount, row.deliveryPeakTimeCount);
    merged.hourlyCompleted = mergeHourly(prev.hourlyCompleted, row.hourlyCompleted);
    byId.set(id, merged);
  }
  return [...byId.values()];
}

function fourTypeTotal(r) {
  return ["foodComplete", "bmartComplete", "storeComplete", "slaOutComplete"]
    .reduce((sum, key) => sum + (nonNegativeNumber(r?.[key]) || 0), 0);
}

function mergeHistoryRows(previousRows, incomingRows, fromDate, toDate) {
  const byKey = new Map();
  for (const row of Array.isArray(previousRows) ? previousRows : []) {
    const date = String(row?.date || "");
    const id = String(row?.userId || "").trim();
    // 새 90일 창 밖의 오래된 메모리는 유지하지 않는다.
    if (!date || !id || (fromDate && date < fromDate) || (toDate && date > toDate)) continue;
    byKey.set(`${date}|${id}`, { ...row });
  }
  for (const row of Array.isArray(incomingRows) ? incomingRows : []) {
    const date = String(row?.date || "");
    const id = String(row?.userId || "").trim();
    if (!date || !id) continue;
    const key = `${date}|${id}`;
    const prev = byKey.get(key) || {};
    const merged = { ...prev, ...row };
    const pa = prev.deliveryAcceptanceCount || {};
    const ia = row.deliveryAcceptanceCount || {};
    const acceptance = { ...pa, ...ia };
    for (const k of ["foodComplete", "bmartComplete", "storeComplete", "slaOutComplete", "allDayComplete", "totalComplete", "foodReject", "totalReject", "totalCancel", "totalRiderFault"]) {
      if (pa[k] != null || ia[k] != null) acceptance[k] = monotonicNumber(pa[k], ia[k]);
    }
    merged.deliveryAcceptanceCount = acceptance;
    merged.deliveryPeakTimeCount = mergePeak(prev.deliveryPeakTimeCount, row.deliveryPeakTimeCount);
    merged.hourlyCompleted = mergeHourly(prev.hourlyCompleted, row.hourlyCompleted);
    for (const k of ["food", "bmart", "store", "out", "allDay", "total", "totalComplete", "morning", "afternoon", "evening", "midnight", "reject", "cancel", "riderFault"]) {
      if (prev[k] != null || row[k] != null) merged[k] = monotonicNumber(prev[k], row[k]);
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.userId).localeCompare(String(b.userId)));
}

/* =========================================================
   Supabase - 라이더 날짜별 실적 저장
========================================================= */

// DB 기록 저장은 30초 수집 주기마다 발생한다.
// 기존 구현은 라이더/날짜마다 pool.query()를 반복해 한 번의 수집에서 수백 개 쿼리가
// 동시에 다음 지사 수집과 겹칠 수 있었다. 아래 저장 함수들은 수집 1회당 SQL 1회로 묶는다.

async function saveWeeklyDetailsToDB(centerKey, weekStart, weeklyDetails) {
  try {
    console.log("[DB WEEKLY INPUT] weekStart:", weekStart);
    if (!Array.isArray(weeklyDetails) || weeklyDetails.length === 0) return;

    const weekdayOffset = { "수요일":0, "목요일":1, "금요일":2, "토요일":3, "일요일":4, "월요일":5, "화요일":6 };
    const rows = [];
    for (const rider of weeklyDetails) {
      const userId = String(rider.userId || "").trim();
      if (!userId) continue;
      const name = String(rider.name || "").trim();
      for (const [weekday, complete] of Object.entries(rider.days || {})) {
        if (weekdayOffset[weekday] === undefined) continue;
        const date = new Date(`${weekStart}T12:00:00+09:00`);
        date.setDate(date.getDate() + weekdayOffset[weekday]);
        const statDate = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Seoul", year:"numeric", month:"2-digit", day:"2-digit" }).format(date);
        rows.push({ stat_date:statDate, center_key:centerKey, rider_user_id:userId, rider_name:name, complete:Number(complete)||0 });
      }
    }
    if (!rows.length) return;

    await pool.query(`
      INSERT INTO rider_daily_stats (stat_date, center_key, rider_user_id, rider_name, complete, reject_count, cancel_count)
      SELECT x.stat_date, x.center_key, x.rider_user_id, x.rider_name, x.complete, 0, 0
      FROM jsonb_to_recordset($1::jsonb) AS x(stat_date date, center_key text, rider_user_id text, rider_name text, complete integer)
      ON CONFLICT (stat_date, center_key, rider_user_id)
      DO UPDATE SET rider_name=EXCLUDED.rider_name,
                    complete=GREATEST(rider_daily_stats.complete, EXCLUDED.complete),
                    updated_at=now()
    `, [JSON.stringify(rows)]);

    console.log("[DB WEEKLY SAVED]", centerKey, "riders:", weeklyDetails.length, "rows:", rows.length);
  } catch (err) {
    console.error("[DB WEEKLY SAVE FAILED]", centerKey, err.message);
  }
}

async function saveDailyRejectToDB(centerKey, dailyRejectData) {
  try {
    if (!Array.isArray(dailyRejectData) || dailyRejectData.length === 0) return;
    const rows = dailyRejectData.map(row => ({
      stat_date:String(row.date || ""), center_key:centerKey,
      rider_user_id:String(row.userId || "").trim(), rider_name:String(row.name || ""),
      food_complete:Number(row.complete)||0, reject_count:Number(row.reject)||0, cancel_count:Number(row.cancel)||0
    })).filter(r => r.stat_date && r.rider_user_id);
    if (!rows.length) return;

    await pool.query(`
      INSERT INTO rider_daily_stats (stat_date, center_key, rider_user_id, rider_name, complete, food_complete, reject_count, cancel_count)
      SELECT x.stat_date, x.center_key, x.rider_user_id, x.rider_name, 0, x.food_complete, x.reject_count, x.cancel_count
      FROM jsonb_to_recordset($1::jsonb) AS x(stat_date date, center_key text, rider_user_id text, rider_name text, food_complete integer, reject_count integer, cancel_count integer)
      ON CONFLICT (stat_date, center_key, rider_user_id)
      DO UPDATE SET rider_name=EXCLUDED.rider_name,
                    food_complete=EXCLUDED.food_complete,
                    reject_count=EXCLUDED.reject_count,
                    cancel_count=EXCLUDED.cancel_count,
                    updated_at=now()
    `, [JSON.stringify(rows)]);
    console.log("[DB REJECT SAVED]", centerKey, "rows:", rows.length);
  } catch (err) {
    console.error("[DB REJECT SAVE FAILED]", centerKey, err.message);
  }
}

async function saveEveningToDB(centerKey, riders) {
  try {
    if (!Array.isArray(riders) || riders.length === 0) return;
    const nowKst = new Date(new Date().toLocaleString("en-US", { timeZone:"Asia/Seoul" }));
    if (nowKst.getHours() < 6) nowKst.setDate(nowKst.getDate() - 1);
    const statDate = `${nowKst.getFullYear()}-${String(nowKst.getMonth()+1).padStart(2,"0")}-${String(nowKst.getDate()).padStart(2,"0")}`;
    const rows = riders.map(rider => ({
      stat_date:statDate, center_key:centerKey, rider_user_id:String(rider.userId||"").trim(), rider_name:String(rider.name||""),
      complete:Number(rider.allDayComplete)||0, evening_complete:Number(rider.evening)||0
    })).filter(r => r.rider_user_id);
    if (!rows.length) return;

    await pool.query(`
      INSERT INTO rider_daily_stats (stat_date, center_key, rider_user_id, rider_name, complete, reject_count, cancel_count, evening_complete)
      SELECT x.stat_date, x.center_key, x.rider_user_id, x.rider_name, x.complete, 0, 0, x.evening_complete
      FROM jsonb_to_recordset($1::jsonb) AS x(stat_date date, center_key text, rider_user_id text, rider_name text, complete integer, evening_complete integer)
      ON CONFLICT (stat_date, center_key, rider_user_id)
      DO UPDATE SET rider_name=EXCLUDED.rider_name,
                    complete=GREATEST(rider_daily_stats.complete, EXCLUDED.complete),
                    evening_complete=GREATEST(rider_daily_stats.evening_complete, EXCLUDED.evening_complete),
                    updated_at=now()
    `, [JSON.stringify(rows)]);
    console.log("[DB EVENING SAVED]", centerKey, "riders:", rows.length);
  } catch (err) {
    console.error("[DB EVENING SAVE FAILED]", centerKey, err.message);
  }
}

async function saveWeeklyRankingToDB(centerKey, weeklyRanking) {
  try {
    if (!Array.isArray(weeklyRanking) || weeklyRanking.length === 0) return;
    const nowKst = new Date(new Date().toLocaleString("en-US", { timeZone:"Asia/Seoul" }));
    if (nowKst.getHours() < 6) nowKst.setDate(nowKst.getDate() - 1);
    const todayStr = `${nowKst.getFullYear()}-${String(nowKst.getMonth()+1).padStart(2,"0")}-${String(nowKst.getDate()).padStart(2,"0")}`;
    const today = new Date(todayStr + "T00:00:00Z");
    const diff = (today.getUTCDay() - 3 + 7) % 7;
    const weekStartDate = new Date(today); weekStartDate.setUTCDate(today.getUTCDate() - diff);
    const weekStart = weekStartDate.toISOString().slice(0,10);
    const rows = weeklyRanking.map(rider => ({
      week_start:weekStart, center_key:centerKey, rider_user_id:String(rider.userId||"").trim(),
      rider_name:String(rider.name||""), complete:Number(rider.val)||0
    })).filter(r => r.rider_user_id);
    if (!rows.length) return;

    await pool.query(`
      INSERT INTO rider_weekly_records (week_start, center_key, rider_user_id, rider_name, complete)
      SELECT x.week_start, x.center_key, x.rider_user_id, x.rider_name, x.complete
      FROM jsonb_to_recordset($1::jsonb) AS x(week_start date, center_key text, rider_user_id text, rider_name text, complete integer)
      ON CONFLICT (week_start, center_key, rider_user_id)
      DO UPDATE SET rider_name=EXCLUDED.rider_name,
                    complete=GREATEST(rider_weekly_records.complete, EXCLUDED.complete),
                    updated_at=now()
    `, [JSON.stringify(rows)]);
    console.log("[DB WEEKLY RECORD SAVED]", centerKey, "week:", weekStart, "riders:", rows.length);
  } catch (err) {
    console.error("[DB WEEKLY RECORD SAVE FAILED]", centerKey, err.message);
  }
}

async function saveHistoryArchiveToDB(centerKey, incomingRows) {
  if (!Array.isArray(incomingRows) || !incomingRows.length) return true;
  try {
    await historyArchiveReady;
    const rows = incomingRows.map(r => {
      const a = r?.deliveryAcceptanceCount || {};
      const p = r?.deliveryPeakTimeCount || {};
      const food = Number(r?.food ?? a.foodComplete) || 0;
      const bmart = Number(r?.bmart ?? a.bmartComplete) || 0;
      const store = Number(r?.store ?? a.storeComplete) || 0;
      const out = Math.max(0, Number(r?.out ?? a.slaOutComplete) || 0);
      return {
        stat_date: String(r?.date || ''), center_key: centerKey,
        rider_user_id: String(r?.userId || '').trim(), rider_name: String(r?.name || ''),
        total_complete: food + bmart + store + out, food_complete: food, bmart_complete: bmart,
        store_complete: store, out_complete: out,
        morning_complete: Number(r?.morning ?? p.morning) || 0,
        afternoon_complete: Number(r?.afternoon ?? p.afternoon) || 0,
        evening_complete: Number(r?.evening ?? p.evening) || 0,
        midnight_complete: Number(r?.midnight ?? p.midnight) || 0,
        reject_count: Number(r?.reject ?? r?.totalReject ?? a.totalReject) || 0,
        cancel_count: Number(r?.cancel ?? r?.totalCancel ?? a.totalCancel) || 0,
        rider_fault_count: Number(r?.riderFault ?? r?.totalRiderFault ?? a.totalRiderFault) || 0,
        hourly_completed: Array.isArray(r?.hourlyCompleted) ? r.hourlyCompleted : [],
        raw_payload: r
      };
    }).filter(r => /^20\d{2}-\d{2}-\d{2}$/.test(r.stat_date) && r.rider_user_id);
    if (!rows.length) return true;

    await pool.query(`
      INSERT INTO nurion_rider_history (
        stat_date, center_key, rider_user_id, rider_name, total_complete, food_complete, bmart_complete,
        store_complete, out_complete, morning_complete, afternoon_complete, evening_complete, midnight_complete,
        reject_count, cancel_count, rider_fault_count, hourly_completed, raw_payload
      )
      SELECT x.stat_date, x.center_key, x.rider_user_id, x.rider_name, x.total_complete, x.food_complete, x.bmart_complete,
             x.store_complete, x.out_complete, x.morning_complete, x.afternoon_complete, x.evening_complete, x.midnight_complete,
             x.reject_count, x.cancel_count, x.rider_fault_count, x.hourly_completed, x.raw_payload
      FROM jsonb_to_recordset($1::jsonb) AS x(
        stat_date date, center_key text, rider_user_id text, rider_name text, total_complete integer, food_complete integer,
        bmart_complete integer, store_complete integer, out_complete integer, morning_complete integer, afternoon_complete integer,
        evening_complete integer, midnight_complete integer, reject_count integer, cancel_count integer, rider_fault_count integer,
        hourly_completed jsonb, raw_payload jsonb
      )
      ON CONFLICT (stat_date, center_key, rider_user_id) DO UPDATE SET
        rider_name=EXCLUDED.rider_name,
        total_complete=GREATEST(nurion_rider_history.total_complete, EXCLUDED.total_complete),
        food_complete=GREATEST(nurion_rider_history.food_complete, EXCLUDED.food_complete),
        bmart_complete=GREATEST(nurion_rider_history.bmart_complete, EXCLUDED.bmart_complete),
        store_complete=GREATEST(nurion_rider_history.store_complete, EXCLUDED.store_complete),
        out_complete=GREATEST(nurion_rider_history.out_complete, EXCLUDED.out_complete),
        morning_complete=GREATEST(nurion_rider_history.morning_complete, EXCLUDED.morning_complete),
        afternoon_complete=GREATEST(nurion_rider_history.afternoon_complete, EXCLUDED.afternoon_complete),
        evening_complete=GREATEST(nurion_rider_history.evening_complete, EXCLUDED.evening_complete),
        midnight_complete=GREATEST(nurion_rider_history.midnight_complete, EXCLUDED.midnight_complete),
        reject_count=GREATEST(nurion_rider_history.reject_count, EXCLUDED.reject_count),
        cancel_count=GREATEST(nurion_rider_history.cancel_count, EXCLUDED.cancel_count),
        rider_fault_count=GREATEST(nurion_rider_history.rider_fault_count, EXCLUDED.rider_fault_count),
        hourly_completed=CASE WHEN jsonb_array_length(EXCLUDED.hourly_completed) > 0 THEN EXCLUDED.hourly_completed ELSE nurion_rider_history.hourly_completed END,
        raw_payload=EXCLUDED.raw_payload, updated_at=NOW()
    `, [JSON.stringify(rows)]);
    console.log('[HISTORY DB SAVED]', centerKey, 'rows:', rows.length);
    return true;
  } catch (err) {
    console.error('[HISTORY DB SAVE FAILED]', centerKey, err.message);
    return false;
  }
}

async function rememberRiderIdentity(account) {
  const identityKey = String(account?.loginId || '').trim();
  const centerKey = String(account?.centerKey || '').trim();
  const riderUserId = String(account?.riderUserId || '').trim();
  if (!identityKey || !centerKey || !riderUserId || account?.role !== 'rider') return;
  try {
    await historyArchiveReady;
    await pool.query(`
      INSERT INTO rider_identity_aliases (identity_key, center_key, rider_user_id, rider_name)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (identity_key, center_key, rider_user_id) DO UPDATE SET
        rider_name=EXCLUDED.rider_name, last_seen_at=NOW()
    `, [identityKey, centerKey, riderUserId, String(account?.name || '')]);
  } catch (err) {
    console.error('[RIDER IDENTITY SAVE FAILED]', identityKey, err.message);
  }
}

/* =========================================================
   서초대장 - 역대 기록 계산
========================================================= */

async function getSeochoChampions(centerKey) {

  /* ================= 일일대장 ================= */

  const dailyResult = await pool.query(
    `
    SELECT
      stat_date,
      rider_user_id,
      rider_name,
      complete
    FROM rider_daily_stats
    WHERE center_key = $1
      AND complete > 0
    AND complete = (
  SELECT MAX(complete)
  FROM rider_daily_stats
  WHERE center_key = $1
    AND complete > 0
)
ORDER BY stat_date ASC, rider_user_id ASC
    `,
    [centerKey]
  );


  /* ================= 저피대장 ================= */

 const eveningResult = await pool.query(
  `
  SELECT
    stat_date,
    rider_user_id,
    rider_name,
    evening_complete
  FROM rider_daily_stats
  WHERE center_key = $1
    AND evening_complete > 0
    AND evening_complete = (
      SELECT MAX(evening_complete)
      FROM rider_daily_stats
      WHERE center_key = $1
        AND evening_complete > 0
    )
  ORDER BY stat_date ASC, rider_user_id ASC
  `,
  [centerKey]
);


/* ================= 주간대장 =================
   현황 weeklyRanking 기록 기준
================================================= */

const weeklyResult = await pool.query(
  `
  SELECT
    week_start,
    rider_user_id,
    rider_name,
    complete
  FROM rider_weekly_records
  WHERE center_key = $1
    AND complete > 0
    AND complete = (
      SELECT MAX(complete)
      FROM rider_weekly_records
      WHERE center_key = $1
        AND complete > 0
    )
  ORDER BY week_start ASC, rider_user_id ASC
  `,
  [centerKey]
);

const uniqueByUserId = rows =>
  [...new Map(
    rows.map(r => [r.rider_user_id, r])
  ).values()];

const daily = uniqueByUserId(dailyResult.rows);
const evening = uniqueByUserId(eveningResult.rows);
const weekly = uniqueByUserId(weeklyResult.rows);


return {
  weekly: weekly.length > 0
    ? {
        names: weekly.map(r => r.rider_name),
        userIds: weekly.map(r => r.rider_user_id),
        val: Number(weekly[0].complete),
        weekStart: weekly[0].week_start
      }
    : null,

  daily: daily.length > 0
    ? {
        names: daily.map(r => r.rider_name),
        userIds: daily.map(r => r.rider_user_id),
        val: Number(daily[0].complete),
        date: daily[0].stat_date
      }
    : null,

  evening: evening.length > 0
    ? {
        names: evening.map(r => r.rider_name),
        userIds: evening.map(r => r.rider_user_id),
        val: Number(evening[0].evening_complete),
        date: evening[0].stat_date
      }
    : null
};
}
/* =========================================================
   계정
========================================================= */

const accounts = new Map();

const hash = s =>
  crypto
    .createHash("sha256")
    .update(String(s))
    .digest("hex");


function addAccount({
  loginId,
  password,
  role = "rider",
  centerKey,
  riderUserId = "",
  name = ""
}) {

  accounts.set(String(loginId), {
    loginId: String(loginId),
    passwordHash: hash(password),
    role,
    centerKey: String(centerKey),
    riderUserId: String(riderUserId),
    name: name || loginId
  });

}

async function loadAccountsFromDB() {
  try {
    const result = await pool.query(`
      SELECT
        login_id,
        password_hash,
        role,
        center_key,
        rider_user_id,
        name
      FROM rider_accounts
    `);

    for (const row of result.rows) {
      accounts.set(String(row.login_id), {
        loginId: String(row.login_id),
        passwordHash: String(row.password_hash),
        role: String(row.role || "rider"),
        centerKey: String(row.center_key || ""),
        riderUserId: String(row.rider_user_id || ""),
        name: row.name || row.login_id
      });
    }

    console.log(
      "[ACCOUNTS DB LOADED]",
      result.rows.length
    );
    for (const account of accounts.values()) rememberRiderIdentity(account);

  } catch (err) {
    console.error(
      "[ACCOUNTS DB LOAD FAILED]",
      err.message
    );
  }
}
async function saveAccountToDB(account) {
  try {
    await pool.query(
      `
        INSERT INTO rider_accounts
        (
          login_id,
          password_hash,
          role,
          center_key,
          rider_user_id,
          name
        )
        VALUES ($1,$2,$3,$4,$5,$6)

        ON CONFLICT (login_id)
        DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          role = EXCLUDED.role,
          center_key = EXCLUDED.center_key,
          rider_user_id = EXCLUDED.rider_user_id,
          name = EXCLUDED.name,
          updated_at = NOW()
      `,
      [
        account.loginId,
        account.passwordHash,
        account.role,
        account.centerKey,
        account.riderUserId,
        account.name
      ]
    );

    rememberRiderIdentity(account);
    console.log(
      "[ACCOUNT DB SAVED]",
      account.loginId
    );

  } catch (err) {
    console.error(
      "[ACCOUNT DB SAVE FAILED]",
      account.loginId,
      err.message
    );
  }
}
loadAccountsFromDB();
initOperationalSettingsDB();


/*
 * 강남 테스트 계정
 */
addAccount({
  loginId: "gangnam01",
  password: "1234",
  role: "center",
  centerKey: "gangnam",
  name: "강남"
});

/*
 * 서초 마스터 테스트 계정
 */
addAccount({
  loginId: "master_321",
  password: "5567",
  role: "master",
  centerKey: "seocho",
  name: "마스터"
});


/* =========================================================
   영구 로그인 토큰
========================================================= */

function makeToken(account) {

  const payload = {
    loginId: account.loginId,
    issuedAt: Date.now(),
    activeCenterKey: account.centerKey
  };

  const body = Buffer
    .from(JSON.stringify(payload))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", LOGIN_SECRET)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}


function verifyToken(t) {

  try {

    if (!t) return null;

    const parts = String(t).split(".");

    if (parts.length !== 2)
      return null;

    const [body, signature] = parts;

    const expected = crypto
      .createHmac("sha256", LOGIN_SECRET)
      .update(body)
      .digest("base64url");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer
        .from(body, "base64url")
        .toString("utf8")
    );

    const account =
      accounts.get(String(payload.loginId));

    if (!account)
      return null;

    // 마스터의 지사 선택은 계정 원본을 바꾸지 않고 토큰별 활성 지사로만 적용한다.
    // 따라서 여러 기기에서 같은 마스터 계정을 사용해도 서로 지사 선택이 덮어써지지 않는다.
    if (
      (account.role === "master" || account.role === "superadmin") &&
      payload.activeCenterKey &&
      isSelectableCenterKey(payload.activeCenterKey)
    ) {
      return { ...account, centerKey: String(payload.activeCenterKey) };
    }

    return account;

  } catch {

    return null;

  }

}


/* =========================================================
   Middleware
========================================================= */

app.use((req, res, next) => {

  res.header(
    "Access-Control-Allow-Origin",
    "https://deliverycenter.baemin.com"
  );

  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-ingest-key"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();

});


app.use(
  express.json({
    limit: "20mb"
  })
);


app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================================
   로그인 인증
========================================================= */

function auth(req, res, next) {

  const t = (
    req.get("authorization") || ""
  ).replace(/^Bearer\s+/i, "");

  const account = verifyToken(t);

  if (!account) {

    return res.status(401).json({
      ok: false,
      message: "로그인이 필요합니다."
    });

  }

  req.account = account;

  next();

}


function centerAllowed(a, key) {

  return (
    a.role === "superadmin" ||
    a.centerKey === key
  );

}


/* =========================================================
   앱으로 공개할 지사 데이터
========================================================= */

function getCenterCollectorStatus(centerKey) {
  const key = String(centerKey || "").trim();
  const main = getBaeminDirectStatus();

  if (String(main?.centerKey || "") === key) return main || {};

  const worker = extraCenterWorkers.get(key);
  return worker?.status || {};
}

function publicPayload(d) {
  const operational = goalsForCenter(d.centerKey);
  const collectorStatus = getCenterCollectorStatus(d.centerKey);
  const live = !Boolean(
    collectorStatus?.authRequired ||
    collectorStatus?.stopped ||
    collectorStatus?.error
  );

  return {
    centerKey: d.centerKey,
    centerName: d.centerName,
    receivedAt: d.receivedAt,
    sentAt: d.sentAt,
    live,

    summary: d.summary,
    peaks: d.peaks,
    goals: operational.goals,
    operationalState: operational.state,

    // 기존 랭킹
    ranking: d.ranking,

    // 누리온 주간 랭킹
    weeklyRanking: d.weeklyRanking || [],
    todayRanking: d.todayRanking || [],
    eveningRanking: d.eveningRanking || [],

    riders: d.riders
  };
}


/* =========================================================
   관제 데이터 수신
========================================================= */

app.post(
  "/api/ingest/:centerKey",
  (req, res) => {

    if (
      req.get("x-ingest-key") !== INGEST_KEY
    ) {

      return res
        .status(401)
        .json({ ok: false });

    }


    const centerKey =
      String(
        req.params.centerKey || ""
      ).trim();


    if (!centerKey) {

      return res
        .status(400)
        .json({ ok: false });

    }


    const previous = centers.get(centerKey) || {};
    const businessDate = businessDateKeyKst();
    const sameBusinessDay = previous.liveBusinessDate === businessDate;
    const riders = mergeLiveRiders(previous.riders, req.body.riders, sameBusinessDay);

    // 현재/피크 누적값은 같은 영업일 안에서 감소하지 않게 라이더별 정상값으로 재계산한다.
    const peaks = riders.reduce((sum, r) => {
      const p = r.deliveryPeakTimeCount || {};
      sum.morning += nonNegativeNumber(p.morning) || 0;
      sum.afternoon += nonNegativeNumber(p.afternoon) || 0;
      sum.evening += nonNegativeNumber(p.evening) || 0;
      sum.night += nonNegativeNumber(p.midnight) || 0;
      return sum;
    }, { morning: 0, afternoon: 0, evening: 0, night: 0 });

    const ranking = riders
      .map(r => ({ name: r.name, val: fourTypeTotal(r) }))
      .filter(r => r.val > 0)
      .sort((a, b) => b.val - a.val);
    const eveningRanking = riders
      .map(r => ({ name: r.name, val: nonNegativeNumber(r?.deliveryPeakTimeCount?.evening) || 0 }))
      .filter(r => r.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, 10);

    const incomingSummary = req.body.summary || {};
    const previousSummary = sameBusinessDay ? (previous.summary || {}) : {};
    const summary = {
      ...previousSummary,
      ...incomingSummary,
      completed: monotonicNumber(previousSummary.completed, incomingSummary.completed)
    };

    centers.set(centerKey, {
      ...previous,
      ...req.body,
      centerKey,
      centerName: req.body.centerName || previous.centerName || centerKey,
      liveBusinessDate: businessDate,
      summary,
      riders,
      peaks,
      ranking,
      eveningRanking,
      receivedAt: new Date().toISOString()
    });

    // 기록보관소용 DB에는 안정화된 누적값만 저장한다.
    saveEveningToDB(centerKey, riders);


    res.json({
      ok: true,
      centerKey
    });

  }
);


/* =========================================================
   장기 이력 제어형 백필
   - 최근 90일보다 오래된 구간만 대상으로 한다.
   - 진행상태는 PostgreSQL에 저장하므로 재배포/재시작 후 이어서 진행한다.
   - 한 번에 최대 30일만 할당하고, 성공 저장 후에만 커서를 이동한다.
========================================================= */
let historyBackfillLease = null; // 한 번에 한 지사만 장기 백필 API를 사용한다.

app.post('/api/history-backfill-plan/:centerKey', async (req, res) => {
  if (req.get('x-ingest-key') !== INGEST_KEY) return res.status(401).json({ ok:false });
  const centerKey = String(req.params.centerKey || '').trim();
  if (!centerKey) return res.status(400).json({ ok:false, message:'centerKey 필요' });
  const months = Math.max(12, Math.min(24, Number(req.body?.months || 24) || 24));
  const batchDays = Math.max(1, Math.min(5, Number(req.body?.batchDays || 5) || 5));
  const now = Date.now();
  if (historyBackfillLease && historyBackfillLease.expiresAt > now && historyBackfillLease.centerKey !== centerKey) {
    return res.json({ ok:true, busy:true, activeCenter:historyBackfillLease.centerKey });
  }
  try {
    await historyArchiveReady;
    const today = businessDateKeyKst();
    const targetFrom = '2026-01-01'; // 누리온 기록 보관 시작일: 2026년 1월 1일
    const targetTo = addDaysKeyServer(today, -90);
    await pool.query(`
      INSERT INTO nurion_history_backfill_state (center_key, target_from, target_to, next_to)
      VALUES ($1,$2,$3,$3)
      ON CONFLICT (center_key) DO UPDATE SET
        target_from = EXCLUDED.target_from,
        target_to = GREATEST(nurion_history_backfill_state.target_to, EXCLUDED.target_to),
        next_to = CASE WHEN nurion_history_backfill_state.completed THEN nurion_history_backfill_state.next_to ELSE nurion_history_backfill_state.next_to END,
        updated_at = NOW()
    `, [centerKey, targetFrom, targetTo]);
    const q = await pool.query(`SELECT target_from::text, target_to::text, next_to::text, completed, batches_completed, rows_saved FROM nurion_history_backfill_state WHERE center_key=$1`, [centerKey]);
    const st = q.rows[0];
    if (!st || st.completed || !st.next_to || st.next_to < st.target_from) {
      if (st && !st.completed) await pool.query(`UPDATE nurion_history_backfill_state SET completed=TRUE, updated_at=NOW() WHERE center_key=$1`, [centerKey]);
      return res.json({ ok:true, done:true, targetFrom:st?.target_from || targetFrom, targetTo:st?.target_to || targetTo, batchesCompleted:Number(st?.batches_completed)||0, rowsSaved:Number(st?.rows_saved)||0 });
    }
    const toDate = st.next_to;
    const candidateFrom = addDaysKeyServer(toDate, -(batchDays - 1));
    const fromDate = candidateFrom < st.target_from ? st.target_from : candidateFrom;
    // 검증된 5일 전송 단위를 사용한다. 3분 lease는 장애 시 자동 회복용이다.
    historyBackfillLease = { centerKey, expiresAt: Date.now() + 3 * 60_000 };
    return res.json({ ok:true, done:false, fromDate, toDate, targetFrom:st.target_from, targetTo:st.target_to, batchDays });
  } catch (err) {
    console.error('[HISTORY BACKFILL PLAN FAILED]', centerKey, err.message);
    return res.status(503).json({ ok:false, message:'백필 계획 생성 실패' });
  }
});

app.post('/api/ingest-history-backfill/:centerKey', async (req, res) => {
  if (req.get('x-ingest-key') !== INGEST_KEY) return res.status(401).json({ ok:false });
  const centerKey = String(req.params.centerKey || '').trim();
  const body = req.body || {};
  const fromDate = String(body.fromDate || '');
  const toDate = String(body.toDate || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!centerKey || !/^20\d{2}-\d{2}-\d{2}$/.test(fromDate) || !/^20\d{2}-\d{2}-\d{2}$/.test(toDate)) {
    return res.status(400).json({ ok:false, message:'백필 범위 오류' });
  }
  try {
    await historyArchiveReady;
    const lock = await pool.query(`SELECT target_from::text, next_to::text, completed FROM nurion_history_backfill_state WHERE center_key=$1`, [centerKey]);
    const st = lock.rows[0];
    if (!st) return res.status(409).json({ ok:false, message:'백필 계획이 없습니다.' });
    if (st.completed) return res.json({ ok:true, done:true, remainingDays:0 });
    // 계획된 현재 커서와 다른 오래된/중복 요청은 저장은 허용하되 커서는 함부로 이동하지 않는다.
    const dbOk = await saveHistoryArchiveToDB(centerKey, rows);
    if (!dbOk) throw new Error('history archive batch save failed');
    if (String(st.next_to) === toDate) {
      const nextTo = addDaysKeyServer(fromDate, -1);
      const done = nextTo < String(st.target_from);
      await pool.query(`
        UPDATE nurion_history_backfill_state
        SET next_to=$2, completed=$3, batches_completed=batches_completed+1,
            rows_saved=rows_saved+$4, last_error=NULL, updated_at=NOW()
        WHERE center_key=$1
      `, [centerKey, nextTo, done, rows.length]);
      const remainingDays = done ? 0 : dateKeySpanDays(String(st.target_from), nextTo);
      if (historyBackfillLease?.centerKey === centerKey) historyBackfillLease = null;
      console.log(`[HISTORY BACKFILL DB] ${centerKey} ${fromDate}~${toDate} rows=${rows.length} remaining=${remainingDays}`);
      return res.json({ ok:true, done, remainingDays, rowCount:rows.length });
    }
    if (historyBackfillLease?.centerKey === centerKey) historyBackfillLease = null;
    console.log(`[HISTORY BACKFILL DUPLICATE] ${centerKey} ${fromDate}~${toDate} rows=${rows.length}`);
    return res.json({ ok:true, done:false, duplicate:true, rowCount:rows.length });
  } catch (err) {
    if (historyBackfillLease?.centerKey === centerKey) historyBackfillLease = null;
    console.error('[HISTORY BACKFILL SAVE FAILED]', centerKey, err.message);
    await pool.query(`UPDATE nurion_history_backfill_state SET last_error=$2, updated_at=NOW() WHERE center_key=$1`, [centerKey, String(err.message || err)]).catch(()=>{});
    return res.status(503).json({ ok:false, message:'백필 저장 실패' });
  }
});

/* =========================================================
   누리온 90일 데이터 수신
========================================================= */

app.post(
  "/api/ingest-history/:centerKey",
  (req, res) => {

    if (req.get("x-ingest-key") !== INGEST_KEY) {
      return res.status(401).json({
        ok: false
      });
    }

    const centerKey =
      String(req.params.centerKey || "").trim();

    if (!centerKey) {
      return res.status(400).json({
        ok: false,
        message: "centerKey 필요"
      });
    }

    const body = req.body || {};

    const incomingRows = Array.isArray(body.rows) ? body.rows : [];
    // 메모리 캐시와 별개로 모든 정상 90일 수집 배치를 장기 DB에 누적한다.
    // DB 실패가 실시간 메모리 수집까지 막지는 않지만 로그로 명확히 남긴다.
    saveHistoryArchiveToDB(centerKey, incomingRows);
    const previousHistory = historyCenters.get(centerKey) || {};
    const rows = mergeHistoryRows(
      previousHistory.rows,
      incomingRows,
      String(body.fromDate || ""),
      String(body.toDate || "")
    );

    historyCenters.set(centerKey, {
      centerKey,

      centerName:
        body.centerName || centerKey,

      fromDate:
        body.fromDate || "",

      toDate:
        body.toDate || "",

      dayCount:
        Number(body.dayCount) || 0,

      rows,

      generatedAt:
        body.generatedAt || previousHistory.generatedAt || null,

      // 90일 분할 전송 중에는 "오늘 전체 로드 완료"로 표시하지 않는다.
      // 마지막 배치가 정상 수신된 순간에만 receivedAt을 갱신한다.
      receivedAt:
        body.finalBatch === false
          ? (previousHistory.receivedAt || null)
          : new Date().toISOString()
    });

    console.log(
      "[90DAY SAVED]",
      centerKey,
      "days:",
      Number(body.dayCount) || 0,
      "rows:",
      rows.length,
      "incoming:",
      incomingRows.length
    );

    res.json({
      ok: true,
      centerKey,
      dayCount:
        Number(body.dayCount) || 0,
      rowCount:
        rows.length
    });
  }
);

/* =========================================================
   일별 상세 데이터 수신 - 주간 30초 수집 결과를 재사용
   월간 90일 데이터와 분리하여 월간 10시 갱신 정책을 유지한다.
========================================================= */

app.post(
  "/api/ingest-daily-detail/:centerKey",
  (req, res) => {
    if (req.get("x-ingest-key") !== INGEST_KEY) {
      return res.status(401).json({ ok: false });
    }

    const centerKey = String(req.params.centerKey || "").trim();
    if (!centerKey) return res.status(400).json({ ok: false, message: "centerKey 필요" });

    const body = req.body || {};
    const incomingRows = Array.isArray(body.rows) ? body.rows : [];
    const previous = dailyDetailCenters.get(centerKey) || {};
    const rows = mergeHistoryRows(
      previous.rows, incomingRows, String(body.fromDate || ""), String(body.toDate || "")
    );

    dailyDetailCenters.set(centerKey, {
      centerKey,
      centerName: body.centerName || centerKey,
      fromDate: body.fromDate || "",
      toDate: body.toDate || "",
      dayCount: Number(body.dayCount) || 0,
      rows,
      generatedAt: body.generatedAt || null,
      receivedAt: new Date().toISOString()
    });

    console.log("[DAILY DETAIL SAVED]", centerKey, "rows:", rows.length);
    res.json({ ok: true, centerKey, rowCount: rows.length });
  }
);

/* =========================================================
   누리온 앱용 주간 데이터 수신
========================================================= */

app.post(
  "/api/ingest-weekly/:centerKey",
  (req, res) => {

    if (
      req.get("x-ingest-key") !== INGEST_KEY
    ) {

      return res
        .status(401)
        .json({
          ok: false
        });

    }


    const centerKey =
      String(
        req.params.centerKey || ""
      ).trim();


    if (!centerKey) {

      return res.status(400).json({
        ok: false,
        message: "centerKey 필요"
      });

    }


    const body =
      req.body || {};


    const current =
      centers.get(centerKey) || {
        centerKey
      };


    centers.set(
      centerKey,
      {

        ...current,

        centerKey,

        weeklyDetails:
          Array.isArray(body.weeklyDetails)
            ? body.weeklyDetails
            : current.weeklyDetails || [],

        weeklyRanking:
          Array.isArray(body.weeklyRanking)
            ? body.weeklyRanking
            : current.weeklyRanking || [],

        todayRanking:
          Array.isArray(body.todayRanking)
            ? body.todayRanking
            : current.todayRanking || [],

        todayDetails:
  Array.isArray(body.todayDetails)
    ? body.todayDetails
    : current.todayDetails || [],
        
        eveningRanking:
  Array.isArray(body.eveningRanking)
    ? body.eveningRanking
    : [],

        weeklyUpdatedAt:
          new Date().toISOString()

      }
    );


    console.log(
      "[WEEKLY SAVED]",
      centerKey,
      "weekly:",
      Array.isArray(body.weeklyDetails)
        ? body.weeklyDetails.length
        : 0,
      "weeklyRanking:",
      Array.isArray(body.weeklyRanking)
        ? body.weeklyRanking.length
        : 0,
      "todayRanking:",
      Array.isArray(body.todayRanking)
        ? body.todayRanking.length
        : 0,
      "eveningRanking:",
      Array.isArray(body.eveningRanking)
        ? body.eveningRanking.length
        : 0
    );
    
    saveWeeklyDetailsToDB(
  centerKey,
  body.weekStart,
  body.weeklyDetails
);

    // 주간대장용 주간 랭킹 DB 저장
saveWeeklyRankingToDB(
  centerKey,
  body.weeklyRanking
);


    res.json({

      ok: true,

      centerKey,

      weeklyDetails:
        Array.isArray(body.weeklyDetails)
          ? body.weeklyDetails.length
          : 0,

      weeklyRanking:
        Array.isArray(body.weeklyRanking)
          ? body.weeklyRanking.length
          : 0,

      todayRanking:
        Array.isArray(body.todayRanking)
          ? body.todayRanking.length
          : 0,

      eveningRanking:
        Array.isArray(body.eveningRanking)
          ? body.eveningRanking.length
          : 0

    });

  }
);

/* =========================================================
   본인 일별 상세 - 현재 주간 30초 갱신 데이터
========================================================= */

app.get(
  "/api/my-daily-detail",
  auth,
  (req, res) => {
    const account = req.account;
    const riderUserId = String(account.riderUserId || "").trim();
    if (!riderUserId) return res.status(404).json({ ok: false, message: "라이더 계정이 연결되어 있지 않습니다." });

    const detail = dailyDetailCenters.get(account.centerKey);
    const rows = Array.isArray(detail?.rows)
      ? detail.rows.filter(row => String(row.userId || "").trim() === riderUserId)
      : [];

    res.json({
      ok: true,
      data: {
        name: account.name, userId: riderUserId,
        fromDate: detail?.fromDate || "", toDate: detail?.toDate || "",
        receivedAt: detail?.receivedAt || null, rows
      }
    });
  }
);

/* =========================================================
   본인 90일 배달 실적
========================================================= */

app.get(
  "/api/my-history",
  auth,
  (req, res) => {

    const account = req.account;

    const riderUserId =
      String(account.riderUserId || "").trim();

    if (!riderUserId) {
      return res.status(404).json({
        ok: false,
        message: "라이더 계정이 연결되어 있지 않습니다."
      });
    }

    // 개인 상세정보는 현재 지사에 묶지 않는다. 동일 riderUserId의 최근 이력을
    // 모든 수집 지사에서 합쳐 지사 이동 전후가 끊기지 않게 한다.
    const candidates = [];
    let latestReceivedAt = null;
    for (const history of historyCenters.values()) {
      if (!Array.isArray(history?.rows)) continue;
      for (const row of history.rows) {
        if (String(row?.userId || '').trim() === riderUserId) candidates.push(row);
      }
      if (history.receivedAt && (!latestReceivedAt || history.receivedAt > latestReceivedAt)) latestReceivedAt = history.receivedAt;
    }
    if (!candidates.length && !historyCenters.size) {
      return res.status(404).json({ ok:false, message:"90일 데이터가 아직 없습니다." });
    }
    const byDate = new Map();
    for (const row of candidates) {
      const key = String(row?.date || '');
      if (!key) continue;
      const prev = byDate.get(key);
      if (!prev || fourTypeTotal(row?.deliveryAcceptanceCount || row) >= fourTypeTotal(prev?.deliveryAcceptanceCount || prev)) byDate.set(key, row);
    }
    const rows = [...byDate.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    res.json({ ok:true, data:{
      name:account.name, userId:riderUserId,
      fromDate:rows[0]?.date || '', toDate:rows.at(-1)?.date || '',
      dayCount:rows.length, receivedAt:latestReceivedAt, rows
    }});
  }
);

/* =========================================================
   본인 장기 이력 - 월 단위 DB 조회
   개인 identity 기준으로 지사 이동 이력을 연결한다.
========================================================= */
app.get('/api/my-history-month', auth, async (req, res) => {
  const account = req.account;
  const riderUserId = String(account.riderUserId || '').trim();
  const identityKey = String(account.loginId || '').trim();
  const month = String(req.query.month || '').trim();
  if (!riderUserId) return res.status(404).json({ ok:false, message:'라이더 계정이 연결되어 있지 않습니다.' });
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ ok:false, message:'month는 YYYY-MM 형식이어야 합니다.' });
  if (month < '2026-01') return res.status(400).json({ ok:false, message:'2026년 1월 이전 기록은 조회할 수 없습니다.' });

  const [year, mon] = month.split('-').map(Number);
  const fromDate = `${year}-${String(mon).padStart(2,'0')}-01`;
  const next = new Date(Date.UTC(year, mon, 1));
  const toExclusive = next.toISOString().slice(0,10);
  try {
    await historyArchiveReady;
    const result = await pool.query(`
      WITH ids AS (
        SELECT $2::text AS rider_user_id
        UNION
        SELECT rider_user_id FROM rider_identity_aliases WHERE identity_key = $1
      ), ranked AS (
        SELECT h.*, ROW_NUMBER() OVER (PARTITION BY h.stat_date ORDER BY h.total_complete DESC, h.updated_at DESC) AS rn
        FROM nurion_rider_history h
        WHERE h.rider_user_id IN (SELECT rider_user_id FROM ids)
          AND h.stat_date >= $3::date AND h.stat_date < $4::date
      )
      SELECT stat_date::text AS date, center_key, rider_user_id, rider_name, total_complete,
             food_complete, bmart_complete, store_complete, out_complete, morning_complete, afternoon_complete,
             evening_complete, midnight_complete, reject_count, cancel_count, rider_fault_count, hourly_completed
      FROM ranked WHERE rn=1 ORDER BY stat_date ASC
    `, [identityKey, riderUserId, fromDate, toExclusive]);
    const rows = result.rows.map(r => ({
      date:r.date, centerKey:r.center_key, userId:r.rider_user_id, name:r.rider_name,
      total:Number(r.total_complete)||0, totalComplete:Number(r.total_complete)||0,
      food:Number(r.food_complete)||0, bmart:Number(r.bmart_complete)||0, store:Number(r.store_complete)||0, out:Number(r.out_complete)||0,
      morning:Number(r.morning_complete)||0, afternoon:Number(r.afternoon_complete)||0, evening:Number(r.evening_complete)||0, midnight:Number(r.midnight_complete)||0,
      reject:Number(r.reject_count)||0, cancel:Number(r.cancel_count)||0, riderFault:Number(r.rider_fault_count)||0,
      deliveryAcceptanceCount:{ foodComplete:Number(r.food_complete)||0, bmartComplete:Number(r.bmart_complete)||0, storeComplete:Number(r.store_complete)||0, slaOutComplete:Number(r.out_complete)||0 },
      deliveryPeakTimeCount:{ morning:Number(r.morning_complete)||0, afternoon:Number(r.afternoon_complete)||0, evening:Number(r.evening_complete)||0, midnight:Number(r.midnight_complete)||0 },
      hourlyCompleted:Array.isArray(r.hourly_completed) ? r.hourly_completed : []
    }));
    res.json({ ok:true, data:{ month, rows } });
  } catch (err) {
    console.error('[HISTORY MONTH QUERY FAILED]', identityKey, month, err.message);
    res.status(503).json({ ok:false, message:'과거 이력 조회에 실패했습니다.' });
  }
});

/* =========================================================
   본인 주간 배달 실적 - 관제 기준
========================================================= */

app.get(
  "/api/my-weekly",
  auth,
  (req, res) => {

    const account = req.account;

    const riderUserId =
      String(
        account.riderUserId || ""
      ).trim();

    if (!riderUserId) {
      return res.status(404).json({
        ok: false,
        message: "라이더 계정이 연결되어 있지 않습니다."
      });
    }

    const center =
      centers.get(account.centerKey);

    if (!center) {
      return res.status(404).json({
        ok: false,
        message: "관제 데이터가 아직 없습니다."
      });
    }

    const weeklyDetails =
      Array.isArray(center.weeklyDetails)
        ? center.weeklyDetails
        : [];

    const rider =
      weeklyDetails.find(
        r =>
          String(r.userId || "").trim() ===
          riderUserId
      );

    if (!rider) {
      return res.status(404).json({
        ok: false,
        message: "본인의 주간 실적을 찾을 수 없습니다."
      });
    }

    const days =
      rider.days || {};

    const weeklyTotal =
      Object.values(days)
        .reduce(
          (sum, value) =>
            sum + (Number(value) || 0),
          0
        );

    res.json({
      ok: true,
      data: {
        name: rider.name || account.name,
        userId: riderUserId,
        weeklyTotal,
        days
      }
    });

  }
);
/* =========================================================
   주간 TOP5
========================================================= */

app.get(
  "/api/weekly-ranking",
  auth,
  (req, res) => {

    const center =
      centers.get(
        req.account.centerKey
      );


    const list =
      Array.isArray(
        center?.weeklyRanking
      )
        ? center.weeklyRanking
            .slice(0, 5)
        : [];


    res.json({

      ok: true,

      data: list

    });

  }
);


/* =========================================================
   오늘의 TOP7
========================================================= */

app.get(
  "/api/today-ranking",
  auth,
  (req, res) => {

    const center =
      centers.get(
        req.account.centerKey
      );


    const list =
      Array.isArray(
        center?.todayRanking
      )
        ? center.todayRanking
            .slice(0, 7)
        : [];


    res.json({

      ok: true,

      data: list

    });

  }
);

/* =========================================================
   나의 오늘 완료
========================================================= */

app.get(
  "/api/my-today",
  auth,
  (req, res) => {

    const center = centers.get(req.account.centerKey);

    if (!center) {
      return res.status(404).json({ ok: false, message: "연결 대기중." });
    }

    const riderUserId = String(req.account.riderUserId || "").trim();
    const riderName = String(req.account.name || "").trim();

    // 오늘 상세 화면은 30초 주간 스냅샷보다 10초 LIVE riders를 우선한다.
    // LIVE에는 피크타임/시간대 원본도 함께 전달되므로 일별 화면이 실제로 갱신될 수 있다.
    const liveList = Array.isArray(center.riders) ? center.riders : [];
    const weeklyList = Array.isArray(center.todayDetails) ? center.todayDetails : [];

    const findRider = list => {
      let rider = null;
      if (riderUserId) {
        rider = list.find(r => String(r.userId || "").trim() === riderUserId);
      }
      if (!rider && riderName) {
        rider = list.find(r => String(r.name || "").trim() === riderName);
      }
      return rider || null;
    };

    const live = findRider(liveList);
    const weekly = findRider(weeklyList);
    const rider = live || weekly;

    if (!rider) {
      return res.status(404).json({ ok: false, message: "운행기록이 없습니다." });
    }

    const food = Number(live?.foodComplete ?? weekly?.food) || 0;
    const bmart = Number(live?.bmartComplete ?? weekly?.bmart) || 0;
    const store = Number(live?.storeComplete ?? weekly?.store) || 0;
    const out = Math.max(0, Number(live?.slaOutComplete ?? weekly?.out) || 0);
    const componentTotal = food + bmart + store + out;
    const total = componentTotal || Number(live?.allDayComplete ?? weekly?.val) || 0;

    const peak = live?.deliveryPeakTimeCount;
    const hasPeak = peak && ["morning", "afternoon", "evening", "midnight"]
      .some(k => peak[k] !== undefined && peak[k] !== null);
    const hourly = Array.isArray(live?.hourlyCompleted) && live.hourlyCompleted.length
      ? live.hourlyCompleted
      : null;

    res.json({
      ok: true,
      data: {
        name: rider.name,
        userId: rider.userId,
        total,
        food,
        bmart,
        store,
        out,
        // 원본이 없는 순간에는 키 자체를 보내지 않는다. 프론트가 마지막 정상값을 보존한다.
        ...(hasPeak ? { deliveryPeakTimeCount: { ...peak } } : {}),
        ...(hourly ? { hourlyCompleted: hourly } : {})
      }
    });
  }
);

/* =========================================================
   저녁피크 TOP10
========================================================= */

app.get(
  "/api/evening-ranking",
  auth,
  (req, res) => {

    const center =
      centers.get(
        req.account.centerKey
      );


    const list =
      Array.isArray(
        center?.eveningRanking
      )
        ? center.eveningRanking
            .filter(
              r => Number(r?.val) > 0
            )
            .slice(0, 10)
        : [];


    res.json({

      ok: true,

      data: list

    });

  }
);

// 기록보관소는 역대 최고기록이라 매 사용자/매 새로고침마다 DB를 다시 읽을 필요가 없다.
// 지사별 마지막 정상 응답을 짧게 캐시해 다지사/다중 사용자 환경의 DB 부하를 줄인다.
const championsResponseCache = new Map();
const CHAMPIONS_CACHE_MS = 30_000;

/* =========================================================
   서초대장 - 역대 기록 조회
========================================================= */

app.get(
  "/api/champions",
  auth,
  async (req, res) => {

    try {

      const centerKey =
        req.account.centerKey;

      const now = Date.now();
      const cached = championsResponseCache.get(centerKey);
      if (cached && now - cached.at < CHAMPIONS_CACHE_MS) {
        return res.json({ ok: true, data: cached.data });
      }

      const champions =
        await getSeochoChampions(centerKey);

      // 정상 조회에 성공했을 때만 캐시를 교체한다.
      championsResponseCache.set(centerKey, { at: now, data: champions });

      res.json({
        ok: true,
        data: champions
      });

    } catch (err) {

      console.error(
        "[CHAMPIONS FAILED]",
        err.message
      );

      res.status(500).json({
        ok: false,
        message: "대장 기록을 불러오지 못했습니다."
      });

    }

  }
);

/* =========================================================
   주간 거절률 데이터 수신
========================================================= */

app.post(
  "/api/ingest-reject/:centerKey",
  async (req, res) => {

    if (
      req.get("x-ingest-key") !== INGEST_KEY
    ) {

      return res.status(401).json({
        ok: false
      });

    }


    const centerKey =
      String(
        req.params.centerKey || ""
      ).trim();


    if (!centerKey) {

      return res.status(400).json({
        ok: false,
        message: "centerKey 필요"
      });

    }


    const body =
      req.body || {};


    const riders =
      Array.isArray(body.riders)
        ? body.riders
        : [];


    rejectCenters.set(
      centerKey,
      {

        centerKey,

        centerName:
          body.centerName ||
          centerKey,

        type:
          body.type ||
          "weeklyReject",

        weekStart:
          body.weekStart ||
          "",

        riderCount:
          riders.length,

        riders,

        dailyRejectData:
  Array.isArray(body.dailyRejectData)
    ? body.dailyRejectData
    : [],
        
        sentAt:
          body.sentAt ||
          null,

        receivedAt:
          new Date().toISOString()

      }
    );


    console.log(
      "[REJECT SAVED]",
      centerKey,
      "riders:",
      riders.length
    );


    res.json({

      ok: true,

      type:
        "weeklyReject",

      centerKey,

      riderCount:
        riders.length

    });

  }
);


/* =========================================================
   개발용 계정 생성
========================================================= */

app.post(
  "/api/dev/account",
  (req, res) => {

    if (
      req.get("x-ingest-key") !== INGEST_KEY
    ) {

      return res
        .status(401)
        .json({
          ok: false
        });

    }


    const {
      loginId,
      password,
      role = "rider",
      centerKey,
      riderUserId = "",
      name = ""
    } = req.body || {};


    if (
      !loginId ||
      !password ||
      !centerKey
    ) {

      return res.status(400).json({

        ok: false,

        message:
          "loginId/password/centerKey 필요"

      });

    }


    addAccount({

      loginId,
      password,
      role,
      centerKey,
      riderUserId,
      name

    });


    res.json({
      ok: true
    });

  }
);


/* =========================================================
   로그인
========================================================= */

app.post(
  "/api/login",
   async (req, res) => {

    const {
      loginId,
      password
    } = req.body || {};


    const id =
      String(
        loginId || ""
      ).trim();


    /*
     * 1. 기존 관리자/센터 계정
     */
    let account =
      accounts.get(id);


    /*
     * 2. 등록된 계정이 아니면
     *    주간 거절 데이터에서 userId 검색
     */
    if (
      !account &&
      password === "1234"
    ) {

      for (
        const [
          centerKey,
          rejectData
        ]
        of rejectCenters
      ) {

        const rider =
          (
            rejectData.riders ||
            []
          ).find(
            r =>
              String(
                r.userId || ""
              ) === id
          );


        if (rider) {

          account = {

            loginId:
              id,

            passwordHash:
              hash("1234"),

            role:
              "rider",

            centerKey:
              centerKey,

            riderUserId:
              id,

            name:
              rider.name ||
              id

          };


          accounts.set(
            id,
            account
          );

          await saveAccountToDB(account);

          break;

        }

      }

    }


    /*
     * 아이디 또는 비밀번호 오류
     */
    if (
      !account ||
      account.passwordHash !==
        hash(password || "")
    ) {

      return res.status(401).json({

        ok: false,

        message:
          "아이디 또는 비밀번호가 맞지 않습니다."

      });

    }


    // 같은 지사의 첫 사용자가 로그인하면 그날 90일 데이터가 아직 없을 때만
    // 백그라운드에서 1회 갱신한다. 로그인 응답 자체는 기다리지 않는다.
    triggerFirstAccessHistory(account.centerKey);

    const t =
      makeToken(account);


    res.json({

      ok: true,

      token: t,

      user: {

        name:
          account.name,

        role:
          account.role,

        centerKey:
          account.centerKey

      }

    });

  }
);

/* =========================================================
   비밀번호 변경
========================================================= */

app.post(
  "/api/change-password",
  auth,
  async (req, res) => {

    const currentPassword =
      String(req.body?.currentPassword || "");

    const newPassword =
      String(req.body?.newPassword || "");

    const account =
      req.account;

    if (
      account.passwordHash !==
      hash(currentPassword)
    ) {
      return res.status(400).json({
        ok: false,
        message: "현재 비밀번호가 맞지 않습니다."
      });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({
        ok: false,
        message: "새 비밀번호는 4자 이상 입력해주세요."
      });
    }

    try {

      const newPasswordHash =
        hash(newPassword);

      await pool.query(
        `
          UPDATE rider_accounts
          SET
            password_hash = $1,
            updated_at = NOW()
          WHERE login_id = $2
        `,
        [
          newPasswordHash,
          account.loginId
        ]
      );

      account.passwordHash =
        newPasswordHash;

      res.json({
        ok: true,
        message: "비밀번호가 변경되었습니다."
      });

    } catch (err) {

      console.error(
        "[PASSWORD CHANGE FAILED]",
        account.loginId,
        err.message
      );

      res.status(500).json({
        ok: false,
        message: "비밀번호 변경에 실패했습니다."
      });

    }

  }
);


/* =========================================================
   로그아웃
========================================================= */

app.post(
  "/api/logout",
  auth,
  (req, res) => {

    res.json({
      ok: true
    });

  }
);


/* =========================================================
   마스터 지사 선택
========================================================= */

app.get(
  "/api/master/centers",
  auth,
  (req, res) => {
    if (req.account.role !== "master" && req.account.role !== "superadmin") {
      return res.status(403).json({ ok: false, message: "마스터 계정만 사용할 수 있습니다." });
    }
    res.json({ ok: true, data: getSelectableCenters(), activeCenterKey: req.account.centerKey });
  }
);

app.post(
  "/api/master/switch-center",
  auth,
  (req, res) => {
    if (req.account.role !== "master" && req.account.role !== "superadmin") {
      return res.status(403).json({ ok: false, message: "마스터 계정만 사용할 수 있습니다." });
    }

    const centerKey = String(req.body?.centerKey || "").trim();
    if (!isSelectableCenterKey(centerKey)) {
      return res.status(400).json({ ok: false, message: "등록되지 않은 지사입니다." });
    }

    const switched = { ...req.account, centerKey };
    triggerFirstAccessHistory(centerKey);

    res.json({
      ok: true,
      token: makeToken(switched),
      user: { name: switched.name, role: switched.role, centerKey: switched.centerKey }
    });
  }
);

app.get(
  "/api/master/baemin-auth/status",
  auth,
  (req, res) => {
    if (req.account.role !== "master" && req.account.role !== "superadmin") {
      return res.status(403).json({ ok: false, message: "마스터 계정만 사용할 수 있습니다." });
    }

    const status = getBaeminDirectStatus();
    return res.json({
      ok: true,
      data: {
        authRequired: Boolean(status.authRequired),
        authStage: status.authStage || (status.authRequired ? "unknown" : "authenticated"),
        authMessage: status.authMessage || "",
        configured: Boolean(status.configured),
        centerKey: status.centerKey,
        lastCenterCheck: status.lastCenterCheck,
        cooldownRemainingMs: Math.max(0, BAEMIN_AUTH_SEND_COOLDOWN_MS - (Date.now() - baeminAuthLastSendAt))
      }
    });
  }
);

app.post(
  "/api/master/baemin-auth/send-code",
  auth,
  async (req, res) => {
    if (req.account.role !== "master" && req.account.role !== "superadmin") {
      return res.status(403).json({ ok: false, message: "마스터 계정만 사용할 수 있습니다." });
    }

    const remaining = BAEMIN_AUTH_SEND_COOLDOWN_MS - (Date.now() - baeminAuthLastSendAt);
    if (remaining > 0) {
      return res.status(429).json({
        ok: false,
        message: `인증번호는 ${Math.ceil(remaining / 1000)}초 후 다시 요청할 수 있습니다.`,
        retryAfterMs: remaining
      });
    }

    try {
      await requestPhoneVerification();
      baeminAuthLastSendAt = Date.now();
      console.log("[BAEMIN AUTH] verification code requested");
      return res.json({ ok: true, message: "인증번호를 발송했습니다." });
    } catch (error) {
      console.error("[BAEMIN AUTH SEND FAILED]", error.message);
      const status = getBaeminDirectStatus();
      return res.status(409).json({
        ok: false,
        authStage: status.authStage || error.authStage || "unknown",
        message: String(error?.message || "배민 인증번호 발송에 실패했습니다.").slice(0, 300)
      });
    }
  }
);

app.post(
  "/api/master/baemin-auth/verify-code",
  auth,
  async (req, res) => {
    if (req.account.role !== "master" && req.account.role !== "superadmin") {
      return res.status(403).json({ ok: false, message: "마스터 계정만 사용할 수 있습니다." });
    }

    const verificationCode = String(req.body?.verificationCode || "").trim();
    if (!/^\d{6}$/.test(verificationCode)) {
      return res.status(400).json({ ok: false, message: "인증번호 6자리를 입력해주세요." });
    }

    try {
      await submitPhoneVerification(verificationCode);

      // 로그인 응답만 믿지 않고 실제 센터 API가 새 세션으로 정상 응답하는지 확인한다.
      const verified = await baeminDirectTest.checkCenter();
      if (!verified) {
        throw new Error("새 배민 세션 검증에 실패했습니다.");
      }

      const cookie = getBaeminCookieHeader();
      await saveBaeminSessionToDB(cookie);
      const workerCount = broadcastBaeminSessionToWorkers(cookie);

      console.log(`[BAEMIN AUTH] verification completed workers=${workerCount}`);
      return res.json({ ok: true, message: "배민 재인증이 완료되었습니다." });
    } catch (error) {
      console.error("[BAEMIN AUTH VERIFY FAILED]", error.message);
      return res.status(502).json({ ok: false, message: "인증번호 확인 또는 새 세션 적용에 실패했습니다." });
    }
  }
);

/* =========================================================
   내 정보
========================================================= */

app.get(
  "/api/me",
  auth,
  (req, res) => {

    res.json({

      ok: true,

      user: {

        name:
          req.account.name,

        role:
          req.account.role,

        centerKey:
          req.account.centerKey

      }

    });

  }
);


/* =========================================================
   지사 데이터
========================================================= */

app.get(
  "/api/center/:centerKey",
  auth,
  (req, res) => {

    const key =
      req.params.centerKey;


    if (
      !centerAllowed(
        req.account,
        key
      )
    ) {

      return res
        .status(403)
        .json({

          ok: false,

          message:
            "다른 지사의 정보는 볼 수 없습니다."

        });

    }


    const d =
      centers.get(key);


    if (!d) {

      return res
        .status(404)
        .json({

          ok: false,

          message:
            "해당 지사의 관제 데이터가 아직 없습니다."

        });

    }


    res.json({

      ok: true,

      data:
        publicPayload(d)

    });

  }
);

/* =========================================================
   내 주간 거절률
========================================================= */

app.get(
  "/api/my-reject",
  auth,
  (req, res) => {

    const account =
      req.account;


    const riderUserId =
      String(
        account.riderUserId || ""
      ).trim();


    if (!riderUserId) {

      return res.status(404).json({

        ok: false,

        message:
          "라이더 계정이 연결되어 있지 않습니다."

      });

    }


    const rejectData =
      rejectCenters.get(
        account.centerKey
      );


    if (!rejectData) {

      return res.status(404).json({

        ok: false,

        message:
          "주간 거절 데이터가 아직 없습니다."

      });

    }


    const rider =
      (
        rejectData.riders ||
        []
      ).find(

        r =>
          String(
            r.userId || ""
          ).trim() ===
          riderUserId

      );


    if (!rider) {

      return res.status(404).json({

        ok: false,

        message:
          "본인의 주간 거절 데이터를 찾을 수 없습니다."

      });

    }


    res.json({

      ok: true,

      data: {

        name:
          rider.name,

        userId:
          rider.userId,

        complete:
          rider.complete,

        reject:
          rider.reject,

        cancel:
          rider.cancel,

        rejectCancel:
          rider.rejectCancel,

        rejectRate:
          rider.rejectRate,

        weekStart:
          rejectData.weekStart,

        receivedAt:
          rejectData.receivedAt

      }

    });

  }
);

/* =========================================================
   내 주간 거절률 - 관제 기준 / 일자별
========================================================= */

app.get(
  "/api/my-reject-detail",
  auth,
  (req, res) => {
    const account = req.account;
    const riderUserId = String(account.riderUserId || "").trim();

    if (!riderUserId) {
      return res.status(404).json({
        ok: false,
        message: "라이더 계정이 연결되어 있지 않습니다."
      });
    }

    // 거절률 팝업은 DB 이력을 사용하지 않는다.
    // collector가 배민 관제에서 실시간으로 만든 weeklyReject/dailyRejectData만 사용한다.
    const rejectData = rejectCenters.get(account.centerKey);
    if (!rejectData) {
      return res.status(404).json({
        ok: false,
        message: "주간 거절 데이터가 아직 없습니다."
      });
    }

    const rows = (Array.isArray(rejectData.dailyRejectData)
      ? rejectData.dailyRejectData
      : [])
      .filter(row => String(row.userId || "").trim() === riderUserId)
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

    const weekdayNamesFull = [
      "일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"
    ];

    const days = [];
    let complete = 0;
    let reject = 0;
    let cancel = 0;

    for (const row of rows) {
      const dateStr = String(row.date || "").slice(0, 10);
      if (!dateStr) continue;

      const [y, m, d] = dateStr.split("-").map(Number);
      const weekday = weekdayNamesFull[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

      // dailyRejectData 자체가 collector에서 foodComplete/foodReject/foodCancel만 담는다.
      // B마트/배민스토어/시간외 완료는 거절률 계산에서 제외된다.
      const dayComplete = Number(row.complete) || 0;
      const dayReject = Number(row.reject) || 0;
      const dayCancel = Number(row.cancel) || 0;
      const dayRejectCancel = dayReject + dayCancel;

      days.push({
        weekday,
        date: dateStr,
        complete: dayComplete,
        reject: dayReject,
        cancel: dayCancel,
        rejectCancel: dayRejectCancel
      });

      complete += dayComplete;
      reject += dayReject;
      cancel += dayCancel;
    }

    const rejectCancel = reject + cancel;
    const total = complete + rejectCancel;
    const rejectRate = total > 0
      ? Number(((rejectCancel / total) * 100).toFixed(1))
      : 0;

    const rider = (rejectData.riders || []).find(
      r => String(r.userId || "").trim() === riderUserId
    );

    return res.json({
      ok: true,
      data: {
        name: rider?.name || account.name,
        userId: riderUserId,
        complete,
        reject,
        cancel,
        rejectCancel,
        rejectRate,
        weekStart: rejectData.weekStart || "",
        receivedAt: rejectData.receivedAt || null,
        days
      }
    });
  }
);

/* =========================================================
   지사 주간 거절률
========================================================= */

app.get(
  "/api/center-reject",
  auth,
  (req, res) => {

    const account =
      req.account;


    const centerKey =
      account.centerKey;


    const rejectData =
      rejectCenters.get(
        centerKey
      );


    if (!rejectData) {

      return res.status(404).json({

        ok: false,

        message:
          "주간 거절 데이터가 아직 없습니다."

      });

    }


    const riders =
      Array.isArray(
        rejectData.riders
      )
        ? rejectData.riders
        : [];


    let complete = 0;
    let rejectCancel = 0;


    for (
      const rider
      of riders
    ) {

      complete +=
        Number(
          rider.complete
        ) || 0;


      rejectCancel +=
        Number(
          rider.rejectCancel
        ) ||
        (
          (
            Number(
              rider.reject
            ) || 0
          ) +
          (
            Number(
              rider.cancel
            ) || 0
          )
        );

    }


    const total =
      complete +
      rejectCancel;


    const rejectRate =
      total > 0

        ? Number(

            (
              rejectCancel /
              total *
              100

            ).toFixed(1)

          )

        : 0;


    res.json({

      ok: true,

      data: {

        centerKey,

        centerName:
          rejectData.centerName ||
          centerKey,

        complete,

        rejectCancel,

        rejectRate,

        weekStart:
          rejectData.weekStart ||
          "",

        receivedAt:
          rejectData.receivedAt ||
          null

      }

    });

  }
);

/* =========================================================
   관리자 - 지사 운영 설정
========================================================= */
app.get("/api/admin/operational-settings", auth, (req, res) => {
  if (req.account.role !== "master" && req.account.role !== "superadmin") {
    return res.status(403).json({ ok:false, message:"관리자만 변경할 수 있습니다." });
  }
  res.json({ ok:true, data:goalsForCenter(req.account.centerKey).state });
});

app.post("/api/admin/operational-settings/set-count", auth, async (req, res) => {
  if (req.account.role !== "master" && req.account.role !== "superadmin") {
    return res.status(403).json({ ok:false, message:"관리자만 변경할 수 있습니다." });
  }
  const setCount = normalizeSetCount(req.body?.setCount);
  if (setCount == null) {
    return res.status(400).json({ ok:false, message:"세트수는 0보다 큰 숫자로 입력해주세요." });
  }
  const centerKey = req.account.centerKey;
  try {
    await saveCenterSetCountToDB(centerKey, setCount);
    saveOperationalSetting(centerKey, { setCount });
    res.json({ ok:true, data:goalsForCenter(centerKey).state });
  } catch (err) {
    console.error("[SET COUNT DB SAVE FAILED]", centerKey, err.message);
    return res.status(500).json({ ok:false, message:"세트수 저장에 실패했습니다." });
  }
});

app.post("/api/admin/operational-settings/day-basis", auth, async (req, res) => {
  if (req.account.role !== "master" && req.account.role !== "superadmin") {
    return res.status(403).json({ ok:false, message:"관리자만 변경할 수 있습니다." });
  }
  const dayType = String(req.body?.dayType || "");
  if (!["weekday","saturday","sunday"].includes(dayType)) {
    return res.status(400).json({ ok:false, message:"요일 기준을 선택해주세요." });
  }
  const businessDate = businessDateKeyKst();
  try {
    await saveGlobalDayOverrideToDB(dayType, businessDate);
    globalDayOverride = { overrideDayType: dayType, overrideBusinessDate: businessDate };
    res.json({ ok:true, data:goalsForCenter(req.account.centerKey).state });
  } catch (err) {
    console.error("[DAY BASIS DB SAVE FAILED]", err.message);
    return res.status(500).json({ ok:false, message:"요일 기준 저장에 실패했습니다." });
  }
});

/* =========================================================
   관리자 - 주간 거절률 20% 초과 기사
========================================================= */

app.get(
  "/api/admin/reject-riders",
  auth,
  (req, res) => {

    const account = req.account;

    if (
      account.role !== "master" &&
      account.role !== "superadmin"
    ) {
      return res.status(403).json({
        ok: false,
        message: "관리자만 볼 수 있습니다."
      });
    }

    const rejectData =
      rejectCenters.get(account.centerKey);

    if (!rejectData) {
      return res.status(404).json({
        ok: false,
        message: "주간 거절 데이터가 아직 없습니다."
      });
    }

    const riders =
      Array.isArray(rejectData.riders)
        ? rejectData.riders
        : [];

    const list = riders
      .map(rider => {

        const complete =
          Number(rider.complete) || 0;

        const rejectCancel =
          Number(rider.rejectCancel) ||
          (
            (Number(rider.reject) || 0) +
            (Number(rider.cancel) || 0)
          );

        const total =
          complete + rejectCancel;

        const rejectRate =
          total > 0
            ? Number(
                (
                  rejectCancel /
                  total *
                  100
                ).toFixed(1)
              )
            : 0;

        return {
          name: rider.name,
          userId: rider.userId,
          total,
          rejectRate
        };
      })

      // 20% 초과만
      .filter(
        rider =>
          rider.rejectRate > 20
      )

      // 전체 건수 많은 순
      // 같은 건수면 거절률 높은 순
      .sort(
        (a, b) =>
          b.total - a.total ||
          b.rejectRate - a.rejectRate
      );

    res.json({
      ok: true,
      data: list
    });

  }
);

/* =========================================================
   전체 관리자
========================================================= */

app.get(
  "/api/admin/centers",
  auth,
  (req, res) => {

    if (
      req.account.role !==
      "superadmin"
    ) {

      return res
        .status(403)
        .json({
          ok: false
        });

    }


    res.json({

      ok: true,

      centers:
        [
          ...centers.values()
        ]
        .map(
          d => ({

            centerKey:
              d.centerKey,

            centerName:
              d.centerName,

            receivedAt:
              d.receivedAt,

            summary:
              d.summary

          })
        )

    });

  }
);


/* =========================================================
   Health
========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      centers:
        centers.size,

      accounts:
        accounts.size,

      rejectCenters:
        rejectCenters.size,

      historyCenters:
        historyCenters.size,

      baeminDirect:
        getBaeminDirectStatus(),

      baeminDirectExtraCenters:
        getExtraCenterStatuses()

    });

  }
);


async function startBaeminCollectors() {
  let sharedCookie = "";

  const restored = await loadBaeminSessionFromDB();
  if (restored?.cookie) {
    updateBaeminSession(restored.cookie);
    sharedCookie = restored.cookie;
  } else {
    sharedCookie = String(process.env.BAEMIN_COOKIE || "").trim();
  }

  await startBaeminDirectCollector({
    port: PORT,
    ingestKey: INGEST_KEY
  });

  // 추가 지사는 메인과 동일한 최신 공용 세션으로 시작한다.
  startExtraCenterCollectors(sharedCookie || getBaeminCookieHeader());
}

app.listen(
  PORT,
  () => {
    console.log(`Rider Control v4: http://localhost:${PORT}`);

    startBaeminCollectors().catch(err => {
      console.error("[BAEMIN COLLECTORS START FAILED]", err.message);
    });
  }
);
