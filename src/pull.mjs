/* ════════════════════════════════════════════════════════════════
   pull — fixtures from API-Football, in steps small enough for the
   free plan's 10 ms of CPU per run.

   A busy Saturday is about 1,500 fixtures and 1.5 MB of JSON. Parsing
   that, turning it into rows and writing them out costs 35-60 ms of
   CPU, so doing it all in one run got the run cut off before anything
   was saved — and, because the bookkeeping was saved last, the next
   run spent another API call on the same thing, and the next. Now:

     fetch    one API call for ONE date. The call is counted, and the
              date marked as tried, BEFORE it is made, so a run that is
              cut off can never cost more than that one call. The reply
              is not parsed: it is cut into slices of 180 fixtures with
              a byte search, and each slice is stored as it came
              (base64, which the runtime encodes in native code).
     process  each later run turns one stored slice into rows,
              and writes the small files the other jobs read: the open
              fixtures for the strategies, the results for the ledger.

   Chunks are fixtures/<date>__<n>, slice n of the day in the API's own
   order. While a day is being rewritten a fixture near the edge of a
   slice can sit in two chunks for a minute; the app shows it once.

   Which date is fetched is decided by how overdue each one is:
     today          every 40 min from 11:00 to 23:59 UTC, 90 min otherwise
     tomorrow       every 60 min in those hours, 120 otherwise — bets are
                    placed a day ahead, so it is never left stale
     yesterday      every 4 hours, for late results
     day after      tried once a day; the free plan has refused it so far,
                    and the strategies build a provisional list instead
   A slice whose bytes have not changed since the last fetch is not
   processed again.

   /jobs/pull              one step (cron)
   /jobs/pull?force=1      every date counts as due; the admin page loops
                           this until it reports done
   /jobs/pull?date=YYYY-MM-DD   fetch that date now
   ════════════════════════════════════════════════════════════════ */
import { FV, iso, shift, rowOf, isFinished, isWomens, pack, unpack, ok, bad } from './lib.mjs';
import { encode, decodeToText, hasBuffer, NB } from './b64.mjs';

export const SLICE = 180;           // fixtures in one stored chunk; one chunk per process run
const BUDGET  = 95;                 // API-Football calls a day for fixtures
const RESERVE = 10;                 // kept back for presses of Pull fixtures
const RETRY_MIN = 20;               // a fetch tried this recently and not finished is left alone
const RETAIN_BACK = 3, RETAIN_FWD = 3;
const API_BASE = 'https://v3.football.api-sports.io';

const OPEN = new Set(['NS', 'TBD']);
/* settled without a result: the ledger voids a selection on these */
const VOID = new Set(['CANC', 'ABD', 'AWD', 'WO']);

