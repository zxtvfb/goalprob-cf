/* history — back-fill from football-data.co.uk. Free CSVs, no key,
   no rate limit, and they carry half-time scores, shots and closing
   odds. Zero API-Football calls.

   The CSV parser takes a fast path (plain split) and only falls back
   to character scanning on lines that contain a quote, because a full
   char-by-char parse of a season file does not fit the 10 ms CPU
   budget on the Workers free plan. */
import { FV, profile, mergeWindow, rebuildLeagues, MAX_WINDOW,
         pack, unpack, unpackObj, ok, bad } from './lib.mjs';
import { canonical, buildIndex, resolve } from './names.mjs';
import { PM } from './model.mjs';

export const BASE = 'https://www.football-data.co.uk/mmz4281';

/* One season and a slice of its teams per invocation. The Workers free
   plan gives 10 ms of CPU per request, and parsing a season costs ~3 ms
   with ~0.2 ms per team on top, so 20 teams leaves comfortable headroom.
   The cursor below walks league -> season -> team offset, so repeated
   calls work through everything without ever doing too much at once.

   Do NOT loop this inside a single request: the CPU of every iteration
   lands on the same invocation. The admin page loops it as separate
   HTTP calls instead, which is what gives each run its own budget. */
const TEAM_CAP = 8;

export const LEAGUES = [
  { code: 'E0',  name: 'Premier League',     country: 'England' },
  { code: 'E1',  name: 'Championship',       country: 'England' },
  { code: 'E2',  name: 'League One',         country: 'England' },
  { code: 'E3',  name: 'League Two',         country: 'England' },
  { code: 'EC',  name: 'National League',    country: 'England' },
  { code: 'SP1', name: 'La Liga',            country: 'Spain' },
  { code: 'SP2', name: 'La Liga 2',          country: 'Spain' },
  { code: 'D1',  name: 'Bundesliga',         country: 'Germany' },
  { code: 'D2',  name: '2. Bundesliga',      country: 'Germany' },
  { code: 'I1',  name: 'Serie A',            country: 'Italy' },
  { code: 'I2',  name: 'Serie B',            country: 'Italy' },
  { code: 'F1',  name: 'Ligue 1',            country: 'France' },
  { code: 'F2',  name: 'Ligue 2',            country: 'France' },
  { code: 'N1',  name: 'Eredivisie',         country: 'Netherlands' },
  { code: 'B1',  name: 'Jupiler Pro League', country: 'Belgium' },
  { code: 'P1',  name: 'Primeira Liga',      country: 'Portugal' },
  { code: 'T1',  name: 'Super Lig',          country: 'Turkey' },
  { code: 'G1',  name: 'Super League',       country: 'Greece' },
  { code: 'SC0', name: 'Premiership',        country: 'Scotland' },
  { code: 'SC1', name: 'Championship',       country: 'Scotland' }
];

export function seasonFolders() {
  const d = new Date();
  const start = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const f = y => String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');
  return [f(start), f(start - 1)];
}

