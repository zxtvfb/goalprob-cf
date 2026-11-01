/* ════════════════════════════════════════════════════════════════
   Shared helpers. The maths here is identical to the Netlify build —
   only the storage layer changed. What is different:

   · no firebase-admin; the caller passes a `D` from firestore(env)
   · secrets come from `env`, not process.env
   · big arrays are stored as JSON strings (see pack/unpack), because
     encoding them as native Firestore values costs more CPU than the
     10 ms the Workers free plan allows
   ════════════════════════════════════════════════════════════════ */
import { canonical, fixtureKey } from './names.mjs';
export { FV } from './firestore.mjs';
import { FV } from './firestore.mjs';

/* ---------- JSON-string packing ----------
   Firestore charges no more for a long string than a long array, and
   the Workers CPU budget cares a great deal about the difference. */
export const pack   = v => JSON.stringify(v ?? []);
export const unpack = v => {
  if (Array.isArray(v)) return v;                 // tolerate old native arrays
  if (typeof v !== 'string' || !v) return [];
  try { return JSON.parse(v); } catch { return []; }
};
export const unpackObj = v => {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v) return {};
  try { return JSON.parse(v); } catch { return {}; }
};

/* ---------- API-Football ---------- */
const API_BASE = 'https://v3.football.api-sports.io';
export const MAX_WINDOW = 45;

