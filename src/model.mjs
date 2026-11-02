/* ════════════════════════════════════════════════════════════════
   model — the probability engine, server side.

   This is the SAME engine the browser runs in public/index.html. It is
   duplicated rather than imported because the browser loads one inline
   script and the Worker bundles ES modules; there is no file both can
   read.

   Duplication is the exact shape of bug that has bitten this project
   twice — the odds key drifted between server and client and no price
   matched anything for days, silently. So model.drift.test.mjs extracts
   PM from index.html and compares it against this file on randomised
   fixtures. If the two ever disagree, that test fails. Change one, change
   both, and run the test.
   ════════════════════════════════════════════════════════════════ */
export const PM = {
  GRID: 9,          // scorelines 0..8
  K: 5,             // shrinkage strength (pseudo-matches toward league mean)
  RHO: -0.045,      // Dixon-Coles low-score correction

  // fallback league priors (used when a league bundle has no averages yet)
  P:  { h: 1.46, a: 1.17, h1h: 0.64, h1a: 0.51 },

  /* ---- shots-based expected goals ----
     Goals are a tiny sample (~1.35/team/match) so the rate is noisy.
     Shots on target run ~4.3/match, so that rate settles about three
     times faster. CONV turns shots on target into expected goals;
     W_SHOTS is how much to trust them at full coverage, from inverse-
     variance weighting of the two estimators. Coverage scales it down
     when only some matches carry shot data. */
  CONV: 0.31,       // goals per shot on target, league-average
  W_SHOTS: 0.75,

  // base rates, used to show how far a pick sits above chance
  BASE: { h: 0.45, d: 0.26, a: 0.29, btts: 0.52, o25: 0.53 },

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
     With no shot data this is exactly the old goals-only behaviour. */
  effRate(goalRate, sotRate, n, sn, conv, prior) {
    let rate = goalRate;
    if (sn > 0 && sotRate > 0) {
      const cover = Math.min(sn / Math.max(n, 1), 1);
      const w = this.W_SHOTS * cover;
      rate = w * (sotRate * conv) + (1 - w) * goalRate;
    }
    return this.shrink(rate, prior, n);
  },

  /* Build a 9x9 scoreline matrix from two expected-goal values */
  matrix(lh, la) {
    const m = [], G = this.GRID;
    let tot = 0;
    for (let i = 0; i < G; i++) {
      m[i] = [];
      for (let j = 0; j < G; j++) {
        const v = this.pois(i, lh) * this.pois(j, la) * this.tau(i, j, lh, la);
        m[i][j] = v; tot += v;
      }
    }
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) m[i][j] /= tot;
    return m;
  },

  /* Expected goals for a fixture, from two stat blocks */
  lambdas(H, A, lg) {
    const pH  = (lg && lg.h  > 0) ? lg.h  : this.P.h;
    const pA  = (lg && lg.a  > 0) ? lg.a  : this.P.a;
    const p1H = (lg && lg.h1h> 0) ? lg.h1h: this.P.h1h;
    const p1A = (lg && lg.h1a> 0) ? lg.h1a: this.P.h1a;

    // home side uses its HOME record, away side its AWAY record.
    // Each rate blends goals with shots on target where available.
    const conv = (lg && lg.conv > 0) ? lg.conv : this.CONV;
    const hAtt = this.effRate(H.hgf, H.hstf, H.hn, H.hsn, conv, pH) / pH;  // home attack
    const hDef = this.effRate(H.hga, H.hsta, H.hn, H.hsn, conv, pA) / pA;  // home defence
    const aAtt = this.effRate(A.agf, A.astf, A.an, A.asn, conv, pA) / pA;
    const aDef = this.effRate(A.aga, A.asta, A.an, A.asn, conv, pH) / pH;

    const h1Att = this.shrink(H.h1gf, p1H, H.hn) / p1H;
    const h1Def = this.shrink(H.h1ga, p1A, H.hn) / p1A;
    const a1Att = this.shrink(A.a1gf, p1A, A.an) / p1A;
    const a1Def = this.shrink(A.a1ga, p1H, A.an) / p1H;

    const cap = v => Math.min(Math.max(v, 0.05), 5.0);
    return {
      lh:  cap(hAtt * aDef * pH),
      la:  cap(aAtt * hDef * pA),
      lh1: cap(h1Att * a1Def * p1H),
      la1: cap(a1Att * h1Def * p1A)
    };
  },

  /* Full probability set for a fixture */
  run(H, A, lg) {
    const L = this.lambdas(H, A, lg);
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

    /* ---- the headline pick ----
       Highest-probability outcome across the markets that are genuinely
       competitive. Markets like Over 1.5 are left out: they sit near 75%
       almost every match and would win every time without saying anything.
       `edge` is how far above the base rate the pick sits — that, not the
       raw percentage, is what separates a real signal from a market that
       is simply likely by default. */
    const B = this.BASE;
    const cands = [
      { k: '1',    label: 'Home win',       p: hw,       base: B.h },
      { k: 'X',    label: 'Draw',           p: dr,       base: B.d },
      { k: '2',    label: 'Away win',       p: aw,       base: B.a },
      { k: 'BTTS', label: 'Both score',     p: btts,     base: B.btts },
      { k: 'NB',   label: 'Not both score', p: 1 - btts, base: 1 - B.btts },
      { k: 'O25',  label: 'Over 2.5',       p: o25,      base: B.o25 },
      { k: 'U25',  label: 'Under 2.5',      p: 1 - o25,  base: 1 - B.o25 }
    ];
    cands.sort((x, y) => y.p - x.p);
    const pick = { ...cands[0], edge: cands[0].p - cands[0].base };

    return {
      hw, dr, aw, btts, o15, o25, o35, csH, csA,
      h1w, h1d, h1a,
      sbhH: sbh(L.lh, L.lh1), sbhA: sbh(L.la, L.la1),
      lh: L.lh, la: L.la, lh1: L.lh1, la1: L.la1,
      top: scores.slice(0, 6),
      pick, ranked: cands
    };
  },

  /* Recompute a stat block from a raw match array (used on team profiles) */
  profile(ms) {
    const s = {
      n:0, hn:0, an:0, gf:0, ga:0,
      hgf:0, hga:0, agf:0, aga:0,
      h1gf:0, h1ga:0, a1gf:0, a1ga:0,
      w:0, d:0, l:0, h1w:0, h1d:0, h1l:0,
      btts:0, cs:0, sbh:0, o25:0, fts:0,
      form:'',
      hsn:0, asn:0, hstf:0, hsta:0, astf:0, asta:0, sot:0, sotA:0
    };
    let hgfT=0,hgaT=0,agfT=0,agaT=0,h1gfT=0,h1gaT=0,a1gfT=0,a1gaT=0;
    let hstT=0,hstaT=0,astT=0,astaT=0,sotT=0,sotaT=0;
    for (const m of ms) {
      const gf=+m.gf||0, ga=+m.ga||0, f1=+m.hgf||0, a1=+m.hga||0;
      const s2=gf-f1;
      s.n++; s.gf+=gf; s.ga+=ga;
      if (gf>ga) s.w++; else if (gf===ga) s.d++; else s.l++;
      if (f1>a1) s.h1w++; else if (f1===a1) s.h1d++; else s.h1l++;
      if (gf>0 && ga>0) s.btts++;
      if (ga===0) s.cs++;
      if (gf===0) s.fts++;
      if (f1>0 && s2>0) s.sbh++;
      if (gf+ga>2.5) s.o25++;
      if (m.h) { s.hn++; hgfT+=gf; hgaT+=ga; h1gfT+=f1; h1gaT+=a1; }
      else     { s.an++; agfT+=gf; agaT+=ga; a1gfT+=f1; a1gaT+=a1; }

      const st=Number(m.st), sta=Number(m.sta);
      if (Number.isFinite(st) && Number.isFinite(sta)) {
        sotT+=st; sotaT+=sta;
        if (m.h) { s.hsn++; hstT+=st; hstaT+=sta; }
        else     { s.asn++; astT+=st; astaT+=sta; }
      }
    }
    const d=(x,y)=> y>0 ? x/y : 0;
    s.hgf=d(hgfT,s.hn); s.hga=d(hgaT,s.hn);
    s.agf=d(agfT,s.an); s.aga=d(agaT,s.an);
    s.h1gf=d(h1gfT,s.hn); s.h1ga=d(h1gaT,s.hn);
    s.a1gf=d(a1gfT,s.an); s.a1ga=d(a1gaT,s.an);
    s.hstf=d(hstT,s.hsn); s.hsta=d(hstaT,s.hsn);
    s.astf=d(astT,s.asn); s.asta=d(astaT,s.asn);
    s.sot=d(sotT,s.hsn+s.asn); s.sotA=d(sotaT,s.hsn+s.asn);
    s.form = ms.slice(0,6).map(m => m.gf>m.ga?'W':m.gf===m.ga?'D':'L').join('');
    return s;
  }
};
