/* ════════════════════════════════════════════════════════════════
   picks — record what each algorithm selected, then grade it.

   A win rate is only honest if the selection was written down BEFORE
   kick-off and never touched afterwards. So this runs in two phases:

     record   for upcoming matches, store the selection as it stood.
              A date is recorded once; a later run never rewrites a
              selection, because a strategy that can revise its picks
              after the fact has no measurable record.

     settle   for matches that have finished, compare the stored
              selection against the result and mark it won or lost.

   Flip x2 needs a bookmaker price, so only fixtures carrying one are
   scored — a few dozen a day rather than a few hundred, which keeps the
   whole job inside a Worker's CPU allowance.

   Zero API calls: fixtures, odds and team stats are all already stored.

   /jobs/picks            record today and tomorrow, settle what finished
   /jobs/picks?reset=1    wipe the ledger and start again
   ════════════════════════════════════════════════════════════════ */
import { PM } from './model.mjs';
import { unpack, unpackObj, pack, iso, shift, ok, bad } from './lib.mjs';

/* How many selections to record per algorithm per day. A strategy judged
   on its single best pick is judged on noise; ten is enough to see a
   trend without storing the whole card. */
const KEEP = 10;

/* Flip x2's conditions, held here so the record cannot drift from a
   change made only in the browser. */
const FLIP = { target: 2.00, band: 0.35, minProb: 0.50 };
const MIN_MATCHES = 4;

/* ---------- selection ---------- */

function legsFor(r, od) {
  if (!od || !(od.fh > 0)) return [];
  const legs = [
    { k: '1',   label: 'Home',       model: r.hw, fair: od.fh, price: od.bh },
    { k: 'X',   label: 'Draw',       model: r.dr, fair: od.fd, price: od.bd },
    { k: '2',   label: 'Away',       model: r.aw, fair: od.fa, price: od.ba }
  ];
  if (od.ou && od.ou.bo > 1 && od.ou.bu > 1) {
    legs.push({ k: 'O25', label: 'Over 2.5',  model: r.o25,     fair: od.ou.fo, price: od.ou.bo });
    legs.push({ k: 'U25', label: 'Under 2.5', model: 1 - r.o25, fair: od.ou.fu, price: od.ou.bu });
  }
  return legs;
}

function flipx2(scored) {
  const out = [];
  for (const { f, r, od } of scored) {
    for (const leg of legsFor(r, od)) {
      if (!(leg.price > 1)) continue;
      if (Math.abs(leg.price - FLIP.target) > FLIP.band) continue;
      if (leg.model < FLIP.minProb) continue;
      out.push({
        fid: f.id, k: leg.k, label: leg.label,
        price: round(leg.price), p: round(leg.model),
        home: f.hname, away: f.aname, lname: f.lname || '',
        ts: f.ts || null, dist: Math.abs(leg.price - FLIP.target)
      });
    }
  }
  out.sort((a, b) => b.p - a.p || a.dist - b.dist);
  return out.slice(0, KEEP).map(({ dist, ...keep }) => keep);
}

const round = n => Math.round(n * 1e4) / 1e4;

/* ---------- grading ---------- */

/* Returns true (won), false (lost), or null when the result cannot be
   read — a void, a postponement, or a score that never arrived. A null
   is dropped from the record rather than counted as a loss. */
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

const FINISHED = new Set(['FT', 'AET', 'PEN']);

