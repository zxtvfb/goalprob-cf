/* ════════════════════════════════════════════════════════════════
   backtest — replay real seasons through the engine and measure it.

   Nothing here knows about the page or the network: it takes seasons of
   results (as /jobs/rows hands them over) and returns numbers. That is
   deliberate — the same file runs under test against simulated seasons
   whose true probabilities are known, which is the only way to check
   that a "correction" actually corrects.

   replay()   walks every match in date order. Before each one it builds
              exactly what the app would have had that morning — each
              side's last 45 matches, the league's averages, the ratings
              from the season's closing prices so far — and asks the
              engine for its forecast. Then it adds the result to the
              record and moves on. No match ever sees its own result.

   fit()      compares those forecasts with what happened, fits a
              correction per market on the earlier 70% of matches, and
              keeps it only if it also improves the later 30% it never
              saw.

   A forecast is recorded four ways for every match, because the app
   makes four kinds and each needs its own correction:
     m    goals + shots on target
     g    goals alone (what a league without shot data gets)
     r    ratings from closing prices
     mi   the markets rebuilt from a bookmaker's 1X2 and over/under
     m1   the same, from a 1X2 price alone (most days, most leagues)
   ════════════════════════════════════════════════════════════════ */
import { PM } from './model.mjs';

export const MARKETS = ['hw', 'dr', 'aw', 'h1w', 'h1d', 'h1a', 'btts', 'o15', 'o25', 'o35'];
const IDX = Object.fromEntries(MARKETS.map((k, i) => [k, i]));
const LABEL = { hw: 'Home win', dr: 'Draw', aw: 'Away win', h1w: 'Half-time home', h1d: 'Half-time draw',
                h1a: 'Half-time away', btts: 'Both score', o15: 'Over 1.5', o25: 'Over 2.5', o35: 'Over 3.5' };
export const labelOf = k => LABEL[k] || k;

/* which markets a table corrects, and how they group for judging */
const GROUPS = [
  { id: 'ft',   name: 'Full-time result', keys: ['hw', 'dr', 'aw'], triple: true },
  { id: 'ht',   name: 'Half-time result', keys: ['h1w', 'h1d', 'h1a'], triple: true },
  { id: 'btts', name: 'Both teams score', keys: ['btts'] },
  { id: 'o15',  name: 'Over 1.5',         keys: ['o15'] },
  { id: 'o25',  name: 'Over 2.5',         keys: ['o25'] },
  { id: 'o35',  name: 'Over 3.5',         keys: ['o35'] }
];
/* With an over/under price the market gives 1X2 and over 2.5 directly,
   so only what is REBUILT from the prices needs a correction. */
const TABLE_GROUPS = { m: null, g: null, r: null, mi: ['ht', 'btts', 'o15', 'o35'], m1: ['ht', 'btts', 'o15', 'o25', 'o35'] };
export const TABLES = ['m', 'g', 'r', 'mi', 'm1'];
export const TABLE_NAME = {
  m: 'Goals and shots on target', g: 'Goals only', r: 'Ratings from closing prices',
  mi: 'Rebuilt from 1X2 and over/under prices', m1: 'Rebuilt from 1X2 prices alone'
};

const dayNo = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const isoOf = day => new Date(day * 864e5).toISOString().slice(0, 10);
const tick = () => new Promise(r => setTimeout(r, 0));
const EPS = 1e-6;
const ln = p => Math.log(Math.min(Math.max(p, EPS), 1 - EPS));

/* the engine's numbers for one fixture, as a compact vector */
const vec = o => Float32Array.from(MARKETS, k => o[k]);
const unvec = (v, rated, cov) => {
  const o = { rated: rated || 0, cov: cov == null ? 1 : cov };
  for (let i = 0; i < MARKETS.length; i++) o[MARKETS[i]] = v[i];
  return o;
};

/* A stat block with the shot data taken out: exactly what profile()
   would have produced for the same matches in a league that reports
   none, because the goal rates never depended on the shots. */
