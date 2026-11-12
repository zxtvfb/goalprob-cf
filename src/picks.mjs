/* ════════════════════════════════════════════════════════════════
   picks — write down what the strategies selected, then grade it.

   A win rate is only honest if the selection was recorded BEFORE
   kick-off and never touched afterwards. So:

     record   for matches that have not started, store each selection as
              it stood. A stored selection is never changed or removed.
              New ones may be ADDED on later runs, until kick-off.
                Flip x2  1xBet's price, the fair probability, the value
                HTD      the forecast half-time draw probability, from
                         the list the algos job saved (algo/<date>)
     settle   once a match has finished, mark each selection won or lost
                Flip x2  on the ninety-minute score
                HTD      on the half-time score
              A selection whose result never arrives is voided after
              three days rather than left open for ever.

   The selection rules are ST.flip() and ST.htd() in model.mjs — the
   same functions the app calls, so the ledger cannot be graded by
   different rules from the ones on screen.

   Zero API calls. A handful of Firestore requests a run.

   /jobs/picks            record today and tomorrow, settle what finished
   /jobs/picks?reset=1    clear the running totals (stored days are kept)
   ════════════════════════════════════════════════════════════════ */
import { ST } from './model.mjs';
import { unpack, unpackObj, pack, iso, shift, ok, bad } from './lib.mjs';

const FINISHED = new Set(['FT', 'AET', 'PEN']);
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

/* the two strategies the ledger keeps, and how each is graded */
export const BOOKS = {
  flipx2: { grade: (s, f) => grade(s.k, f.gh, f.ga),   score: f => ({ gh: f.gh, ga: f.ga }) },
  htd:    { grade: (s, f) => grade('HTD', f.hth, f.hta), score: f => ({ gh: f.hth, ga: f.hta, ft: [f.gh, f.ga] }) }
};
const settledOf = s => s.won === true || s.won === false || s.void === 1;

const rowsOf = snap => { const out = []; snap.forEach(d => out.push(...unpack(d.data().f))); return out; };

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

    /* every ledger day, both odds days and both saved lists in three requests */
    const [pickSnaps, oddsSnaps, algoSnaps] = await Promise.all([
      D.getAll(...allDates.map(d => D.doc(`picks/${d}`))),
      D.getAll(...recDates.map(d => D.doc(`odds/${d}`))),
      D.getAll(...recDates.map(d => D.doc(`algo/${d}`)))
    ]);
    const ledger = {};
    allDates.forEach((d, i) => { ledger[d] = pickSnaps[i] && pickSnaps[i].exists ? pickSnaps[i].data() : null; });

    const fixturesCache = {};
    const fixturesOf = async date => {
      if (!fixturesCache[date])
        fixturesCache[date] = rowsOf(await D.collection('fixtures').where('date', '==', date).get());
      return fixturesCache[date];
    };

    const patch = {};                     // date -> fields to write
    const put = (date, fields) => { patch[date] = { ...(patch[date] || {}), ...fields }; };
    const recorded = [], settled = [];
    const at = Math.round(Date.now() / 60000);

    /* ---- record ---- */
    for (let i = 0; i < recDates.length; i++) {
      const date = recDates[i];
      const rec = { date };

      /* Flip x2, from the prices */
      const odds = oddsSnaps[i] && oddsSnaps[i].exists ? unpackObj(oddsSnaps[i].data().o) : {};
      const have = ledger[date] ? unpack(ledger[date].flipx2) : [];
      if (!Object.keys(odds).length) rec.flipx2 = 'no prices stored';
      else if (have.length >= ST.FLIP.keep) rec.flipx2 = 'full for this day';
      else {
        const rows = await fixturesOf(date);
        /* provisional rows (built from the bookmakers' card before the
           fixture feed reaches the day) are never recorded: their ids
           are not the feed's, so they could not be graded */
        const items = rows
          .filter(f => !f.prov && f.k && odds[f.k] && !FINISHED.has(f.st) && (!f.ts || f.ts > nowSec))
          .map(f => ({ f, od: odds[f.k] }));
        const taken = new Set(have.map(s => s.fid + '|' + s.k));
        const add = [];
        for (const c of ST.flip(items)) {
          if (have.length + add.length >= ST.FLIP.keep) break;
          const id = c.f.id + '|' + c.leg.k;
          if (taken.has(id)) continue;
          taken.add(id);
          add.push({
            fid: c.f.id, k: c.leg.k, label: c.leg.label, tier: c.tier,
            price: round(c.leg.price), fair: round(c.leg.fair), ev: round(c.ev),
            src: c.leg.src, best: round(c.leg.best),
            home: c.f.hname, away: c.f.aname, lname: c.f.lname || '', ts: c.f.ts || null, at
          });
        }
        if (add.length) {
          const sel = have.concat(add);
          put(date, { flipx2: pack(sel), n: sel.length });
          ledger[date] = { ...(ledger[date] || {}), flipx2: pack(sel) };
        }
        rec.flipx2 = { added: add.length, total: have.length + add.length, considered: items.length,
                       ...(add.length ? {} : { blockers: ST.flipBlockers(items) }) };
      }

      /* HTD, from the list the algos job saved */
      const algo = algoSnaps[i] && algoSnaps[i].exists ? algoSnaps[i].data() : null;
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
          if (f.prov || taken.has(String(f.id)) || !(f.ts > nowSec)) continue;
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
      if (patch[date] && !ledger[date].recordedAt) put(date, { recordedAt: new Date().toISOString() });
      recorded.push(rec);
    }

    /* ---- settle ---- */
    for (const date of setDates) {
      const doc = ledger[date];
      if (!doc || doc.settledAt) continue;
      const lastChance = date === setDates[0];
      let byId = null, newly = 0, open = 0;
      const out = {};
      for (const key of Object.keys(BOOKS)) {
        const sel = unpack(doc[key]);
        if (!sel.length) continue;
        if (!byId) { byId = {}; for (const f of await fixturesOf(date)) byId[f.id] = f; }
        out[key] = sel.map(s => {
          if (settledOf(s)) return s;
          const f = byId[s.fid];
          const won = f && FINISHED.has(f.st) ? BOOKS[key].grade(s, f) : null;
          if (won === null) {
            if (lastChance) { newly++; return { ...s, void: 1 }; }
            open++; return s;
          }
          newly++;
          return { ...s, won, ...BOOKS[key].score(f) };
        });
      }
      if (!newly) continue;
      const fields = { settledAt: open === 0 ? new Date().toISOString() : null };
      for (const key of Object.keys(out)) fields[key] = pack(out[key]);
      if (out.flipx2) {
        const done = out.flipx2.filter(s => s.won === true || s.won === false);
        fields.won = done.filter(s => s.won).length;
        fields.lost = done.filter(s => !s.won).length;
        fields.pnl = round(done.reduce((a, s) => a + (s.won ? s.price - 1 : -1), 0));
      }
      put(date, fields);
      settled.push({ date, graded: newly, stillOpen: open });
    }

    /* ---- running totals ----
       Rebuilt from the stored days whenever something changed, so a day
       that settles late corrects the totals rather than double counting.
       Skipped otherwise: on most hourly runs nothing has moved. */
    const dates = Object.keys(patch);
    let totals = null;
    if (dates.length || url.searchParams.get('rollup')) {
      if (dates.length) {
        const batch = D.batch();
        for (const d of dates) batch.set(D.doc(`picks/${d}`), { date: d, ...patch[d] }, { merge: true });
        await batch.commit();
      }
      totals = await rollup(D);
      await metaRef.set({
        totals: JSON.stringify(totals.flipx2), htd: JSON.stringify(totals.htd), u: Date.now(),
        lastRun: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      }, { merge: true });
    }

    return ok({ today: iso(), recorded, settled, totals: totals || 'unchanged', ms: Date.now() - started });
  } catch (e) {
    console.error('picks failed:', e);
    return bad(e.message);
  }
}