export default async function picks(D, env, url) {
  const started = Date.now();
  try {
    if (url.searchParams.get('reset')) {
      await D.doc('meta/picks').set({ totals: null, settledDates: null }, { merge: true });
      return ok({ reset: true, note: 'running totals cleared; stored days left alone' });
    }

    const today = iso();
    const recorded = [], settled = [];

    /* ---- phase 1: record upcoming days that have no ledger yet ---- */
    for (const off of [0, 1]) {
      const date = shift(off);
      const ref  = D.doc(`picks/${date}`);
      const prev = (await ref.get()).data();
      if (prev && prev.flipx2) { recorded.push({ date, skipped: 'already recorded' }); continue; }

      const scored = await scoreDay(D, date, true);
      if (!scored.length) { recorded.push({ date, skipped: 'nothing priced yet' }); continue; }

      const sel = flipx2(scored);
      await ref.set({
        date, recordedAt: new Date().toISOString(),
        flipx2: pack(sel), n: sel.length, settledAt: null
      }, { merge: true });
      recorded.push({ date, selections: sel.length, considered: scored.length });
    }

    /* ---- phase 2: settle days that have finished ---- */
    for (const off of [-1, -2, -3, 0]) {
      const date = shift(off);
      const ref  = D.doc(`picks/${date}`);
      const doc  = (await ref.get()).data();
      if (!doc || !doc.flipx2) continue;
      if (doc.settledAt) continue;

      const sel = unpack(doc.flipx2);
      if (!sel.length) { await ref.set({ settledAt: new Date().toISOString() }, { merge: true }); continue; }

      const results = await resultsFor(D, date);
      let open = 0;
      const graded = sel.map(s => {
        if (s.won !== undefined && s.won !== null) return s;
        const res = results[s.fid];
        if (!res || !res.done) { open++; return s; }
        const won = grade(s.k, res.gh, res.ga);
        return won === null ? s : { ...s, won, gh: res.gh, ga: res.ga };
      });

      const done = graded.filter(s => s.won === true || s.won === false);
      await ref.set({
        flipx2: pack(graded),
        settledAt: open === 0 ? new Date().toISOString() : null,
        won:  done.filter(s => s.won).length,
        lost: done.filter(s => !s.won).length,
        pnl:  round(done.reduce((a, s) => a + (s.won ? s.price - 1 : -1), 0))
      }, { merge: true });

      settled.push({ date, graded: done.length, stillOpen: open });
    }

    /* ---- running totals, rebuilt from the stored days ---- */
    const totals = await rollup(D);
    await D.doc('meta/picks').set({
      totals: JSON.stringify(totals), u: Date.now(),
      lastRun: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    }, { merge: true });

    return ok({ today, recorded, settled, totals, ms: Date.now() - started });
  } catch (e) {
    console.error('picks failed:', e);
    return bad(e.message);
  }
}

/* Score every fixture on a date that carries a bookmaker price. */
async function scoreDay(D, date, upcomingOnly) {
  const snap = await D.collection('fixtures').where('date', '==', date).get();
  const rows = [];
  snap.forEach(d => rows.push(...unpack(d.data().f)));
  if (!rows.length) return [];

  const oddsDoc = (await D.doc(`odds/${date}`).get()).data();
  const odds = oddsDoc ? unpackObj(oddsDoc.o) : {};
  if (!Object.keys(odds).length) return [];

  const wanted = rows.filter(f => f.k && odds[f.k] &&
    (!upcomingOnly || !FINISHED.has(f.st)));
  if (!wanted.length) return [];

  /* one bundle read per league, not two team reads per fixture */
  const lids = [...new Set(wanted.map(f => f.lid).filter(Boolean))];
  const bundles = {};
  for (const lid of lids) {
    const b = (await D.doc(`cache/league_${lid}`).get()).data();
    if (b) bundles[lid] = { teams: unpackObj(b.teams), avg: b.avg || null };
  }

  const out = [];
  for (const f of wanted) {
    const bundle = bundles[f.lid];
    if (!bundle) continue;
    const H = bundle.teams[f.hid], A = bundle.teams[f.aid];
    if (!H || !A || H.n < MIN_MATCHES || A.n < MIN_MATCHES) continue;
    out.push({ f, r: PM.run(H, A, bundle.avg), od: odds[f.k] });
  }
  return out;
}

/* Final scores for a date, keyed by fixture id. */
async function resultsFor(D, date) {
  const snap = await D.collection('fixtures').where('date', '==', date).get();
  const map = {};
  snap.forEach(d => {
    for (const f of unpack(d.data().f)) {
      map[f.id] = {
        done: FINISHED.has(f.st),
        gh: Number.isFinite(f.gh) ? f.gh : null,
        ga: Number.isFinite(f.ga) ? f.ga : null
      };
    }
  });
  return map;
}

/* Rebuild the running record from the stored days, so a re-settled day
   corrects the totals instead of double counting. */
async function rollup(D) {
  const snap = await D.collection('picks').orderBy('__name__').limit(60).get();
  let won = 0, lost = 0, pnl = 0, days = 0, open = 0;
  snap.forEach(d => {
    const v = d.data() || {};
    const sel = unpack(v.flipx2);
    if (!sel.length) return;
    days++;
    for (const s of sel) {
      if (s.won === true)       { won++;  pnl += s.price - 1; }
      else if (s.won === false) { lost++; pnl -= 1; }
      else open++;
    }
  });
  const settledCount = won + lost;
  return {
    won, lost, open, days,
    settled: settledCount,
    winRate: settledCount ? round(won / settledCount) : null,
    pnl: round(pnl),
    roi: settledCount ? round(pnl / settledCount) : null
  };
}
