/* ════════════════════════════════════════════════════════════════
   picks — write down what the strategies selected, then grade it.

   A win rate is only honest if the selection was recorded BEFORE
   kick-off and never touched afterwards. So:

     record   for matches that have not started, store each selection as
              it stood in the list the algos job saved (algo/<date>) —
              the same list the app shows. A stored selection is never
              changed or removed. New ones may be ADDED on later runs,
              until kick-off.
                Flip x2  1xBet's price, the fair probability, the value
                HTD      the forecast half-time draw probability
     settle   once a match has finished, mark each selection won or lost
                Flip x2  on the ninety-minute score
                HTD      on the half-time score
              A match cancelled, abandoned or awarded voids its
              selections at once; one whose result never arrives is
              voided after three days rather than left open for ever.

   Results come from the small `res` field pull writes on each chunk, so
   grading a day reads a few kilobytes, not the whole fixture list. Each
   day carries its own totals, so the running record reads those alone.

   Zero API calls. A handful of Firestore requests a run.

   /jobs/picks            record today and tomorrow, settle what finished
   /jobs/picks?reset=1    clear the running totals (stored days are kept)
   /jobs/picks?rollup=1   rebuild the running totals now
   ════════════════════════════════════════════════════════════════ */
import { ST } from './model.mjs';
import { unpack, unpackObj, pack, iso, shift, ok, bad } from './lib.mjs';

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const VOIDED = new Set(['CANC', 'ABD', 'AWD', 'WO']);
const round = n => Math.round(n * 1e4) / 1e4;

/* Returns true (won), false (lost), or null when the result cannot be
   read — a void, a postponement, a score that never arrived. A null is
   left open rather than counted as a loss. */
export function grade(k, gh, ga) {
  if (!Number.isFinite(gh) || !Number.isFinite(ga)) return null;
  switch (k) {
    case '1':   return gh > ga;
    case 'X':   return gh === ga;
    case '2':   return ga > gh;
    case 'O25': return gh + ga > 2.5;
    case 'U25': return gh + ga < 2.5;
    case 'HTD': return gh === ga;        // graded on the half-time score
    default:    return null;
  }
}

/* the two strategies the ledger keeps, and how each is graded from a
   result [status, home, away, home at half-time, away at half-time] */
export const BOOKS = {
  flipx2: { grade: (s, r) => grade(s.k, r[1], r[2]), score: r => ({ gh: r[1], ga: r[2] }) },
  htd:    { grade: (s, r) => grade('HTD', r[3], r[4]), score: r => ({ gh: r[3], ga: r[4], ft: [r[1], r[2]] }) }
};
const settledOf = s => s.won === true || s.won === false || s.void === 1;

/* one day's totals, kept on the day so the running record is cheap */
function summary(v) {
  const mk = () => ({ won: 0, lost: 0, pnl: 0, open: 0, void: 0, said: 0 });
  const f = { all: mk(), value: mk(), near: mk(), legacy: 0 }, h = { all: mk(), priced: mk(), model: mk() };
  for (const s of unpack(v.flipx2)) {
    /* Days recorded before 11 Nov 2026 were chosen by the old rule and
       priced at the best odds across every book, which nobody could
       actually take. They stay stored but are not part of this record. */
    if (!s.tier) { f.legacy++; continue; }
    for (const t of [f.all, s.tier === 'value' ? f.value : f.near]) {
      if (s.won === true) { t.won++; t.pnl += s.price - 1; }
      else if (s.won === false) { t.lost++; t.pnl -= 1; }
      else if (s.void) t.void++;
      else t.open++;
    }
  }
  for (const s of unpack(v.htd)) for (const t of [h.all, s.priced ? h.priced : h.model]) {
    if (s.won === true) { t.won++; t.said += s.p || 0; }
    else if (s.won === false) { t.lost++; t.said += s.p || 0; }
    else if (s.void) t.void++;
    else t.open++;
  }
  return { f, h };
}