const matchHours = h => h >= 11 && h <= 23;
function staleAfter(offset, hour) {
  const peak = matchHours(hour);
  if (offset === 0) return peak ? 40 : 90;
  if (offset === 1) return peak ? 60 : 120;
  if (offset === -1) return 240;
  return 24 * 60;                   // the day after tomorrow
}
const stamp = (t = Date.now()) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export default async function pull(D, env, url) {
  const started = Date.now();
  try {
    const ref = D.doc('meta/pull');
    const M = (await ref.get()).data() || {};
    const today = iso();
    if (M.day !== today) { M.day = today; M.calls = 0; }
    M.q = Array.isArray(M.q) ? M.q : unpack(M.q);

    /* finish what was fetched before fetching anything new */
    if (M.q.length && !url.searchParams.get('date')) return await processStep(D, ref, M, started);

    const forced = url.searchParams.get('date');
    const force = url.searchParams.get('force') === '1';
    let off;
    if (forced) {
      off = Math.round((Date.parse(forced + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
      if (Number.isNaN(off)) return bad(`"${forced}" is not a YYYY-MM-DD date`, 400);
      if (off < -1 || off > 1) return bad(`${forced} is outside the window this API plan allows (${shift(-1)} to ${shift(1)}).`, 400);
    } else {
      off = pickDate(M, force);
      if (off === null) {
        const purged = await purgeOld(D, ref, M);
        return ok({ idle: true, done: true, note: 'every date is fresh enough', purged,
                    calls: M.calls || 0, last: M.last || null, ms: Date.now() - started });
      }
    }
    return await fetchStep(D, env, ref, M, off, !!(forced || force), started);
  } catch (e) {
    console.error('pull failed:', e);
    return bad(e.message);
  }
}

/* The most overdue date, or null. Ties go today, tomorrow, yesterday. */
export function pickDate(M, force, now = Date.now()) {
  const hour = new Date(now).getUTCHours();
  const seen = M.seen || {}, tried = M.tried || {};
  let best = null, bestScore = 0;
  for (const off of [0, 1, -1, 2]) {
    const date = shift(off, new Date(now));
    if (off === 2 && (force || M.plus2 === iso(new Date(now)) + ':no')) continue;
    const last = seen[date] || 0, t = tried[date] || 0;
    /* tried and not finished: the run was cut off, or the API failed.
       Wait before trying again rather than spending a call every run. */
    if (t > last && now - t < RETRY_MIN * 60000) continue;
    const age = (now - last) / 60000;
    const score = force ? (age >= 5 ? 1 + age / 1e7 : 0) : age / staleAfter(off, hour);
    if (score >= 1 && score > bestScore + 1e-12) { best = off; bestScore = score; }
  }
  return best;
}

/* ---------------------------------------------------------------- fetch */
async function fetchStep(D, env, ref, M, off, manual, started) {
  const date = shift(off), today = iso(), now = Date.now();
  const cap = manual ? BUDGET : BUDGET - RESERVE;
  if ((M.calls || 0) >= cap) return ok({ skipped: 'fixture budget spent for today', calls: M.calls, budget: cap });
  const key = env.APIFOOTBALL_KEY;
  if (!key) return bad('APIFOOTBALL_KEY is not set');

  /* Counted and marked BEFORE the call. */
  M.calls = (M.calls || 0) + 1;
  M.tried = keepWindow({ ...(M.tried || {}), [date]: now });
  await ref.set({ day: M.day, calls: M.calls, tried: M.tried }, { merge: true });

  let res, buf;
  try {
    res = await fetch(`${API_BASE}/fixtures?date=${date}`, { headers: { 'x-apisports-key': key } });
    buf = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return await failed(ref, date, 'network: ' + e.message);
  }
  const remaining = Number(res.headers.get('x-ratelimit-requests-remaining') ?? -1);
  if (!res.ok) return await failed(ref, date, `API ${res.status}`, remaining);

  /* An error reply is small; a real day is not, and is never parsed
     whole here. */
  if (buf.length < 60000) {
    let j;
    try { j = JSON.parse(new TextDecoder().decode(buf)); } catch { return await failed(ref, date, 'API sent something that is not JSON', remaining); }
    const e = j.errors;
    if (e && !Array.isArray(e) && Object.keys(e).length) {
      const said = JSON.stringify(e);
      if (e.requests) {
        await ref.set({ calls: BUDGET }, { merge: true });          // nothing more today
        return await failed(ref, date, 'API quota exhausted: ' + e.requests, remaining);
      }
      if (e.token) return await failed(ref, date, `API key rejected: ${e.token} — check APIFOOTBALL_KEY, and that you registered at api-football.com rather than RapidAPI`, remaining);
      if (e.plan || /plan|access|date/i.test(said)) {
        if (off === 2) {
          await ref.set({ plus2: today + ':no', rem: remaining }, { merge: true });
          return ok({ date, note: 'the API plan does not reach the day after tomorrow yet — the strategies build a provisional list from the bookmakers\' card', calls: M.calls });
        }
        return await failed(ref, date, 'API plan limit: ' + (e.plan || said), remaining);
      }
      return await failed(ref, date, 'API error: ' + said.slice(0, 200), remaining);
    }
  }

  const cut = cutSlices(buf);
  if (!cut) return await failed(ref, date, 'the API reply is not laid out the way it always has been — nothing was changed', remaining);
  const n = cut.count, P = cut.slices.length;

  /* An empty day where there used to be a full one is a glitch upstream
     far more often than a day with no football. Keep what is stored. */
  const before = (M.cnt || {})[date] || 0;
  if (!n && before > 20) {
    M.seen = keepWindow({ ...(M.seen || {}), [date]: now });
    await ref.set({ seen: M.seen, rem: remaining, err: { at: stamp(), date, msg: `empty reply ignored — ${before} fixtures kept` } }, { merge: true });
    return ok({ date, note: `the API returned no fixtures for ${date}; the ${before} already stored are kept`, calls: M.calls });
  }

  /* Which slices changed, by a hash of each. Fixtures that have not
     started, and ones long finished, do not move between fetches, so
     even on a match day most slices come back unchanged. */
  const oldH = (M.h || {})[date] || [];
  const sameCount = ((M.np || {})[date] ?? -1) === P;
  const queue = [], hs = {};
  const batch = D.batch();
  const run = now.toString(36);
  for (let k = 0; k < P; k++) {
    const bytes = cut.slices[k];
    const h = await sha(bytes);
    hs[k] = h;
    if (!manual && sameCount && h === oldH[k]) continue;   // nothing in this slice moved
    queue.push(k);
    batch.set(D.doc(`fxraw/${date}__${k}`), { date, k, run, b64: FV.bytes(encode(bytes)), at: now });
  }

  M.seen = keepWindow({ ...(M.seen || {}), [date]: now });
  M.cnt = keepWindow({ ...(M.cnt || {}), [date]: n });
  const fields = { day: M.day, calls: M.calls, rem: remaining, seen: M.seen, cnt: M.cnt, err: null,
                   last: { at: stamp(now), date, fixtures: n, slices: P, queued: queue.length } };
  if (off === 2) fields.plus2 = today + ':ok';
  if (queue.length) {
    M.q.push({ d: date, r: run, p: queue, n: P, hs, full: queue.length === P ? 1 : 0 });
    fields.q = M.q;
  }
  batch.set(ref, fields, { merge: true });
  batch.set(D.doc('meta/sync'), { lastPull: stamp(now), lastPullDate: date, apiDay: M.day,
                                  apiToday: M.calls, apiRemaining: remaining }, { merge: true });
  await batch.commit();

  return ok({ step: 'fetch', date, fixtures: n, slices: P,
              queued: queue.length ? `${queue.length} slice(s) to store` : 'nothing changed since the last fetch',
              calls: M.calls, apiRemaining: remaining, done: false, ms: Date.now() - started });
}

async function failed(ref, date, msg, remaining) {
  await ref.set({ err: { at: stamp(), date, msg }, ...(remaining >= 0 ? { rem: remaining } : {}) }, { merge: true }).catch(() => {});
  return bad(`${date}: ${msg}`);
}

/* ------------------------------------------------- cutting the reply up */
const MARK = '{"fixture":{';
const MARK_B = new TextEncoder().encode(MARK);

/* Every fixture object in the reply starts with the same twelve bytes.
   Their positions are found by a native byte search; the slices are
   views into the reply, nothing is copied or decoded. */
export function cutSlices(buf) {
  const marks = [];
  let start;
  if (hasBuffer) {
    const B = NB.from(buf.buffer, buf.byteOffset, buf.byteLength);
    start = B.indexOf('"response":');
    if (start < 0) return null;
    let i = B.indexOf(MARK_B, start);
    while (i >= 0) { marks.push(i); i = B.indexOf(MARK_B, i + MARK.length); }
  } else {
    /* no Buffer: decode once and search the text, then work back to bytes */
    const text = new TextDecoder().decode(buf);
    start = text.indexOf('"response":');
    if (start < 0) return null;
    const enc = new TextEncoder();
    let i = text.indexOf(MARK, start), lastChar = 0, lastByte = 0;
    while (i >= 0) {
      lastByte += enc.encode(text.slice(lastChar, i)).length; lastChar = i;
      marks.push(lastByte);
      i = text.indexOf(MARK, i + MARK.length);
    }
    start = enc.encode(text.slice(0, start)).length;
  }
  if (!marks.length) {
    /* fine if the response really is empty */
    const head = new TextDecoder().decode(buf.subarray(start, start + 40));
    return /"response"\s*:\s*\[\s*\]/.test(head) ? { count: 0, slices: [] } : null;
  }
  const end = endOfObject(buf, marks[marks.length - 1]);
  if (end < 0) return null;
  const slices = [];
  for (let k = 0; k < marks.length; k += SLICE) {
    const a = marks[k];
    let b;
    if (k + SLICE < marks.length) {
      b = marks[k + SLICE] - 1;
      while (b > a && buf[b] !== 44) b--;           // back to the comma between objects
    } else b = end;
    slices.push(buf.subarray(a, b));
  }
  return { count: marks.length, slices };
}

/* Where the object starting at i ends (one past its closing brace).
   Used for the last fixture only, so the walk is short. */
function endOfObject(buf, i) {
  let depth = 0, str = false;
  for (let k = i; k < buf.length; k++) {
    const c = buf[k];
    if (str) {
      if (c === 92) k++;                 // backslash: skip what it escapes
      else if (c === 34) str = false;
      continue;
    }
    if (c === 34) str = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) return k + 1;
  }
  return -1;
}

async function sha(bytes) {
  const buf = await crypto.subtle.digest('SHA-1', bytes);
  let h = '';
  for (const b of new Uint8Array(buf, 0, 10)) h += b.toString(16).padStart(2, '0');
  return h;
}

/* bookkeeping maps keep only the dates still in play */
function keepWindow(map) {
  const out = {};
  const lo = shift(-RETAIN_BACK), hi = shift(RETAIN_FWD);
  for (const [k, v] of Object.entries(map || {})) if (k >= lo && k <= hi) out[k] = v;
  return out;
}

/* -------------------------------------------------------------- process */
async function processStep(D, ref, M, started) {
  /* An entry that has sat in the queue for 45 minutes — its runs keep
     failing, or being cut off — is dropped, so one bad slice cannot hold
     up every fetch after it. The next fetch of that date brings it back. */
  const now = Date.now();
  while (M.q.length && (now - parseInt(M.q[0].r, 36) > 45 * 60000 || !Array.isArray(M.q[0].p) || !M.q[0].p.length)) M.q.shift();
  if (!M.q.length) {
    await ref.set({ q: [] }, { merge: true });
    return ok({ step: 'process', note: 'dropped a stale queue entry', done: false, ms: Date.now() - started });
  }
  const E = M.q[0];
  const date = E.d;
  /* A slice tried three times without finishing is skipped. The count is
     saved before the work, so a run cut off for CPU still counts. */
  E.t = (E.t || 0) + 1;
  if (E.t > 3) {
    E.p.shift(); E.t = 0;
    await ref.set({ q: M.q, err: { at: stamp(), date, msg: 'a slice of fixtures failed three times and was skipped' } }, { merge: true });
    return ok({ step: 'process', date, note: 'skipped a slice that kept failing', done: false, ms: Date.now() - started });
  }
  await ref.set({ q: M.q }, { merge: true });
  const take = E.p.slice(0, 1);
  const [dgSnap, ...raws] = await Promise.all([
    D.doc(`dg/${date}`).get(),
    ...take.map(k => D.getBytes(`fxraw/${date}__${k}`, 'b64', ['run']))
  ]);
  const dg = new Set(unpack(dgSnap.exists ? dgSnap.data().ids : null).map(String));

  const nowSec = Date.now() / 1000;
  const batch = D.batch();
  const done = [];
  let stored = 0, women = 0, finished = 0, skipped = 0;
  take.forEach((k, i) => {
    const raw = raws[i];
    done.push(k);
    if (!raw || raw.run !== E.r || !raw.b64) { skipped++; return; }    // replaced by a newer fetch
    const list = parseSlice(decodeToText(raw.b64));
    if (!list) { skipped++; return; }                                  // unreadable: keep what is stored

    const out = [], res = {}, open = [];
    let fin = 0, pend = false;
    for (const x of list) {
      const r = rowOf(x);
      if (!r.id || !r.hid || !r.aid) continue;
      if (isWomens(r.lname, r.hname, r.aname)) { women++; continue; }
      out.push(r);
      if (isFinished(r.st)) {
        fin++;
        res[r.id] = [r.st, r.gh, r.ga, r.hth, r.hta];
        if (!dg.has(String(r.id))) pend = true;
      } else if (VOID.has(r.st)) {
        res[r.id] = [r.st, null, null, null, null];
      } else if (OPEN.has(r.st) && (!r.ts || r.ts > nowSec)) {
        open.push([r.id, r.ts, r.lid, r.hid, r.aid, r.k, r.hname, r.aname, r.lname, r.ctry]);
      }
    }
    stored += out.length; finished += fin;
    batch.set(D.doc(`fixtures/${date}__${k}`), {
      date, part: k, v: 4, f: pack(out), n: out.length, fin, res: JSON.stringify(res), pend,
      lids: [...new Set(out.map(r => r.lid))], u: FV.serverTimestamp()
    });
    batch.set(D.doc(`fxo/${date}__${k}`), { date, k, o: pack(open), n: open.length, at: Date.now() });
  });

  /* the queue, and the record of what is now stored */
  E.p = E.p.filter(k => !done.includes(k));
  E.t = 0;
  const fields = { q: M.q };
  const h = { ...(M.h || {}) };
  h[date] = Array.isArray(h[date]) ? h[date].slice(0, E.n) : [];
  for (const k of done) if (E.hs && E.hs[k] != null) h[date][k] = E.hs[k];
  fields.h = keepWindow(h);
  let finishedEntry = false;
  if (!E.p.length) {
    M.q.shift(); finishedEntry = true;
    const np = { ...(M.np || {}) };
    const was = np[date] ?? (E.n + 6);
    /* chunks beyond the new count — a smaller day, or the old layout —
       and the bookmakers'-card list once the real one is complete */
    for (let k = E.n; k < Math.max(was, E.n); k++) {
      batch.delete(D.doc(`fixtures/${date}__${k}`)); batch.delete(D.doc(`fxo/${date}__${k}`));
    }
    batch.delete(D.doc(`fixtures/${date}__p`));
    np[date] = E.n;
    fields.np = keepWindow(np);
    const ver = { ...(M.ver || {}) };
    ver[date] = (ver[date] || 0) + 1;            // the strategies notice a new list by this
    fields.ver = keepWindow(ver);
  }
  batch.set(ref, fields, { merge: true });
  await batch.commit();

  return ok({ step: 'process', date, slices: done, fixturesStored: stored, finished, womensDropped: women,
              skipped: skipped || undefined, queueLeft: M.q.reduce((a, e) => a + e.p.length, 0),
              done: false, entryFinished: finishedEntry, ms: Date.now() - started });
}

/* A slice is parsed whole; if that fails, fixture by fixture, so one
   bad object cannot empty the chunk. */
export function parseSlice(text) {
  try { return JSON.parse('[' + text + ']'); } catch {}
  const out = [];
  let i = text.indexOf(MARK);
  while (i >= 0) {
    const j = text.indexOf(MARK, i + MARK.length);
    const piece = text.slice(i, j < 0 ? text.length : text.lastIndexOf(',', j));
    try { out.push(JSON.parse(piece)); } catch {}
    i = j;
  }
  return out.length ? out : null;
}

/* --------------------------------------------------------------- purge */
/* Days that have left the window are removed, at most once an hour and
   only when there is nothing else to do. */
async function purgeOld(D, ref, M) {
  if (Date.now() - (M.purgedAt || 0) < 3600e3) return 0;
  const lo = shift(-RETAIN_BACK), hi = shift(RETAIN_FWD);
  let removed = 0;
  const batch = D.batch();
  for (const col of ['fixtures', 'fxraw', 'fxo', 'dg']) {
    for (const q of [D.collection(col).where('date', '<', lo).select('date').limit(25),
                     D.collection(col).where('date', '>', hi).select('date').limit(25)]) {
      const snap = await q.get();
      snap.forEach(d => { batch.delete(d.ref); removed++; });
    }
  }
  batch.set(ref, { purgedAt: Date.now() }, { merge: true });
  await batch.commit();
  return removed;
}
