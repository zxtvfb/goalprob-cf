/* ════════════════════════════════════════════════════════════════
   algos — run Flip x2 and HTD on the server and save what they pick.

   The app used to work these out on the phone, and only when Run was
   pressed. Now the Worker does it by itself, for today, tomorrow and
   the day after, and saves the lists in algo/<date>. The app shows them
   the moment the tab opens; the picks job writes them into the ledger
   before kick-off, so the win rate counts exactly what was shown.

   A pass is split over many short runs, because the free plan gives a
   run 10 ms of CPU:

     prov     tomorrow and the day after, when the fixture feed has not
              released them yet: a provisional list built from the
              bookmakers' card for the twelve priced leagues
     fx       one run per date: that day's fixtures and prices, Flip x2
              (it needs prices only, so it is saved straight away), and
              the matches split into work slices of a few leagues each
     slice    one run per slice: those leagues' bundles, a forecast for
              every match, the half-time draws that clear the bar
     final    the slices gathered and ranked; HTD saved
     mend     any league with matches coming up but no stats bundle gets
              one built, two a run, so the next pass and the app have it

   Runs every two minutes from cron; a new pass starts ninety minutes
   after the last one started. /jobs/algos?force=1 starts one now.
   ════════════════════════════════════════════════════════════════ */
import { PM, ST } from './model.mjs';
import { unpack, unpackObj, pack, shift, isFinished, isWomens, rebuildLeagues, FV, ok, bad } from './lib.mjs';
import { teamIndex } from './history.mjs';
import { canonical, resolve } from './names.mjs';

const EVERY_MIN = 90;            // a new pass this long after the last one started
const STUCK_MIN = 30;            // a pass untouched this long is abandoned
const LEAGUES_PER_SLICE = 6;
const MATCHES_PER_SLICE = 10;    // a priced forecast costs ~0.2 ms warm; ten fit the 10 ms allowance cold
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT']);

/* The Odds API's leagues, as API-Football numbers and names them. */
export const SPORT_LEAGUE = {
  soccer_epl:                    { lid: 39,  lname: 'Premier League',        ctry: 'England' },
  soccer_spain_la_liga:          { lid: 140, lname: 'La Liga',               ctry: 'Spain' },
  soccer_germany_bundesliga:     { lid: 78,  lname: 'Bundesliga',            ctry: 'Germany' },
  soccer_italy_serie_a:          { lid: 135, lname: 'Serie A',               ctry: 'Italy' },
  soccer_france_ligue_one:       { lid: 61,  lname: 'Ligue 1',               ctry: 'France' },
  soccer_netherlands_eredivisie: { lid: 88,  lname: 'Eredivisie',            ctry: 'Netherlands' },
  soccer_portugal_primeira_liga: { lid: 94,  lname: 'Primeira Liga',         ctry: 'Portugal' },
  soccer_belgium_first_div:      { lid: 144, lname: 'Jupiler Pro League',    ctry: 'Belgium' },
  soccer_england_efl_cham:       { lid: 40,  lname: 'Championship',          ctry: 'England' },
  soccer_uefa_champs_league:     { lid: 2,   lname: 'UEFA Champions League', ctry: 'World' },
  soccer_uefa_europa_league:     { lid: 3,   lname: 'UEFA Europa League',    ctry: 'World' },
  soccer_turkey_super_league:    { lid: 203, lname: 'Süper Lig',             ctry: 'Turkey' }
};

const r4 = v => Math.round(v * 1e4) / 1e4;
const parse = x => { if (typeof x !== 'string') return x || null; try { return JSON.parse(x); } catch { return null; } };

/* what the app needs to show a match and open its sheet */
const slim = (f, date) => ({
  id: f.id, date, ts: f.ts || null, k: f.k || null, st: f.st || 'NS',
  lid: f.lid, lname: f.lname || '', ctry: f.ctry || '',
  hid: f.hid, hname: f.hname, hlogo: f.hlogo || '', aid: f.aid, aname: f.aname, alogo: f.alogo || '',
  ...(f.prov ? { prov: 1 } : {})
});