export default async function picks(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/picks');
    if (url.searchParams.get('reset')) {
      await metaRef.set({ totals: null, htd: null }, { merge: true });
      return ok({ reset: true, note: 'running totals cleared; stored days left alone' });
    }

    const nowSec = Date.now() / 1000;
    const recDates = [shift(0), shift(1)];
    const setDates = [shift(-3), shift(-2), shift(-1), shift(0)];
    const allDates = [...new Set([...setDates, ...recDates])];

    const [pickSnaps, algoSnaps] = await Promise.all([
      D.getAll(...allDates.map(d => D.doc(`picks/${d}`))),
      D.getAll(...recDates.map(d => D.doc(`algo/${d}`)), { mask: ['flipx2', 'htd'] })
    ]);
    const ledger = {};
    allDates.forEach((d, i) => { ledger[d] = pickSnaps[i] && pickSnaps[i].exists ? pickSnaps[i].data() : null; });

    const patch = {};                     // date -> fields to write
    const put = (date, fields) => { patch[date] = { ...(patch[date] || {}), ...fields }; };
    const recorded = [], settled = [];
    const at = Math.round(Date.now() / 60000);
    const real = f => f && !f.prov && !String(f.id).startsWith('p') && f.ts > nowSec;

    /* ---- record ---- */
    recDates.forEach((date, i) => {
      const algo = algoSnaps[i] && algoSnaps[i].exists ? algoSnaps[i].data() : null;
      const rec = { date };

      /* Flip x2 */
      const flips = algo ? unpack(algo.flipx2) : [];
      const have = ledger[date] ? unpack(ledger[date].flipx2) : [];
      if (!flips.length) rec.flipx2 = 'no saved list yet';
      else if (have.length >= ST.FLIP.keep) rec.flipx2 = 'full for this day';
      else {
        const taken = new Set(have.map(s => s.fid + '|' + s.k));
        const add = [];
        for (const x of flips) {
          if (have.length + add.length >= ST.FLIP.keep) break;
          const f = x.f, leg = x.leg || {};
          /* provisional rows are never recorded: their ids are not the
             feed's, so they could not be graded */
          if (!real(f) || !leg.k) continue;
          const id = f.id + '|' + leg.k;
          if (taken.has(id)) continue;
          taken.add(id);
          add.push({
            fid: f.id, k: leg.k, label: leg.label, tier: x.tier,
            price: round(leg.price), fair: round(leg.fair), ev: round(x.ev),
            src: leg.src, best: round(leg.best || leg.price),
            home: f.hname, away: f.aname, lname: f.lname || '', ts: f.ts || null, at
          });
        }
        if (add.length) {
          const sel = have.concat(add);
          put(date, { flipx2: pack(sel), n: sel.length });
          ledger[date] = { ...(ledger[date] || {}), flipx2: pack(sel) };
        }
        rec.flipx2 = { added: add.length, total: have.length + add.length };
      }

      /* HTD */
      const list = algo ? unpack(algo.htd) : [];
      const haveH = ledger[date] ? unpack(ledger[date].htd) : [];
      if (!list.length) rec.htd = 'no saved list yet';
      else if (haveH.length >= ST.HTD.keep) rec.htd = 'full for this day';
      else {
        const taken = new Set(haveH.map(s => String(s.fid)));
        const add = [];
        for (const x of list) {
          if (haveH.length + add.length >= ST.HTD.keep) break;
          const f = x.f || {};
          if (!real(f) || taken.has(String(f.id))) continue;
          taken.add(String(f.id));
          add.push({ fid: f.id, k: 'HTD', label: 'Half-time draw', p: round(x.prob), fair: round(x.fair),
                     priced: x.priced ? 1 : 0, totals: x.totals ? 1 : 0,
                     home: f.hname, away: f.aname, lname: f.lname || '', ts: f.ts || null, at });
        }
        if (add.length) {
          const sel = haveH.concat(add);
          put(date, { htd: pack(sel), nh: sel.length });
          ledger[date] = { ...(ledger[date] || {}), htd: pack(sel) };
        }
        rec.htd = { added: add.length, total: haveH.length + add.length };
      }
      if (patch[date] && !(ledger[date] && ledger[date].recordedAt)) put(date, { recordedAt: new Date().toISOString() });
      recorded.push(rec);
    });

    /* ---- settle ---- */
    const open = setDates.filter(d => {
      const doc = ledger[d];
      return doc && !doc.settledAt && Object.keys(BOOKS).some(k => unpack(doc[k]).some(s => !settledOf(s)));
    });
    const resOf = async d => {
      const snap = await D.collection('fixtures').where('date', '==', d).select('res').get();
      const res = {};
      let missing = false;
      snap.forEach(c => { const v = c.data().res; if (v == null) missing = true; else Object.assign(res, unpackObj(v)); });
      if (missing) {
        /* chunks stored before results were kept separately: read the rows */
        const full = await D.collection('fixtures').where('date', '==', d).select('f').get();
        full.forEach(c => { for (const f of unpack(c.data().f)) if (f && (FINISHED.has(f.st) || VOIDED.has(f.st)) && !(f.id in res)) res[f.id] = [f.st, f.gh, f.ga, f.hth ?? null, f.hta ?? null]; });
      }
      return res;
    };
    const resList = await Promise.all(open.map(resOf));
    open.forEach((date, i) => {
      const doc = ledger[date];
      const res = resList[i];
      const lastChance = date === setDates[0];
      let newly = 0, left = 0;
      const out = {};
      for (const key of Object.keys(BOOKS)) {
        const sel = unpack(doc[key]);
        if (!sel.length) continue;
        out[key] = sel.map(s => {
          if (settledOf(s)) return s;
          const r = res[s.fid];
          if (r && VOIDED.has(r[0])) { newly++; return { ...s, void: 1, st: r[0] }; }
          const won = r && FINISHED.has(r[0]) ? BOOKS[key].grade(s, r) : null;
          if (won === null) {
            if (lastChance) { newly++; return { ...s, void: 1 }; }
            left++; return s;
          }
          newly++;
          return { ...s, won, ...BOOKS[key].score(r) };
        });
      }
      if (!newly) return;
      const fields = { settledAt: left === 0 ? new Date().toISOString() : null };
      for (const key of Object.keys(out)) fields[key] = pack(out[key]);
      if (out.flipx2) {
        const done = out.flipx2.filter(s => s.won === true || s.won === false);
        fields.won = done.filter(s => s.won).length;
        fields.lost = done.filter(s => !s.won).length;
        fields.pnl = round(done.reduce((a, s) => a + (s.won ? s.price - 1 : -1), 0));
      }
      put(date, fields);
      ledger[date] = { ...doc, ...fields };
      settled.push({ date, graded: newly, stillOpen: left });
    });

    /* ---- write, and the running totals ---- */
    const dates = Object.keys(patch);
    let totals = null;
    if (dates.length) {
      const batch = D.batch();
      for (const d of dates) {
        const s = summary({ ...(ledger[d] || {}), ...patch[d] });
        batch.set(D.doc(`picks/${d}`), { date: d, ...patch[d], sum: JSON.stringify(s) }, { merge: true });
      }
      await batch.commit();
    }
    if (dates.length || url.searchParams.get('rollup')) {
      totals = await rollup(D);
      await metaRef.set({
        totals: JSON.stringify(totals.flipx2), htd: JSON.stringify(totals.htd), u: Date.now(),
        lastRun: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      }, { merge: true });
    } else {
      await metaRef.set({ lastRun: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }, { merge: true });
    }

    return ok({ today: iso(), recorded, settled, totals: totals || 'unchanged', ms: Date.now() - started });
  } catch (e) {
    console.error('picks failed:', e);
    return bad(e.message);
  }
}