const NO_SHOTS = { hsn: 0, asn: 0, hstf: 0, hsta: 0, astf: 0, asta: 0, sot: 0, sotA: 0, hshf: 0, hsha: 0, ashf: 0, asha: 0 };
const goalsOnly = S => ({ ...S, ...NO_SHOTS });

/* loss of a forecast against what happened: lower is better.
   For a three-way market it is -log of the probability given to the
   outcome that occurred; for a yes/no market the usual log loss. */
const lossTriple = (v, y, i) => y[i] < 0 ? NaN
  : -ln(y[i] ? v[i] : y[i + 1] ? v[i + 1] : v[i + 2]);
const lossBinary = (v, y, i) => y[i] < 0 ? NaN : -(y[i] ? ln(v[i]) : ln(1 - v[i]));

class Diff {                       // running mean and standard error of paired differences
  constructor() { this.n = 0; this.s = 0; this.q = 0; }
  add(d) { if (Number.isFinite(d)) { this.n++; this.s += d; this.q += d * d; } }
  get mean() { return this.n ? this.s / this.n : 0; }
  get se() { return this.n > 1 ? Math.sqrt(Math.max(this.q / this.n - this.mean ** 2, 0) / this.n) : Infinity; }
  /* clearly better means better by more than two standard errors */
  get better() { return this.n >= 500 && this.mean < -2 * this.se; }
  toJSON() { return { n: this.n, mean: this.mean, se: this.se, better: this.better }; }
}

/* ════════════════════════════════════════════════════════════════
   replay
   `files`  [{ league, season, rows: [[date, home, away, gh, ga, hh, ha,
              hs, as, hst, ast, [h,d,a]|null, [o,u]|null], ...] }]
   `opt`    { settings: { shotMix, h1Blend, wr }, probe, minPrior, onProgress }
   ════════════════════════════════════════════════════════════════ */
