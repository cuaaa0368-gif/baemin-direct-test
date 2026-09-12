const TOKEN_KEY = "rc_token";

let user = null;
let data = null;
let myReject = null;
let centerReject = null;
let myWeekly = null;
let myHistory = null;
let myToday = null;

let rankingMode = "champions";

const $ = id => document.getElementById(id);


/* =========================================================
   TOKEN
========================================================= */

function token() {
  return localStorage.getItem(TOKEN_KEY) || "";
}


/* =========================================================
   LOGIN / APP
========================================================= */

function showLogin() {
  $("login")?.classList.remove("hidden");
  $("app")?.classList.add("hidden");
}


function showApp() {
  $("login")?.classList.add("hidden");
  $("app")?.classList.remove("hidden");
}


/* =========================================================
   API
========================================================= */

async function api(url, options = {}) {

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token()}`,
    "Content-Type": "application/json"
  };


  const res = await fetch(url, {
    ...options,
    headers
  });


  let json = {};

  try {
    json = await res.json();
  } catch {}


  if (res.status === 401) {

    localStorage.removeItem(TOKEN_KEY);

    showLogin();

    throw new Error("login");
  }


  if (!res.ok) {

    throw new Error(
      json.message ||
      `HTTP ${res.status}`
    );

  }


  return json;
}


/* =========================================================
   LOGIN
========================================================= */

$("loginBtn")?.addEventListener(
  "click",
  login
);


$("password")?.addEventListener(
  "keydown",
  e => {

    if (e.key === "Enter") {
      login();
    }

  }
);


async function login() {

  const loginId =
    ($("loginId")?.value || "").trim();


  const password =
    $("password")?.value || "";


  if (!loginId) {

    $("loginMsg").textContent =
      "아이디를 입력해주세요.";

    return;
  }


  try {

    const res =
      await fetch(
        "/api/login",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              loginId,
              password
            })
        }
      );


    const json =
      await res.json();


    if (!json.ok) {

      $("loginMsg").textContent =
        json.message ||
        "로그인 실패";

      return;
    }


    localStorage.setItem(
      TOKEN_KEY,
      json.token
    );


    user =
      json.user;


    showApp();


    await load();


  } catch (e) {

    console.error(
      "[LOGIN]",
      e
    );


    $("loginMsg").textContent =
      "서버 연결 실패";

  }

}


/* =========================================================
   LOGOUT
========================================================= */

$("logout")?.addEventListener(
  "click",
  async () => {

    try {

      await api(
        "/api/logout",
        {
          method: "POST"
        }
      );

    } catch {}


    localStorage.removeItem(
      TOKEN_KEY
    );


    user = null;
    data = null;
    myReject = null;
    centerReject = null;
    myWeekly = null;


    showLogin();

  }
);


/* =========================================================
   LIVE
========================================================= */

function setLive(active) {

  const el =
    $("live");

  if (!el) return;


  const text =
    el.querySelector("b");


  el.classList.toggle(
    "off",
    !active
  );


  if (text) {

    text.textContent =
      active
        ? "LIVE"
        : "WAIT";

  }

}


/* =========================================================
   마지막 수신
========================================================= */

function renderReceivedTime(value) {

  const el =
    $("lastReceived");


  if (!el) return;


  if (!value) {

    el.textContent =
      "마지막 수신 -";

    return;
  }


  const d =
    new Date(value);


  if (
    Number.isNaN(
      d.getTime()
    )
  ) {

    el.textContent =
      "마지막 수신 -";

    return;
  }


  el.textContent =
    "마지막 수신 " +
    d.toLocaleTimeString(
      "ko-KR",
      {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }
    );

}


/* =========================================================
   거절 가능 / 완료 필요
========================================================= */

function rejectGuide(
  complete,
  rejectCancel
) {

  complete =
    Number(complete) || 0;


  rejectCancel =
    Number(rejectCancel) || 0;


  const total =
    complete +
    rejectCancel;


  if (!total) {

    return "데이터 없음";

  }


  const rate =
    rejectCancel /
    total;


  if (rate > 0.20) {

    const need =
      Math.ceil(
        (rejectCancel / 0.20) -
        total
      );


    return `${need}건 완료 필요`;

  }


  const allow =
    Math.floor(
      (
        0.20 * total -
        rejectCancel
      ) / 0.80
    );


  return `${Math.max(
    0,
    allow
  )}건 거절 가능`;

}


/* =========================================================
   나의 주간 거절률
========================================================= */

function renderMyReject() {

  const rateEl =
    $("myRejectRate");


  const guideEl =
    $("myRejectGuide");


  if (
    !rateEl ||
    !guideEl
  ) {
    return;
  }


  if (!myReject) {

    rateEl.textContent =
      "-%";

    guideEl.textContent =
      "데이터 대기중";

    return;
  }


  const rate =
    Number(
      myReject.rejectRate
    );


  if (
    !Number.isFinite(rate)
  ) {

    rateEl.textContent =
      "-%";

    guideEl.textContent =
      "데이터 대기중";

    return;
  }


  rateEl.textContent =
    rate.toFixed(1) +
    "%";


  guideEl.textContent =
    rejectGuide(
      myReject.complete,
      myReject.rejectCancel
    );

}


/* =========================================================
   지사 주간 거절률
========================================================= */

function renderCenterReject() {

  const rateEl =
    $("branchRejectRate");


  const guideEl =
    $("branchRejectGuide");


  if (
    !rateEl ||
    !guideEl
  ) {
    return;
  }


  if (!centerReject) {

    rateEl.textContent =
      "-%";

    guideEl.textContent =
      "데이터 대기중";

    return;
  }


  const rate =
    Number(
      centerReject.rejectRate
    );


  if (
    !Number.isFinite(rate)
  ) {

    rateEl.textContent =
      "-%";

    guideEl.textContent =
      "데이터 대기중";

    return;
  }


  rateEl.textContent =
    rate.toFixed(1) +
    "%";


  guideEl.textContent =
    rejectGuide(
      centerReject.complete,
      centerReject.rejectCancel
    );


  if ($("branchComplete")) {

    $("branchComplete")
      .textContent =
      Number(
        centerReject.complete
      ) || 0;

  }


  if ($("branchReject")) {

    $("branchReject")
      .textContent =
      Number(
        centerReject.reject
      ) || 0;

  }


  if ($("branchCancel")) {

    $("branchCancel")
      .textContent =
      Number(
        centerReject.cancel
      ) || 0;

  }

}


/* =========================================================
   현황
========================================================= */

function renderPeaks(d) {

  const box =
    $("peaks");


  if (!box) return;


  const peaks =
    d.peaks || {};


  const goals =
    d.goals || {};


  const items = [

    [
      "morning",
      "아침점심피크",
      "평일 09시-13시 / 주말·공휴일 09시-14시"
    ],

    [
      "afternoon",
      "오후논피크",
      "평일 13시-17시 / 주말·공휴일 14시-17시"
    ],

    [
      "evening",
      "저녁피크",
      "17시-20시"
    ],

    [
      "night",
      "야간논피크",
      "20시-24시"
    ]

  ];


  box.innerHTML =
    items
      .map(
        ([key, name, time]) => {

          const value =
            Number(
              peaks[key]
            ) || 0;


          const goal =
            Number(
              goals[key]
            ) || 0;


          const percent =
            goal > 0
              ? Math.min(
                  100,
                  value /
                  goal *
                  100
                )
              : 0;


          return `

            <div class="peak">

              <div class="peak-main">

                <div class="peak-label">

                  <b>
                    ${name}
                  </b>

                  <small>
                    ${time}
                  </small>

                </div>

                <strong>
                  ${value} / ${goal}
                </strong>

              </div>


              <div class="bar">

                <i
                  style="width:${percent}%"
                ></i>

              </div>

            </div>

          `;

        }
      )
      .join("");

}


/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHtml(value) {

  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );

}


/* =========================================================
   RANKING TAB 생성
========================================================= */

function ensureRankingTabs() {

  const page =
    $("rankingPage");


  if (!page) return;


  if (
    $("rankingTabs")
  ) {
    return;
  }


  const head =
    page.querySelector(
      ".page-head"
    );


  if (!head) return;


  const tabs =
    document.createElement(
      "div"
    );


  tabs.id =
    "rankingTabs";


  tabs.style.display =
    "grid";


  tabs.style.gridTemplateColumns =
    "repeat(4, 1fr)";


  tabs.style.gap =
    "6px";


  tabs.style.margin =
    "0 0 16px";


  tabs.innerHTML = `