export default async function algos(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/algos');
    const meta = (await metaRef.get()).data() || {};
    let P = parse(meta.pass);
    const now = Date.now();
    const force = url.searchParams.get('force') === '1';

    const due = !P
      || (P.step === 'done' && (force || now - P.startedAt >= EVERY_MIN * 60000))
      || (P.step !== 'done' && now - (P.touched || 0) >= STUCK_MIN * 60000);

    if (due) {
      /* the previous pass's scratch documents go first */
      const old = P && Array.isArray(P.slices) ? P.slices : [];
      if (old.length) {
        const b = D.batch();
        for (const id of old.slice(0, 450)) b.delete(D.doc(`algowork/${id}`));
        await b.commit();
      }
      P = { id: now.toString(36), startedAt: now, step: 'prov',
            dates: [shift(0), shift(1), shift(2)], di: 0, slices: [], si: 0 };
    }

    if (P.step === 'done') {
      return ok({ idle: true, done: true, lastPass: new Date(P.startedAt).toISOString(),
                  nextPassAfter: new Date(P.startedAt + EVERY_MIN * 60000).toISOString() });
    }

    let did;
    if (P.step === 'prov') {
      did = [];
      for (const d of [P.dates[1], P.dates[2]]) did.push(await provisional(D, d));
      P.step = 'fx'; P.di = 0;
    } else if (P.step === 'fx') {
      did = await fixturesStep(D, P, now);
      if (++P.di >= P.dates.length) { P.step = P.slices.length ? 'slice' : 'final'; P.si = 0; }
    } else if (P.step === 'slice') {
      /* The cursor moves on BEFORE the work. If a run is ever cut off
         for using too much CPU, the pass skips that one slice instead of
         retrying it for ever. */
      const id = P.slices[P.si];
      if (++P.si >= P.slices.length) P.step = 'final';
      P.touched = now;
      await metaRef.set({ pass: JSON.stringify(P), u: now }, { merge: true });
      did = await sliceStep(D, id);
      return ok({ pass: P.id, step: P.step, did, done: false,
                  progress: `${P.si}/${P.slices.length} slices`, ms: Date.now() - started });
    } else if (P.step === 'final') {
      did = await finalStep(D, P, now);
      P.step = P.mend && P.mend.length ? 'mend' : 'done'; P.doneAt = now;
    } else if (P.step === 'mend') {
      const lids = P.mend.splice(0, 2);
      did = { bundlesBuilt: await rebuildLeagues(D, lids, 60, {}), leagues: lids };
      if (!P.mend.length) P.step = 'done';
    }

    P.touched = now;
    await metaRef.set({ pass: JSON.stringify(P), u: now }, { merge: true });
    return ok({ pass: P.id, step: P.step, did, done: P.step === 'done',
                progress: P.step === 'slice' ? `${P.si}/${P.slices.length} slices` : undefined,
                ms: Date.now() - started });
  } catch (e) {
    console.error('algos failed:', e);
    return bad(e.message);
  }
}

/* ---- prov ----
   The fixture feed reaches tomorrow at most; Mauritius is four hours
   ahead of the feed's clock, so after midnight there "tomorrow" is the
   feed's day after tomorrow and the list would be empty until 04:00.
   The bookmakers' card already has those matches for the twelve priced
   leagues, so a provisional list is built from it. The real list
   replaces it the moment the feed releases the day. */