export async function replay(files, opt = {}) {
  const set = { shotMix: PM.SHOT_MIX, h1Blend: PM.H1_BLEND, wr: PM.W_RATING, ...(opt.settings || {}) };
  const minPrior = opt.minPrior ?? 15;
  const WINDOW = 45;

  /* ---- every match, oldest first ---- */
  const all = [], leagues = new Map();
  for (const f of files || []) {
    if (!f || !Array.isArray(f.rows)) continue;
    const sk = f.league + '|' + f.season;
    let st = leagues.get(sk);
    if (!st) leagues.set(sk, st = { lg: f.league, teams: new Set(), ms: [], avgDay: -1, avg: null, fitDay: -1, fit: null, asOf: '' });
    for (const r of f.rows) {
      const [date, home, away, gh, ga, hh, ha, hs, as, hst, ast, x, t] = r;
      if (!date || !home || !away || !(gh >= 0) || !(ga >= 0)) continue;
      st.teams.add(home); st.teams.add(away);
      all.push({ st, day: dayNo(date), home, away, gh, ga, hh, ha, hs, as, hst, ast, x, t });
    }
  }
  all.sort((a, b) => a.day - b.day);

  const win = new Map(), blk = new Map();
  const cases = [];
  const base = { n: 0, n1: 0, h: 0, d: 0, a: 0, h1h: 0, h1d: 0, h1a: 0, btts: 0, o15: 0, o25: 0, o35: 0 };
  const probe = opt.probe ? {
    shotMix: { 0.25: new Diff() },
    h1Blend: { 0.25: new Diff(), 0.75: new Diff(), 1: new Diff() },
    wr: { 0.7: new Diff(), 1: new Diff() }
  } : null;
  let rated = 0, priced = 0;

  const avgFor = (st, day) => {
    if (st.avgDay !== day) {
      const blocks = [];
      for (const t of st.teams) { const b = blk.get(t); if (b && b.n) blocks.push(b); }
      const a = blocks.length >= 4 ? PM.avgOf(PM.tally(blocks)) : null;
      st.avg = a && a.h > 0 && a.a > 0 ? a : null;
      st.avgDay = day;
    }
    return st.avg;
  };
  /* the ratings as the results import would have stored them that
     morning: fitted on this season's matches up to the day before */
  const ratingsFor = (st, day) => {
    if (st.fitDay !== day) {
      st.fitDay = day; st.fit = null;
      let last = -Infinity;
      const pool = [];
      for (const m of st.ms) if (m.day < day) { pool.push(m); if (m.day > last) last = m.day; }
      if (pool.length >= PM.RATING_MIN_MATCHES) {
        const from = last - PM.RATING_WINDOW;
        const recent = pool.filter(m => m.day >= from);
        if (recent.length >= PM.RATING_MIN_MATCHES) { st.fit = PM.ratings(recent, last); st.asOf = isoOf(last); }
      }
    }
    return st.fit;
  };

  const total = all.length;
  for (let i = 0; i < total; i++) {
    const m = all[i], st = m.st;
    if (i % 400 === 0) { if (opt.onProgress) opt.onProgress(i / total); await tick(); }

    const htOK = m.hh != null && m.ha != null && m.hh <= m.gh && m.ha <= m.ga;
    const y = new Int8Array(MARKETS.length);
    y[0] = m.gh > m.ga ? 1 : 0; y[1] = m.gh === m.ga ? 1 : 0; y[2] = m.gh < m.ga ? 1 : 0;
    if (htOK) { y[3] = m.hh > m.ha ? 1 : 0; y[4] = m.hh === m.ha ? 1 : 0; y[5] = m.hh < m.ha ? 1 : 0; }
    else { y[3] = y[4] = y[5] = -1; }
    y[6] = m.gh > 0 && m.ga > 0 ? 1 : 0;
    y[7] = m.gh + m.ga > 1 ? 1 : 0; y[8] = m.gh + m.ga > 2 ? 1 : 0; y[9] = m.gh + m.ga > 3 ? 1 : 0;

    base.n++; base.h += y[0]; base.d += y[1]; base.a += y[2];
    base.btts += y[6]; base.o15 += y[7]; base.o25 += y[8]; base.o35 += y[9];
    if (htOK) { base.n1++; base.h1h += y[3]; base.h1d += y[4]; base.h1a += y[5]; }

    const H = blk.get(m.home), A = blk.get(m.away);
    if (H && A && H.n >= minPrior && A.n >= minPrior && H.hn > 0 && A.an > 0) {
      const avg = avgFor(st, m.day);
      const now = m.day * 864e5 + 432e5;
      const c = { day: m.day, lg: st.lg, y, m: null, g: null, r: null, mi: null, m1: null, mk: null, rw: 0 };
      if (opt.keep) c.key = isoOf(m.day) + '|' + m.home + '|' + m.away;

      const Lm = PM.lambdas(H, A, avg, { wr: 0, shotMix: set.shotMix, h1Blend: set.h1Blend });
      const Gm = PM.grid(Lm);
      c.m = vec(Gm); c.cov = Lm.cov;
      c.g = vec(PM.grid(PM.lambdas(goalsOnly(H), goalsOnly(A), avg, { wr: 0, h1Blend: set.h1Blend })));

      /* rated, when the season is far enough along */
      let best = Gm, HR = null, AR = null;
      const fit = ratingsFor(st, m.day);
      if (fit) {
        const rh = PM.ratingOf(fit, m.home, st.lg, st.asOf), ra = PM.ratingOf(fit, m.away, st.lg, st.asOf);
        if (rh && ra) {
          HR = { ...H, mr: rh }; AR = { ...A, mr: ra };
          const Lr = PM.lambdas(HR, AR, avg, { wr: set.wr, now, shotMix: set.shotMix, h1Blend: set.h1Blend });
          if (Lr.rated >= 0.5) { best = PM.grid(Lr); c.r = vec(best); c.rw = Lr.rated; rated++; }
        }
      }

      /* the closing price, and what blend() rebuilds from it */
      const p3 = m.x ? PM.devig(m.x) : null;
      if (p3) {
        const p2 = m.t ? PM.devig(m.t) : null;
        const mk = { fh: p3[0], fd: p3[1], fa: p3[2], sharp: true };
        if (p2) mk.fo = p2[0];
        c.mk = Float32Array.of(p3[0], p3[1], p3[2], p2 ? p2[0] : NaN);
        if (p2) c.mi = vec(PM.blend(PM.pickOf({ ...best }, null), mk, 1, null));
        c.m1 = vec(PM.blend(PM.pickOf({ ...best }, null), { fh: p3[0], fd: p3[1], fa: p3[2], sharp: true }, 1, null));
        priced++;
      }
      cases.push(c);

      if (probe) {
        const lossFT = v => lossTriple(v, y, 0) + lossBinary(v, y, 8);
        const baseM = lossFT(c.m);
        probe.shotMix[0.25].add(lossFT(vec(PM.grid(PM.lambdas(H, A, avg, { wr: 0, shotMix: 0.25, h1Blend: set.h1Blend })))) - baseM);
        if (htOK) {
          const baseH = lossTriple(c.m, y, 3);
          for (const hb of [0.25, 0.75, 1]) {
            if (hb === set.h1Blend) continue;
            probe.h1Blend[hb].add(lossTriple(vec(PM.grid(PM.lambdas(H, A, avg, { wr: 0, shotMix: set.shotMix, h1Blend: hb }))), y, 3) - baseH);
          }
        }
        if (c.r) {
          const baseR = lossFT(c.r);
          for (const w of [0.7, 1]) {
            if (w === set.wr) continue;
            const L = PM.lambdas(HR, AR, avg, { wr: w, now, shotMix: set.shotMix, h1Blend: set.h1Blend });
            probe.wr[w].add(lossFT(vec(PM.grid(L))) - baseR);
          }
        }
      }
    }

    /* ---- the result goes on the record, exactly as the import stores it ---- */
    const d = isoOf(m.day);
    const recH = { d, h: 1, gf: m.gh, ga: m.ga, hgf: htOK ? m.hh : null, hga: htOK ? m.ha : null,
                   sh: m.hs, st: m.hst, sha: m.as, sta: m.ast };
    const recA = { d, h: 0, gf: m.ga, ga: m.gh, hgf: htOK ? m.ha : null, hga: htOK ? m.hh : null,
                   sh: m.as, st: m.ast, sha: m.hs, sta: m.hst };
    for (const [team, rec] of [[m.home, recH], [m.away, recA]]) {
      let w = win.get(team);
      if (!w) win.set(team, w = []);
      w.unshift(rec);
      if (w.length > WINDOW) w.length = WINDOW;
      blk.set(team, PM.profile(w));
    }
    const L = m.x ? PM.lean(m.x, m.t) : null;
    if (L) st.ms.push({ h: m.home, a: m.away, u: L.u, v: L.v, day: m.day });
  }
  if (opt.onProgress) opt.onProgress(1);

  const rate = (k, n) => n > 0 ? base[k] / n : null;
  return {
    cases, settings: set,
    matches: total, rated, priced,
    from: total ? isoOf(all[0].day) : null, to: total ? isoOf(all[total - 1].day) : null,
    leagues: [...new Set([...leagues.values()].map(s => s.lg))].sort(),
    base: {
      h: rate('h', base.n), d: rate('d', base.n), a: rate('a', base.n),
      h1h: rate('h1h', base.n1), h1d: rate('h1d', base.n1), h1a: rate('h1a', base.n1),
      btts: rate('btts', base.n), o15: rate('o15', base.n), o25: rate('o25', base.n), o35: rate('o35', base.n)
    },
    probe: probe ? JSON.parse(JSON.stringify(probe)) : null
  };
}

