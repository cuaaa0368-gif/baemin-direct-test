const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const {
  startBaeminDirectCollector,
  getBaeminDirectStatus
} = require("./baemin-direct");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.query("SELECT NOW()")
  .then(() => console.log("[DB] PostgreSQL connected"))
  .catch(err => console.error("[DB] PostgreSQL connection failed:", err.message));

const app = express();

const PORT = process.env.PORT || 8787;
const INGEST_KEY = process.env.INGEST_KEY || "change-me-later";

/*
 * 로그인 토큰 서명용 비밀키
 * Render에서는 LOGIN_SECRET 환경변수를 설정하는 것을 권장.
 * 설정하지 않은 동안은 INGEST_KEY를 사용.
 */
const LOGIN_SECRET = process.env.LOGIN_SECRET || INGEST_KEY;


/* =========================================================
   메모리 데이터
========================================================= */

const centers = new Map();
const rejectCenters = new Map();
const historyCenters = new Map();
const dailyDetailCenters = new Map();


/* =========================================================
   지사 운영 설정
   - 세트수: 관리자가 변경할 때까지 계속 유지
   - 요일 기준 수동 지정: 해당 영업일(06:00~다음 05:59)에만 유지
========================================================= */
const operationalSettings = new Map();

function normalizeSetCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

function getOperationalSetting(centerKey) {
  const key = String(centerKey || "").trim();
  const saved = operationalSettings.get(key) || {};
  const businessDate = businessDateKeyKst();
  const manualActive =
    saved.overrideBusinessDate === businessDate &&
    ["weekday", "saturday", "sunday"].includes(saved.overrideDayType);

  return {
    centerKey: key,
    setCount: normalizeSetCount(saved.setCount) ?? 10,
    overrideDayType: manualActive ? saved.overrideDayType : null,
    overrideBusinessDate: manualActive ? saved.overrideBusinessDate : null,
    manualActive
  };
}