export async function apiGet(env, path, params = {}) {
  const key = env.APIFOOTBALL_KEY;
  if (!key) throw new Error('APIFOOTBALL_KEY is not set');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${path}${qs ? '?' + qs : ''}`, {
    headers: { 'x-apisports-key': key }
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  const json = await res.json();

  if (json.errors && !Array.isArray(json.errors) && Object.keys(json.errors).length) {
    const e = json.errors;
    if (e.plan)     throw new Error(`API plan limit: ${e.plan}`);
    if (e.token)    throw new Error(`API key rejected: ${e.token} — check APIFOOTBALL_KEY, and that you registered at api-football.com rather than RapidAPI`);
    if (e.requests) throw new Error(`API quota exhausted: ${e.requests}`);
    throw new Error('API error: ' + JSON.stringify(e));
  }
  return {
    data: json.response || [],
    remaining: Number(res.headers.get('x-ratelimit-requests-remaining') ?? -1)
  };
}

/* ---------- status + dates ---------- */
const FINISHED = new Set(['FT', 'AET', 'PEN']);
export const isFinished = s => FINISHED.has(s);
export const iso = (d = new Date()) => d.toISOString().slice(0, 10);
export function shift(n, from = new Date()) {
  const d = new Date(from); d.setUTCDate(d.getUTCDate() + n); return iso(d);
}

/* ---------- women's competitions ---------- */
const W_PATTERNS = [
  /\bwomen'?s?\b/i, /\bwoman\b/i, /\bladies\b/i, /\bgirls\b/i,
  /\bf[ée]minin[ae]?s?\b/i, /\bfemenin[ao]s?\b/i, /\bfemminile\b/i,
  /\bfeminino\b/i, /\bfrauen\b/i, /\bdamen\b/i, /\bdames\b/i,
  /\bkvinner\b/i, /\bkvinde\b/i, /\bnaiset\b/i, /\bkobiet\b/i,
  /\bzeny\b/i, /\bzenska\b/i, /\bnoi\b/i, /\bgynaik\w*\b/i,
  /\bdamallsvenskan\b/i, /\btoppserien\b/i, /\bfrauen[- ]?bundesliga\b/i,
  /\bnwsl\b/i, /\bwsl\b/i, /\bw[- ]?league\b/i, /\bwomens?\b/i,
  /\(w\)/i, /\bu?\d{0,2}\s*w$/i
];
export function isWomens(...names) {
  for (const raw of names) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (W_PATTERNS.some(re => re.test(s))) return true;
    if (/\s+w$/i.test(s)) return true;
  }
  return false;
}

/* ---------- fixture mapping ---------- */
export function toFixtureRow(x) {
  const hname = x.teams?.home?.name ?? '';
  const aname = x.teams?.away?.name ?? '';
  return {
    k:    (hname && aname) ? fixtureKey(hname, aname) : null,
    id:   x.fixture?.id,
    ts:   x.fixture?.timestamp ?? null,
    st:   x.fixture?.status?.short ?? 'NS',
    lid:  x.league?.id ?? 0,
    lname:x.league?.name ?? '',
    ctry: x.league?.country ?? '',
    flag: x.league?.flag || x.league?.logo || '',
    hid:  x.teams?.home?.id,
    hname, hlogo: x.teams?.home?.logo ?? '',
    aid:  x.teams?.away?.id,
    aname, alogo: x.teams?.away?.logo ?? '',
    gh:   x.goals?.home ?? null,
    ga:   x.goals?.away ?? null
  };
}

/* ════════════════════════════════════════════════════════════════
   Stat block — must stay identical to PM.profile() in index.html
   ════════════════════════════════════════════════════════════════ */
export function profile(ms) {
  const s = {
    n:0, hn:0, an:0, gf:0, ga:0,
    hgf:0, hga:0, agf:0, aga:0,
    h1gf:0, h1ga:0, a1gf:0, a1ga:0,
    w:0, d:0, l:0, h1w:0, h1d:0, h1l:0,
    btts:0, cs:0, sbh:0, o25:0, fts:0, form:'',
    hsn:0, asn:0, hstf:0, hsta:0, astf:0, asta:0, sot:0, sotA:0
  };
  let hgfT=0,hgaT=0,agfT=0,agaT=0,h1gfT=0,h1gaT=0,a1gfT=0,a1gaT=0;
  let hstT=0,hstaT=0,astT=0,astaT=0,sotT=0,sotaT=0;

  for (const m of ms) {
    const gf=+m.gf||0, ga=+m.ga||0, f1=+m.hgf||0, a1=+m.hga||0;
    const s2 = gf - f1;
    s.n++; s.gf+=gf; s.ga+=ga;
    if (gf>ga) s.w++; else if (gf===ga) s.d++; else s.l++;
    if (f1>a1) s.h1w++; else if (f1===a1) s.h1d++; else s.h1l++;
    if (gf>0 && ga>0) s.btts++;
    if (ga===0) s.cs++;
    if (gf===0) s.fts++;
    if (f1>0 && s2>0) s.sbh++;
    if (gf+ga > 2.5) s.o25++;
    if (m.h) { s.hn++; hgfT+=gf; hgaT+=ga; h1gfT+=f1; h1gaT+=a1; }
    else     { s.an++; agfT+=gf; agaT+=ga; a1gfT+=f1; a1gaT+=a1; }

    const st = Number(m.st), sta = Number(m.sta);
    if (Number.isFinite(st) && Number.isFinite(sta)) {
      sotT += st; sotaT += sta;
      if (m.h) { s.hsn++; hstT+=st; hstaT+=sta; }
      else     { s.asn++; astT+=st; astaT+=sta; }
    }
  }
  const r = (x,y) => y>0 ? +(x/y).toFixed(4) : 0;
  s.hgf=r(hgfT,s.hn); s.hga=r(hgaT,s.hn);
  s.agf=r(agfT,s.an); s.aga=r(agaT,s.an);
  s.h1gf=r(h1gfT,s.hn); s.h1ga=r(h1gaT,s.hn);
  s.a1gf=r(a1gfT,s.an); s.a1ga=r(a1gaT,s.an);
  s.hstf=r(hstT,s.hsn); s.hsta=r(hstaT,s.hsn);
  s.astf=r(astT,s.asn); s.asta=r(astaT,s.asn);
  s.sot =r(sotT, s.hsn+s.asn); s.sotA=r(sotaT, s.hsn+s.asn);
  s.form = ms.slice(0,6).map(m => m.gf>m.ga?'W':m.gf===m.ga?'D':'L').join('');
  return s;
}

/* ════════════════════════════════════════════════════════════════
   Rolling window merge. Two dedupe passes: by fixture id, then by
   opponent and date, because the same match arrives from two sources
   with different id spaces and would otherwise be counted twice.
   ════════════════════════════════════════════════════════════════ */
export function mergeWindow(existing, incoming) {
  const byId = new Map();
  for (const m of (existing || [])) if (m && m.i != null) byId.set(String(m.i), m);
  for (const m of incoming)         if (m && m.i != null) byId.set(String(m.i), m);

  /* Annotate once. The earlier version compared every record against
     every kept record and called canonical() inside each comparison —
     about 2000 calls per team, which alone blew the CPU budget. Each
     record's key and day are now computed a single time, and the
     opponent buckets make the second pass linear. */
  const all = [];
  for (const m of byId.values()) {
    all.push({ m, key: canonical(m.o), day: Date.parse((m.d || '') + 'T12:00:00Z') });
  }
  all.sort((a, b) => (b.m.d || '').localeCompare(a.m.d || ''));

  const byOpp = new Map();          // canonical opponent -> entries kept so far
  const kept = [];

  for (const x of all) {
    if (Number.isNaN(x.day)) { kept.push(x); continue; }
    const bucket = byOpp.get(x.key);
    let twin = null;
    if (bucket) {
      for (const y of bucket) {
        /* same opponent within a day is the same fixture arriving from
           the other source — kickoff timestamps and local match dates
           can land on different days for a late kickoff */
        if (Math.abs(y.day - x.day) <= 864e5) { twin = y; break; }
      }
    }
    if (!twin) {
      kept.push(x);
      if (bucket) bucket.push(x); else byOpp.set(x.key, [x]);
    } else if (betterOf(x.m, twin.m) === x.m) {
      twin.m = x.m;                 // kept holds the same wrapper, so this lands
    }
  }
  return kept.slice(0, MAX_WINDOW).map(x => x.m);
}

function betterOf(a, b) {
  const shots = r => Number.isFinite(Number(r.st)) && Number.isFinite(Number(r.sta));
  if (shots(a) !== shots(b)) return shots(a) ? a : b;
  return Object.keys(a).length >= Object.keys(b).length ? a : b;
}

/* ════════════════════════════════════════════════════════════════
   League bundle — one document per league so the app reads once per
   league rather than twice per fixture. history MUST rebuild these
   after importing or the app keeps serving pre-import stats.
   ════════════════════════════════════════════════════════════════ */
export async function rebuildLeagues(D, leagueIds, cap = 60) {
  let n = 0;
  for (const lid of new Set(leagueIds)) {
    if (!lid) continue;
    try {
      const snap = await D.collection('teams').where('lid', '==', lid).limit(cap).get();
      if (snap.empty) continue;

      const teams = {};
      let hgT=0, hnT=0, agT=0, anT=0, h1T=0, a1T=0, goalT=0, sotT=0;

      snap.forEach(d => {
        const s = d.data().s;
        if (!s || !s.n) return;
        teams[d.id] = s;
        hgT += s.hgf * s.hn; hnT += s.hn; h1T += s.h1gf * s.hn;
        agT += s.agf * s.an; anT += s.an; a1T += s.a1gf * s.an;
        const sn = (s.hsn || 0) + (s.asn || 0);
        if (sn > 0 && s.sot > 0) {
          sotT  += s.sot * sn;
          goalT += ((s.hgf * s.hsn) + (s.agf * s.asn));
        }
      });
      if (!Object.keys(teams).length) continue;

      const r = (x, y) => y > 0 ? +(x / y).toFixed(4) : 0;
      await D.doc(`cache/league_${lid}`).set({
        lid,
        avg:  { h: r(hgT, hnT), a: r(agT, anT), h1h: r(h1T, hnT), h1a: r(a1T, anT) },
        conv: sotT > 200 ? r(goalT, sotT) : 0,
        teams: pack(teams),            // packed: 60 stat blocks is too much to encode natively
        u: FV.serverTimestamp()
      });
      n++;
    } catch (e) { console.warn('league bundle', lid, e.message); }
  }
  return n;
}

/* ---------- responses ---------- */
export const ok = body => {
  const r = { ok: true, ...body };
  console.log('RESULT ' + JSON.stringify(r));
  return new Response(JSON.stringify(r, null, 2), {
    headers: { 'content-type': 'application/json' }
  });
};
export const bad = (msg, code = 500) => {
  console.error('FAILED ' + msg);
  return new Response(JSON.stringify({ ok: false, error: msg }, null, 2), {
    status: code, headers: { 'content-type': 'application/json' }
  });
};
