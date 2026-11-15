/* ════════════════════════════════════════════════════════════════
   algos — run Flip x2 and HTD on the server and save what they pick.

   The Worker does this by itself, for tomorrow, today and the day
   after, and saves the lists in algo/<date>. The app shows them the
   moment the tab opens; the picks job writes them into the ledger
   before kick-off, so the win rate counts exactly what was shown.

   A list is worked out again only when something it depends on has
   changed — the day's fixtures (pull bumps a version number), the
   bookmakers' prices (the odds file's time stamp) — or it is six hours
   old (team records move as results come in). Working everything out
   every ninety minutes, as before, kept the Worker over its CPU
   allowance all day long.

   A pass is split over short runs, because the free plan gives a run
   10 ms of CPU:

     plan     the day's open fixtures (pull's small fxo files) and
              prices; Flip x2 needs nothing else, so it is saved now;
              the matches are shared out into steps of a few leagues
     step     one run per step: those leagues' stats bundles, the
              half-time draw for every match with enough history
     final    the steps gathered and ranked; HTD saved
     mend     a league with matches coming up but no stats bundle gets
              one built, two a run

   Tomorrow and the day after tomorrow, before the fixture feed reaches
   them, get a provisional list built from the bookmakers' card for the
   priced leagues; the real list replaces it as soon as pull has it.

   /jobs/algos            one step (cron)
   /jobs/algos?force=1    work every list out again now
   ════════════════════════════════════════════════════════════════ */
import { PM, ST } from './model.mjs';
import { unpack, unpackObj, pack, shift, SPORT_LEAGUE, PRICED_LIDS, teamLogo, rebuildLeagues, FV, ok, bad } from './lib.mjs';
import { canonical, resolve, buildIndex } from './names.mjs';
export { SPORT_LEAGUE };

const REFRESH_H = 6;              // a list this old is worked out again anyway
const STUCK_MIN = 30;             // a pass untouched this long is abandoned
const LEAGUES_PER_STEP = 8;       // stats bundles one step reads
const UNITS_PER_STEP = 80;        // a match without prices costs 1, one with prices 16
const PRICED_UNITS = 16;        // the price blend is the expensive part of a forecast

const r4 = v => Math.round(v * 1e4) / 1e4;
const parse = x => { if (typeof x !== 'string') return x || null; try { return JSON.parse(x); } catch { return null; } };

/* an open-fixture tuple, as pull writes it -> what the app needs to
   show a match and open its sheet */
const slimOf = (t, date, prov) => ({
  id: t[0], date, ts: t[1] || null, k: t[5] || null, st: 'NS',
  lid: t[2], lname: t[8] || '', ctry: t[9] || '',
  hid: t[3], hname: t[6], hlogo: teamLogo(t[3]), aid: t[4], aname: t[7], alogo: teamLogo(t[4]),
  ...(prov ? { prov: 1 } : {})
});