function goalBaseForBusinessDate(businessDate, overrideDayType = null) {
  const [y, m, d] = String(businessDate).split("-").map(Number);
  let day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  // 수동 기준은 해당 영업일에서만 자동 달력/공휴일 판정보다 우선한다.
  if (overrideDayType === "saturday") day = 6;
  else if (overrideDayType === "sunday") day = 0;
  else if (overrideDayType === "weekday") {
    // 평일 지정은 실제 날짜의 평일 세부 기준을 유지한다.
    // 금요일이면 금요일 기준, 월~목이면 월~목 기준.
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
  if (setting.manualActive) {
    day = goalBaseForBusinessDate(businessDate, setting.overrideDayType);
  } else if (businessDate === "2026-07-17") {
    day = 6;
  } else if (holidayDates.has(businessDate)) {
    day = 0;
  } else {
    day = actualDay;
  }

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

// 현재 단계에서는 운영 설정을 DB에 저장하지 않는다.
// Render 프로세스 메모리에서만 유지한다.
// - 세트수: 프로세스가 살아있는 동안 관리자가 다시 변경할 때까지 유지
// - 요일 수동 기준: 현재 영업일에만 유효하고 다음 06:00부터 자동 무효
function saveOperationalSetting(centerKey, setting) {
  operationalSettings.set(String(centerKey || "").trim(), {
    setCount: normalizeSetCount(setting?.setCount) ?? 10,
    overrideDayType: setting?.overrideDayType || null,
    overrideBusinessDate: setting?.overrideBusinessDate || null
  });
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

async function saveWeeklyDetailsToDB(centerKey, weekStart, weeklyDetails) {
  try {
    console.log("[DB WEEKLY INPUT] weekStart:", weekStart);
    if (!Array.isArray(weeklyDetails) || weeklyDetails.length === 0) {
      return;
    }

    const weekdayOffset = {
      "수요일": 0,
      "목요일": 1,
      "금요일": 2,
      "토요일": 3,
      "일요일": 4,
      "월요일": 5,
      "화요일": 6
    };

    for (const rider of weeklyDetails) {
      const userId = String(rider.userId || "").trim();

      if (!userId) continue;

      const name = String(rider.name || "").trim();
      const days = rider.days || {};

      for (const [weekday, complete] of Object.entries(days)) {
        if (weekdayOffset[weekday] === undefined) continue;

        const date = new Date(`${weekStart}T12:00:00+09:00`);
        date.setDate(date.getDate() + weekdayOffset[weekday]);

        const statDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(date);

        await pool.query(
          `
          INSERT INTO rider_daily_stats
            (
              stat_date,
              center_key,
              rider_user_id,
              rider_name,
              complete,
              reject_count,
              cancel_count
            )
          VALUES ($1,$2,$3,$4,$5,0,0)

          ON CONFLICT
            (stat_date, center_key, rider_user_id)

DO UPDATE SET
  rider_name = EXCLUDED.rider_name,
  complete = GREATEST(
    rider_daily_stats.complete,
    EXCLUDED.complete
  ),
  updated_at = now()
          `,
          [
            statDate,
            centerKey,
            userId,
            name,
            Number(complete) || 0
          ]
        );
      }
    }

    console.log(
      "[DB WEEKLY SAVED]",
      centerKey,
      "riders:",
      weeklyDetails.length
    );

  } catch (err) {
    console.error(
      "[DB WEEKLY SAVE FAILED]",
      centerKey,
      err.message
    );
  }
}

/* =========================================================
   Supabase - 라이더 날짜별 거절/취소 저장
========================================================= */

async function saveDailyRejectToDB(centerKey, dailyRejectData) {
  try {
    if (!Array.isArray(dailyRejectData) || dailyRejectData.length === 0) {
      return;
    }

    for (const row of dailyRejectData) {
       console.log(
    "[REJECT ROW CHECK]",
    row.date,
    row.name,
    "complete:", row.complete,
    "reject:", row.reject,
    "cancel:", row.cancel
  );
      const userId = String(row.userId || "").trim();
      if (!userId || !row.date) continue;

      await pool.query(
  `
  INSERT INTO rider_daily_stats
    (
      stat_date,
      center_key,
      rider_user_id,
      rider_name,
      complete,
      food_complete,
      reject_count,
      cancel_count
    )
  VALUES ($1,$2,$3,$4,0,$5,$6,$7)

  ON CONFLICT
    (stat_date, center_key, rider_user_id)

  DO UPDATE SET
    rider_name = EXCLUDED.rider_name,
    food_complete = EXCLUDED.food_complete,
    reject_count = EXCLUDED.reject_count,
    cancel_count = EXCLUDED.cancel_count,
    updated_at = now()
  `,
  [
    row.date,
    centerKey,
    userId,
    String(row.name || ""),
    Number(row.complete) || 0,
    Number(row.reject) || 0,
    Number(row.cancel) || 0
  ]
);
 } 
    console.log(
      "[DB REJECT SAVED]",
      centerKey,
      "rows:",
      dailyRejectData.length
    );

  } catch (err) {
    console.error(
      "[DB REJECT SAVE FAILED]",
      centerKey,
      err.message
    );
  }
}

/* =========================================================
   Supabase - 오늘 저녁피크 실적 저장
========================================================= */

async function saveEveningToDB(centerKey, riders) {
  try {
    if (!Array.isArray(riders) || riders.length === 0) return;

// 배민 업무일 기준: 06:00 이전은 전날
const nowKst = new Date(
  new Date().toLocaleString("en-US", {
    timeZone: "Asia/Seoul"
  })
);

if (nowKst.getHours() < 6) {
  nowKst.setDate(nowKst.getDate() - 1);
}

const statDate =
  `${nowKst.getFullYear()}-` +
  `${String(nowKst.getMonth() + 1).padStart(2, "0")}-` +
  `${String(nowKst.getDate()).padStart(2, "0")}`;

    for (const rider of riders) {
      const userId = String(rider.userId || "").trim();
      if (!userId) continue;

      await pool.query(
        `
        INSERT INTO rider_daily_stats
        (
          stat_date,
          center_key,
          rider_user_id,
          rider_name,
          complete,
          reject_count,
          cancel_count,
          evening_complete
        )
        VALUES ($1,$2,$3,$4,$5,0,0,$6)

        ON CONFLICT
          (stat_date, center_key, rider_user_id)

DO UPDATE SET
  rider_name = EXCLUDED.rider_name,

  complete = GREATEST(
    rider_daily_stats.complete,
    EXCLUDED.complete
  ),

  evening_complete = GREATEST(
    rider_daily_stats.evening_complete,
    EXCLUDED.evening_complete
  ),

  updated_at = now()
        `,
        [
          statDate,
          centerKey,
          userId,
          String(rider.name || ""),
          Number(rider.allDayComplete) || 0,
          Number(rider.evening) || 0
        ]
      );
    }

    console.log(
      "[DB EVENING SAVED]",
      centerKey,
      "riders:",
      riders.length
    );

  } catch (err) {
    console.error(
      "[DB EVENING SAVE FAILED]",
      centerKey,
      err.message
    );
  }
}

/* =========================================================
   Supabase - 주간 실적 기록 저장
========================================================= */

async function saveWeeklyRankingToDB(centerKey, weeklyRanking) {
  try {
    if (!Array.isArray(weeklyRanking) || weeklyRanking.length === 0) {
      return;
    }

// 배민 업무일 기준: 06:00 이전은 전날
const nowKst = new Date(
  new Date().toLocaleString("en-US", {
    timeZone: "Asia/Seoul"
  })
);

if (nowKst.getHours() < 6) {
  nowKst.setDate(nowKst.getDate() - 1);
}

const todayStr =
  `${nowKst.getFullYear()}-` +
  `${String(nowKst.getMonth() + 1).padStart(2, "0")}-` +
  `${String(nowKst.getDate()).padStart(2, "0")}`;

const today = new Date(todayStr + "T00:00:00Z");

    // 수요일을 한 주의 시작으로 계산
    const dow = today.getUTCDay();
    const diff = (dow - 3 + 7) % 7;

    const weekStartDate = new Date(today);
    weekStartDate.setUTCDate(today.getUTCDate() - diff);

    const weekStart =
      weekStartDate.toISOString().slice(0, 10);

    for (const rider of weeklyRanking) {

      const userId =
        String(rider.userId || "").trim();

      if (!userId) continue;

      const complete =
        Number(rider.val) || 0;

      await pool.query(
        `
        INSERT INTO rider_weekly_records
          (
            week_start,
            center_key,
            rider_user_id,
            rider_name,
            complete
          )

        VALUES ($1,$2,$3,$4,$5)

        ON CONFLICT
          (week_start, center_key, rider_user_id)

        DO UPDATE SET
          rider_name = EXCLUDED.rider_name,
          complete = GREATEST(
            rider_weekly_records.complete,
            EXCLUDED.complete
          ),
          updated_at = now()
        `,
        [
          weekStart,
          centerKey,
          userId,
          String(rider.name || ""),
          complete
        ]
      );
    }

    console.log(
      "[DB WEEKLY RECORD SAVED]",
      centerKey,
      "week:",
      weekStart,
      "riders:",
      weeklyRanking.length
    );

  } catch (err) {

    console.error(
      "[DB WEEKLY RECORD SAVE FAILED]",
      centerKey,
      err.message
    );

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
    LIMIT 1
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
  LIMIT 1
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
  LIMIT 1
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
    issuedAt: Date.now()
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

function publicPayload(d) {
  const operational = goalsForCenter(d.centerKey);
  return {
    centerKey: d.centerKey,
    centerName: d.centerName,
    receivedAt: d.receivedAt,
    sentAt: d.sentAt,

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
        body.generatedAt || null,

      receivedAt:
        new Date().toISOString()
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

    const history =
      historyCenters.get(account.centerKey);

    if (!history) {
      return res.status(404).json({
        ok: false,
        message: "90일 데이터가 아직 없습니다."
      });
    }

    const rows =
      Array.isArray(history.rows)
        ? history.rows.filter(
            row =>
              String(row.userId || "").trim() ===
              riderUserId
          )
        : [];

    res.json({
      ok: true,
      data: {
        name: account.name,
        userId: riderUserId,
        fromDate: history.fromDate,
        toDate: history.toDate,
        dayCount: history.dayCount,
        receivedAt: history.receivedAt,
        rows
      }
    });
  }
);

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
    const out = Number(live?.slaOutComplete ?? weekly?.out) || 0;
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

      const champions =
        await getSeochoChampions(centerKey);

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

    const rejectData =
      rejectCenters.get(account.centerKey);

    if (!rejectData) {
      return res.status(404).json({
        ok: false,
        message: "주간 거절 데이터가 아직 없습니다."
      });
    }

    const dailyRejectData =
      Array.isArray(rejectData.dailyRejectData)
        ? rejectData.dailyRejectData
        : [];

    const nowKst = new Date(
      new Date().toLocaleString(
        "en-US",
        {
          timeZone: "Asia/Seoul"
        }
      )
    );

    if (nowKst.getHours() < 6) {
      nowKst.setDate(
        nowKst.getDate() - 1
      );
    }

    const dow =
      nowKst.getDay();

    const diff =
      (dow - 3 + 7) % 7;

    const weekStartDate =
      new Date(nowKst);

    weekStartDate.setDate(
      nowKst.getDate() - diff
    );

    const formatDate = date =>
      `${date.getFullYear()}-` +
      `${String(
        date.getMonth() + 1
      ).padStart(2, "0")}-` +
      `${String(
        date.getDate()
      ).padStart(2, "0")}`;

    const weekStart =
      formatDate(weekStartDate);

    const weekdayNames = [
      "수요일",
      "목요일",
      "금요일",
      "토요일",
      "일요일",
      "월요일",
      "화요일"
    ];

const days = [];

let complete = 0;
let reject = 0;
let cancel = 0;


/* Tampermonkey가 보내온 실제 날짜를 그대로 사용 */

const myDaily =
  dailyRejectData
    .filter(
      r =>
        String(r.userId || "").trim() ===
        riderUserId
    )
    .sort(
      (a, b) =>
        String(a.date || "")
          .localeCompare(
            String(b.date || "")
          )
    );


const weekdayNamesFull = [
  "일요일",
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일"
];


for (const row of myDaily) {

  const dateStr =
    String(row.date || "")
      .slice(0, 10);

  if (!dateStr) continue;


  const [y, m, d] =
    dateStr
      .split("-")
      .map(Number);


 const weekday =
  weekdayNamesFull[
    new Date(
      Date.UTC(y, m - 1, d)
    ).getUTCDay()
  ];


  const dayComplete =
    Number(row.complete) || 0;

  const dayReject =
    Number(row.reject) || 0;

  const dayCancel =
    Number(row.cancel) || 0;

  const dayRejectCancel =
    dayReject + dayCancel;


  days.push({

    weekday,

    date:
      dateStr,

    complete:
      dayComplete,

    reject:
      dayReject,

    cancel:
      dayCancel,

    rejectCancel:
      dayRejectCancel

  });


  complete +=
    dayComplete;

  reject +=
    dayReject;

  cancel +=
    dayCancel;
}

    const rejectCancel =
      reject + cancel;

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

    res.json({
      ok: true,
      data: {
        name: account.name,
        userId: riderUserId,
        complete,
        reject,
        cancel,
        rejectCancel,
        rejectRate,
        weekStart,
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

app.post("/api/admin/operational-settings/set-count", auth, (req, res) => {
  if (req.account.role !== "master" && req.account.role !== "superadmin") {
    return res.status(403).json({ ok:false, message:"관리자만 변경할 수 있습니다." });
  }
  const setCount = normalizeSetCount(req.body?.setCount);
  if (setCount == null) {
    return res.status(400).json({ ok:false, message:"세트수는 0보다 큰 숫자로 입력해주세요." });
  }
  const current = getOperationalSetting(req.account.centerKey);
  const next = {
    setCount,
    overrideDayType: current.overrideDayType,
    overrideBusinessDate: current.overrideBusinessDate
  };
  saveOperationalSetting(req.account.centerKey, next);
  res.json({ ok:true, data:goalsForCenter(req.account.centerKey).state });
});

app.post("/api/admin/operational-settings/day-basis", auth, (req, res) => {
  if (req.account.role !== "master" && req.account.role !== "superadmin") {
    return res.status(403).json({ ok:false, message:"관리자만 변경할 수 있습니다." });
  }
  const dayType = String(req.body?.dayType || "");
  if (!["weekday","saturday","sunday"].includes(dayType)) {
    return res.status(400).json({ ok:false, message:"요일 기준을 선택해주세요." });
  }
  const current = getOperationalSetting(req.account.centerKey);
  const next = {
    setCount: current.setCount,
    overrideDayType: dayType,
    overrideBusinessDate: businessDateKeyKst()
  };
  saveOperationalSetting(req.account.centerKey, next);
  res.json({ ok:true, data:goalsForCenter(req.account.centerKey).state });
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
        getBaeminDirectStatus()

    });

  }
);


app.listen(
  PORT,
  () => {
    console.log(
      `Rider Control v4: http://localhost:${PORT}`
    );

    startBaeminDirectCollector({
      port: PORT,
      ingestKey: INGEST_KEY
    }).catch(err => {
      console.error(
        "[BAEMIN DIRECT START FAILED]",
        err.message
      );
    });
  }
);