/* The running record over the last six months of stored days: Flip x2
   overall and for its two tiers, HTD overall and split by whether the
   forecast was backed by a price. Each day's own totals are read; a day
   stored before those existed is worked out from its selections once. */
export async function rollup(D) {
  const snap = await D.collection('picks').where('date', '>=', shift(-180)).select('date', 'sum').limit(200).get();
  const late = [];
  const sums = [];
  snap.forEach(d => { const v = d.data(); const s = parse(v.sum); if (s) sums.push(s); else late.push(d.id); });
  if (late.length) {
    const docs = await D.getAll(...late.slice(0, 40).map(id => D.doc(`picks/${id}`)), { mask: ['flipx2', 'htd'] });
    const batch = D.batch();
    docs.forEach((d, i) => { if (!d.exists) return; const s = summary(d.data()); sums.push(s); batch.set(D.doc(`picks/${late[i]}`), { sum: JSON.stringify(s) }, { merge: true }); });
    await batch.commit();
  }
  const mk = () => ({ won: 0, lost: 0, pnl: 0, open: 0, void: 0, said: 0 });
  const F = { all: mk(), value: mk(), near: mk() }, H = { all: mk(), priced: mk(), model: mk() };
  let days = 0, hdays = 0, legacy = 0;
  const add = (t, x) => { for (const k of Object.keys(t)) t[k] += x[k] || 0; };
  for (const s of sums) {
    const fn = s.f.all.won + s.f.all.lost + s.f.all.open + s.f.all.void;
    if (fn || s.f.legacy) days++;
    legacy += s.f.legacy || 0;
    add(F.all, s.f.all); add(F.value, s.f.value); add(F.near, s.f.near);
    if (s.h.all.won + s.h.all.lost + s.h.all.open + s.h.all.void) hdays++;
    add(H.all, s.h.all); add(H.priced, s.h.priced); add(H.model, s.h.model);
  }
  const fin = (t, money = true) => {
    const n = t.won + t.lost;
    const out = { won: t.won, lost: t.lost, open: t.open, void: t.void, settled: n, winRate: n ? round(t.won / n) : null };
    if (money) { out.pnl = round(t.pnl); out.roi = n ? round(t.pnl / n) : null; }
    else out.said = n ? round(t.said / n) : null;
    return out;
  };
  return {
    flipx2: { ...fin(F.all), days, value: fin(F.value), near: fin(F.near), legacySkipped: legacy },
    htd: { ...fin(H.all, false), days: hdays, priced: fin(H.priced, false), model: fin(H.model, false) }
  };
}
const parse = x => { if (typeof x !== 'string') return x || null; try { return JSON.parse(x); } catch { return null; } };