export default async function algos(D, env, url) {
  const started = Date.now();
  try {
    const ref = D.doc('meta/algos');
    const A = (await ref.get()).data() || {};
    let P = parse(A.pass);
    const now = Date.now();
    const force = url.searchParams.get('force') === '1';
    const asMap = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    const done = { ...asMap(parse(A.done)) };
    /* a pass left by the previous version of this job is not resumable */
    if (P && !['idle', 'prov', 'plan', 'step', 'final', 'mend'].includes(P.step)) P = null;
    if (P && P.step === 'step' && !Array.isArray(P.steps)) P = null;
    /* ?force=1 works each date out again once; this remembers which have
       been redone in the last half hour, so a loop of presses ends */
    const forced = { ...asMap(parse(A.forced)) };
    /* leagues a stats bundle was attempted for lately: one with no team
       records yet would otherwise be retried on every pass */
    const mended = { ...asMap(parse(A.mended)) };
    for (const l of Object.keys(mended)) if (mended[l] < now - 864e5) delete mended[l];

    if (P && now - (P.touched || 0) > STUCK_MIN * 60000) P = null;

    if (!P || P.step === 'idle') {
      /* what needs working out? tomorrow first: that is what is bet on */
      const dates = [shift(1), shift(0), shift(2)];
      const [pullSnap, ...oddsSnaps] = await D.getAll(D.doc('meta/pull'), ...dates.map(d => D.doc(`odds/${d}`)), { mask: ['ver', 'np', 'u', 'n'] });
      const pm = pullSnap.exists ? pullSnap.data() : {};
      let pick = null;
      dates.forEach((d, i) => {
        if (pick) return;
        const od = oddsSnaps[i].exists ? oddsSnaps[i].data() : null;
        const ou = od ? String(od.u || od.n || '') : '';
        const ver = (pm.ver || {})[d] || 0, real = ((pm.np || {})[d] || 0) > 0;
        const prev = done[d];
        const today = i === 1;
        if (!real && !ou) return;                         // nothing to work with yet
        /* the morning sweep updates prices a league at a time for twenty
           minutes; the lists wait until it has settled */
        const settling = od && od.u && now - Date.parse(od.u) < 10 * 60000;
        const stale = !prev || (force && !(forced[d] > now - 30 * 60000)) ||
                      (prev.ou !== ou && !settling) || (prev.ver !== ver && (!today || !prev.open)) || (prev.prov && real) ||
                      now - prev.at > (today ? 2 * REFRESH_H : REFRESH_H) * 3600e3;
        if (stale) pick = { date: d, ver, ou, real };
      });
      if (!pick) {
        await ref.set({ pass: JSON.stringify({ step: 'idle', touched: now }) }, { merge: true });
        return ok({ idle: true, done: true, note: 'every saved list is up to date', lists: done, ms: Date.now() - started });
      }
      if (force) forced[pick.date] = now;
      P = { id: now.toString(36), date: pick.date, ver: pick.ver, ou: pick.ou, real: pick.real,
            step: pick.real ? 'plan' : 'prov', steps: [], si: 0, startedAt: now };
    }

    let did;
    if (P.step === 'prov') {
      did = await provisional(D, P.date);
      P.step = 'plan';
    } else if (P.step === 'plan') {
      did = await planStep(D, P, now);
      P.step = P.steps.length ? 'step' : 'final';
    } else if (P.step === 'step') {
      /* the cursor moves on BEFORE the work: a run cut off for CPU skips
         that one step instead of retrying it for ever */
      const id = P.steps[P.si];
      if (++P.si >= P.steps.length) P.step = 'final';
      P.touched = now;
      await ref.set({ pass: JSON.stringify(P) }, { merge: true });
      did = await workStep(D, id);
      return ok({ pass: P.id, date: P.date, step: 'step', did, done: false,
                  progress: `${P.si}/${P.steps.length} steps`, ms: Date.now() - started });
    } else if (P.step === 'final') {
      did = await finalStep(D, P, now, mended);
      done[P.date] = { at: now, ver: P.ver, ou: P.ou, n: did.htd, open: P.open || 0, prov: P.real ? 0 : 1 };
      for (const d of Object.keys(done)) if (d < shift(-2)) delete done[d];
      P.step = P.mend && P.mend.length ? 'mend' : 'idle';
    } else if (P.step === 'mend') {
      const lids = P.mend.splice(0, 2);
      for (const l of lids) mended[l] = now;
      did = { bundlesBuilt: await rebuildLeagues(D, lids, 60, {}), leagues: lids };
      if (!P.mend.length) P.step = 'idle';
    }

    P.touched = now;
    await ref.set({ pass: JSON.stringify(P), done: JSON.stringify(done), forced: JSON.stringify(forced),
                    mended: JSON.stringify(mended), u: now }, { merge: true });
    return ok({ pass: P.id, date: P.date, step: P.step, did, done: false,
                progress: P.step === 'step' ? `${P.si}/${P.steps.length} steps` : undefined,
                ms: Date.now() - started });
  } catch (e) {
    console.error('algos failed:', e);
    return bad(e.message);
  }
}

