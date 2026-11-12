/* ════════════════════════════════════════════════════════════════
   model — the probability engine.

   This file exists twice and the two copies must be identical:
     public/model.mjs   served to the browser; index.html and
                        backtest.html import it
     src/model.mjs      bundled into the Worker
   Nothing else may compute a probability or a stat block. lib.mjs used
   to carry its own copy of profile(), which is how a change made here
   could silently never reach a stored prediction. A test compares the
   two files and fails if they differ.

   What it does, in order:
     profile()   a team's recent matches  -> a stat block
     ratings()   a league's closing prices -> a strength rating per team
     lambdas()   two stat blocks (+ ratings) -> expected goals
     grid()      expected goals           -> every probability
     calibrate() corrections measured on real results
     run()       the three above, i.e. the model's own opinion
     implied()   bookmaker prices         -> the expected goals they imply
     blend()     the forecast: mostly the market, a little of the model
   ════════════════════════════════════════════════════════════════ */
export const PM = {
  GRID: 9,          // scorelines 0..8

  /* Shrinkage strength, in pseudo-matches pulled toward the league mean.
     Measured against simulated seasons where the true probability of
     every result is known: with recency weighting in place the error
     against truth is lowest between 6 and 8 and nearly flat across that
     range, at every rate of strength drift tried. */
  K: 8,

  RHO: -0.045,      // Dixon-Coles low-score correction

  /* Blanket flattening: every probability pulled this fraction of the
     way from its base rate toward what the model computed. 1.0 is off.
     Off because, with recency weighting and K at 8, the error against
     truth is the same to two decimals with or without it. The
     correction that IS applied is calibrate()'s measured one. */
  FLATTEN: 1.0,

  /* Recency, as a half-life in matches: a result this many matches back
     counts half as much as the latest one. Team strength drifts, so an
     old match describes a different team. Against simulated seasons
     with drifting strength this cut the error against truth by about
     6%, and 15 was at or near the best value at every drift rate. */
  HALF_LIFE: 15,

  /* Bumped whenever profile() changes what a stat block means, so that
     stored blocks built by an older version can be recognised. */
  PROFILE_V: 3,

  // league priors of last resort (a league with no averages of its own)
  P:  { h: 1.46, a: 1.17, h1h: 0.64, h1a: 0.51 },

  /* ---- shots-based expected goals ----
     Goals are a tiny sample, so the rate is noisy. Shots on target run
     about four a match and settle roughly three times faster. CONV turns
     shots on target into expected goals; W_SHOTS is how far to trust
     them at full coverage. */
  CONV: 0.31,
  W_SHOTS: 0.75,

  /* Total shots are stored as well. SHOT_MIX is the share of the shot
     signal taken from them (converted to shots-on-target terms) instead
     of from shots on target alone. It is 0 here on purpose: whether
     this helps cannot be settled by a simulator, only by real results,
     so the backtest page measures it on the stored history and switches
     it on only if those results say so. */
  SHOT_MIX: 0,
  SOT_PER_SHOT: 0.34,

  /* First-half expected goals come from two estimates: one built from
     first-half goals alone, and the full-match figure scaled by the
     share of goals the league scores before the break. The second is
     far less noisy (it uses every goal), the first can see a side that
     genuinely starts fast or slow. This is the weight on the second. */
  H1_BLEND: 0.5,

  /* ---- ratings from closing prices ----
     The results files carry the odds every match closed at. Those odds
     imply how many goals the market expected from each side, and a fit
     across the league separates each team from the opponents it faced.
     That is a far cleaner measure of a team than its scorelines: against
     simulated seasons where the truth is known, forecasts built on it
     missed by about 5 points where goals and shots missed by 8.6.

       W_RATING       share of expected goals taken from the ratings when
                      both sides have one from the same league
       RATING_HL      half-life of a match inside the fit, in days. 30
                      was at or near the best whether teams were made to
                      change slowly or quickly
       RATING_WINDOW  days of matches the fit looks back over; anything
                      older carries under a fifth of the weight and only
                      slows the import down
       RATING_RIDGE   pull toward "average team", in matches' worth
       RATING_MIN     matches before a rating gets its full say
       RATING_FRESH   days a rating is trusted in full; past that it
       RATING_FADE    fades, halving every this many days (a summer
                      break must not be priced on May's ratings) */
  W_RATING: 0.9,
  RATING_HL: 30,
  RATING_WINDOW: 75,
  RATING_MIN_MATCHES: 10,     // priced matches a league needs before it is rated at all
  RATING_RIDGE: 0.3,
  RATING_MIN: 4,
  RATING_FRESH: 10,
  RATING_FADE: 45,

  /* A 1X2 price without an over/under price says who is likelier to
     win but only vaguely how many goals to expect (through the draw
     price). The goal total is then a mix of what the draw price implies
     and the model's own total, and this is the model's share. Measured
     against simulated seasons where the truth is known: 0.4 was best
     for a total built from goals and shots; one built from closing-price
     ratings is good enough for 0.6–0.7, which took the error on over
     2.5 from 6.6 to 5.9 points, both-score from 6.4 to 5.7 and the
     half-time draw from 2.7 to 2.5. */
  TOTAL_FROM_MODEL: { stats: 0.4, rated: 0.65 },

  /* How much of the forecast is the bookmaker's when a price exists.
     Measured against truth, the market's error was 1-3 points where the
     model's own was about 8.6, and the best weight ran from 0.90 for a
     thin, noisy market to 1.00 for a sharp one. The model earns a small
     share only when the price itself is unreliable. */
  MARKET_W_SHARP: 0.95,
  MARKET_W_SOFT:  0.85,

  /* Base rates: how often each thing happens across football generally.
     Used to show how far a pick sits above chance. Each group sums to
     one. A measured set from the stored history replaces these when the
     calibration carries one. */
  BASE: {
    h: 0.45, d: 0.26, a: 0.29,              // full time
    h1h: 0.34, h1d: 0.41, h1a: 0.25,        // half time
    btts: 0.52, o15: 0.75, o25: 0.53, o35: 0.33
  },
  baseOf(cal) { return (cal && cal.base) ? { ...this.BASE, ...cal.base } : this.BASE; },

  /* ════════════════ arithmetic ════════════════ */
  pois(k, l) {
    if (l <= 0) return k === 0 ? 1 : 0;
    let p = Math.exp(-l);
    for (let i = 1; i <= k; i++) p = p * l / i;
    return p;
  },
  tau(i, j, lh, la) {
    const r = this.RHO;
    if (i === 0 && j === 0) return 1 - lh * la * r;
    if (i === 0 && j === 1) return 1 + lh * r;
    if (i === 1 && j === 0) return 1 + la * r;
    if (i === 1 && j === 1) return 1 - r;
    return 1;
  },
  shrink(rate, prior, n) { return (rate * n + prior * this.K) / (n + this.K); },

  /* Blend a goals-based rate with a shots-derived one, then shrink.
     With no shot data this is exactly the goals-only behaviour. */
  effRate(goalRate, sotRate, n, sn, conv, prior) {
    let rate = goalRate;
    if (sn > 0 && sotRate > 0) {
      const cover = Math.min(sn / Math.max(n, 1), 1);
      const w = this.W_SHOTS * cover;
      rate = w * (sotRate * conv) + (1 - w) * goalRate;
    }
    return this.shrink(rate, prior, n);
  },

  /* 9x9 scoreline matrix from two expected-goal values */
  matrix(lh, la) {
    const G = this.GRID, m = [];
    const ph = [], pa = [];
    for (let k = 0; k < G; k++) { ph.push(this.pois(k, lh)); pa.push(this.pois(k, la)); }
    let tot = 0;
    for (let i = 0; i < G; i++) {
      m[i] = [];
      for (let j = 0; j < G; j++) {
        const v = ph[i] * pa[j] * this.tau(i, j, lh, la);
        m[i][j] = v; tot += v;
      }
    }
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) m[i][j] /= tot;
    return m;
  },

  /* ════════════════ expected goals ════════════════ */

  /* Does this stat block carry real first-half information?

     A match whose half-time score was never reported used to be stored
     as 0-0 at the break. A side whose whole record looks like that has
     no first-half goals at all — which the model read as "never scores
     or concedes before half time" and priced at a near-certain half-time
     draw. Blocks built since say how many matches had a real half-time
     score; older ones are judged by the giveaway: plenty of goals, none
     of them ever in a first half. */
  hasH1(S) {
    if (!S) return false;
    if (S.n1 != null) return S.n1 >= 3;
    const g1 = (S.h1gf || 0) + (S.h1ga || 0) + (S.a1gf || 0) + (S.a1ga || 0);
    return !(g1 === 0 && ((S.gf || 0) + (S.ga || 0)) >= 10);
  },

  lambdas(H, A, lg, opt) {
    const mix = (opt && opt.shotMix != null) ? opt.shotMix : this.SHOT_MIX;
    const hb  = (opt && opt.h1Blend != null) ? opt.h1Blend : this.H1_BLEND;

    const pH = (lg && lg.h > 0) ? lg.h : this.P.h;
    const pA = (lg && lg.a > 0) ? lg.a : this.P.a;

    /* Share of goals scored before the break. Taken from the league when
       it has one; clamped, because a league whose half-time scores are
       partly missing reports a share that is far too low. */
    const clampS = s => Math.min(Math.max(s, 0.36), 0.52);
    const s1h = clampS((lg && lg.h1h > 0 && lg.h > 0) ? lg.h1h / lg.h : this.P.h1h / this.P.h);
    const s1a = clampS((lg && lg.h1a > 0 && lg.a > 0) ? lg.h1a / lg.a : this.P.h1a / this.P.a);
    const p1H = pH * s1h, p1A = pA * s1a;

    const conv = (lg && lg.conv > 0) ? lg.conv : this.CONV;
    const sps  = (lg && lg.sps > 0) ? lg.sps : this.SOT_PER_SHOT;
    /* the shot signal, optionally part-built from total shots */
    const sig = (sot, shots) => (mix > 0 && shots > 0 && sot > 0)
      ? (1 - mix) * sot + mix * shots * sps : sot;

    // home side uses its HOME record, away side its AWAY record
    const hAtt = this.effRate(H.hgf, sig(H.hstf, H.hshf), H.hn, H.hsn, conv, pH) / pH;
    const hDef = this.effRate(H.hga, sig(H.hsta, H.hsha), H.hn, H.hsn, conv, pA) / pA;
    const aAtt = this.effRate(A.agf, sig(A.astf, A.ashf), A.an, A.asn, conv, pA) / pA;
    const aDef = this.effRate(A.aga, sig(A.asta, A.asha), A.an, A.asn, conv, pH) / pH;

    const cap = v => Math.min(Math.max(v, 0.05), 5.0);
    let lh = cap(hAtt * aDef * pH), la = cap(aAtt * hDef * pA);

    /* Ratings from closing prices, when both sides carry one from the
       same division — a rating is relative to its own league's average,
       so two from different divisions cannot be set against each other. */
    let rated = 0;
    const wr = (opt && opt.wr != null) ? opt.wr : this.W_RATING;
    const RH = H.mr, RA = A.mr;
    if (wr > 0 && RH && RA && RH.c && RH.c === RA.c) {
      const now = (opt && opt.now) || Date.now();
      const age = t => (now - Date.parse(t + 'T12:00:00Z')) / 864e5;
      const old = Math.max(age(RH.t), age(RA.t));
      const g = Number.isFinite(old) ? this.fromRatings(RH, RA, RH.t >= RA.t ? RH : RA, lh + la) : null;
      if (g && g.lh > 0 && g.la > 0) {
        const fresh = old <= this.RATING_FRESH ? 1
          : Math.pow(0.5, (old - this.RATING_FRESH) / this.RATING_FADE);
        const w = wr * Math.min(1, RH.n / this.RATING_MIN) * Math.min(1, RA.n / this.RATING_MIN) * fresh;
        if (w > 0) {
          lh = cap(w * g.lh + (1 - w) * lh); la = cap(w * g.la + (1 - w) * la);
          rated = w;
        }
      }
    }
    /* how much of this forecast had shots behind it — the corrections
       for a goals-only forecast are different ones */
    const cov = ((H.hn > 0 ? Math.min(H.hsn / H.hn, 1) : 0) + (A.an > 0 ? Math.min(A.asn / A.an, 1) : 0)) / 2;

    /* First half. The scaled full-match figure is always available; the
       estimate from first-half goals only when both sides actually have
       half-time scores on record. */
    let lh1 = lh * s1h, la1 = la * s1a;
    if (hb < 1 && this.hasH1(H) && this.hasH1(A)) {
      const hn1 = H.hn1 != null ? H.hn1 : H.hn, an1 = A.an1 != null ? A.an1 : A.an;
      if (hn1 > 0 && an1 > 0) {
        const h1Att = this.effRate(H.h1gf, sig(H.hstf, H.hshf), hn1, Math.min(H.hsn, hn1), conv * s1h, p1H) / p1H;
        const h1Def = this.effRate(H.h1ga, sig(H.hsta, H.hsha), hn1, Math.min(H.hsn, hn1), conv * s1a, p1A) / p1A;
        const a1Att = this.effRate(A.a1gf, sig(A.astf, A.ashf), an1, Math.min(A.asn, an1), conv * s1a, p1A) / p1A;
        const a1Def = this.effRate(A.a1ga, sig(A.asta, A.asha), an1, Math.min(A.asn, an1), conv * s1h, p1H) / p1H;
        lh1 = hb * lh1 + (1 - hb) * cap(h1Att * a1Def * p1H);
        la1 = hb * la1 + (1 - hb) * cap(a1Att * h1Def * p1A);
      }
    }
    /* a first half cannot be expected to out-score the whole match */
    lh1 = Math.min(lh1, lh * 0.8); la1 = Math.min(la1, la * 0.8);
    return { lh, la, lh1: cap(lh1), la1: cap(la1), rated, cov };
  },

  /* ════════════════ probabilities ════════════════ */

  /* Everything the app shows, from four expected-goal values. */
  grid(L) {
    const m  = this.matrix(L.lh,  L.la);
    const m1 = this.matrix(L.lh1, L.la1);
    const G = this.GRID;

    let hw=0, dr=0, aw=0, btts=0, o15=0, o25=0, o35=0, csH=0, csA=0;
    const scores = [];
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      const p = m[i][j];
      if (i > j) hw += p; else if (i === j) dr += p; else aw += p;
      if (i > 0 && j > 0) btts += p;
      if (i + j > 1) o15 += p;
      if (i + j > 2) o25 += p;
      if (i + j > 3) o35 += p;
      if (j === 0) csH += p;
      if (i === 0) csA += p;
      if (i < 5 && j < 5) scores.push({ s: i + '-' + j, p });
    }
    let h1w=0, h1d=0, h1a=0;
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      const p = m1[i][j];
      if (i > j) h1w += p; else if (i === j) h1d += p; else h1a += p;
    }
    scores.sort((x, y) => y.p - x.p);

    // P(team scores in both halves) — 2nd-half lambda = full minus 1st
    const sbh = (lf, l1) => (1 - this.pois(0, l1)) * (1 - this.pois(0, Math.max(lf - l1, 0.02)));

    return {
      hw, dr, aw, btts, o15, o25, o35, csH, csA,
      h1w, h1d, h1a,
      sbhH: sbh(L.lh, L.lh1), sbhA: sbh(L.la, L.la1),
      lh: L.lh, la: L.la, lh1: L.lh1, la1: L.la1,
      rated: L.rated || 0, cov: L.cov || 0,
      top: scores.slice(0, 6)
    };
  },

  /* One market's correction: a straight line in log-odds, fitted by the
     backtest page to how often the model's numbers actually came true. */
  platt(p, c) {
    if (!c) return p;
    const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
    const z = c[0] + c[1] * Math.log(q / (1 - q));
    return 1 / (1 + Math.exp(-z));
  },

  /* Apply the measured corrections to a grid() result, in place.

     A table maps a market to its fitted line. The lines come from real,
     settled matches — the one thing no simulator can supply — and
     correct what the goal model gets structurally wrong: draws it
     under-calls, a half-time market it over- or under-states, numbers
     that are too sure of themselves.

     There are three tables, because a forecast is only as sure as what
     it was built from, and one correction cannot fit all three:
       cal.r   both sides rated from closing prices
       cal.m   goals and shots on target
       cal.g   goals alone (most leagues outside the big ones)
     With no calibration stored this does nothing. */
  calibrate(o, cal) {
    const F = this.FLATTEN;
    if (F !== 1) {
      const B = this.BASE, fl = (p, b) => Math.min(Math.max(b + (p - b) * F, 0), 1);
      o.hw = fl(o.hw, B.h); o.dr = fl(o.dr, B.d); o.aw = fl(o.aw, B.a);
      o.h1w = fl(o.h1w, B.h1h); o.h1d = fl(o.h1d, B.h1d); o.h1a = fl(o.h1a, B.h1a);
      o.btts = fl(o.btts, B.btts);
      o.o15 = fl(o.o15, B.o15); o.o25 = fl(o.o25, B.o25); o.o35 = fl(o.o35, B.o35);
    }
    let t = null;
    if (cal) {
      if (o.rated >= 0.5 && cal.r) t = cal.r;
      else if (!(o.cov >= 0.5) && cal.g) t = cal.g;
      else t = cal.m;
    }
    if (t) {
      let a = this.platt(o.hw, t.hw), b = this.platt(o.dr, t.dr), c = this.platt(o.aw, t.aw);
      let s = a + b + c;
      if (s > 0) { o.hw = a / s; o.dr = b / s; o.aw = c / s; }
      a = this.platt(o.h1w, t.h1w); b = this.platt(o.h1d, t.h1d); c = this.platt(o.h1a, t.h1a);
      s = a + b + c;
      if (s > 0) { o.h1w = a / s; o.h1d = b / s; o.h1a = c / s; }
      o.btts = this.platt(o.btts, t.btts);
      o.o15 = this.platt(o.o15, t.o15);
      /* separately fitted lines could in principle cross; an over line
         can never be likelier than the one below it */
      o.o25 = Math.min(this.platt(o.o25, t.o25), o.o15);
      o.o35 = Math.min(this.platt(o.o35, t.o35), o.o25);
    }
    return o;
  },

  /* The headline pick: the likeliest outcome among the markets that are
     genuinely competitive. Over 1.5 and the like are left out — they sit
     near 75% in almost every match and would win the badge every time
     without saying anything. */
  pickOf(o, cal) {
    const B = this.baseOf(cal);
    const cands = [
      { k: '1',    label: 'Home win',       p: o.hw,       base: B.h },
      { k: 'X',    label: 'Draw',           p: o.dr,       base: B.d },
      { k: '2',    label: 'Away win',       p: o.aw,       base: B.a },
      { k: 'BTTS', label: 'Both score',     p: o.btts,     base: B.btts },
      { k: 'NB',   label: 'Not both score', p: 1 - o.btts, base: 1 - B.btts },
      { k: 'O25',  label: 'Over 2.5',       p: o.o25,      base: B.o25 },
      { k: 'U25',  label: 'Under 2.5',      p: 1 - o.o25,  base: 1 - B.o25 }
    ];
    cands.sort((x, y) => y.p - x.p);
    o.ranked = cands;
    o.pick = { ...cands[0], edge: cands[0].p - cands[0].base };
    return o;
  },

  /* The model's own opinion of a fixture — no prices involved. */
  run(H, A, lg, cal) {
    const o = this.calibrate(this.grid(this.lambdas(H, A, lg, cal)), cal);
    return this.pickOf(o, cal);
  },

  /* ════════════════ ratings from closing prices ════════════════ */

  /* Remove the bookmaker's margin from a set of decimal odds (power
     method: every probability raised to the same exponent until they
     sum to one, which takes more off the outsiders than off the
     favourite, as bookmakers do). Newton's method on the exponent — the
     function is convex and falling, so it cannot overshoot. */
  devig(odds) {
    const n = odds.length, lg = [];
    let over = 0;
    for (let i = 0; i < n; i++) {
      const o = +odds[i];
      if (!(o > 1)) return null;
      lg.push(-Math.log(o)); over += 1 / o;
    }
    let k = 1;
    if (over > 1) {
      for (let it = 0; it < 20; it++) {
        let f = -1, d = 0;
        for (let i = 0; i < n; i++) { const e = Math.exp(k * lg[i]); f += e; d += e * lg[i]; }
        const step = f / d;
        k -= step;
        if (Math.abs(step) < 1e-10) break;
      }
    }
    const out = lg.map(l => Math.exp(k * l));
    const tot = out.reduce((a, b) => a + b, 0);
    return out.map(p => p / tot);
  },

  /* Expected goals for each side from two numbers: how much likelier a
     home win is than an away win (`sup`, -1..1) and the chance of three
     or more goals (`fo`).

     Does the same job as implied() further down at a small fraction of
     the cost. Two facts make that possible. The low-score correction
     only moves probability between 0-0, 1-1, 1-0 and 0-1, so it changes
     neither the chance of three or more goals nor the gap between a
     home and an away win: total goals come straight from `fo`, and the
     split between the sides from `sup`, with no scoreline grid at all.

     With no over/under figure the total is taken as given (`seedTotal`)
     and only the split is solved — the draw price is too blunt an
     instrument to read total goals from by itself. */
  split(sup, fo, seedTotal) {
    if (!(sup > -1 && sup < 1)) return null;
    const hasTot = fo > 0 && fo < 1;
    let T = seedTotal > 0.5 && seedTotal < 7 ? seedTotal : 2.6;
    if (hasTot) {
      /* P(three or more goals) = 1 - e^-T (1 + T + T²/2). Newton's
         method, damped and fenced so an extreme price cannot throw it. */
      const want = Math.min(Math.max(fo, 0.02), 0.985);
      T = 2.6;
      for (let i = 0; i < 14; i++) {
        const e = Math.exp(-T);
        let step = (1 - e * (1 + T + T * T / 2) - want) / (e * T * T / 2);
        if (step > 0.8) step = 0.8; else if (step < -0.8) step = -0.8;
        T -= step;
        if (T < 0.4) T = 0.4; else if (T > 8) T = 8;
        if (step < 1e-6 && step > -1e-6) break;
      }
    }
    /* home-win minus away-win probability for a given split of T */
    const gap = D => {
      const lh = (T + D) / 2, la = (T - D) / 2;
      let ph = Math.exp(-lh), pa = Math.exp(-la), ch = 0, ca = 0, s = 0;
      for (let k = 0; k < 13; k++) {
        s += ph * ca - pa * ch;
        ch += ph; ca += pa;
        ph = ph * lh / (k + 1); pa = pa * la / (k + 1);
      }
      return s;
    };
    /* The gap rises smoothly with D, so a secant started from a decent
       guess lands in three or four evaluations. */
    const lim = T - 0.1;
    const fence = x => x > lim ? lim : x < -lim ? -lim : x;
    let x0 = 0, f0 = -sup;                       // gap(0) is exactly zero
    let x1 = fence(sup * 2.45 * Math.sqrt(T / 2.6)), f1 = gap(x1) - sup;
    for (let i = 0; i < 10 && (f1 > 2e-5 || f1 < -2e-5); i++) {
      const den = f1 - f0;
      if (!(den > 1e-12 || den < -1e-12)) break;
      const x2 = fence(x1 - f1 * (x1 - x0) / den);
      if (x2 === x1) break;
      x0 = x1; f0 = f1; x1 = x2; f1 = gap(x1) - sup;
    }
    return { lh: (T + x1) / 2, la: (T - x1) / 2, total: T, fromTotals: hasTot };
  },
  quick(fh, fd, fa, fo, seedTotal) {
    if (!(fh > 0 && fd > 0 && fa > 0)) return null;
    return this.split(fh - fa, fo, seedTotal);
  },

  /* Closing prices for one match -> the two figures a rating is fitted
     to. `x` is [home, draw, away] in decimal odds, `t` is [over, under]
     2.5 or null.

       u   how far the match leaned to the home side: atanh of the home-
           minus-away win probability. On this scale a goal of supremacy
           is worth much the same anywhere, so team effects add up.
       v   how many goals were expected: log-odds of over 2.5. NaN when
           the file has no over/under price for the match.

     The margin is taken off in proportion rather than by the power
     method. This runs inside the Worker's 10 ms budget for a whole
     league, and a rating averaged over a dozen matches cannot tell the
     two methods apart. */
  lean(x, t) {
    if (!x || !(x[0] > 1 && x[1] > 1 && x[2] > 1)) return null;
    const ih = 1 / x[0], id = 1 / x[1], ia = 1 / x[2], s = ih + id + ia;
    if (!(s > 0.9 && s < 1.3)) return null;               // not a real book
    let sup = (ih - ia) / s;
    if (sup > 0.97) sup = 0.97; else if (sup < -0.97) sup = -0.97;
    let v = NaN;
    if (t && t[0] > 1 && t[1] > 1) {
      const io = 1 / t[0], iu = 1 / t[1], s2 = io + iu;
      if (s2 > 0.9 && s2 < 1.3) {
        const fo = Math.min(Math.max(io / s2, 0.03), 0.97);
        v = Math.log(fo / (1 - fo));
      }
    }
    return { u: 0.5 * Math.log((1 + sup) / (1 - sup)), v };
  },

  /* Fit a rating for every team in a league from what the market
     expected of its matches.

     `ms` is [{ h, a, u, v, day }]: the two sides, the two figures from
     lean(), and the day number the match was played. Two small least-
     squares fits, each with one unknown per team:

         u  =  home advantage + quality(home) - quality(away)
         v  =  league level   + openness(home) + openness(away)

     which is the form bookmakers' own power ratings take. Fitting the
     whole league at once is what separates a team from the opponents it
     happened to face. Recent matches weigh more (RATING_HL), and every
     rating is pulled gently toward the average team so that a side with
     two matches cannot run away with one result.

     Solved exactly (Cholesky), not iterated, so the Worker and the
     backtest page cannot disagree about a rating.

     Returns { hf, lv, n, teams: { key: { q, o, n } } }: the home
     advantage, the league's goal level, and each team's quality and
     openness (how many goals its matches tend to have). */
  ratings(ms, now) {
    const idx = new Map(), keys = [];
    const id = k => { let i = idx.get(k); if (i === undefined) { i = keys.length; idx.set(k, i); keys.push(k); } return i; };
    const rows = [];
    for (const m of ms) {
      if (!m || !Number.isFinite(m.u) || !(m.day <= now)) continue;
      rows.push([id(m.h), id(m.a), m.u, m.v, Math.pow(0.5, (now - m.day) / this.RATING_HL)]);
    }
    const N = keys.length;
    if (!N || !rows.length) return null;
    const P = N + 1, RG = this.RATING_RIDGE;

    /* solve (A + ridge) x = b for one of the two fits; sign is -1 for
       the supremacy fit (home minus away) and +1 for the totals fit */
    const solve = (col, sign) => {
      const A = new Float64Array(P * P), b = new Float64Array(P);
      let any = 0;
      for (const r of rows) {
        const y = r[col], w = r[4];
        if (!Number.isFinite(y)) continue;
        any++;
        const h = r[0], v = r[1];
        A[h * P + h] += w; A[v * P + v] += w;
        A[h * P + v] += sign * w; A[v * P + h] += sign * w;
        A[h * P + N] += w; A[N * P + h] += w;
        A[v * P + N] += sign * w; A[N * P + v] += sign * w;
        A[N * P + N] += w;
        b[h] += w * y; b[v] += sign * w * y; b[N] += w * y;
      }
      if (!any) return null;
      for (let i = 0; i < N; i++) A[i * P + i] += RG;
      A[N * P + N] += 1e-9;
      /* Cholesky, in place (lower triangle) */
      for (let j = 0; j < P; j++) {
        let d = A[j * P + j];
        for (let k = 0; k < j; k++) d -= A[j * P + k] * A[j * P + k];
        if (!(d > 1e-12)) return null;
        d = Math.sqrt(d); A[j * P + j] = d;
        for (let i = j + 1; i < P; i++) {
          let s = A[i * P + j];
          for (let k = 0; k < j; k++) s -= A[i * P + k] * A[j * P + k];
          A[i * P + j] = s / d;
        }
      }
      for (let i = 0; i < P; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= A[i * P + k] * b[k];
        b[i] = s / A[i * P + i];
      }
      for (let i = P - 1; i >= 0; i--) {
        let s = b[i];
        for (let k = i + 1; k < P; k++) s -= A[k * P + i] * b[k];
        b[i] = s / A[i * P + i];
      }
      return b;
    };

    const Q = solve(2, -1);
    if (!Q) return null;
    const Tt = solve(3, 1);
    const cnt = new Int32Array(N);
    for (const r of rows) { cnt[r[0]]++; cnt[r[1]]++; }
    const teams = {};
    for (let i = 0; i < N; i++) teams[keys[i]] = { q: Q[i], o: Tt ? Tt[i] : 0, n: cnt[i] };
    return { hf: Q[N], lv: Tt ? Tt[N] : null, n: rows.length, teams };
  },

  /* One team's rating as it is stored beside its stat block (`mr`).
     `fit` is what ratings() returned, `code` the league it was fitted
     on, `asOf` the date of the newest match in the fit. Rounded here,
     once, so the Worker that stores it and the backtest that replays it
     work from identical numbers. */
  ratingOf(fit, key, code, asOf) {
    const t = fit && fit.teams[key];
    if (!t) return null;
    const r4 = v => Math.round(v * 1e4) / 1e4;
    const lv = (fit.lv !== null && Number.isFinite(fit.lv)) ? r4(fit.lv) : null;
    return { c: code, t: asOf, hf: r4(fit.hf), lv, q: r4(t.q), o: r4(t.o), n: t.n };
  },

  /* What a pair of ratings expects of a fixture: the home-minus-away
     win probability and the chance of over 2.5, then split() for the
     goals. `L` carries the league's home advantage and goal level.
     A league whose file has no over/under prices has no goal level; the
     ratings then say only who is the better side, and the number of
     goals is left to `seedTotal` (the figure from goals and shots). */
  fromRatings(RH, RA, L, seedTotal) {
    const sup = Math.tanh(L.hf + RH.q - RA.q);
    const z = (L.lv === null || L.lv === undefined) ? NaN : L.lv + RH.o + RA.o;
    const fo = Number.isFinite(z) ? 1 / (1 + Math.exp(-z)) : 0;
    return this.split(sup, fo, seedTotal);
  },

  /* ════════════════ league averages ════════════════ */

  /* Sums over a league's stat blocks, and the averages they give. One
     implementation, because the Worker stores these and the backtest
     has to reproduce exactly what the Worker would have stored. */
  tally(blocks, into) {
    const T = into || { hg:0, hn:0, ag:0, an:0, h1:0, hg1:0, a1:0, ag1:0, goal:0, sot:0, shot:0, sos:0 };
    for (const s of blocks) {
      if (!s || !s.n) continue;
      T.hg += s.hgf * s.hn; T.hn += s.hn;
      T.ag += s.agf * s.an; T.an += s.an;
      /* First-half averages come only from teams that really have
         half-time scores. Averaging in sides whose half-time data is
         missing dragged the league's first-half share toward zero. */
      if (this.hasH1(s)) {
        const hn1 = s.hn1 != null ? s.hn1 : s.hn, an1 = s.an1 != null ? s.an1 : s.an;
        T.h1 += s.h1gf * hn1; T.hg1 += s.hgf * hn1;
        T.a1 += s.a1gf * an1; T.ag1 += s.agf * an1;
      }
      const sn = (s.hsn || 0) + (s.asn || 0);
      if (sn > 0 && s.sot > 0) {
        T.sot  += s.sot * sn;
        T.goal += (s.hgf * s.hsn) + (s.agf * s.asn);
        const shots = (s.hshf || 0) * s.hsn + (s.ashf || 0) * s.asn;
        if (shots > 0) { T.shot += shots; T.sos += (s.hstf * s.hsn) + (s.astf * s.asn); }
      }
    }
    return T;
  },
  avgOf(T, minSot = 200, minShot = 400) {
    const r = (x, y) => y > 0 ? +(x / y).toFixed(4) : 0;
    const h = r(T.hg, T.hn), a = r(T.ag, T.an);
    return {
      h, a,
      /* stored as a rate so lambdas() can take the share as h1h / h */
      h1h: T.hg1 > 0 ? +(h * T.h1 / T.hg1).toFixed(4) : 0,
      h1a: T.ag1 > 0 ? +(a * T.a1 / T.ag1).toFixed(4) : 0,
      conv: T.sot > minSot ? r(T.goal, T.sot) : 0,
      sps:  T.shot > minShot ? r(T.sos, T.shot) : 0,
      n: T.hn
    };
  },

  /* ════════════════ fitting a correction ════════════════ */

  /* The straight line in log-odds that best maps what was forecast onto
     what happened: `ps` the forecast probabilities, `ys` 1 or 0. Plain
     logistic regression by Newton's method, pulled toward "no
     correction" by `prior` matches' worth so that a thin sample cannot
     produce a wild line. Returns [shift, slope]; [0, 1] changes nothing. */
  fitLine(ps, ys, prior = 25) {
    const n = Math.min(ps.length, ys.length);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const q = Math.min(Math.max(ps[i], 1e-4), 1 - 1e-4);
      x[i] = Math.log(q / (1 - q));
    }
    let a = 0, b = 1;
    const lam = prior * 0.2;                 // one match carries about p(1-p) of information
    for (let it = 0; it < 30; it++) {
      let g0 = lam * a, g1 = lam * (b - 1), h00 = lam, h01 = 0, h11 = lam;
      for (let i = 0; i < n; i++) {
        const p = 1 / (1 + Math.exp(-(a + b * x[i])));
        const e = p - ys[i], w = p * (1 - p);
        g0 += e; g1 += e * x[i];
        h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
      }
      const det = h00 * h11 - h01 * h01;
      if (!(det > 1e-12)) break;
      const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
      a -= da; b -= db;
      if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return [a, b];
  },

  /* ════════════════ the market ════════════════ */

  /* The two expected-goal values a set of devigged prices implies.

     A 1X2 price pins down how much better one side is than the other;
     an over/under price pins down how many goals are expected. Together
     they locate both sides' expected goals — which then yield markets
     no bookmaker in the feed quotes at all, the half-time result above
     everything. Without an over/under price the draw probability stands
     in for it (fewer goals, more draws), but that is a blunter
     instrument, so the model's own total is given a say.

     Solved by bisection on total goals and supremacy in turn; both are
     monotone, so it cannot wander off. */
  implied(fh, fd, fa, fo, seedTotal, seedW) {
    if (!(fh > 0 && fd > 0 && fa > 0)) return null;
    const G = this.GRID, R = this.RHO;
    /* The same four sums matrix() would give — home win, draw, away win,
       over 2.5 — without building the matrix. The low-score correction
       touches only four cells, so everything else is a product of two
       Poisson columns and comes out of running totals in one pass. This
       runs a few hundred times per priced match; done the long way it
       made the server's strategy run too slow for its CPU allowance. */
    const ph = new Float64Array(G), pa = new Float64Array(G);
    const at = (T, D) => {
      const lim = T - 0.1;
      const d = D > lim ? lim : D < -lim ? -lim : D;
      const lh = (T + d) / 2, la = (T - d) / 2;
      ph[0] = Math.exp(-lh); pa[0] = Math.exp(-la);
      for (let k = 1; k < G; k++) { ph[k] = ph[k - 1] * lh / k; pa[k] = pa[k - 1] * la / k; }
      let sh = 0, sa = 0, ch = 0, ca = 0, hw = 0, aw = 0, dr = 0;
      for (let k = 0; k < G; k++) {
        hw += ph[k] * ca; aw += pa[k] * ch; dr += ph[k] * pa[k];
        ch += ph[k]; ca += pa[k];
      }
      sh = ch; sa = ca;
      const a00 = -lh * la * R * ph[0] * pa[0], a01 = lh * R * ph[0] * pa[1],
            a10 = la * R * ph[1] * pa[0], a11 = -R * ph[1] * pa[1];
      const tot = sh * sa + a00 + a01 + a10 + a11;
      hw += a10; aw += a01; dr += a00 + a11;
      const low = ph[0] * pa[0] + ph[0] * pa[1] + ph[1] * pa[0] + ph[0] * pa[2] + ph[2] * pa[0] + ph[1] * pa[1]
                + a00 + a01 + a10 + a11;
      return { hw: hw / tot, dr: dr / tot, aw: aw / tot, o25: (tot - low) / tot };
    };
    const hasTot = fo > 0 && fo < 1;
    const sup = fh - fa;
    let T = seedTotal > 0.5 && seedTotal < 7 ? seedTotal : 2.6, D = 0;

    const solveD = () => {
      let lo = -(T - 0.1), hi = T - 0.1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2, p = at(T, mid);
        if (p.hw - p.aw < sup) lo = mid; else hi = mid;
      }
      D = (lo + hi) / 2;
    };
    const solveT = () => {
      let lo = 0.6, hi = 6.5;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2, p = at(mid, D);
        const needMore = hasTot ? p.o25 < fo : p.dr > fd;
        if (needMore) lo = mid; else hi = mid;
      }
      T = (lo + hi) / 2;
    };
    for (let it = 0; it < 4; it++) { solveD(); solveT(); }
    /* With no over/under price, total goals read from the draw price
       alone are noisy, so they are averaged with the model's own total.
       How far to trust the model's figure depends on what it was built
       from: see TOTAL_FROM_MODEL. */
    if (!hasTot && seedTotal > 0.5 && seedTotal < 7) {
      const sw = seedW >= 0 && seedW <= 1 ? seedW : this.TOTAL_FROM_MODEL.stats;
      T = (1 - sw) * T + sw * seedTotal;
    }
    solveD();

    const lim = T - 0.1, d = D > lim ? lim : D < -lim ? -lim : D;
    return { lh: (T + d) / 2, la: (T - d) / 2, total: T, fromTotals: hasTot };
  },

  /* The forecast for a priced fixture.

     `mk` is the devigged market: { fh, fd, fa, fo?, sharp? }.
     1X2 (and over 2.5, when quoted) lean directly on the price. Every
     other market is rebuilt from the expected goals the prices imply,
     with only the first-half share taken from the model, and leaned on
     to the same degree.

     run() stays free of prices so that the model's own number is still
     there to be compared with the market; this is what gets shown. */
  blend(r, mk, w, cal) {
    if (!mk || !(mk.fh > 0 && mk.fd > 0 && mk.fa > 0)) return r;
    if (!(w >= 0 && w <= 1)) w = mk.sharp ? this.MARKET_W_SHARP : this.MARKET_W_SOFT;
    const mix = (model, market) => market * w + model * (1 - w);
    const hasTot = mk.fo > 0 && mk.fo < 1;

    const out = { ...r, blended: true, w,
                  model: { hw: r.hw, dr: r.dr, aw: r.aw, o25: r.o25, btts: r.btts, h1d: r.h1d } };
    out.hw = mix(r.hw, mk.fh); out.dr = mix(r.dr, mk.fd); out.aw = mix(r.aw, mk.fa);
    let s = out.hw + out.dr + out.aw;
    if (s > 0) { out.hw /= s; out.dr /= s; out.aw /= s; }
    if (hasTot) out.o25 = mix(r.o25, mk.fo);

    /* a model total that came from closing-price ratings deserves more
       of a say than one from goals and shots */
    const fm = this.TOTAL_FROM_MODEL;
    const seedW = fm.stats + (fm.rated - fm.stats) * Math.min(1, (r.rated || 0) / this.W_RATING);
    const im = this.implied(mk.fh, mk.fd, mk.fa, hasTot ? mk.fo : 0, r.lh + r.la, seedW);
    if (im) {
      const cl = x => Math.min(Math.max(x, 0.30), 0.60);
      const g = this.grid({
        lh: im.lh, la: im.la,
        lh1: im.lh * cl(r.lh > 0 ? r.lh1 / r.lh : 0.44),
        la1: im.la * cl(r.la > 0 ? r.la1 / r.la : 0.44)
      });
      /* What the prices imply for the markets they do not quote has its
         own measured correction: the grid is a model of how goals fall,
         and real first halves end level more often than it allows. There
         are two, because goals read from an over/under price and goals
         guessed from the draw price are wrong in different ways. */
      const ct = cal ? (hasTot ? cal.mi : cal.m1) : null;
      if (ct) this.calibrate(g, { m: ct });
      for (const k of ['btts', 'o15', 'o35', 'csH', 'csA', 'h1w', 'h1d', 'h1a', 'sbhH', 'sbhA', 'lh', 'la', 'lh1', 'la1'])
        out[k] = mix(r[k], g[k]);
      if (!hasTot) out.o25 = mix(r.o25, g.o25);
      s = out.h1w + out.h1d + out.h1a;
      if (s > 0) { out.h1w /= s; out.h1d /= s; out.h1a /= s; }
      out.o25 = Math.min(out.o25, out.o15);
      out.o35 = Math.min(out.o35, out.o25);
      out.top = g.top;
      out.implied = { lh: im.lh, la: im.la, fromTotals: im.fromTotals };
    }
    return this.pickOf(out, cal);
  },

  /* ════════════════ stat block ════════════════ */

  /* A team's stat block from its match list. The only implementation:
     the Worker stores what this returns, the browser recomputes with it.

     Rates (goals and shots per game, home and away) are recency-
     weighted. The tallies (wins, clean sheets, both-scored and so on)
     are plain counts — they are shown to a person, and a weighted
     "7.3 wins in 20" would be nonsense. */
  profile(ms) {
    const s = {
      v: this.PROFILE_V,
      n:0, hn:0, an:0, gf:0, ga:0,
      hgf:0, hga:0, agf:0, aga:0,
      n1:0, hn1:0, an1:0,
      h1gf:0, h1ga:0, a1gf:0, a1ga:0,
      w:0, d:0, l:0, h1w:0, h1d:0, h1l:0,
      btts:0, cs:0, sbh:0, o25:0, fts:0,
      form:'',
      hsn:0, asn:0, hstf:0, hsta:0, astf:0, asta:0, sot:0, sotA:0,
      hshf:0, hsha:0, ashf:0, asha:0
    };
    const n = ms.length;
    if (!n) return s;

    /* Weighting runs on recency rank, so the direction of the list
       matters: handed oldest-first, the same code would quietly give the
       oldest match the most weight. Stored windows are newest-first, but
       that is checked rather than assumed. */
    const first = ms[0] && ms[0].d, last = ms[n - 1] && ms[n - 1].d;
    const asc = !!(first && last && first < last);
    const HL = this.HALF_LIFE;
    const has = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

    let hgfT=0,hgaT=0,agfT=0,agaT=0, hW=0, aW=0;
    let h1gfT=0,h1gaT=0,a1gfT=0,a1gaT=0, h1W=0, a1W=0, g1all=0, gAllWithHT=0;
    let hstT=0,hstaT=0,astT=0,astaT=0,sotT=0,sotaT=0, hsW=0, asW=0;
    let hshT=0,hshaT=0,ashT=0,ashaT=0, hshW=0, ashW=0;

    for (let idx = 0; idx < n; idx++) {
      const m = ms[idx];
      if (!m) continue;
      const rank = asc ? n - 1 - idx : idx;
      const wt = HL > 0 ? Math.pow(0.5, rank / HL) : 1;
      const gf = +m.gf || 0, ga = +m.ga || 0;

      s.n++; s.gf += gf; s.ga += ga;
      if (gf > ga) s.w++; else if (gf === ga) s.d++; else s.l++;
      if (gf > 0 && ga > 0) s.btts++;
      if (ga === 0) s.cs++;
      if (gf === 0) s.fts++;
      if (gf + ga > 2.5) s.o25++;
      if (m.h) { s.hn++; hW += wt; hgfT += gf * wt; hgaT += ga * wt; }
      else     { s.an++; aW += wt; agfT += gf * wt; agaT += ga * wt; }

      /* First-half figures only from matches that have a half-time
         score. A missing one is not 0-0. */
      if (has(m.hgf) && has(m.hga)) {
        const f1 = +m.hgf, a1 = +m.hga;
        s.n1++; g1all += f1 + a1; gAllWithHT += gf + ga;
        if (f1 > a1) s.h1w++; else if (f1 === a1) s.h1d++; else s.h1l++;
        if (f1 > 0 && gf - f1 > 0) s.sbh++;
        if (m.h) { s.hn1++; h1W += wt; h1gfT += f1 * wt; h1gaT += a1 * wt; }
        else     { s.an1++; a1W += wt; a1gfT += f1 * wt; a1gaT += a1 * wt; }
      }

      /* Shots. null is "not recorded", which Number() would turn into a
         perfectly valid-looking zero. */
      if (has(m.st) && has(m.sta)) {
        const st = +m.st, sta = +m.sta;
        sotT += st * wt; sotaT += sta * wt;
        if (m.h) { s.hsn++; hsW += wt; hstT += st * wt; hstaT += sta * wt; }
        else     { s.asn++; asW += wt; astT += st * wt; astaT += sta * wt; }
        if (has(m.sh) && has(m.sha)) {
          const sh = +m.sh, sha = +m.sha;
          if (m.h) { hshW += wt; hshT += sh * wt; hshaT += sha * wt; }
          else     { ashW += wt; ashT += sh * wt; ashaT += sha * wt; }
        }
      }
    }

    /* Older records stored a missing half-time score as 0-0 and cannot
       be told from a real one individually. Collectively they can: ten
       or more goals with not one of them before the break does not
       happen (about one chance in four hundred). */
    if (s.n1 > 0 && g1all === 0 && gAllWithHT >= 10) {
      s.n1 = 0; s.hn1 = 0; s.an1 = 0; s.h1w = 0; s.h1d = 0; s.h1l = 0; s.sbh = 0;
      h1W = 0; a1W = 0;
    }

    const d = (x, y) => y > 0 ? x / y : 0;
    s.hgf = d(hgfT, hW);   s.hga = d(hgaT, hW);
    s.agf = d(agfT, aW);   s.aga = d(agaT, aW);
    s.h1gf = d(h1gfT, h1W); s.h1ga = d(h1gaT, h1W);
    s.a1gf = d(a1gfT, a1W); s.a1ga = d(a1gaT, a1W);
    s.hstf = d(hstT, hsW); s.hsta = d(hstaT, hsW);
    s.astf = d(astT, asW); s.asta = d(astaT, asW);
    s.sot  = d(sotT, hsW + asW); s.sotA = d(sotaT, hsW + asW);
    s.hshf = d(hshT, hshW); s.hsha = d(hshaT, hshW);
    s.ashf = d(ashT, ashW); s.asha = d(ashaT, ashW);

    const recent = asc ? ms.slice(-6).reverse() : ms.slice(0, 6);
    s.form = recent.map(m => m.gf > m.ga ? 'W' : m.gf === m.ga ? 'D' : 'L').join('');
    return s;
  }
};