/* The settings the probe says are clearly better than the defaults —
   "clearly" meaning by more than two standard errors on at least 500
   matches. Anything short of that keeps the default. */
export function choose(run) {
  const out = { ...run.settings }, why = [];
  const p = run.probe;
  if (!p) return { settings: out, why };
  /* the best clearly-better alternative among a setting's candidates */
  const best = table => {
    let hit = null;
    for (const k of Object.keys(table)) {
      const d = table[k];
      if (d.better && (!hit || d.mean < hit.d.mean)) hit = { k: +k, d };
    }
    return hit;
  };
  const tried = table => Object.keys(table).map(k => ({ value: +k, n: table[k].n, gain: -table[k].mean, se: table[k].se }));

  const sm = best(p.shotMix);
  if (sm) out.shotMix = sm.k;
  why.push({ key: 'shotMix', what: 'Counting total shots as well as shots on target',
             was: run.settings.shotMix, now: out.shotMix, changed: !!sm, tried: tried(p.shotMix) });

  const hb = best(p.h1Blend);
  if (hb) out.h1Blend = hb.k;
  why.push({ key: 'h1Blend', what: 'First-half goals: how much to lean on the full-match figure',
             was: run.settings.h1Blend, now: out.h1Blend, changed: !!hb, tried: tried(p.h1Blend) });

  const wr = best(p.wr);
  if (wr) out.wr = wr.k;
  why.push({ key: 'wr', what: 'Weight on the ratings from closing prices',
             was: run.settings.wr, now: out.wr, changed: !!wr, tried: tried(p.wr) });

  return { settings: out, why };
}