export default async function history(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/history');

    if (url.searchParams.get('reset')) {
      await metaRef.set({ cursor: 0 }, { merge: true });
      return ok({ reset: true, note: 'queue restarted' });
    }

    const meta = (await metaRef.get()).data() || {};
    const forced = url.searchParams.get('league');

    /* auto: the hourly refresh. It walks the CURRENT season only, on a
       cursor of its own, so it neither disturbs nor waits for a manual
       full import. This is what keeps shots and half-time scores
       arriving: the live feed has neither for most leagues, and without
       a refresh the imported ones simply age out of every team's window
       until the model is running on goals alone. */
    const auto = !forced && url.searchParams.get('auto') === '1';

    /* cursor: league index -> season index -> team offset */
    let li = forced ? LEAGUES.findIndex(l => l.code.toUpperCase() === forced.toUpperCase())
           : auto   ? (meta.ali || 0) % LEAGUES.length
                    : (meta.li || 0) % LEAGUES.length;
    let si = auto ? 0 : Number(meta.si || 0);
    let to = auto ? Number(meta.ato || 0) : Number(meta.to || 0);
    if (forced) { si = Number(url.searchParams.get('si') || 0); to = Number(url.searchParams.get('to') || 0); }

    if (li < 0) {
      return bad(`unknown league "${forced}". Codes: ${LEAGUES.map(l => l.code).join(', ')}`, 400);
    }

    const league  = LEAGUES[li];
    const seasons = url.searchParams.get('season')
      ? [url.searchParams.get('season')]
      : auto ? [seasonFolders()[0]] : seasonFolders();
    if (si >= seasons.length) { si = 0; }
    const season = seasons[si];

    let rows = [];
    const fetched = [];
    const sinceHere = auto ? ((meta.since || {})[league.code] || '') : '';
    try {
      const res = await fetch(`${BASE}/${season}/${league.code}.csv`);
      if (res.ok) {
        const text = await res.text();
        /* The files are in date order. If the last line is no newer than
           what was folded in last time, nothing has changed: move on
           without parsing a thing. Most visits end here. */
        if (sinceHere) {
          const last = lastDateOf(text);
          if (last && last <= sinceHere) {
            const nx = await advance(metaRef, { li, si, to: 0 }, seasons.length, true, forced, auto);
            return ok({ league: league.code, season, note: `no results since ${sinceHere}`, next: nx, done: nx.done === true,
                        ms: Date.now() - started });
          }
        }
        rows = parseCSV(text);
        fetched.push({ season, rows: rows.length });
      } else {
        fetched.push({ season, error: `HTTP ${res.status}` });
      }
    } catch (e) {
      fetched.push({ season, error: e.message });
    }

    if (!rows.length) {
      const nx = await advance(metaRef, { li, si, to }, seasons.length, true, forced, auto);
      /* `done` at the top level, like every other reply: the admin loop
         stops on it. Without it, a pass that ENDED on a missing file
         never reported finishing and the loop went round again. */
      return ok({ league: league.code, season, fetched, matches: 0,
                  note: 'no rows — the season file may not exist yet', next: nx, done: nx.done === true });
    }

    const perTeam = new Map();
    let skipped = 0;

    for (const r of rows) {
      const home = r.HomeTeam, away = r.AwayTeam;
      const fthg = num(r.FTHG), ftag = num(r.FTAG);
      const hthg = num(r.HTHG), htag = num(r.HTAG);
      const date = parseDate(r.Date);
      if (!home || !away || fthg == null || ftag == null || !date) { skipped++; continue; }
      r._d = date;                       // kept for the ratings pass below

      const id = `fd:${date}:${canonical(home).slice(0, 14)}:${canonical(away).slice(0, 14)}`;

      /* A half-time score that is missing, or larger than the final one,
         is stored as missing — not as 0-0, which the model would read as
         a first half with no goals. */
      const htOK = hthg != null && htag != null && hthg <= fthg && htag <= ftag;
      const h1 = htOK ? hthg : null, a1 = htOK ? htag : null;

      push(perTeam, home, {
        i: id, d: date, o: away, oi: null, h: 1,
        gf: fthg, ga: ftag, hgf: h1, hga: a1, src: 'fd',
        sh: num(r.HS), st: num(r.HST), sha: num(r.AS), sta: num(r.AST),
        od: odds(r, 'H')
      });
      push(perTeam, away, {
        i: id, d: date, o: home, oi: null, h: 0,
        gf: ftag, ga: fthg, hgf: a1, hga: h1, src: 'fd',
        sh: num(r.AS), st: num(r.AST), sha: num(r.HS), sta: num(r.HST),
        od: odds(r, 'A')
      });
    }

    /* Ratings from this season's closing prices — see leagueRatings().
       Only the current season's file: last season's prices describe
       last season's teams. */
    const rating = season === seasonFolders()[0] ? leagueRatings(rows, league.code) : null;

    /* Match the CSV's team names against what is already stored: the
       teams an earlier import of this league wrote, and the ones the
       fixture feed has filed under the league. Two small queries.

       This used to read an index of EVERY team, rebuilt by scanning the
       whole collection every six hours — ten to twenty thousand reads
       a time, and the scan's CPU got the run cut off before the index
       was saved, so the next run scanned again. A few of those used up
       the 50,000 reads a day the free tier allows. */
    const index = await candidates(D, league.code, auto);

    /* Sorted so the offset means the same thing on every invocation —
       Map iteration order would otherwise depend on insertion.

       The automatic refresh rewrites only the teams with a match newer
       than the last one it folded in for this league; the rest of a
       season's file is already in their records. Their ratings move
       with every new result, though, so on a league's first slice every
       side's rating is written — a few bytes each. */
    const since = auto ? ((meta.since || {})[league.code] || '') : '';
    const lastInFile = rows.reduce((a, r) => (r._d && r._d > a ? r._d : a), '');
    /* plain comparison: any fixed order will do, and localeCompare
       loads the collation tables on first use — several milliseconds of
       a fresh run's ten */
    const allTeams = [...perTeam.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const changed  = since ? allTeams.filter(t => t.recs.some(r => r.d > since)) : allTeams;
    const entries  = changed.slice(to, to + TEAM_CAP);
    const moreTeams = to + TEAM_CAP < changed.length;
    const docIdOf = e => {
      const hit = resolve(e.name, index);
      return { e, hit, docId: hit ? hit.team.id : 'fd_' + canonical(e.name).replace(/\s+/g, '-').slice(0, 60) };
    };
    const resolved = entries.map(docIdOf);

    const refs = resolved.map(r => D.doc(`teams/${r.docId}`));
    const prevDocs = refs.length ? await D.getAll(...refs) : [];

    const batch = D.batch();
    let matched = 0, created = 0, rated = 0;
    const unresolved = [];
    const touched = new Set();
    const newTeams = [];

    resolved.forEach((r, i) => {
      if (r.hit) matched++;
      else { created++; unresolved.push(r.e.name); newTeams.push({ id: r.docId, name: r.e.name, lid: 0 }); }
      const prev = prevDocs[i] && prevDocs[i].exists ? prevDocs[i].data() : null;
      if (prev?.lid) touched.add(prev.lid);

      const m = mergeWindow(unpack(prev?.m), r.e.recs);

      /* A side that has not played inside the rating window keeps the
         rating it had; its date says how old it is, and the model lets
         an old one fade. */
      const mr = rating ? rating.of(r.e.key) : null;
      if (mr) rated++;

      batch.set(refs[i], {
        name:    prev?.name || r.e.name,
        search:  String(prev?.name || r.e.name).toLowerCase(),
        logo:    prev?.logo || null,
        country: prev?.country || league.country,
        lid:     prev?.lid || 0,
        fdCode:  league.code,
        sd:      true,
        m:       pack(m),
        s:       profile(m),
        ...(mr ? { mr } : {}),
        u:       FV.serverTimestamp()
      }, { merge: true });
    });

    /* the other sides' ratings, on the league's first slice */
    let ratedOnly = 0;
    if (rating && to === 0) {
      const inBatch = new Set(resolved.map(r => r.docId));
      for (const e of allTeams) {
        const mr = rating.of(e.key);
        if (!mr) continue;
        const hit = resolve(e.name, index);
        if (!hit || inBatch.has(hit.team.id)) continue;     // a team never stored is left until it has a match
        batch.set(D.doc(`teams/${hit.team.id}`), { mr }, { merge: true });
        if (hit.team.lid) touched.add(hit.team.lid);
        ratedOnly++;
      }
    }

    batch.set(D.doc('meta/sync'), {
      lastHistory: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      historySource: 'football-data.co.uk'
    }, { merge: true });

    /* The league's stats bundle is rebuilt by the digest job, which takes
       a list of leagues to redo — doing it here as well cost this run
       more CPU than it has. */
    const finishedLeague = !moreTeams && si >= seasons.length - 1;
    if (touched.size || LID[league.code]) {
      const dref = D.doc('meta/digest');
      const dm = (await dref.get()).data() || {};
      const dirty = [...new Set([...unpack(dm.dirty), ...touched, ...(LID[league.code] ? [LID[league.code]] : [])])].slice(0, 400);
      batch.set(dref, { dirty: pack(dirty) }, { merge: true });
    }
    if (auto && finishedLeague && lastInFile) {
      batch.set(metaRef, { since: { ...(meta.since || {}), [league.code]: lastInFile } }, { merge: true });
    }
    await batch.commit();
    const bundles = 0;

    const nx = await advance(metaRef, { li, si, to }, seasons.length, !moreTeams, forced, auto);

    return ok({
      league: `${league.code} — ${league.country} ${league.name}`,
      season,
      fetched,
      matchesParsed: rows.length,
      skippedRows: skipped,
      teamsInFile: allTeams.length,
      teamsWithNewMatches: changed.length,
      teamsWritten: resolved.length,
      ratingsOnly: ratedOnly,
      teamOffset: to,
      matchedToExisting: matched,
      newTeams: created,
      ratings: rating ? { asOf: rating.asOf, fromMatches: rating.n, teamsRatedThisRun: rated,
                          goalLevel: rating.hasTotals ? 'from over/under prices' : 'no over/under prices in the file' }
                      : (season === seasonFolders()[0] ? 'too few priced matches yet' : 'not computed for a past season'),
      leagueBundlesRebuilt: bundles,
      candidates: index.size,
      unresolvedSample: unresolved.slice(0, 8),
      next: nx,
      done: nx.done === true,
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('history failed:', e);
    return bad(e.message);
  }
}

/* ════════════════════════════════════════════════════════════════
   The teams a results file can mean.

   football-data.co.uk codes against API-Football league ids. A full
   import reads last season too, so it also looks one division up and
   one down: a side relegated since then is filed under the other one.
   ════════════════════════════════════════════════════════════════ */
const LID = { E0: 39, E1: 40, E2: 41, E3: 42, EC: 43, SP1: 140, SP2: 141, D1: 78, D2: 79, I1: 135, I2: 136,
              F1: 61, F2: 62, N1: 88, B1: 144, P1: 94, T1: 203, G1: 197, SC0: 179, SC1: 180 };
const NEXT = { E0: ['E1'], E1: ['E0', 'E2'], E2: ['E1', 'E3'], E3: ['E2', 'EC'], EC: ['E3'], SP1: ['SP2'], SP2: ['SP1'],
               D1: ['D2'], D2: ['D1'], I1: ['I2'], I2: ['I1'], F1: ['F2'], F2: ['F1'], SC0: ['SC1'], SC1: ['SC0'] };
const SECOND = { N1: [89], P1: [95], T1: [204], B1: [145] };   // second divisions not imported themselves

export async function candidates(D, code, auto) {
  const codes = auto ? [code] : [code, ...(NEXT[code] || [])];
  const lids = [LID[code], ...(auto ? [] : (NEXT[code] || []).map(c => LID[c])), ...(auto ? [] : SECOND[code] || [])]
    .filter(Boolean);
  const [a, b] = await Promise.all([
    D.collection('teams').where('fdCode', 'in', codes).select('name', 'lid').limit(200).get(),
    lids.length ? D.collection('teams').where('lid', 'in', lids).select('name', 'lid').limit(200).get() : null
  ]);
  const seen = new Set(), all = [];
  for (const snap of [a, b]) if (snap) snap.forEach(d => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    const v = d.data();
    if (v.name) all.push({ id: d.id, name: v.name, lid: v.lid || 0 });
  });
  return buildIndex(all);
}

function push(map, name, rec) {
  const key = canonical(name);
  if (!key) return;
  if (!map.has(key)) map.set(key, { name, key, recs: [] });
  const e = map.get(key);
  if (e.recs.length < MAX_WINDOW * 2) e.recs.push(rec);
}

/* Move the cursor on: more teams in this season -> bump the offset;
   season finished -> next season; both finished -> next league. */
async function advance(ref, { li, si, to }, seasonCount, teamsDone, forced, auto) {
  let n = { li, si, to };

  if (!teamsDone) {
    n.to = to + TEAM_CAP;
  } else if (si + 1 < seasonCount) {
    n.si = si + 1; n.to = 0;
  } else {
    n.li = li + 1; n.si = 0; n.to = 0;
  }

  const wrapped = n.li >= LEAGUES.length;
  if (wrapped) n = { li: 0, si: 0, to: 0 };

  if (!forced) {
    /* the automatic refresh keeps its place separately from a manual import */
    const save = auto ? { ali: n.li, ato: n.to, au: Date.now() } : { ...n, u: Date.now() };
    await ref.set(save, { merge: true }).catch(() => {});
  }
  return {
    ...n,
    league: LEAGUES[n.li].code,
    done: wrapped,
    note: wrapped ? 'every league covered — the cursor wrapped to the start'
                  : `next: ${LEAGUES[n.li].code} season slot ${n.si}, teams from ${n.to}`
  };
}

export const num = v => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ════════════════════════════════════════════════════════════════
   Ratings from closing prices.

   The file carries the odds each match closed at. Those say what the
   market — which knew the line-ups, the injuries and everything else
   this app deliberately does not track — expected of each side. A fit
   across the league's recent matches turns that into a rating per team
   (see PM.ratings). Measured against simulated seasons where the true
   chances are known, forecasts built on such ratings missed by about
   5 points where goals and shots miss by 8.6.

   One bookmaker's three prices are always taken together: mixing the
   home price of one book with the draw price of another would leave a
   margin that belongs to neither. Pinnacle first, as the sharpest; then
   Bet365; then the market average.
   ════════════════════════════════════════════════════════════════ */
const X3 = [['PSCH', 'PSCD', 'PSCA'], ['B365CH', 'B365CD', 'B365CA'], ['AvgCH', 'AvgCD', 'AvgCA'],
            ['PSH', 'PSD', 'PSA'], ['B365H', 'B365D', 'B365A'], ['AvgH', 'AvgD', 'AvgA']];
const X2 = [['PC>2.5', 'PC<2.5'], ['B365C>2.5', 'B365C<2.5'], ['AvgC>2.5', 'AvgC<2.5']];

export function closing(r) {
  let x = null, t = null;
  for (const k of X3) {
    const a = num(r[k[0]]), b = num(r[k[1]]), c = num(r[k[2]]);
    if (a > 1 && b > 1 && c > 1) { x = [a, b, c]; break; }
  }
  for (const k of X2) {
    const a = num(r[k[0]]), b = num(r[k[1]]);
    if (a > 1 && b > 1) { t = [a, b]; break; }
  }
  return { x, t };
}

const dayNo = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;

/* `rows` must already carry `_d` (the ISO date) on every usable row.
   Returns null when there is not enough to fit, otherwise
   { asOf, n, hasTotals, of(canonicalName) -> the team's `mr` or null }. */
export function leagueRatings(rows, code) {
  let lastDay = -Infinity, lastDate = '';
  for (const r of rows) {
    if (!r._d) continue;
    const d = dayNo(r._d);
    r._n = d;
    if (d > lastDay) { lastDay = d; lastDate = r._d; }
  }
  if (!lastDate) return null;

  const from = lastDay - PM.RATING_WINDOW, ms = [];
  for (const r of rows) {
    if (!r._d || r._n < from) continue;
    const c = closing(r);
    const L = c.x ? PM.lean(c.x, c.t) : null;
    if (!L) continue;
    ms.push({ h: canonical(r.HomeTeam), a: canonical(r.AwayTeam), u: L.u, v: L.v, day: r._n });
  }
  if (ms.length < PM.RATING_MIN_MATCHES) return null;

  const fit = PM.ratings(ms, lastDay);
  if (!fit) return null;
  return {
    asOf: lastDate, n: fit.n,
    hasTotals: fit.lv !== null && Number.isFinite(fit.lv),
    of: key => PM.ratingOf(fit, key, code, lastDate)
  };
}

function odds(r, side) {
  const keys = side === 'H'
    ? ['B365CH', 'PSCH', 'MaxCH', 'AvgCH', 'B365H', 'PSH', 'AvgH']
    : ['B365CA', 'PSCA', 'MaxCA', 'AvgCA', 'B365A', 'PSA', 'AvgA'];
  for (const k of keys) { const v = num(r[k]); if (v && v > 1) return v; }
  return null;
}

export function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? (Number(y) > 70 ? '19' + y : '20' + y) : y;
  return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/* Split one line. The quoted form is rare in these files (a referee
   name containing a comma), so it is only paid for when a quote
   actually appears on the line. */
function splitLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* The only columns the model uses. These files carry well over a
   hundred bookmaker columns; building a string for every one of them
   on every row is most of the parse cost and all of it is wasted. */
const WANTED = new Set([
  'Div','Date','HomeTeam','AwayTeam','FTHG','FTAG','HTHG','HTAG',
  'HS','AS','HST','AST',
  'B365CH','B365CA','PSCH','PSCA','MaxCH','MaxCA','AvgCH','AvgCA',
  'B365H','B365A','PSH','PSA','AvgH','AvgA',
  /* the draw and over/under prices, for the ratings */
  'B365CD','PSCD','AvgCD','B365D','PSD','AvgD',
  'PC>2.5','PC<2.5','B365C>2.5','B365C<2.5','AvgC>2.5','AvgC<2.5'
]);

/* the date on a file's last row, without parsing the rest */
export function lastDateOf(text) {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const head = splitLine(text.slice(0, nl).replace(/\r$/, '')).map(h => h.trim());
  const di = head.indexOf('Date');
  if (di < 0) return null;
  const body = text.trimEnd();
  const line = body.slice(body.lastIndexOf('\n') + 1);
  return parseDate(splitLine(line.replace(/\r$/, ''))[di]);
}

export function parseCSV(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  const head = splitLine(lines[0].replace(/\r$/, '')).map(h => h.trim());

  /* resolve the wanted columns to indices once, then read only those */
  const picks = [];
  for (let c = 0; c < head.length; c++) {
    if (head[c] && WANTED.has(head[c])) picks.push([c, head[c]]);
  }
  if (!picks.length) return [];
  const lastIdx = picks[picks.length - 1][0];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.length < 8) continue;

    const o = {};
    if (raw.indexOf('"') === -1) {
      /* fast path: walk commas and slice only the columns we want,
         stopping as soon as the last wanted column is past */
      let col = 0, start = 0, p = 0;
      for (let j = 0; j <= raw.length; j++) {
        if (j === raw.length || raw.charCodeAt(j) === 44) {   // 44 = ','
          if (p < picks.length && picks[p][0] === col) {
            let end = j;
            if (end > start && raw.charCodeAt(end - 1) === 13) end--;  // trailing \r
            o[picks[p][1]] = raw.slice(start, end).trim();
            p++;
          }
          col++; start = j + 1;
          if (col > lastIdx) break;
        }
      }
    } else {
      const cells = splitLine(raw.replace(/\r$/, ''));
      for (const [idx, name] of picks) o[name] = (cells[idx] ?? '').trim();
    }

    if (o.HomeTeam && o.AwayTeam) out.push(o);
  }
  return out;
}
