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
import { PM } from './model.mjs';
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
  /\(w\)/i, /\bu?\d{0,2}\s*w$/i,
  /* added 12 Nov: names the first list let through */
  /\bliga\s*f\b/i,                    // Spain's top women's league ("Liga F", not "Liga FPD")
  /\bwe[- ]?league\b/i, /\bwk[- ]?league\b/i,
  /\bfemenil\b/i, /\bfemen[ií](?![a-z])/i,      // Liga MX Femenil, Barcelona Femení
  /\bvrouwen\b/i, /\bkvind\w*/i, /\bnaisten\b/i, /\belitettan\b/i,
  /\bkad[ıi]nlar?\b/i, /(^|[^a-zà-ž])[zž]en[ey](\b|$)/i, /\b[zž]ensk[aá]\b/i, /\bn[őo]i\b/i,
  /\bcopa de la reina\b/i, /\bshebelieves\b/i, /\bmatildas\b/i, /\bfeminil\b/i
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
    ...scoreOf(x)
  };
}

/* The score a bet is settled on.

   For a match that went to extra time or penalties the API's `goals`
   includes the extra-time goals, but 1X2 and over/under are settled on
   ninety minutes. A cup tie drawn 1-1 and won 2-1 in extra time is a
   DRAW for betting purposes; stored as 2-1 it was both graded and
   learned from as a home win. The ninety-minute score is kept as the
   score, and the final one alongside it for display. */
function scoreOf(x) {
  let gh = x.goals?.home ?? null, ga = x.goals?.away ?? null;
  const st = x.fixture?.status?.short;
  const ft = x.score?.fulltime;
  if ((st === 'AET' || st === 'PEN') && ft && ft.home != null && ft.away != null) {
    const out = { gh: ft.home, ga: ft.away };
    if (ft.home !== gh || ft.away !== ga) out.et = [gh, ga];
    return out;
  }
  return { gh, ga };
}

/* ════════════════════════════════════════════════════════════════
   Stat block.

   This used to be a second, hand-kept copy of the engine's profile(),
   under a comment saying the two "must stay identical". They did not:
   recency weighting went into the engine and never reached this one, so
   every stored prediction would have gone on using unweighted figures
   while the backtest measured weighted ones. There is now one
   implementation, in model.mjs, and this only rounds its output so the
   stored document stays small.
   ════════════════════════════════════════════════════════════════ */
const RATE_KEYS = ['hgf','hga','agf','aga','h1gf','h1ga','a1gf','a1ga',
                   'hstf','hsta','astf','asta','sot','sotA','hshf','hsha','ashf','asha'];
export function profile(ms) {
  const s = PM.profile(ms);
  for (const k of RATE_KEYS) s[k] = +(+s[k] || 0).toFixed(4);
  return s;
}
export const PROFILE_V = PM.PROFILE_V;

/* ════════════════════════════════════════════════════════════════
   Rolling window merge. Two dedupe passes: by fixture id, then by
   opponent and date, because the same match arrives from two sources
   with different id spaces and would otherwise be counted twice.
   ════════════════════════════════════════════════════════════════ */
export function mergeWindow(existing, incoming) {
  const byId = new Map();
  for (const m of (existing || [])) if (m && m.i != null) byId.set(String(m.i), m);
  for (const m of incoming) {
    if (!m || m.i == null) continue;
    const id = String(m.i), prev = byId.get(id);
    if (!prev) { byId.set(id, m); continue; }
    /* The same record arriving again: its values win (a corrected score
       should land), but anything it leaves blank keeps what was there —
       otherwise a re-import wipes the fields merged in from the other
       feed the last time round. */
    const out = { ...prev };
    for (const k of Object.keys(m)) if (present(m[k])) out[k] = m[k];
    byId.set(id, out);
  }

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
    /* The opponent's name is not always spelt alike in the two feeds, and
       when it is not, the rule above misses and the same match is stored
       twice — every goal in it counted double. A side does not play two
       matches a day apart at the same venue with the same score, so that
       identifies the twin without needing the names to agree. The list
       is date-sorted, so only the last few kept entries can be close. */
    if (!twin) {
      for (let i = kept.length - 1; i >= 0 && i >= kept.length - 4; i--) {
        const y = kept[i];
        if (Number.isNaN(y.day) || Math.abs(y.day - x.day) > 864e5) continue;
        if (y.m.h === x.m.h && +y.m.gf === +x.m.gf && +y.m.ga === +x.m.ga) { twin = y; break; }
      }
    }
    if (!twin) {
      kept.push(x);
      if (bucket) bucket.push(x); else byOpp.set(x.key, [x]);
    } else {
      twin.m = combine(x.m, twin.m);      // kept holds the same wrapper, so this lands
    }
  }
  return kept.slice(0, MAX_WINDOW).map(x => x.m);
}