<button
  type="button"
  data-ranking-mode="champions"
  style="
    border:0;
    border-radius:12px;
    padding:11px 4px;
    background:#f3f4f6;
    color:#6b7280;
    font-weight:800;
    font-size:12px;
    cursor:pointer;
  "
>
  기록보관소
</button>

    <button
      type="button"
      data-ranking-mode="weekly"
      style="
        border:0;
        border-radius:12px;
        padding:11px 4px;
        background:#20c997;
        color:#fff;
        font-weight:800;
        font-size:12px;
        cursor:pointer;
      "
    >
      주간 TOP5
    </button>


    <button
      type="button"
      data-ranking-mode="today"
      style="
        border:0;
        border-radius:12px;
        padding:11px 4px;
        background:#f3f4f6;
        color:#6b7280;
        font-weight:800;
        font-size:12px;
        cursor:pointer;
      "
    >
      오늘의 TOP7
    </button>


    <button
      type="button"
      data-ranking-mode="evening"
      style="
        border:0;
        border-radius:12px;
        padding:11px 4px;
        background:#f3f4f6;
        color:#6b7280;
        font-weight:800;
        font-size:12px;
        cursor:pointer;
      "
    >
      저녁피크 TOP10
    </button>

  `;


  head.after(
    tabs
  );


  tabs
    .querySelectorAll(
      "[data-ranking-mode]"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          async () => {

            rankingMode =
              button.dataset
                .rankingMode;


            try {

              let result;

               if (
  rankingMode ===
  "champions"
) {

  result =
    await api(
      "/api/champions"
    );

  data.champions =
    result.data || null;

}

              else if (
                rankingMode ===
                "weekly"
              ) {

                result =
                  await api(
                    "/api/weekly-ranking"
                  );


                data.weeklyRanking =
                  extractRanking(
                    result,
                    "weeklyRanking"
                  );

              }


              else if (
                rankingMode ===
                "today"
              ) {

                result =
                  await api(
                    "/api/today-ranking"
                  );


                data.todayRanking =
                  extractRanking(
                    result,
                    "todayRanking"
                  );

              }


              else if (
                rankingMode ===
                "evening"
              ) {

                result =
                  await api(
                    "/api/evening-ranking"
                  );

                 console.log(
  "[EVENING API]",
  new Date().toLocaleTimeString(),
  result
);
               

                data.eveningRanking =
                  extractRanking(
                    result,
                    "eveningRanking"
                  );

              }


              renderRanking(
                data || {}
              );


            } catch (e) {

              console.error(
                "[RANKING]",
                e
              );


              renderRanking(
                data || {}
              );

            }

          }
        );

      }
    );

}


/* =========================================================
   랭킹 응답 배열 추출
========================================================= */

function extractRanking(result, key) {

  if (Array.isArray(result?.data)) {
    return result.data;
  }

  if (Array.isArray(result?.[key])) {
    return result[key];
  }

  if (Array.isArray(result?.data?.[key])) {
    return result.data[key];
  }

  return [];
}


/* =========================================================
   랭킹 탭 상태
========================================================= */

function updateRankingTabs() {

  const tabs =
    $("rankingTabs");


  if (!tabs) return;


  tabs
    .querySelectorAll(
      "[data-ranking-mode]"
    )
    .forEach(
      button => {

        const active =
          button.dataset
            .rankingMode ===
          rankingMode;


        button.style.background =
          active
            ? "#20c997"
            : "#f3f4f6";


        button.style.color =
          active
            ? "#ffffff"
            : "#6b7280";

      }
    );

}


/* =========================================================
   랭킹 데이터 선택
========================================================= */

function getRankingList(d) {

  if (rankingMode === "today") {

    const list =
      Array.isArray(d.todayRanking)
        ? d.todayRanking
        : [];

    return list.slice(0, 7);
  }


  if (rankingMode === "evening") {

    const list =
      Array.isArray(d.eveningRanking)
        ? d.eveningRanking
        : [];

    if (list.length === 0) {
      return [];
    }

    return list.slice(0, 10);
  }


  const list =
    Array.isArray(d.weeklyRanking)
      ? d.weeklyRanking
      : [];


  if (!list.length) {

    const oldRanking =
      Array.isArray(d.ranking)
        ? d.ranking
        : [];

    return oldRanking.slice(0, 5);
  }


  return list.slice(0, 5);
}


/* =========================================================
   랭킹 제목
========================================================= */

function rankingTitle() {

  if (
    rankingMode ===
    "champions"
  ) {

    return {
      title: "기록보관소",
      small: "역대 최고 배달 기록",
      head: "",
      top: "ALL-TIME RECORDS"
    };

  }


  if (
    rankingMode ===
    "today"
  ) {


    return {
      title:
        "오늘의 TOP7",

      small:
        "오늘 배달 건수",

      head:
        "",

      top:
        "DAILY TOP 7"

    };

  }


  if (
    rankingMode ===
    "evening"
  ) {

    return {
      title:
        "저녁피크 TOP10",

      small:
        "저녁피크 배달 건수",

      head:
        "",

      top:
        "EVENING TOP 10"

    };

  }


  return {

    title:
      "주간 TOP5",

    small:
      "배달 건수 TOP 5",

    head:
      "",

    top:
      "WEEKLY TOP 5"

  };

}


/* =========================================================
   랭킹 헤더
========================================================= */

function renderRankingHeader() {

  const info =
    rankingTitle();


  const page =
    $("rankingPage");


  if (!page) return;


  const h2 =
    page.querySelector(
      ".page-head h2"
    );


  const small =
    page.querySelector(
      ".page-head small"
    );


  const headSpan =
    page.querySelector(
      ".ranking-head span"
    );


  const headStrong =
    page.querySelector(
      ".ranking-head strong"
    );


  if (h2) {

    h2.textContent =
      info.title;

  }


  if (small) {

    small.textContent =
      info.small;

  }


  if (headSpan) {

    headSpan.textContent =
      info.head;

  }


  if (headStrong) {

    headStrong.textContent =
      info.top;

  }

}


/* =========================================================
   랭킹 렌더링
========================================================= */

function renderRanking(d) {

  /*
   * 현재 index.html의 실제 ID:
   *
   * <div id="ranking" class="ranking">
   *
   * 따라서 weeklyRanking이 아니라 ranking 사용
   */

  const box =
    $("ranking");


  if (!box) return;


  ensureRankingTabs();

  updateRankingTabs();

  renderRankingHeader();

   if (rankingMode === "champions") {

  const champions =
    d.champions || {};

  const items = [
    {
      title: "역대 주간기록",
      data: champions.weekly
    },
    {
      title: "역대 일일기록",
      data: champions.daily
    },
    {
      title: "역대 저피기록",
      data: champions.evening
    }
  ];

  box.innerHTML =
    items
      .map(item => {

        const names =
          Array.isArray(item.data?.names)
            ? item.data.names
                .map(name => escapeHtml(name))
                .join(" · ")
            : "-";

        const value =
          Number(item.data?.val) || 0;

     return `
  <div class="champion-group">
    <div class="champion-title">${item.title}</div>

    <article>
      <span class="rank">👑</span>
      <div>
        <b>${names}</b>
      </div>
      <strong>${value}건</strong>
    </article>
  </div>`;

      })
      .join("");

  return;
}

  const list =
    getRankingList(d);


  if (!list.length) {

    box.innerHTML = `

      <div class="empty">
        저녁피크는 17시 - 20시 입니다. 
      </div>

    `;

    return;
  }


  box.innerHTML =
    list
      .map(
        (r, i) => {

          const name =
            escapeHtml(
              r.name ||
              r.userName ||
              "-"
            );


          const value =
            Number(
              r.val ??
              r.count ??
              r.total ??
              r.complete ??
              0
            ) || 0;


          return `

            <article>

              <span class="rank">${i === 0 ? "👑" : i + 1}</span>


              <div>

                <b>
                  ${name}
                </b>

               

              </div>


              <strong>
                ${value}건
              </strong>

            </article>

          `;

        }
      )
      .join("");

}


/* =========================================================
   상세정보 공통 데이터
========================================================= */

const DETAIL_DAY_MS = 86400000;
let detailWeekStart = null;
let detailDailyDate = null;
let periodStartDate = null;
let periodEndDate = null;
let periodVisibleRows = 5;
let detailMode = "weekly";
let detailHistoryInitialized = false;
const detailLoadState = { history: "idle", weekly: "idle", today: "idle" };
const detailLoadError = { history: "", weekly: "", today: "" };

function normalizeHistoryRows(source) {
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const dateKeys = ["date", "statDate", "stat_date", "deliveryDate", "workDate", "targetDate"];
  const byDate = new Map();

  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    let rawDate = "";
    for (const key of dateKeys) {
      if (raw[key] != null) { rawDate = String(raw[key]); break; }
    }
    const match = rawDate.match(/(20\d{2})[-./]?(\d{2})[-./]?(\d{2})/);
    if (!match) continue;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    byDate.set(date, { ...raw, date });
  }
  return [...byDate.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}

function detailRows() {
  const rows = normalizeHistoryRows(myHistory);
  const byDate = new Map(rows.map(row => [String(row.date), row]));
  if (myToday) {
    const key = dateKey(getBusinessDate());
    const existing = byDate.get(key) || {};
    byDate.set(key, { ...existing, ...myToday, date: key, deliveryPeakTimeCount: existing.deliveryPeakTimeCount, hourlyCompleted: existing.hourlyCompleted });
  }
  return [...byDate.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}

function getBusinessDate() {
  const d = new Date();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  d.setHours(0,0,0,0);
  return d;
}

function parseLocalDate(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWedWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (d.getDay() - 3 + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function formatKoreanDate(date, withYear = true) {
  if (!date) return "-";
  const shortYear = String(date.getFullYear()).slice(-2);
  return `${withYear ? `${shortYear}년 ` : ""}${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function rowNumber(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && row[key] !== "") {
      const n = Number(row[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function rowParts(row) {
  const acceptance = row?.deliveryAcceptanceCount || {};
  const source = { ...acceptance, ...(row || {}) };
  const food = rowNumber(source, ["food", "foodComplete", "food_complete", "foodCount"]);
  const bmart = rowNumber(source, ["bmart", "bMart", "bmartComplete", "bmart_complete", "bmartCount"]);
  const store = rowNumber(source, ["store", "storeComplete", "store_complete", "storeCount"]);
  const out = rowNumber(source, ["out", "outComplete", "slaOutComplete", "sla_out_complete", "outside", "outCount"]);
  const explicitTotal = rowNumber(source, ["total", "totalComplete", "total_complete", "complete", "completeCount", "deliveryCount", "count", "allDayComplete"]);
  // 상세정보의 총합은 항상 시간외까지 포함한다. 유형 데이터가 있으면 유형 합계를 기준으로 사용한다.
  const typedTotal = food + bmart + store + out;
  const hasTypedData = ["food","foodComplete","food_complete","foodCount","bmart","bMart","bmartComplete","bmart_complete","bmartCount","store","storeComplete","store_complete","storeCount","out","outComplete","slaOutComplete","sla_out_complete","outside","outCount"].some(k => source[k] !== undefined && source[k] !== null && source[k] !== "");
  return { total: hasTypedData ? typedTotal : explicitTotal, food, bmart, store, out };
}

function rowsBetween(start, end) {
  const a = dateKey(start);
  const b = dateKey(end);
  return detailRows().filter(row => String(row.date) >= a && String(row.date) <= b);
}

function sumRows(rows) {
  return rows.reduce((sum, row) => {
    const p = rowParts(row);
    sum.total += p.total;
    sum.food += p.food;
    sum.bmart += p.bmart;
    sum.store += p.store;
    sum.out += p.out;
    return sum;
  }, { total: 0, food: 0, bmart: 0, store: 0, out: 0 });
}

function historyBounds() {
  const rows = detailRows();
  if (!rows.length) return null;
  return {
    min: parseLocalDate(rows[0].date),
    max: parseLocalDate(rows[rows.length - 1].date)
  };
}

function setDetailRiderNames() {
  document.querySelectorAll("#detailPage .detail-rider-name").forEach(el => {
    el.textContent = user?.name ? `${user.name} 기사님` : "기사님";
  });
}

function rateText(value, total) {
  return total > 0 ? `(${(value / total * 100).toFixed(1)}%)` : "(0.0%)";
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function initializeDetailDates() {
  const bounds = historyBounds();
  const anchor = bounds?.max ? new Date(bounds.max) : getBusinessDate();
  if (!detailWeekStart) detailWeekStart = startOfWedWeek(anchor);
  if (!detailDailyDate) detailDailyDate = new Date(anchor);
  if (!periodEndDate) periodEndDate = new Date(anchor);
  if (!periodStartDate) periodStartDate = addDays(periodEndDate, -89);
  if (bounds && periodStartDate < bounds.min) periodStartDate = new Date(bounds.min);
  if (!detailHistoryInitialized) {
    calendarDate = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    detailHistoryInitialized = true;
  }
}

function setDetailState(id, kind, message) {
  const el = $(id);
  if (!el) return;
  if (!message) { el.className = "detail-data-state hidden"; el.textContent = ""; return; }
  el.className = `detail-data-state ${kind || ""}`.trim();
  el.textContent = message;
}

function currentWeekFallbackMap(weekStart) {
  const map = new Map();
  const currentStart = startOfWedWeek(getBusinessDate());
  if (dateKey(currentStart) !== dateKey(weekStart) || !myWeekly) return map;
  const days = myWeekly.days || {};
  const names = ["수요일","목요일","금요일","토요일","일요일","월요일","화요일"];
  for (let i=0;i<7;i++) {
    const value = days[names[i]] ?? days[names[i].slice(0,1)] ?? days[i];
    if (value !== undefined && value !== null && value !== "") {
      map.set(dateKey(addDays(weekStart,i)), { date:dateKey(addDays(weekStart,i)), total:Number(value)||0, __weeklyFallback:true });
    }
  }
  return map;
}

function historyStatusMessage(view) {
  if (detailLoadState.history === "loading") return ["loading", "90일 배달 이력을 불러오는 중입니다."];
  if (detailLoadState.history === "error") return ["error", detailLoadError.history || "90일 배달 이력을 불러오지 못했습니다."];
  if (detailLoadState.history === "success" && !detailRows().length) return ["empty", "저장된 90일 배달 이력이 없습니다."];
  return ["", ""];
}

/* =========================================================
   주간 상세정보
========================================================= */

function renderMyWeekly() {
  setDetailRiderNames();
  initializeDetailDates();
  const chart = $("weeklyBarChart");
  if (!detailWeekStart || !chart) return;

  const weekEnd = addDays(detailWeekStart, 6);
  const history = rowsBetween(detailWeekStart, weekEnd);
  const rowMap = new Map(history.map(row => [String(row.date), row]));
  for (const [key,row] of currentWeekFallbackMap(detailWeekStart)) if (!rowMap.has(key)) rowMap.set(key,row);
  const rows = [...rowMap.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const totals = sumRows(rows);
  const bounds = historyBounds();

  setText("weekRange", `${formatKoreanDate(detailWeekStart)} ~ ${formatKoreanDate(weekEnd, false)}`);
  setText("weeklyTotal", rows.length ? `${totals.total.toLocaleString()}건` : "-");

  const valid = rows.map(row => ({row,value:rowParts(row).total}));
  setText("weeklyAverage", valid.length ? `${(totals.total/valid.length).toFixed(1)}건` : "-");
  if (valid.length) {
    const max=valid.reduce((a,b)=>b.value>a.value?b:a), min=valid.reduce((a,b)=>b.value<a.value?b:a);
    setText("weeklyMax",`${max.value}건`);
    setText("weeklyMin",`${min.value}건`);
  } else {
    setText("weeklyMax","-"); setText("weeklyMin","-");
  }

  const prevStart=addDays(detailWeekStart,-7), prevEnd=addDays(detailWeekStart,-1);
  const prevRows=rowsBetween(prevStart,prevEnd), prevTotal=sumRows(prevRows).total;
  setText("previousWeekTotal",prevRows.length?`${prevTotal.toLocaleString()}건`:"-");
  const compareEl = $("weeklyCompare");
  if (compareEl) {
    if (rows.length && prevRows.length && prevTotal > 0) {
      const diff = totals.total - prevTotal;
      compareEl.textContent = `${diff>0?"▲":diff<0?"▼":"•"} ${Math.abs(diff/prevTotal*100).toFixed(1)}% (지난주 대비)`;
      compareEl.classList.toggle("up", diff > 0);
      compareEl.classList.toggle("down", diff < 0);
      compareEl.classList.toggle("same", diff === 0);
    } else {
      compareEl.textContent = "비교 데이터 없음";
      compareEl.classList.remove("up","down","same");
    }
  }

  const hasTypes = rows.some(r => !r.__weeklyFallback && (rowParts(r).food || rowParts(r).bmart || rowParts(r).store || rowParts(r).out || r.deliveryAcceptanceCount));
  for (const [id,val] of [["weeklyFood",totals.food],["weeklyBmart",totals.bmart],["weeklyStore",totals.store],["weeklyOut",totals.out]]) setText(id,hasTypes?`${val.toLocaleString()}건`:"-");
  for (const [id,val] of [["weeklyFoodRate",totals.food],["weeklyBmartRate",totals.bmart],["weeklyStoreRate",totals.store],["weeklyOutRate",totals.out]]) setText(id,hasTypes?rateText(val,totals.total):"-");

  const days=Array.from({length:7},(_,i)=>addDays(detailWeekStart,i));
  const values=days.map(d=>rowMap.has(dateKey(d))?rowParts(rowMap.get(dateKey(d))).total:null);
  const numeric=values.filter(v=>v!==null), maxValue=Math.max(1,...numeric), maxVal=numeric.length?Math.max(...numeric):null;
  chart.innerHTML=days.map((d,i)=>{const v=values[i],exists=v!==null,h=exists?Math.max(4,v/maxValue*120):3;return `<div class="detail-bar-item ${exists&&v===maxVal?"max":""}"><span class="bar-value">${exists?v:"-"}</span><i class="bar-column" style="height:${h}px"></i><small class="bar-date">${d.getMonth()+1}/${d.getDate()}</small></div>`}).join("");

  if (!rows.length) {
    if (detailLoadState.weekly==="loading" || detailLoadState.history==="loading") setDetailState("weeklyDataState","loading","주간 배달 실적을 불러오는 중입니다.");
    else if (detailLoadState.weekly==="error" && detailLoadState.history==="error") setDetailState("weeklyDataState","error","주간 실적과 90일 이력을 모두 불러오지 못했습니다.");
    else setDetailState("weeklyDataState","empty","선택한 주의 배달 기록이 없습니다.");
  } else setDetailState("weeklyDataState","","");

  const minAllowed=bounds?.min?startOfWedWeek(bounds.min):addDays(startOfWedWeek(getBusinessDate()),-84);
  const maxAllowed=startOfWedWeek(getBusinessDate());
  $("weeklyPrev").disabled=addDays(detailWeekStart,-7)<minAllowed;
  $("weeklyNext").disabled=addDays(detailWeekStart,7)>maxAllowed;
}

/* =========================================================
   운행중 기사 팝업
========================================================= */

function openRunningModal() {

  const modal =
    $("runningModal");

  const list =
    $("runningRiderList");

  if (!modal || !list) return;


  const riders =
    Array.isArray(data?.riders)
      ? data.riders.filter(
          rider =>
            rider.status === "DELIVERING"
        )
      : [];


  if (!riders.length) {

    list.innerHTML =
      `<span>없음</span>`;

  } else {

    list.innerHTML =
      riders
        .map(
          rider =>
            `<span>${escapeHtml(
              rider.name || "-"
            )}</span>`
        )
        .join("");

  }


  modal.classList.remove("hidden");

}


function closeRunningModal() {

  $("runningModal")
    ?.classList.add("hidden");

}

function openMyCompleteModal() {

  const modal =
    $("myCompleteModal");

  const detail =
    $("myCompleteDetail");

  const empty =
    $("myCompleteEmpty");

  if (!modal || !detail || !empty) return;


  if (!myToday) {

    detail.classList.add("hidden");

    empty.classList.remove("hidden");

    modal.classList.remove("hidden");

    return;
  }


  detail.classList.remove("hidden");

  empty.classList.add("hidden");


  if ($("myCompleteFood")) {
    $("myCompleteFood").textContent =
      `${Number(myToday.food) || 0}건`;
  }

  if ($("myCompleteBmart")) {
    $("myCompleteBmart").textContent =
      `${Number(myToday.bmart) || 0}건`;
  }

  if ($("myCompleteStore")) {
    $("myCompleteStore").textContent =
      `${Number(myToday.store) || 0}건`;
  }

   if ($("myCompleteOut")) {
  $("myCompleteOut").textContent =
    `${Number(myToday.out) || 0}건`;
}

  if ($("myCompleteTotal")) {
    $("myCompleteTotal").textContent =
      `${Number(myToday.total) || 0}건`;
  }


  modal.classList.remove("hidden");

}
function closeMyCompleteModal() {

  $("myCompleteModal")
    ?.classList.add("hidden");

}

async function openMyRejectModal() {

  const modal =
    $("myRejectModal");

  const detail =
    $("myRejectDetail");

  if (!modal || !detail) return;

  try {


      const result = await api("/api/my-reject-detail");

    const rejectData =
      result.data || {};

    const days =
      Array.isArray(rejectData.days)
        ? rejectData.days
        : [];

    detail.innerHTML = `
      ${days.map(day => `
        <div>
          <strong>${escapeHtml(day.weekday || "-")}</strong>
          <span>
            완료 ${Number(day.complete) || 0}건 ·
            거절취소 ${Number(day.rejectCancel) || 0}건
          </span>
        </div>
      `).join("")}

   
      <div class="my-complete-total">
        <strong>합계</strong>
        <span>
          총완료 ${Number(rejectData.complete) || 0}건 ·
          총거절취소 ${Number(rejectData.rejectCancel) || 0}건
        </span>
      </div>
    `;

    modal.classList.remove("hidden");

  } catch (e) {

    console.error(
      "[MY REJECT DETAIL]",
      e
    );

  }

}

async function openAdminRejectModal() {

  if (
    user?.role !== "master" &&
    user?.role !== "superadmin"
  ) {
    return;
  }

  const modal =
    $("adminRejectModal");

  const list =
    $("adminRejectRiderList");

  if (!modal || !list) return;

  try {

    const result =
      await api(
        "/api/admin/reject-riders"
      );

    const riders =
      Array.isArray(result.data)
        ? result.data
        : [];

    if (!riders.length) {

      list.innerHTML =
        `<span>해당 기사님이 없습니다.</span>`;

    } else {

      list.innerHTML =
        riders
          .map(rider => `
            <div class="admin-reject-rider ${Number(rider.total) > 130 ? "high-total" : ""}">
              <strong>
                ${escapeHtml(rider.name || "-")}
              </strong>

              <span>
                ${Number(rider.total) || 0}건 ·
                ${Number(rider.rejectRate || 0).toFixed(1)}%
              </span>
            </div>
          `)
          .join("");

    }

    modal.classList.remove("hidden");

  } catch (e) {

    console.error(
      "[ADMIN REJECT RIDERS]",
      e
    );

  }

}

function openChangePasswordModal() {
  $("currentPassword").value = "";
  $("newPassword").value = "";
  $("newPasswordConfirm").value = "";
  $("changePasswordMsg").textContent = "";

  $("changePasswordModal")
    ?.classList.remove("hidden");
}

function closeChangePasswordModal() {
  $("changePasswordModal")
    ?.classList.add("hidden");
}

$("changePasswordMenu")
  ?.addEventListener(
    "click",
    openChangePasswordModal
  );

$("changePasswordClose")
  ?.addEventListener(
    "click",
    closeChangePasswordModal
  );

$("changePasswordBtn")
  ?.addEventListener(
    "click",
    async () => {

      const currentPassword =
        $("currentPassword")?.value || "";

      const newPassword =
        $("newPassword")?.value || "";

      const newPasswordConfirm =
        $("newPasswordConfirm")?.value || "";

      const msg =
        $("changePasswordMsg");

      if (newPassword !== newPasswordConfirm) {
        if (msg) {
          msg.textContent =
            "새 비밀번호가 서로 일치하지 않습니다.";
        }
        return;
      }

      try {

        const result =
          await api(
            "/api/change-password",
            {
              method: "POST",
              body: JSON.stringify({
                currentPassword,
                newPassword
              })
            }
          );

        if (msg) {
          msg.textContent =
            result.message ||
            "비밀번호가 변경되었습니다.";
        }

      } catch (e) {

        if (msg) {
          msg.textContent =
            e.message ||
            "비밀번호 변경에 실패했습니다.";
        }

      }

    }
  );

/* 운행중 카드 클릭 */

document
  .querySelector(".hero")
  ?.addEventListener(
    "click",
    openRunningModal
  );


/* X 버튼 */

$("runningModalClose")
  ?.addEventListener(
    "click",
    closeRunningModal
  );

/* 지사 거절률 카드 클릭 - 관리자 전용 */

document
  .querySelector(".branch-reject-card")
  ?.addEventListener(
    "click",
    () => {

      if (
        user?.role !== "master" &&
        user?.role !== "superadmin"
      ) {
        return;
      }

      openAdminRejectModal();

    }
  );

/* 관리자 거절률 팝업 X 버튼 */

$("adminRejectModalClose")
  ?.addEventListener(
    "click",
    () => {
      $("adminRejectModal")
        ?.classList.add("hidden");
    }
  );

/* 나의 거절률 카드 클릭 */

document
  .querySelector(".my-reject-card")
  ?.addEventListener(
    "click",
    () => {
      openMyRejectModal();
    }
  );


/* 나의 주간 거절 팝업 X 버튼 */

$("myRejectModalClose")
  ?.addEventListener(
    "click",
    () => {
      $("myRejectModal")
        ?.classList.add("hidden");
    }
  );

/* 나의 완료 카드 클릭 */

document
  .querySelector(".my-complete-card")
  ?.addEventListener(
    "click",
    openMyCompleteModal
  );


/* 나의 완료 X 버튼 */

$("myCompleteModalClose")
  ?.addEventListener(
    "click",
    closeMyCompleteModal
  );

/* =========================================================
   MAIN
========================================================= */

function renderMain(d) {

  data = d;


  if ($("runCount")) {

    $("runCount")
      .textContent =
      Number(
        d.summary?.runCount
      ) || 0;

  }


  renderReceivedTime(
    d.receivedAt
  );


  renderPeaks(d);


  renderRanking(d);


  renderMyReject();


  renderCenterReject();


  renderMyWeekly();


  if ($("who")) {

    $("who")
  .textContent =
  user?.name
    ? `${user.name} 기사님`
    : "";

  }


  if ($("myName")) {

    $("myName")
      .textContent =
      user?.name || "-";

  }


  if ($("myCenter")) {

    $("myCenter")
      .textContent =
      d.centerName || "-";

  }


  setLive(true);

}


/* =========================================================
   LOAD
========================================================= */

async function load() {

  if (!token()) {

    showLogin();

    return;

  }


  try {

    /* =====================================================
       사용자 정보
    ===================================================== */

    const me =
      await api(
        "/api/me"
      );


    user =
      me.user;


    /* =====================================================
       기본 관제 데이터
    ===================================================== */

    const center =
      await api(
        "/api/center/" +
        encodeURIComponent(
          user.centerKey
        )
      );


    data =
      center.data;


    /*
     * 기본 응답 안에 랭킹이 들어있으면
     * 먼저 사용.
     */

    data.weeklyRanking =
      Array.isArray(
        data.weeklyRanking
      )
        ? data.weeklyRanking
        : [];


    data.todayRanking =
      Array.isArray(
        data.todayRanking
      )
        ? data.todayRanking
        : [];


   // 저녁피크 순위는 별도 API에서만 가져온다.
// 기본 관제 데이터의 eveningRanking은 사용하지 않는다.
data.eveningRanking = [];


    /* =====================================================
       랭킹 3종 별도 조회
    ===================================================== */

    try {

      const [
        weeklyResult,
        todayResult,
        eveningResult
      ] =
        await Promise.all([

          api(
            "/api/weekly-ranking"
          ),

          api(
            "/api/today-ranking"
          ),

          api(
            "/api/evening-ranking"
          )

        ]);


      data.weeklyRanking =
        extractRanking(
          weeklyResult,
          "weeklyRanking"
        );


      data.todayRanking =
        extractRanking(
          todayResult,
          "todayRanking"
        );


      data.eveningRanking =
        extractRanking(
          eveningResult,
          "eveningRanking"
        );


    } catch (e) {

      console.warn(
        "랭킹 데이터 조회:",
        e
      );

    }

         /* =====================================================
       서초대장 조회
    ===================================================== */

    try {

      const result =
        await api(
          "/api/champions"
        );

      data.champions =
        result.data || null;

    } catch (e) {

      console.warn(
        "서초대장 조회:",
        e
      );

      data.champions =
        null;

    }

    /* =====================================================
       화면 렌더링
    ===================================================== */

    renderMain(
      data
    );


    /* =====================================================
       개인 주간 거절률
    ===================================================== */

    try {

      const result =
        await api(
          "/api/my-reject"
        );


      myReject =
        result.data;


      renderMyReject();


    } catch (e) {

      console.warn(
        "개인 주간 거절률:",
        e
      );


      myReject =
        null;


      renderMyReject();

    }


    /* =====================================================
       지사 주간 거절률
    ===================================================== */

    try {

      const result =
        await api(
          "/api/center-reject"
        );


      centerReject =
        result.data;


      renderCenterReject();


    } catch (e) {

      console.warn(
        "지사 주간 거절률:",
        e
      );


      centerReject =
        null;


      renderCenterReject();

    }


    /* =====================================================
       나의 주간 배달 실적
    ===================================================== */

    try {

      detailLoadState.weekly = "loading"; detailLoadError.weekly = "";
      const result =
        await api(
          "/api/my-weekly"
        );


      myWeekly = result?.data ?? result ?? null;
      detailLoadState.weekly = "success";

      renderMyWeekly();


    } catch (e) {

      console.warn(
        "나의 주간 배달 실적:",
        e
      );


      myWeekly = null;
      detailLoadState.weekly = "error"; detailLoadError.weekly = e?.message || "주간 실적 조회 실패";

      renderMyWeekly();

    }

    /* =====================================================
       나의 90일 배달 실적
    ===================================================== */

    try {

      detailLoadState.history = "loading"; detailLoadError.history = "";
      const result =
        await api(
          "/api/my-history"
        );

      myHistory = result?.data ?? result ?? null;
      detailLoadState.history = "success";

      const historyRows = detailRows();

      if (historyRows.length) {

        const latestDate =
          historyRows
            .map(row => String(row.date || ""))
            .filter(Boolean)
            .sort()
            .at(-1);

        if (latestDate && !detailHistoryInitialized) {

          const year = Number(latestDate.slice(0, 4));
          const month = Number(latestDate.slice(5, 7)) - 1;

          calendarDate = new Date(year, month, 1);
          detailHistoryInitialized = true;

        }

        if (!$((detailMode || "weekly") + "DetailView")?.classList.contains("hidden")) {
          if (detailMode === "weekly") renderMyWeekly();
          if (detailMode === "monthly") renderMonthlyCalendar();
          if (detailMode === "daily") renderDailyDetail();
          if (detailMode === "period") renderPeriodDetail();
        }

      }

      if (detailMode === "weekly") renderMyWeekly();
      if (detailMode === "monthly") renderMonthlyCalendar();
      if (detailMode === "daily") renderDailyDetail();
      if (detailMode === "period") renderPeriodDetail();

    } catch (e) {

      console.warn(
        "나의 90일 배달 실적:",
        e
      );

      myHistory = null;
      detailLoadState.history = "error"; detailLoadError.history = e?.message || "90일 이력 조회 실패";
      if (detailMode === "weekly") renderMyWeekly();
      if (detailMode === "monthly") renderMonthlyCalendar();
      if (detailMode === "daily") renderDailyDetail();
      if (detailMode === "period") renderPeriodDetail();

    }
     
/* =====================================================
   나의 오늘 완료
===================================================== */

try {

  detailLoadState.today = "loading"; detailLoadError.today = "";
  const result =
    await api(
      "/api/my-today"
    );

  myToday = result.data || null;
  detailLoadState.today = "success";

if ($("myComplete")) {
  $("myComplete").textContent =
    Number(myToday?.total) || 0;
}

if (detailMode === "weekly") renderMyWeekly();
if (detailMode === "monthly") renderMonthlyCalendar();
if (detailMode === "daily") renderDailyDetail();
if (detailMode === "period") renderPeriodDetail();

} catch (e) {

  console.warn(
    "나의 오늘 완료:",
    e
  );

    myToday = null;
    detailLoadState.today = "error"; detailLoadError.today = e?.message || "오늘 실적 조회 실패";

  if ($("myComplete")) {
    $("myComplete").textContent = 0;
  }

}
     
  } catch (e) {

    console.error(
      "[LOAD]",
      e
    );


    if (
      e.message ===
      "login"
    ) {

      return;

    }


    setLive(false);

  }

}

/* =========================================================
   MONTHLY CALENDAR
========================================================= */

let calendarDate = new Date();

function heatClass(count) {
  if (!count) return "heat-0";
  if (count <= 30) return "heat-1";
  if (count <= 60) return "heat-2";
  if (count <= 90) return "heat-3";
  return "heat-4";
}

function renderRecentMonths() {
  const box=$("recentMonths"); if(!box)return;
  const anchor=getBusinessDate();
  const months=[]; for(let i=2;i>=0;i--) months.push(new Date(anchor.getFullYear(),anchor.getMonth()-i,1));
  box.innerHTML=`<button type="button" class="recent-label" disabled>최근 3개월</button>`+months.map(d=>`<button type="button" data-month="${dateKey(d).slice(0,7)}" class="${d.getFullYear()===calendarDate.getFullYear()&&d.getMonth()===calendarDate.getMonth()?"active":""}">${d.getFullYear()}. ${d.getMonth()+1}월</button>`).join("");
  box.querySelectorAll("[data-month]").forEach(btn=>btn.addEventListener("click",()=>{const [y,m]=btn.dataset.month.split("-").map(Number);calendarDate=new Date(y,m-1,1);renderMonthlyCalendar();}));
}

function renderMonthlyCalendar() {
  setDetailRiderNames(); initializeDetailDates();
  const calendar=$("monthlyCalendar"),title=$("calendarTitle"); if(!calendar||!title)return;
  const year=calendarDate.getFullYear(),month=calendarDate.getMonth(); title.textContent=`${String(year).slice(-2)}년 ${month+1}월`;
  const rows=detailRows(),rowMap=new Map(rows.map(r=>[String(r.date),r]));
  const first=new Date(year,month,1),last=new Date(year,month+1,0),gridStart=addDays(first,-first.getDay()),gridEnd=addDays(last,6-last.getDay());
  let html="";
  for(let d=new Date(gridStart);d<=gridEnd;d=addDays(d,1)){
    const key=dateKey(d),row=rowMap.get(key),count=row?rowParts(row).total:0,other=d.getMonth()!==month;
    html+=`<button type="button" class="calendar-day ${row?heatClass(count):"heat-0"} ${other?"other-month":""} ${d.getDay()===0?"sunday":""} ${d.getDay()===6?"saturday":""}" data-date="${key}" ${row?"":"disabled"}><span class="day-number">${d.getDate()}</span><span class="day-count">${row&&count>0?`${count}건`:""}</span></button>`;
  }
  calendar.innerHTML=html;
  calendar.querySelectorAll(".calendar-day[data-date]:not(:disabled)").forEach(btn=>btn.addEventListener("click",()=>openCalendarDayModal(btn.dataset.date)));
  const prefix=`${year}-${String(month+1).padStart(2,"0")}`,monthRows=rows.filter(r=>String(r.date).startsWith(prefix)),sums=sumRows(monthRows);
  setText("monthTotal",monthRows.length?`${sums.total.toLocaleString()}건`:"-"); setText("monthAverage",monthRows.length?`${(sums.total/monthRows.length).toFixed(1)}건`:"-");
  if(monthRows.length){const maxRow=monthRows.reduce((a,b)=>rowParts(b).total>rowParts(a).total?b:a);setText("monthMax",`${rowParts(maxRow).total}건`);}else{setText("monthMax","-");}
  const [kind,msg]=historyStatusMessage("monthly"); setDetailState("monthlyDataState",kind,msg);
  const minMonth=new Date(getBusinessDate().getFullYear(),getBusinessDate().getMonth()-2,1),maxMonth=new Date(getBusinessDate().getFullYear(),getBusinessDate().getMonth(),1);
  $("calendarPrev").disabled=new Date(year,month-1,1)<minMonth; $("calendarNext").disabled=new Date(year,month+1,1)>maxMonth;
  renderRecentMonths();
}

function openCalendarDayModal(key) {
  const row = detailRows().find(r => String(r.date) === key);
  if (!row) return;
  const p = rowParts(row);
  setText("calendarDayModalDate", formatKoreanDate(parseLocalDate(key)));
  setText("calendarDayModalName", user?.name ? `${user.name} 기사님` : "기사님");
  setText("calendarDayModalTotal", `${p.total.toLocaleString()}건`);
  setText("calendarDayModalFood", `${p.food.toLocaleString()}건`);
  setText("calendarDayModalBmart", `${p.bmart.toLocaleString()}건`);
  setText("calendarDayModalStore", `${p.store.toLocaleString()}건`);
  setText("calendarDayModalOut", `${p.out.toLocaleString()}건`);
  $("calendarDayModal")?.classList.remove("hidden");
}

$("calendarDayModalClose")?.addEventListener("click", () => $("calendarDayModal")?.classList.add("hidden"));
$("calendarDayModal")?.addEventListener("click", e => {
  if (e.target === $("calendarDayModal")) $("calendarDayModal")?.classList.add("hidden");
});

/* =========================================================
   DAILY DETAIL
========================================================= */

const detailHourlyCache = new Map();
const detailPeakCache = new Map();

function normalizeHourLabel(value) {
  const match = String(value ?? "").match(/(\d{1,2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function extractHourly(row) {
  const raw = row?.hourlyCompleted;
  if (!Array.isArray(raw) || !raw.length) return [];
  const byHour = new Map();
  raw.forEach((item,index)=>{
    let hour, value;
    if (typeof item === "number") { hour=index; value=Number(item)||0; }
    else if (item && typeof item === "object") {
      hour=normalizeHourLabel(item.hour ?? item.time ?? item.label ?? item.hourOfDay ?? item.startHour ?? index);
      value=Number(item.count ?? item.complete ?? item.completed ?? item.value ?? item.total ?? 0)||0;
    }
    if (hour !== null && hour !== undefined) byHour.set(hour,value);
  });
  const order=[...Array.from({length:18},(_,i)=>i+6),0,1,2,3,4,5];
  return order.map(hour=>({label:String(hour).padStart(2,"0"),value:byHour.get(hour)||0}));
}

function renderHourly(row, key="") {
  const box=$("dailyHourlyChart"),note=$("dailyHourlyNote"); if(!box)return;
  let items=extractHourly(row);
  if(items.length && key) detailHourlyCache.set(key,items);
  if(!items.length && key && detailHourlyCache.has(key)) items=detailHourlyCache.get(key);
  if(!items.length){box.innerHTML=`<div class="daily-hourly-empty">이 날짜에는 시간대별 원본 데이터가 제공되지 않았습니다.<br>가짜 막대는 표시하지 않습니다.</div>`; if(note)note.classList.add("hidden"); return;}
  const max=Math.max(1,...items.map(x=>x.value));
  box.innerHTML=`<div class="daily-hourly-track">${items.map(x=>`<div class="hourly-item"><strong>${x.value>0?x.value:""}</strong><i class="${x.value>0?"":"zero"}" style="height:${x.value>0?Math.max(4,x.value/max*92):2}px"></i><span>${x.label}</span></div>`).join("")}</div>`;
  if(note)note.classList.add("hidden");
}

function renderPeaks(row, key="") {
  let peak=row?.deliveryPeakTimeCount || null;
  const keys=[["dailyPeakMorning","morning"],["dailyPeakAfternoon","afternoon"],["dailyPeakEvening","evening"],["dailyPeakMidnight","midnight"]];
  let has=!!peak && keys.some(([,k])=>peak[k]!==undefined&&peak[k]!==null);
  if(has && key) detailPeakCache.set(key,{...peak});
  if(!has && key && detailPeakCache.has(key)){ peak=detailPeakCache.get(key); has=true; }
  keys.forEach(([id,k])=>setText(id,has?`${Number(peak[k])||0}건`:"-"));
  const note=$("dailyPeakNote"); if(note){note.textContent=has?"":"이 날짜에는 피크타임 원본 데이터가 제공되지 않았습니다.";note.classList.toggle("hidden",has);}
}

function renderDailyDetail() {
  setDetailRiderNames(); initializeDetailDates(); if(!detailDailyDate)return;
  const key=dateKey(detailDailyDate),bizKey=dateKey(getBusinessDate());
  let row=detailRows().find(r=>String(r.date)===key);
  if(key===bizKey&&myToday){ row={...(row||{}),...myToday,date:key,deliveryPeakTimeCount:row?.deliveryPeakTimeCount,hourlyCompleted:row?.hourlyCompleted}; }
  const p=rowParts(row);
  setText("dailyDateTitle",formatKoreanDate(detailDailyDate)); setText("dailyTotal",row?`${p.total.toLocaleString()}건`:"-");
  setText("dailyFood",row?`${p.food.toLocaleString()}건`:"-"); setText("dailyBmart",row?`${p.bmart.toLocaleString()}건`:"-"); setText("dailyStore",row?`${p.store.toLocaleString()}건`:"-"); setText("dailyOut",row?`${p.out.toLocaleString()}건`:"-");
  setText("dailyFoodRate",row?rateText(p.food,p.total):"-"); setText("dailyBmartRate",row?rateText(p.bmart,p.total):"-"); setText("dailyStoreRate",row?rateText(p.store,p.total):"-"); setText("dailyOutRate",row?rateText(p.out,p.total):"-");
  renderHourly(row,key); renderPeaks(row,key);
  if(!row){if(detailLoadState.history==="loading"||detailLoadState.today==="loading")setDetailState("dailyDataState","loading","일별 배달 기록을 불러오는 중입니다.");else if(detailLoadState.history==="error"&&key!==bizKey)setDetailState("dailyDataState","error",detailLoadError.history||"90일 이력을 불러오지 못했습니다.");else setDetailState("dailyDataState","empty","선택한 날짜의 배달 기록이 없습니다.");}else setDetailState("dailyDataState","","");
  const min=historyBounds()?.min || addDays(getBusinessDate(),-89),max=getBusinessDate(); $("dailyPrev").disabled=addDays(detailDailyDate,-1)<min; $("dailyNext").disabled=addDays(detailDailyDate,1)>max;
}

/* =========================================================
   PERIOD DETAIL
========================================================= */

function setPeriodRange(days) {
  const bounds = historyBounds();
  periodEndDate = bounds?.max ? new Date(bounds.max) : getBusinessDate();
  periodStartDate = addDays(periodEndDate, -(days - 1));
  if (bounds && periodStartDate < bounds.min) periodStartDate = new Date(bounds.min);
  periodVisibleRows = 5;
  renderPeriodDetail();
}

function renderPeriodDetail() {
  setDetailRiderNames();
  initializeDetailDates();
  if (!periodStartDate || !periodEndDate) return;
  const rows = rowsBetween(periodStartDate, periodEndDate);
  const sums = sumRows(rows);
  const [periodStateKind, periodStateMsg] = historyStatusMessage("period");
  setDetailState("periodDataState", periodStateKind, periodStateMsg);
  setText("periodRangeTitle", `${formatKoreanDate(periodStartDate)} ~ ${formatKoreanDate(periodEndDate)}`);
  setText("periodTotal", rows.length ? `${sums.total.toLocaleString()}건` : "-");
  setText("periodAverage", `일평균 ${rows.length ? (sums.total/rows.length).toFixed(1) : "-"}건`);
  setText("periodFood", rows.length ? `${sums.food.toLocaleString()}건` : "-"); setText("periodFoodRate", rateText(sums.food,sums.total));
  setText("periodBmart", rows.length ? `${sums.bmart.toLocaleString()}건` : "-"); setText("periodBmartRate", rateText(sums.bmart,sums.total));
  setText("periodStore", rows.length ? `${sums.store.toLocaleString()}건` : "-"); setText("periodStoreRate", rateText(sums.store,sums.total));
  setText("periodOut", rows.length ? `${sums.out.toLocaleString()}건` : "-"); setText("periodOutRate", rateText(sums.out,sums.total));

  const monthMap = new Map();
  rows.forEach(row => {
    const month = String(row.date).slice(0,7);
    if (!monthMap.has(month)) monthMap.set(month, []);
    monthMap.get(month).push(row);
  });
  const monthItems = [...monthMap.entries()];
  const maxMonthTotal = Math.max(1, ...monthItems.map(([,rs]) => sumRows(rs).total));
  const chart = $("periodMonthlyChart");
  if (chart) chart.innerHTML = monthItems.map(([month,rs]) => {
    const total = sumRows(rs).total;
    const [y,m] = month.split("-");
    const h = Math.max(4,total/maxMonthTotal*120);
    return `<div class="period-month-item"><strong>${total.toLocaleString()}</strong><i style="height:${h}px"></i><span>${String(y).slice(-2)}년 ${Number(m)}월</span><small>일평균 ${(total/rs.length).toFixed(1)}건</small></div>`;
  }).join("") || `<div class="empty">데이터가 없습니다.</div>`;


  const bounds=historyBounds();
  if (bounds) {
    const spanDays=Math.round((periodEndDate-periodStartDate)/DETAIL_DAY_MS);
    $("periodPrev").disabled = addDays(periodStartDate,-1) < bounds.min;
    $("periodNext").disabled = addDays(periodEndDate,1) > bounds.max;
    $("periodPrev").dataset.span=String(spanDays);
    $("periodNext").dataset.span=String(spanDays);
  }
}

/* =========================================================
   DETAIL MODE / EVENTS
========================================================= */

function showDetailMode(mode) {
  detailMode = ["weekly", "monthly", "daily", "period"].includes(mode) ? mode : "weekly";
  mode = detailMode;
  document.querySelectorAll(".detail-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.detailMode === mode));
  ["weekly","monthly","daily","period"].forEach(name => {
    $(`${name}DetailView`)?.classList.toggle("hidden", name !== mode);
  });
  if (mode === "weekly") renderMyWeekly();
  if (mode === "monthly") renderMonthlyCalendar();
  if (mode === "daily") renderDailyDetail();
  if (mode === "period") renderPeriodDetail();
}

document.querySelectorAll(".detail-tab").forEach(btn => btn.addEventListener("click", () => showDetailMode(btn.dataset.detailMode)));

$("weeklyPrev")?.addEventListener("click",()=>{ detailWeekStart=addDays(detailWeekStart,-7); renderMyWeekly(); });
$("weeklyNext")?.addEventListener("click",()=>{ detailWeekStart=addDays(detailWeekStart,7); renderMyWeekly(); });
$("dailyPrev")?.addEventListener("click",()=>{ detailDailyDate=addDays(detailDailyDate,-1); renderDailyDetail(); });
$("dailyNext")?.addEventListener("click",()=>{ detailDailyDate=addDays(detailDailyDate,1); renderDailyDetail(); });

$("calendarPrev")?.addEventListener("click",()=>{ calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()-1,1); renderMonthlyCalendar(); });
$("calendarNext")?.addEventListener("click",()=>{ calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,1); renderMonthlyCalendar(); });

document.querySelectorAll("[data-period-days]").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll("[data-period-days]").forEach(b=>b.classList.toggle("active",b===btn));
  const value=btn.dataset.periodDays;
  if(value==="custom") {
    $("customPeriodPicker")?.classList.remove("hidden");
    const bounds=historyBounds();
    if(bounds){
      $("periodStartDate").min=dateKey(bounds.min); $("periodStartDate").max=dateKey(bounds.max);
      $("periodEndDate").min=dateKey(bounds.min); $("periodEndDate").max=dateKey(bounds.max);
      $("periodStartDate").value=dateKey(periodStartDate); $("periodEndDate").value=dateKey(periodEndDate);
    }
    return;
  }
  $("customPeriodPicker")?.classList.add("hidden");
  setPeriodRange(Number(value));
}));

$("applyCustomPeriod")?.addEventListener("click",()=>{
  const start=parseLocalDate($("periodStartDate")?.value), end=parseLocalDate($("periodEndDate")?.value);
  if(!start||!end){ alert("조회할 시작일과 종료일을 선택해주세요."); return; }
  if(start>end){ alert("시작일은 종료일보다 늦을 수 없습니다."); return; }
  if(Math.floor((end-start)/DETAIL_DAY_MS)+1>90){ alert("기간조회는 최대 90일까지 가능합니다."); return; }
  periodStartDate=start; periodEndDate=end; periodVisibleRows=5; renderPeriodDetail();
});

$("periodPrev")?.addEventListener("click",()=>{
  const bounds=historyBounds(); if(!bounds)return;
  const span=Math.round((periodEndDate-periodStartDate)/DETAIL_DAY_MS);
  let nextEnd=addDays(periodStartDate,-1), nextStart=addDays(nextEnd,-span);
  if(nextStart<bounds.min){ nextStart=new Date(bounds.min); nextEnd=addDays(nextStart,span); if(nextEnd>bounds.max)nextEnd=new Date(bounds.max); }
  periodStartDate=nextStart; periodEndDate=nextEnd; renderPeriodDetail();
});
$("periodNext")?.addEventListener("click",()=>{
  const bounds=historyBounds(); if(!bounds)return;
  const span=Math.round((periodEndDate-periodStartDate)/DETAIL_DAY_MS);
  let nextStart=addDays(periodEndDate,1), nextEnd=addDays(nextStart,span);
  if(nextEnd>bounds.max){ nextEnd=new Date(bounds.max); nextStart=addDays(nextEnd,-span); if(nextStart<bounds.min)nextStart=new Date(bounds.min); }
  periodStartDate=nextStart; periodEndDate=nextEnd; renderPeriodDetail();
});


/* =========================================================
   PAGE
========================================================= */

function showPage(page) {

  const pages = {

    control:
      $("controlPage"),

    detail:
      $("detailPage"),

    ranking:
      $("rankingPage"),

    more:
      $("morePage")

  };


  Object.entries(
    pages
  ).forEach(
    ([key, el]) => {

      if (!el) return;


      el.classList.toggle(
        "hidden",
        key !== page
      );

    }
  );


  document
    .querySelectorAll(
      "nav button[data-page]"
    )
    .forEach(
      button => {

        button.classList.toggle(
          "active",
          button.dataset.page ===
          page
        );

      }
    );


  if (
    page ===
    "detail"
  ) {

    showDetailMode(detailMode || "weekly");

  }


  if (
    page ===
    "ranking"
  ) {

    ensureRankingTabs();

    renderRanking(
      data || {}
    );

  }


  window.scrollTo({

    top: 0,

    behavior: "smooth"

  });

}


/* =========================================================
   PAGE BUTTON
========================================================= */

document
  .querySelectorAll(
    "[data-page]"
  )
  .forEach(
    button => {

      button.addEventListener(
        "click",
        () => {

          showPage(
            button.dataset.page
          );

        }
      );

    }
  );


/* =========================================================
   START
========================================================= */

if (token()) {

  showApp();

  load();

} else {

  showLogin();

}


/* =========================================================
   AUTO REFRESH
========================================================= */

setInterval(
  () => {

    if (token()) {

      load();

    }

  },
  5000
);

// 앱 설치 버튼
let deferredInstallPrompt = null;

const installAppBtn =
  document.getElementById("installAppBtn");

function isStandaloneApp() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (
      navigator.platform === "MacIntel" &&
      navigator.maxTouchPoints > 1
    )
  );
}

function updateInstallButton() {

  if (!installAppBtn) return;

  if (isStandaloneApp()) {
    installAppBtn.classList.add("hidden");
  } else {
    installAppBtn.classList.remove("hidden");
  }

}

window.addEventListener(
  "beforeinstallprompt",
  e => {

    e.preventDefault();

    deferredInstallPrompt = e;

    updateInstallButton();

  }
);

window.addEventListener(
  "appinstalled",
  () => {

    deferredInstallPrompt = null;

    updateInstallButton();

  }
);

if (installAppBtn) {

  installAppBtn.addEventListener(
    "click",
    async () => {

      // 설치된 앱에서는 버튼 자체가 없어야 하지만 이중 방어
      if (isStandaloneApp()) {

        installAppBtn.classList.add("hidden");

        return;
      }

      // 안드로이드 / PC 설치 가능
      if (deferredInstallPrompt) {

        deferredInstallPrompt.prompt();

        await deferredInstallPrompt.userChoice;

        deferredInstallPrompt = null;

        return;
      }

      // 아이폰 / 아이패드
      if (isIOS()) {

        alert(
          "아이폰 앱 설치 방법\n\n" +
          "1. 아래의 공유 버튼을 누르세요.\n" +
          "2. '홈 화면에 추가'를 누르세요.\n" +
          "3. 오른쪽 위 '추가'를 누르세요."
        );

        return;
      }

      // 앱을 삭제한 뒤 기존 브라우저 탭인 경우
      // 새로고침하여 설치 가능 상태를 다시 확인
      location.reload();

    }
  );

}

updateInstallButton();


/* =========================================================
   SERVICE WORKER
========================================================= */

if (
  "serviceWorker"
  in navigator
) {

  navigator.serviceWorker
    .register(
      "/sw.js"
    )
    .catch(
      console.warn
    );

}