async function provisional(D, date) {
  const [chunk, od] = await D.getAll(D.doc(`fixtures/${date}__0`), D.doc(`odds/${date}`));
  if (chunk.exists && !chunk.data().prov) return { date, provisional: 'not needed — the fixture feed has this day' };
  if (!od.exists) return { date, provisional: 'no prices stored for this day yet' };
  const stamp = String(od.data().u || od.data().n || '');
  if (chunk.exists && chunk.data().from === stamp) return { date, provisional: 'up to date' };

  const prices = unpackObj(od.data().o);
  const idx = await teamIndex(D);
  const byLeague = new Map();
  const leagueIndex = lid => {
    if (!byLeague.has(lid)) {
      const m = new Map();
      for (const [k, t] of idx.map) if (t && Number(t.lid) === lid) m.set(k, t);
      byLeague.set(lid, m);
    }
    return byLeague.get(lid);
  };
  const find = (name, L) => {
    /* European nights mix leagues, so only an exact name is trusted */
    if (L.lid === 2 || L.lid === 3) return idx.map.get(canonical(name)) || null;
    const hit = resolve(name, leagueIndex(L.lid));
    return hit ? hit.team : null;
  };

  const rows = [];
  let unmatched = 0;
  for (const [k, p] of Object.entries(prices)) {
    const L = SPORT_LEAGUE[p.sk];
    const ts = Math.floor(Date.parse(p.ts) / 1000);
    if (!L || !ts) continue;
    const H = find(p.hn, L), A = find(p.an, L);
    if (!H || !A || String(H.id) === String(A.id)) { unmatched++; continue; }
    const id = v => (/^\d+$/.test(String(v)) ? Number(v) : v);
    rows.push({ k, id: 'p' + k, ts, st: 'NS', lid: L.lid, lname: L.lname, ctry: L.ctry, flag: '',
                hid: id(H.id), hname: H.name, hlogo: '', aid: id(A.id), aname: A.name, alogo: '',
                gh: null, ga: null, hth: null, hta: null, prov: 1 });
  }
  rows.sort((a, b) => a.ts - b.ts);
  await D.doc(`fixtures/${date}__0`).set({
    date, part: 0, f: pack(rows), fin: 0, pend: false, done: 0, prov: true, from: stamp,
    u: FV.serverTimestamp()
  });
  return { date, provisional: rows.length + ' matches from the bookmakers\' card', unmatched };
}

/* ---- fx ---- */
async function fixturesStep(D, P, now) {
  const date = P.dates[P.di];
  const [snap, odds] = await Promise.all([
    D.collection('fixtures').where('date', '==', date).get(),
    D.getAll(D.doc(`odds/${date}`))
  ]);
  const rows = [];
  snap.forEach(d => rows.push(...unpack(d.data().f)));
  const prices = odds[0] && odds[0].exists ? unpackObj(odds[0].data().o) : {};
  const nowSec = now / 1000;
  const open = rows.filter(f => f.hid && f.aid && !isFinished(f.st) && !LIVE.has(f.st) &&
                                (!f.ts || f.ts > nowSec) && !isWomens(f.lname, f.hname, f.aname));

  /* Flip x2 needs nothing but prices, so its list is saved now */
  const items = open.filter(f => f.k && prices[f.k]).map(f => ({ f, od: prices[f.k] }));
  const flips = ST.flip(items).map(x => ({ f: slim(x.f, date), leg: x.leg, ev: r4(x.ev), tier: x.tier }));

  /* work slices: whole leagues where they fit, at most a few leagues
     and ten matches each (a big cup round is split) */
  const byL = new Map();
  for (const f of open) { if (!byL.has(f.lid)) byL.set(f.lid, []); byL.get(f.lid).push(f); }
  const slices = [];
  let cur = null;
  for (const [lid, list] of byL) for (const f of list) {
    if (!cur || cur.fx.length >= MATCHES_PER_SLICE || (!cur.lids.includes(lid) && cur.lids.length >= LEAGUES_PER_SLICE)) {
      cur = { lids: [], fx: [] }; slices.push(cur);
    }
    if (!cur.lids.includes(lid)) cur.lids.push(lid);
    cur.fx.push({ ...slim(f, date), mk: f.k && prices[f.k] ? ST.market(prices[f.k]) : null });
  }
  const batch = D.batch();
  slices.forEach((sl, i) => {
    const id = `${P.id}_${date}_${i}`;
    batch.set(D.doc(`algowork/${id}`), { pass: P.id, date, lids: sl.lids, fx: pack(sl.fx) });
    P.slices.push(id);
  });
  batch.set(D.doc(`algo/${date}`), {
    date, flipx2: pack(flips), flipAt: now, considered: items.length,
    prov: rows.some(f => f.prov) ? 1 : 0
  }, { merge: true });
  await batch.commit();
  return { date, fixtures: rows.length, open: open.length, priced: items.length, flipx2: flips.length,
           slices: slices.length };
}