/* ---- plan ---- */
async function planStep(D, P, now) {
  const date = P.date;
  const [fxo, oddsArr] = await Promise.all([
    D.collection('fxo').where('date', '==', date).get(),
    D.getAll(D.doc(`odds/${date}`))
  ]);
  const prices = oddsArr[0] && oddsArr[0].exists ? unpackObj(oddsArr[0].data().o) : {};
  const nowSec = now / 1000 + 60;
  const seen = new Set(), open = [];
  let prov = false;
  /* the bookmakers'-card list counts only while the real one is missing */
  const real = fxo.docs.some(d => !d.id.endsWith('__p'));
  fxo.forEach(d => {
    const isProv = d.id.endsWith('__p');
    if (isProv && real) return;
    for (const t of unpack(d.data().o)) {
      if (!t || seen.has(t[0]) || !(t[1] > nowSec)) continue;
      seen.add(t[0]); open.push(t);
      if (isProv) prov = true;
    }
  });

  /* Flip x2 needs nothing but prices, so its list is saved now */
  const items = [];
  for (const t of open) if (t[5] && prices[t[5]]) items.push({ f: slimOf(t, date, prov), od: prices[t[5]] });
  const flips = ST.flip(items).map(x => ({ f: x.f, leg: x.leg, ev: r4(x.ev), tier: x.tier }));

  /* steps: whole leagues where they fit */
  const byL = new Map();
  for (const t of open) { if (!byL.has(t[2])) byL.set(t[2], []); byL.get(t[2]).push(t); }
  const steps = [];
  let cur = null;
  const unitsOf = t => (t[5] && prices[t[5]] ? PRICED_UNITS : 1);
  for (const [lid, list] of byL) for (const t of list) {
    const u = unitsOf(t);
    if (!cur || cur.units + u > UNITS_PER_STEP || (!cur.lids.includes(lid) && cur.lids.length >= LEAGUES_PER_STEP)) {
      cur = { lids: [], fx: [], units: 0 }; steps.push(cur);
    }
    if (!cur.lids.includes(lid)) cur.lids.push(lid);
    cur.units += u;
    const mk = t[5] && prices[t[5]] ? ST.market(prices[t[5]]) : null;
    cur.fx.push(mk ? [...t, mk] : t);
  }
  const batch = D.batch();
  steps.forEach((st, i) => {
    const id = `${P.id}_${i}`;
    batch.set(D.doc(`algowork/${id}`), { pass: P.id, date, prov: prov ? 1 : 0, lids: st.lids, fx: pack(st.fx), at: now });
    P.steps.push(id);
  });
  batch.set(D.doc(`algo/${date}`), { date, flipx2: pack(flips), flipAt: now, considered: items.length, prov: prov ? 1 : 0 }, { merge: true });
  await batch.commit();
  P.open = open.length;
  return { date, open: open.length, priced: items.length, flipx2: flips.length, steps: steps.length, provisional: prov };
}

/* ---- step ---- */
async function workStep(D, id) {
  const ref = D.doc(`algowork/${id}`);
  const w = (await ref.get()).data();
  if (!w || !w.fx) return { step: id, skipped: 'already done or missing' };
  const fx = unpack(w.fx);
  const lids = w.lids || [];
  const [model, ...bundles] = await D.getAll(D.doc('meta/model'), ...lids.map(l => D.doc(`cache/league_${l}`)),
                                             { mask: ['avg', 'cal', 'teams'] });
  const mv = model.exists ? model.data() : {};
  const cal = parse(mv.cal), gavg = parse(mv.avg);
  const B = new Map();
  bundles.forEach((b, i) => { if (b.exists) B.set(String(lids[i]), { avg: b.data().avg, teams: unpackObj(b.data().teams) }); });

  const items = [];
  const miss = lids.filter((l, i) => !(bundles[i] && bundles[i].exists));
  let noStats = 0;
  for (const t of fx) {
    const b = B.get(String(t[2]));
    const H = b && b.teams[t[3]], A = b && b.teams[t[4]];
    if (!H || !A || !(H.n >= ST.MIN_MATCHES) || !(A.n >= ST.MIN_MATCHES)) { noStats++; continue; }
    const avg = b.avg && b.avg.h > 0 ? b.avg : gavg;
    const mk = t[10] || null;
    /* priced: the full forecast, prices blended in, as the app shows it;
       otherwise only the half-time draw, which is the same number */
    const r = mk ? PM.blend(PM.run(H, A, avg, cal), mk, undefined, cal) : PM.h1dOnly(H, A, avg, cal);
    items.push({ f: slimOf(t, w.date, w.prov), r });
  }
  const sel = ST.htd(items, cal).map(x => ({
    f: x.f, prob: r4(x.prob), fair: r4(x.fair), lift: r4(x.lift), goals: r4(x.goals),
    priced: x.priced ? 1 : 0, totals: x.totals ? 1 : 0
  }));
  /* the working copy of the fixtures is dropped once used, so the final
     step reads only the results */
  await ref.set({ out: pack(sel), n: items.length, fx: '', miss }, { merge: true });
  return { step: id, forecast: items.length, noStats, selected: sel.length, noBundle: miss.length };
}