/* ════════════════════════════════════════════════════════════════
   fit
   ════════════════════════════════════════════════════════════════ */
const SHIFT_MAX = 1.0, SLOPE_MIN = 0.35, SLOPE_MAX = 1.6;      // what /jobs/calib accepts
const inBounds = l => Math.abs(l[0]) <= SHIFT_MAX && l[1] >= SLOPE_MIN && l[1] <= SLOPE_MAX;

function linesFor(cases, T, keys) {
  const out = {};
  for (const k of keys) {
    const i = IDX[k], ps = [], ys = [];
    for (const c of cases) { const v = c[T]; if (v && c.y[i] >= 0) { ps.push(v[i]); ys.push(c.y[i]); } }
    if (ps.length >= 300) out[k] = PM.fitLine(ps, ys);
  }
  return out;
}

/* a case's vector after the engine applies a table of lines */
const corrected = (v, lines) => PM.calibrate(unvec(v), { m: lines });

function groupLoss(o, y, g) {
  const i = IDX[g.keys[0]];
  const v = MARKETS.map(k => o[k]);
  return g.triple ? lossTriple(v, y, i) : lossBinary(v, y, i);
}

export function fit(run, opt = {}) {
  const cases = run.cases;
  const cut = Math.floor(cases.length * (opt.trainShare ?? 0.7));
  const train = cases.slice(0, cut), test = cases.slice(cut);
  const cal = { n: 0 }, report = { tables: {}, compare: null, htd: null, split: { train: train.length, test: test.length } };

  for (const T of TABLES) {
    const groups = GROUPS.filter(g => !TABLE_GROUPS[T] || TABLE_GROUPS[T].includes(g.id));
    const keys = groups.flatMap(g => g.keys);
    const nAll = cases.reduce((a, c) => a + (c[T] ? 1 : 0), 0);
    const trainLines = linesFor(train, T, keys);

    /* judged on matches the fit never saw */
    const rows = [];
    for (const g of groups) {
      if (!g.keys.every(k => trainLines[k])) { rows.push({ group: g.id, name: g.name, n: 0, kept: false, why: 'too few matches' }); continue; }
      const only = Object.fromEntries(g.keys.map(k => [k, trainLines[k]]));
      let b = 0, a = 0, n = 0;
      for (const c of test) {
        const v = c[T];
        if (!v) continue;
        const lb = groupLoss(unvec(v), c.y, g);
        if (!Number.isFinite(lb)) continue;
        b += lb; a += groupLoss(corrected(v, only), c.y, g); n++;
      }
      const before = n ? b / n : NaN, after = n ? a / n : NaN;
      const ok = n >= 300 && after < before && g.keys.every(k => inBounds(trainLines[k]));
      rows.push({ group: g.id, name: g.name, n, before, after, kept: ok,
                  why: n < 300 ? 'too few later matches to judge it'
                     : !g.keys.every(k => inBounds(trainLines[k])) ? 'the fitted line was implausibly steep or shifted'
                     : after < before ? '' : 'did not improve the later matches' });
    }

    /* the lines that go into use are refitted on everything */
    const keepKeys = rows.filter(r => r.kept).flatMap(r => GROUPS.find(g => g.id === r.group).keys);
    const finalLines = linesFor(cases, T, keepKeys);
    const table = {};
    for (const k of keepKeys) if (finalLines[k] && inBounds(finalLines[k])) table[k] = finalLines[k].map(x => +x.toFixed(4));
    for (const r of rows) {
      const g = GROUPS.find(x => x.id === r.group);
      r.lines = Object.fromEntries(g.keys.filter(k => table[k]).map(k => [k, table[k]]));
      if (r.kept && !g.keys.every(k => table[k])) { r.kept = false; r.why = 'the fitted line was implausibly steep or shifted'; for (const k of g.keys) delete table[k]; }
    }
    if (Object.keys(table).length) cal[T] = table;
    report.tables[T] = { name: TABLE_NAME[T], n: nAll, rows };
    if (T === 'm') cal.n = nAll;
  }

  /* ---- how the four kinds of forecast compare, on the same matches ---- */
  {
    const acc = { g: 0, m: 0, r: 0, mk: 0, n: 0 };
    for (const c of cases) {
      if (!c.r || !c.mk || !c.m || !c.g) continue;
      acc.n++;
      acc.g += lossTriple(c.g, c.y, 0); acc.m += lossTriple(c.m, c.y, 0);
      acc.r += lossTriple(c.r, c.y, 0); acc.mk += lossTriple(c.mk, c.y, 0);
    }
    if (acc.n) report.compare = { n: acc.n, g: acc.g / acc.n, m: acc.m / acc.n, r: acc.r / acc.n, mk: acc.mk / acc.n,
                                  chance: -(run.base.h * ln(run.base.h) + run.base.d * ln(run.base.d) + run.base.a * ln(run.base.a)) };
  }

  /* ---- the half-time draw, said against happened, on the later matches ---- */
  {
    const edges = [0, 0.36, 0.39, 0.42, 0.45, 0.48, 1.01];
    const bands = (T, lines) => {
      const out = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, said: 0, was: 0 }));
      for (const c of test) {
        const v = c[T];
        if (!v || c.y[4] < 0) continue;
        const p = lines ? corrected(v, lines).h1d : v[4];
        const b = out.find(x => p >= x.lo && p < x.hi);
        if (b) { b.n++; b.said += p; b.was += c.y[4]; }
      }
      return out.filter(b => b.n).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, said: b.said / b.n, was: b.was / b.n }));
    };
    report.htd = {};
    for (const T of ['mi', 'm1', 'r', 'm', 'g']) {
      if (!report.tables[T].n) continue;
      report.htd[T] = { before: bands(T, null), after: cal[T] ? bands(T, cal[T]) : null };
    }
  }

  /* ---- base rates, settings ---- */
  const base = {};
  for (const k of Object.keys(run.base)) if (run.base[k] > 0.02 && run.base[k] < 0.98) base[k] = +run.base[k].toFixed(4);
  if (Object.keys(base).length) cal.base = base;
  if (run.settings.shotMix !== PM.SHOT_MIX) cal.shotMix = run.settings.shotMix;
  if (run.settings.h1Blend !== PM.H1_BLEND) cal.h1Blend = run.settings.h1Blend;
  if (run.settings.wr !== PM.W_RATING) cal.wr = run.settings.wr;

  return { cal, report };
}

/* The whole thing: probe the settings, replay again if any changed, fit. */
export async function measure(files, opt = {}) {
  const on = (stage, f) => opt.onProgress && opt.onProgress(stage, f);
  let run = await replay(files, { probe: true, minPrior: opt.minPrior, onProgress: f => on('replay', f) });
  const pick = choose(run);
  const changed = Object.keys(pick.settings).some(k => pick.settings[k] !== run.settings[k]);
  if (changed) {
    const probe = run.probe;
    run = await replay(files, { settings: pick.settings, minPrior: opt.minPrior, onProgress: f => on('again', f) });
    run.probe = probe;
  }
  on('fit', 0);
  const out = fit(run, opt);
  return { run, why: pick.why, ...out };
}