/* ---- slice ---- */
async function sliceStep(D, id) {
  const ref = D.doc(`algowork/${id}`);
  const w = (await ref.get()).data();
  if (!w || !w.fx) return { slice: id, skipped: 'already done or missing' };
  const fx = unpack(w.fx);
  const lids = w.lids || [];
  const [model, ...bundles] = await D.getAll(D.doc('meta/model'), ...lids.map(l => D.doc(`cache/league_${l}`)));
  const mv = model.exists ? model.data() : {};
  const cal = parse(mv.cal), gavg = parse(mv.avg);
  const B = new Map();
  bundles.forEach((b, i) => { if (b.exists) B.set(String(lids[i]), { avg: b.data().avg, teams: unpackObj(b.data().teams) }); });

  const items = [];
  const miss = lids.filter((l, i) => !(bundles[i] && bundles[i].exists));
  let noStats = 0;
  for (const f of fx) {
    const b = B.get(String(f.lid));
    const H = b && b.teams[f.hid], A = b && b.teams[f.aid];
    if (!H || !A || !(H.n >= ST.MIN_MATCHES) || !(A.n >= ST.MIN_MATCHES)) { noStats++; continue; }
    const avg = b.avg && b.avg.h > 0 ? b.avg : gavg;
    const raw = PM.run(H, A, avg, cal);
    const { mk, ...f0 } = f;
    items.push({ f: f0, r: mk ? PM.blend(raw, mk, undefined, cal) : raw });
  }
  const sel = ST.htd(items, cal).map(x => ({
    f: x.f, prob: r4(x.prob), fair: r4(x.fair), lift: r4(x.lift), goals: r4(x.goals),
    priced: x.priced ? 1 : 0, totals: x.totals ? 1 : 0
  }));
  /* the working copy of the fixtures is dropped once used, so the final
     step reads only the results */
  await ref.set({ out: pack(sel), n: items.length, fx: '', miss }, { merge: true });
  return { slice: id, forecast: items.length, noStats, selected: sel.length, noBundle: miss.length };
}

/* ---- final ---- */
async function finalStep(D, P, now) {
  const docs = P.slices.length ? await D.getAll(...P.slices.map(id => D.doc(`algowork/${id}`))) : [];
  const per = Object.fromEntries(P.dates.map(d => [d, []]));
  const miss = new Set();
  for (const d of docs) {
    if (!d.exists) continue;
    const v = d.data();
    if (per[v.date]) per[v.date].push(...unpack(v.out));
    for (const l of v.miss || []) miss.add(l);
  }
  P.mend = [...miss].slice(0, 30);
  const batch = D.batch();
  const counts = {};
  for (const date of P.dates) {
    const list = per[date].sort((a, b) => (b.prob - a.prob) || (b.priced - a.priced)).slice(0, ST.HTD.list);
    counts[date] = list.length;
    batch.set(D.doc(`algo/${date}`), { date, htd: pack(list), htdAt: now }, { merge: true });
  }
  /* saved lists older than a week are dropped */
  const stale = await D.collection('algo').where('date', '<', shift(-7)).limit(20).get();
  stale.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { htd: counts, leaguesWithoutBundle: P.mend.length };
}