/* ---- final ---- */
async function finalStep(D, P, now, mended = {}) {
  const docs = P.steps.length ? await D.getAll(...P.steps.map(id => D.doc(`algowork/${id}`)), { mask: ['out', 'miss'] }) : [];
  const all = [];
  const miss = new Set();
  for (const d of docs) {
    if (!d.exists) continue;
    const v = d.data();
    all.push(...unpack(v.out));
    for (const l of v.miss || []) miss.add(l);
  }
  P.mend = [...miss].filter(l => !mended[l]).slice(0, 20);
  const list = all.sort((a, b) => (b.prob - a.prob) || (b.priced - a.priced)).slice(0, ST.HTD.list);
  const batch = D.batch();
  batch.set(D.doc(`algo/${P.date}`), { date: P.date, htd: pack(list), htdAt: now, prov: P.real ? 0 : 1 }, { merge: true });
  for (const id of P.steps) batch.delete(D.doc(`algowork/${id}`));
  /* saved lists older than a week are dropped */
  const stale = await D.collection('algo').where('date', '<', shift(-7)).select('date').limit(10).get();
  stale.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { htd: list.length, leaguesWithoutBundle: P.mend.length };
}

/* ---- prov ----
   The fixture feed reaches tomorrow at most; Mauritius is four hours
   ahead of the feed's clock, so after midnight there "tomorrow" is the
   feed's day after tomorrow. The bookmakers' card already has those
   matches for the priced leagues, so a provisional list is built from
   it: each side found among the teams stored for that league. The real
   list replaces it the moment the feed releases the day. European
   nights are left out — their clubs come from every league, and a
   wrong match would be worse than none. */
async function provisional(D, date) {
  const od = await D.doc(`odds/${date}`).get();
  if (!od.exists) return { date, provisional: 'no prices stored for this day yet' };
  const prices = unpackObj(od.data().o);
  const leagues = new Map();
  for (const [k, p] of Object.entries(prices)) {
    const L = SPORT_LEAGUE[p.sk];
    if (!L || L.lid === 2 || L.lid === 3) continue;
    if (!leagues.has(L.lid)) leagues.set(L.lid, { L, list: [] });
    leagues.get(L.lid).list.push([k, p]);
  }
  const snaps = await Promise.all([...leagues.keys()].map(lid =>
    D.collection('teams').where('lid', '==', lid).select('name').limit(80).get()));
  const rows = [], open = [];
  let unmatched = 0;
  [...leagues.values()].forEach(({ L, list }, i) => {
    const index = buildIndex(snaps[i].docs.map(d => ({ id: d.id, name: d.data().name })));
    for (const [k, p] of list) {
      const ts = Math.floor(Date.parse(p.ts) / 1000);
      if (!ts) continue;
      const H = resolve(p.hn, index), A2 = resolve(p.an, index);
      if (!H || !A2 || H.team.id === A2.team.id) { unmatched++; continue; }
      const id = v => (/^\d+$/.test(String(v)) ? Number(v) : v);
      const hid = id(H.team.id), aid = id(A2.team.id);
      rows.push({ k, id: 'p' + k, ts, st: 'NS', lid: L.lid, lname: L.lname, ctry: L.ctry, flag: '',
                  hid, hname: H.team.name, aid, aname: A2.team.name, gh: null, ga: null, hth: null, hta: null, prov: 1 });
      open.push(['p' + k, ts, L.lid, hid, aid, k, H.team.name, A2.team.name, L.lname, L.ctry]);
    }
  });
  rows.sort((a, b) => a.ts - b.ts);
  const batch = D.batch();
  batch.set(D.doc(`fixtures/${date}__p`), { date, part: 'p', f: pack(rows), n: rows.length, fin: 0, res: '{}', pend: false, prov: true, u: FV.serverTimestamp() });
  batch.set(D.doc(`fxo/${date}__p`), { date, k: 'p', o: pack(open), n: open.length, at: Date.now() });
  await batch.commit();
  return { date, provisional: rows.length + ' matches from the bookmakers\' card', unmatched };
}
