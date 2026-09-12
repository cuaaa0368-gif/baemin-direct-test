import express from 'express';
import setCookieParser from 'set-cookie-parser';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BASE = 'https://api-deliverycenter.baemin.com';

const CENTER_ID = String(process.env.BAEMIN_CENTER_ID || '').trim();
const INITIAL_COOKIE = String(process.env.BAEMIN_COOKIE || '').trim();
const POLL_MS = Math.max(10_000, Number(process.env.BAEMIN_POLL_MS || 20_000));

if (!CENTER_ID) {
  console.error('[BOOT] BAEMIN_CENTER_ID가 없습니다.');
}
if (!INITIAL_COOKIE) {
  console.error('[BOOT] BAEMIN_COOKIE가 없습니다.');
}

const cookieJar = new Map();

function loadCookieHeader(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) cookieJar.set(name, value);
  }
}

function buildCookieHeader() {
  return [...cookieJar.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function cookieNames() {
  return [...cookieJar.keys()].sort();
}

function mergeSetCookieHeaders(response) {
  let raw = [];

  try {
    if (typeof response.headers.getSetCookie === 'function') {
      raw = response.headers.getSetCookie();
    }
  } catch {}

  // Node/undici 호환 fallback
  if (!raw.length) {
    const one = response.headers.get('set-cookie');
    if (one) raw = [one];
  }

  if (!raw.length) return [];

  let parsed = [];
  try {
    parsed = setCookieParser.parse(raw, { map: false });
  } catch (e) {
    console.warn('[COOKIE] Set-Cookie 파싱 실패:', e.message);
    return [];
  }

  const changed = [];

  for (const c of parsed) {
    if (!c?.name) continue;

    const expired =
      c.maxAge === 0 ||
      (c.expires instanceof Date && c.expires.getTime() <= Date.now());

    if (expired) {
      cookieJar.delete(c.name);
      changed.push(`${c.name}(deleted)`);
      continue;
    }

    if (typeof c.value === 'string') {
      cookieJar.set(c.name, c.value);
      changed.push(c.name);
    }
  }

  return changed;
}

loadCookieHeader(INITIAL_COOKIE);

const state = {
  startedAt: new Date().toISOString(),
  pollMs: POLL_MS,
  running: false,
  pollCount: 0,
  successCount: 0,
  authFailCount: 0,
  errorCount: 0,
  last: null,
  centerCheck: null
};

function baseHeaders() {
  return {
    'accept': 'application/json, text/plain, */*',
    'center-id': CENTER_ID,
    'cookie': buildCookieHeader(),
    'origin': 'https://deliverycenter.baemin.com',
    'referer': 'https://deliverycenter.baemin.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36'
  };
}

async function callBaemin(path) {
  const started = Date.now();

  const response = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: baseHeaders(),
    redirect: 'manual'
  });

  const setCookieNames = mergeSetCookieHeaders(response);
  const durationMs = Date.now() - started;
  const text = await response.text();

  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    durationMs,
    location: response.headers.get('location') || null,
    setCookieNames,
    body,
    textLength: text.length
  };
}

function summarizeDeliveryBody(body) {
  if (!body || typeof body !== 'object') return null;

  return {
    dataIsArray: Array.isArray(body.data),
    riderCountInPage: Array.isArray(body.data) ? body.data.length : null,
    totalPage: Number.isFinite(body.totalPage) ? body.totalPage : null,
    topLevelKeys: Object.keys(body).sort()
  };
}

async function checkCenter() {
  if (!CENTER_ID || !cookieJar.size) {
    state.centerCheck = {
      at: new Date().toISOString(),
      status: 0,
      ok: false,
      reason: 'missing-env'
    };
    return state.centerCheck;
  }

  try {
    const r = await callBaemin('/v2/center');
    state.centerCheck = {
      at: new Date().toISOString(),
      status: r.status,
      ok: r.ok,
      durationMs: r.durationMs,
      redirectedTo: r.location,
      setCookieNames: r.setCookieNames
    };

    console.log(
      `[CENTER] ${r.status} ${r.ok ? 'OK' : 'FAIL'} | ${r.durationMs}ms` +
      (r.setCookieNames.length ? ` | Set-Cookie: ${r.setCookieNames.join(', ')}` : '')
    );

    return state.centerCheck;
  } catch (e) {
    state.centerCheck = {
      at: new Date().toISOString(),
      status: 0,
      ok: false,
      error: e.message
    };
    console.error('[CENTER] 오류:', e.message);
    return state.centerCheck;
  }
}

async function pollOnce(reason = 'interval') {
  if (state.running) return state.last;

  if (!CENTER_ID || !cookieJar.size) {
    state.last = {
      at: new Date().toISOString(),
      reason,
      status: 0,
      ok: false,
      error: 'BAEMIN_CENTER_ID 또는 BAEMIN_COOKIE 없음'
    };
    return state.last;
  }

  state.running = true;
  state.pollCount++;

  try {
    // 실제로 브라우저에서 200이 확인된 v4 엔드포인트
    const r = await callBaemin('/v4/management/delivery-status?page=0&size=1');

    if (r.ok) state.successCount++;
    if (r.status === 401 || r.status === 403) state.authFailCount++;

    state.last = {
      at: new Date().toISOString(),
      reason,
      status: r.status,
      ok: r.ok,
      durationMs: r.durationMs,
      redirectedTo: r.location,
      setCookieNames: r.setCookieNames,
      body: summarizeDeliveryBody(r.body)
    };

    const authText =
      (r.status === 401 || r.status === 403) ? ' AUTH_EXPIRED?' : '';

    console.log(
      `[BAEMIN] ${r.status} ${r.ok ? 'OK' : 'FAIL'}${authText}` +
      ` | ${r.durationMs}ms | poll=${state.pollCount}` +
      (r.setCookieNames.length ? ` | Set-Cookie: ${r.setCookieNames.join(', ')}` : '')
    );

    return state.last;
  } catch (e) {
    state.errorCount++;
    state.last = {
      at: new Date().toISOString(),
      reason,
      status: 0,
      ok: false,
      error: e.message
    };
    console.error('[BAEMIN] 호출 오류:', e.message);
    return state.last;
  } finally {
    state.running = false;
  }
}

app.get('/', (_req, res) => {
  res.type('text/plain').send(
`Baemin Render Direct Test

GET /health  - 현재 상태
GET /test    - 즉시 delivery-status 1회 호출
GET /center  - 즉시 /v2/center 1회 호출
`
  );
});

app.get('/health', (_req, res) => {
  res.json({
    service: 'baemin-render-direct-test',
    now: new Date().toISOString(),
    centerIdConfigured: Boolean(CENTER_ID),
    cookieConfigured: Boolean(cookieJar.size),
    cookieNames: cookieNames(),
    state
  });
});

app.get('/test', async (_req, res) => {
  const result = await pollOnce('manual');
  res.status(result?.ok ? 200 : 502).json(result);
});

app.get('/center', async (_req, res) => {
  const result = await checkCenter();
  res.status(result?.ok ? 200 : 502).json(result);
});

app.listen(PORT, async () => {
  console.log(`[BOOT] listening on :${PORT}`);
  console.log(`[BOOT] center-id: ${CENTER_ID || '(없음)'}`);
  console.log(`[BOOT] cookie names: ${cookieNames().join(', ') || '(없음)'}`);
  console.log(`[BOOT] poll interval: ${POLL_MS}ms`);

  await checkCenter();
  await pollOnce('startup');

  setInterval(() => {
    pollOnce('interval').catch(() => {});
  }, POLL_MS);
});