const present = v => v !== null && v !== undefined && v !== '';

function betterOf(a, b) {
  /* null means "not recorded"; Number(null) is 0, which looked like a
     perfectly good shot count and made an empty record win the tie */
  const shots = r => present(r.st) && present(r.sta) &&
                     Number.isFinite(Number(r.st)) && Number.isFinite(Number(r.sta));
  if (shots(a) !== shots(b)) return shots(a) ? a : b;
  return Object.keys(a).length >= Object.keys(b).length ? a : b;
}

/* Two records of one match, from two feeds. Neither is complete: the
   results file has shots, half-time scores and closing odds but no team
   ids; the live feed has the ids and the league but no shots. Choosing
   one threw the other's fields away. Take the better as the base and
   fill its gaps from the other. */
function combine(a, b) {
  const base = betterOf(a, b), other = base === a ? b : a;
  const out = { ...base };
  for (const k of Object.keys(other)) {
    if (!present(out[k]) && present(other[k])) out[k] = other[k];
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════
   League bundle — one document per league so the app reads once per
   league rather than twice per fixture. history MUST rebuild these
   after importing or the app keeps serving pre-import stats.
   ════════════════════════════════════════════════════════════════ */
export async function rebuildLeagues(D, leagueIds, cap = 60, opts = {}) {
  let n = 0;
  for (const lid of new Set(leagueIds)) {
    if (!lid) continue;
    try {
      const snap = await D.collection('teams').where('lid', '==', lid).limit(cap).get();
      if (snap.empty) continue;

      const teams = {};
      const refreshed = [];
      const blocks = [];

      snap.forEach(d => {
        const data = d.data();
        let s = data.s;

        /* A stat block built by an older profile() is rebuilt from the
           team's stored matches, so one pass of the bundles job brings
           every league up to the current engine. Only that job asks for
           this: it costs CPU, and digest has none to spare. */
        if (opts.reprofile && (!s || s.v !== PROFILE_V)) {
          const m = unpack(data.m);
          if (m.length) { s = profile(m); refreshed.push([d.ref, s]); }
        }
        if (!s || !s.n) return;
        blocks.push(s);
        /* The rating from closing prices lives beside the stat block on
           the team document (the results import writes it). It travels
           with the block in the bundle, which is all the app reads. */
        teams[d.id] = data.mr ? { ...s, mr: data.mr } : s;
      });
      if (!blocks.length) continue;

      /* The sums and the averages are the engine's, so that the backtest
         page reproduces exactly what is stored here. */
      const T = PM.tally(blocks);
      const avg = PM.avgOf(T);

      await D.doc(`cache/league_${lid}`).set({
        lid, avg,
        conv: avg.conv,
        teams: pack(teams),            // packed: 60 stat blocks is too much to encode natively
        u: FV.serverTimestamp()
      });
      n++;

      if (refreshed.length && opts.writeBack) {
        const batch = D.batch();
        for (const [ref, s] of refreshed) batch.set(ref, { s }, { merge: true });
        await batch.commit();
      }

      /* running totals for the cross-league average */
      if (opts.acc) {
        const A = opts.acc;
        for (const k of TALLY_KEYS) A[k] += T[k];
        A.leagues++; A.reprofiled = (A.reprofiled || 0) + refreshed.length;
      }
    } catch (e) { console.warn('league bundle', lid, e.message); }
  }
  return n;
}

const TALLY_KEYS = ['hg','hn','ag','an','h1','hg1','a1','ag1','goal','sot','shot','sos'];
export const emptyAcc = () => ({ hg:0, hn:0, ag:0, an:0, h1:0, hg1:0, a1:0, ag1:0,
                                 goal:0, sot:0, shot:0, sos:0, leagues:0, reprofiled:0 });

/* The scoring rate across every league in the accumulator — the average
   a league with none of its own falls back to. The shot figures need
   ten times the sample a single league does before they are believed. */
export function averageOf(A) {
  if (!A || !(A.hn > 50) || !(A.an > 50)) return null;
  return PM.avgOf(A, 2000, 4000);
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
