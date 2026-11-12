/* pull — fixtures for the three dates the free API plan allows.
   Staleness is time-based, so this behaves correctly whether the cron
   fires hourly or something hits it more often. */
import { FV, apiGet, iso, shift, toFixtureRow, isFinished, isWomens, pack, ok, bad } from './lib.mjs';

const CHUNK   = 300;
const BUDGET  = 95;
const RESERVE = 10;     // for presses of Pull fixtures; the seed job is off on the free plan
const MIN_OFFSET = -1, MAX_OFFSET = 1;
const RETAIN_BACK = 3, RETAIN_FWD = 3;

const matchHours = h => h >= 11 && h <= 23;

/* Minutes before a date is fetched again. Tomorrow is refreshed every
   hour in match hours and every two hours otherwise: bets are placed a
   day ahead, so tomorrow's card has to be complete well before the day
   starts. The day after tomorrow is fetched only if the plan allows it
   (see PLUS2 below). */
function staleAfter(offset, hour) {
  const peak = matchHours(hour);
  if (offset ===  0) return peak ?  20 : 90;
  if (offset ===  1) return peak ?  60 : 120;
  if (offset ===  2) return peak ? 180 : 360;
  return peak ? 180 : Infinity;
}

export default async function pull(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/sync');
    const meta = (await metaRef.get()).data() || {};

    const today = iso();
    const hour  = new Date().getUTCHours();
    let   used  = meta.apiDay === today ? (meta.apiToday || 0) : 0;

    const forced = url.searchParams.get('date');
    const force  = url.searchParams.get('force') === '1';

    let targets;
    if (forced) {
      const days = Math.round(
        (Date.parse(forced + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
      if (Number.isNaN(days)) return bad(`"${forced}" is not a YYYY-MM-DD date`, 400);
      if (days < MIN_OFFSET || days > MAX_OFFSET) {
        return bad(`${forced} is outside the window this API plan allows ` +
                   `(${shift(MIN_OFFSET)} to ${shift(MAX_OFFSET)}).`, 400);
      }
      targets = [days];
    } else {
      const seen = meta.dateSeen || {};
      /* The day after tomorrow: the free plan's window has been yesterday
         to tomorrow. It is tried once a day; if the API refuses, it is
         left alone until the next day, and the algorithms job builds a
         provisional list for it from the bookmakers' card instead. */
      const plus2 = meta.plus2 === today + ':no' ? [] : [2];
      targets = [0, 1, -1, ...plus2].filter(off => {
        if (force && off !== 2) return true;
        const last = seen[shift(off)] || 0;
        return (Date.now() - last) / 60000 >= staleAfter(off, hour);
      });
    }

    const spendable = Math.max(0, BUDGET - RESERVE - used);
    if (!spendable) return ok({ skipped: 'fixture budget spent for today', used, reserve: RESERVE });
    if (!targets.length) return ok({ upToDate: true, used, note: 'all three dates are fresh enough' });
    targets = targets.slice(0, Math.min(spendable, 4));
    let plus2 = meta.plus2 || null;

    const seen = { ...(meta.dateSeen || {}) };
    const results = [];
    let remaining = meta.apiRemaining ?? null;

    for (const off of targets) {
      const date = shift(off);
      try {
        const r = await apiGet(env, '/fixtures', { date });
        used++; remaining = r.remaining;
        const stored = await storeDay(D, date, r.data);
        seen[date] = Date.now();
        results.push({ date, ...stored });
        if (off === 2) plus2 = today + ':ok';
      } catch (e) {
        used++;
        if (off === 2 && /plan|access|date/i.test(e.message)) {
          plus2 = today + ':no';
          results.push({ date, note: 'the API plan does not reach this date yet — a provisional list is built from the bookmakers\' card' });
          continue;
        }
        results.push({ date, error: e.message });
        if (/quota|budget/i.test(e.message)) break;
      }
    }

    const purged = await purgeOldDates(D);

    const keep = [shift(-1), shift(0), shift(1), shift(2)];
    for (const k of Object.keys(seen)) if (!keep.includes(k)) delete seen[k];

    await metaRef.set({
      apiDay: today, apiToday: used, apiRemaining: remaining,
      dateSeen: seen, plus2,
      lastPull: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      lastPullDate: results.map(r => r.date).join(', ')
    }, { merge: true });

    return ok({
      hour: `${String(hour).padStart(2, '0')}:00 UTC`,
      phase: matchHours(hour) ? 'match hours' : 'quiet hours',
      pulled: results,
      retained: `${shift(-RETAIN_BACK)} … ${shift(RETAIN_FWD)}`,
      purgedChunks: purged,
      apiUsedToday: used,
      apiRemaining: remaining,
      budgetLeftForFixtures: Math.max(0, BUDGET - RESERVE - used),
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('pull failed:', e);
    return bad(e.message);
  }
}

async function purgeOldDates(D) {
  const oldest = shift(-RETAIN_BACK), newest = shift(RETAIN_FWD);
  let removed = 0;
  for (const q of [
    D.collection('fixtures').where('date', '<', oldest).limit(40),
    D.collection('fixtures').where('date', '>', newest).limit(40)
  ]) {
    const snap = await q.get();
    if (snap.empty) continue;
    const batch = D.batch();
    snap.forEach(doc => { batch.delete(doc.ref); removed++; });
    await batch.commit();
  }
  return removed;
}

async function storeDay(D, date, data) {
  let dropped = 0;
  const rows = data.map(x => {
    const r = toFixtureRow(x);
    r.hth = x.score?.halftime?.home ?? null;
    r.hta = x.score?.halftime?.away ?? null;
    return r;
  }).filter(r => {
    if (!r.id || !r.hid || !r.aid) return false;
    if (isWomens(r.lname, r.hname, r.aname)) { dropped++; return false; }
    return true;
  });

  const parts = [];
  for (let i = 0; i < rows.length; i += CHUNK) parts.push(rows.slice(i, i + CHUNK));
  if (!parts.length) parts.push([]);

  /* read the existing chunks in one round trip so the pending flag
     can be preserved without a get() per chunk */
  const refs = parts.map((_, p) => D.doc(`fixtures/${date}__${p}`));
  const prev = await D.getAll(...refs);

  const batch = D.batch();
  let finished = 0;

  for (let p = 0; p < parts.length; p++) {
    const fin = parts[p].filter(r => isFinished(r.st)).length;
    finished += fin;
    const old = prev[p] && prev[p].exists ? prev[p].data() : null;
    const grew = !old || (old.fin || 0) !== fin;

    batch.set(refs[p], {
      date, part: p,
      f: pack(parts[p]),            // JSON string: cheap to encode, cheap to read
      fin,
      pend: fin > 0 && (grew || old.pend === true),
      done: grew ? 0 : (old.done || 0),
      u: FV.serverTimestamp()
    });
  }

  /* drop chunks left over from a bigger earlier pull */
  const strayRefs = [];
  for (let p = parts.length; p < parts.length + 4; p++) strayRefs.push(D.doc(`fixtures/${date}__${p}`));
  const strays = await D.getAll(...strayRefs);
  for (let i = 0; i < strays.length; i++) {
    if (strays[i].exists) batch.delete(strayRefs[i]); else break;
  }

  await batch.commit();
  return { fixtures: rows.length, finished, chunks: parts.length, womensDropped: dropped };
}