/* ════════════════════════════════════════════════════════════════
   ST — what to do with a price.

   Shared for the same reason the engine is: the app lists selections
   and the Worker keeps the ledger that grades them, and a ledger graded
   by different rules from the ones you bet on is worse than none. Both
   call these functions; neither has its own copy.

   The rule underneath all of it, measured rather than assumed: where a
   sharp price exists, the model's disagreement with it is not an edge.
   Backing selections because the model rated them 3 points above the
   market returned the same as backing at random (-3.9% against -4.1%).
   What did pay, in the same test, was the price itself: taking YOUR
   bookmaker's odds only when the sharp market's own probability made
   them generous returned +2% to +4% on the true probabilities. So a
   selection is judged on its price against the market's number, and the
   model is kept for what the market does not quote.
   ════════════════════════════════════════════════════════════════ */
export const ST = {
  SHARP: 'pinnacle',

  FLIP: {
    target: 2.00, band: 0.35,
    /* Expected value at your bookmaker's price before a selection counts
       as value. The consensus of soft books is a noisier yardstick than
       Pinnacle, so it has to clear a higher bar to mean the same. */
    valueSharp: 0.01, valueCons: 0.02,
    /* Anything priced worse than this against the fair odds is left off
       the list altogether. */
    floor: -0.03,
    minBooks: 5,
    keep: 10
  },

  /* Is this fair probability good enough to judge a price by? Pinnacle's
     is. A consensus is once enough books are in it. One soft book is not:
     measured, a flawless forecaster would be shown a false 3-point edge
     on about one selection in eight against a single soft book. */
  trusted(src, books) {
    return src === this.SHARP || (src === 'consensus' && books >= this.FLIP.minBooks);
  },

  /* Every selection that can be bet on a priced fixture.

       price   what YOUR bookmaker pays, when it is in the feed; the
               best price anywhere otherwise (mine: false)
       fair    the market's probability with the margin removed
       ev      expected return per unit at `price` if `fair` is right

     An over/under carried forward from an earlier day is good enough
     to read expected goals from but not to bet on — the price may have
     moved — so those legs are marked stale. */
  legs(od) {
    const out = [];
    if (!od || !(od.fh > 0 && od.fd > 0 && od.fa > 0)) return out;
    const mine = Array.isArray(od.x) && od.x.length === 3;
    const px = mine ? od.x : [od.bh, od.bd, od.ba];
    const best = [od.bh, od.bd, od.ba];
    const t1 = this.trusted(od.bk, od.books || 0);
    const add = (k, label, fair, price, bestPx, src, trusted, fresh, isMine) => {
      if (!(price > 1) || !(fair > 0)) return;
      out.push({ k, label, fair, price, best: bestPx > 1 ? bestPx : price,
                 ev: fair * price - 1, mine: isMine, trusted, fresh,
                 sharp: src === this.SHARP, src });
    };
    add('1', 'Home', od.fh, px[0], best[0], od.bk, t1, true, mine);
    add('X', 'Draw', od.fd, px[1], best[1], od.bk, t1, true, mine);
    add('2', 'Away', od.fa, px[2], best[2], od.bk, t1, true, mine);

    const ou = od.ou;
    if (ou && ou.fo > 0 && ou.fu > 0) {
      const m2 = Array.isArray(ou.x) && ou.x.length === 2;
      const t2 = this.trusted(ou.bk || od.bk, ou.books || od.books || 0);
      const fresh = !ou.c;
      add('O25', 'Over 2.5',  ou.fo, m2 ? ou.x[0] : ou.bo, ou.bo, ou.bk || od.bk, t2, fresh, m2);
      add('U25', 'Under 2.5', ou.fu, m2 ? ou.x[1] : ou.bu, ou.bu, ou.bk || od.bk, t2, fresh, m2);
    }
    return out;
  },

  /* The devigged market in the shape PM.blend() takes. */
  market(od) {
    if (!od || !(od.fh > 0 && od.fd > 0 && od.fa > 0)) return null;
    const mk = { fh: od.fh, fd: od.fd, fa: od.fa, sharp: od.bk === this.SHARP };
    if (od.ou && od.ou.fo > 0 && od.ou.fo < 1) mk.fo = od.ou.fo;
    return mk;
  },

  /* Flip x2: a single selection priced near 2.00 at your bookmaker.

     `items` is [{ f, od }]. Returned best-priced first: the ones the
     market itself says are value, then the ones closest to a fair bet.
     Nothing is listed on a price that is not yours, a fair probability
     that cannot be trusted, or a quote that has gone stale. */
  flip(items) {
    const P = this.FLIP, out = [];
    for (const it of items) {
      for (const leg of this.legs(it.od)) {
        if (!leg.mine || !leg.trusted || !leg.fresh) continue;
        if (Math.abs(leg.price - P.target) > P.band) continue;
        if (leg.ev < P.floor) continue;
        const tier = leg.ev >= (leg.sharp ? P.valueSharp : P.valueCons) ? 'value' : 'near';
        out.push({ f: it.f, od: it.od, leg, ev: leg.ev, tier });
      }
    }
    out.sort((a, b) => b.ev - a.ev || b.leg.fair - a.leg.fair);
    return out;
  },

  /* Why a priced fixture produced no Flip x2 candidates at all — so an
     empty list can say what is missing instead of just being empty. */
  flipBlockers(items) {
    const c = { priced: 0, noMine: 0, untrusted: 0, outOfBand: 0, tooPoor: 0 };
    const P = this.FLIP;
    for (const it of items) {
      const legs = this.legs(it.od);
      if (!legs.length) continue;
      c.priced++;
      if (!legs.some(l => l.mine)) { c.noMine++; continue; }
      if (!legs.some(l => l.mine && l.trusted)) { c.untrusted++; continue; }
      const band = legs.filter(l => l.mine && l.trusted && l.fresh && Math.abs(l.price - P.target) <= P.band);
      if (!band.length) { c.outOfBand++; continue; }
      if (!band.some(l => l.ev >= P.floor)) c.tooPoor++;
    }
    return c;
  },

  /* ════════════════ HTD — half-time draw ════════════════

     The rule lives here, beside Flip x2's, so the Worker that records
     the selections and the app that shows them cannot disagree.

       lift   how far above the usual half-time draw rate a match must be
       keep   selections a day written into the ledger
       list   selections a day kept for display */
  HTD: { lift: 0.03, keep: 10, list: 30 },
  MIN_MATCHES: 4,

  /* The forecast for one fixture, exactly as the app shows it: the
     model's own number, then the market's where a price exists. */
  forecast(H, A, avg, od, cal) {
    const raw = PM.run(H, A, avg, cal);
    return { raw, r: PM.blend(raw, this.market(od), undefined, cal) };
  },

  /* items: [{ f, r }] with r a forecast from forecast(). Returns the
     matches whose half-time draw clears the bar, likeliest first. A
     price-backed estimate is several times more accurate than a model-
     only one, so at equal probability it goes first. */
  htd(items, cal) {
    const base = PM.baseOf(cal).h1d, out = [];
    for (const { f, r } of items) {
      if (!r || !(r.h1d > 0) || r.h1d < base + this.HTD.lift) continue;
      out.push({ f, prob: r.h1d, fair: 1 / r.h1d, lift: r.h1d - base,
                 goals: (r.lh1 || 0) + (r.la1 || 0), priced: !!r.blended,
                 totals: !!(r.implied && r.implied.fromTotals) });
    }
    out.sort((a, b) => (b.prob - a.prob) || (b.priced - a.priced));
    return out;
  }
};