/* The running record over the last six months of stored days: Flip x2
   overall and for its two tiers, HTD overall and split by whether the
   forecast was backed by a price. */
export async function rollup(D) {
  const snap = await D.collection('picks').where('date', '>=', shift(-180)).limit(200).get();
  const mk = () => ({ won: 0, lost: 0, pnl: 0, open: 0, void: 0 });
  const all = mk(), value = mk(), near = mk();
  const h = { ...mk(), said: 0 }, hp = mk(), hm = mk();
  let days = 0, hdays = 0, legacy = 0;
  snap.forEach(d => {
    const v = d.data() || {};
    const sel = unpack(v.flipx2);
    if (sel.length) days++;
    for (const s of sel) {
      /* Days recorded before 11 Nov 2026 were chosen by the old rule and
         priced at the best odds across every book, which nobody could
         actually take. They stay stored but are not part of this record. */
      if (!s.tier) { legacy++; continue; }
      for (const t of [all, s.tier === 'value' ? value : near]) {
        if (s.won === true)       { t.won++;  t.pnl += s.price - 1; }
        else if (s.won === false) { t.lost++; t.pnl -= 1; }
        else if (s.void)          t.void++;
        else t.open++;
      }
    }
    const hs = unpack(v.htd);
    if (hs.length) hdays++;
    for (const s of hs) {
      for (const t of [h, s.priced ? hp : hm]) {
        if (s.won === true)       t.won++;
        else if (s.won === false) t.lost++;
        else if (s.void)          t.void++;
        else t.open++;
      }
      if (s.won === true || s.won === false) h.said += s.p || 0;
    }
  });
  const fin = t => {
    const n = t.won + t.lost;
    return { ...t, pnl: round(t.pnl), settled: n,
             winRate: n ? round(t.won / n) : null, roi: n ? round(t.pnl / n) : null };
  };
  const H = fin(h);
  H.said = H.settled ? round(h.said / H.settled) : null;
  delete H.pnl; delete H.roi;
  return {
    flipx2: { ...fin(all), days, value: fin(value), near: fin(near), legacySkipped: legacy },
    htd: { ...H, days: hdays, priced: fin(hp), model: fin(hm) }
  };
}
