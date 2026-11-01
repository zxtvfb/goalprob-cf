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

const BASE = 'https://www.football-data.co.uk/mmz4281';

/* One season and a slice of its teams per invocation. The Workers free
   plan gives 10 ms of CPU per request, and parsing a season costs ~3 ms
   with ~0.2 ms per team on top, so 20 teams leaves comfortable headroom.
   The cursor below walks league -> season -> team offset, so repeated
   calls work through everything without ever doing too much at once.

   Do NOT loop this inside a single request: the CPU of every iteration
   lands on the same invocation. The admin page loops it as separate
   HTTP calls instead, which is what gives each run its own budget. */
const TEAM_CAP = 20;

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

function seasonFolders() {
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

    /* cursor: league index -> season index -> team offset */
    let li = forced ? LEAGUES.findIndex(l => l.code.toUpperCase() === forced.toUpperCase())
                    : (meta.li || 0) % LEAGUES.length;
    let si = Number(meta.si || 0);
    let to = Number(meta.to || 0);
    if (forced) { si = Number(url.searchParams.get('si') || 0); to = Number(url.searchParams.get('to') || 0); }

    if (li < 0) {
      return bad(`unknown league "${forced}". Codes: ${LEAGUES.map(l => l.code).join(', ')}`, 400);
    }

    const league  = LEAGUES[li];
    const seasons = url.searchParams.get('season')
      ? [url.searchParams.get('season')] : seasonFolders();
    if (si >= seasons.length) { si = 0; }
    const season = seasons[si];

    let rows = [];
    const fetched = [];
    try {
      const res = await fetch(`${BASE}/${season}/${league.code}.csv`);
      if (res.ok) {
        rows = parseCSV(await res.text());
        fetched.push({ season, rows: rows.length });
      } else {
        fetched.push({ season, error: `HTTP ${res.status}` });
      }
    } catch (e) {
      fetched.push({ season, error: e.message });
    }

    if (!rows.length) {
      const nx = await advance(metaRef, { li, si, to }, seasons.length, true, forced);
      return ok({ league: league.code, season, fetched, matches: 0,
                  note: 'no rows — the season file may not exist yet', next: nx });
    }

    const perTeam = new Map();
    let skipped = 0;

    for (const r of rows) {
      const home = r.HomeTeam, away = r.AwayTeam;
      const fthg = num(r.FTHG), ftag = num(r.FTAG);
      const hthg = num(r.HTHG), htag = num(r.HTAG);
      const date = parseDate(r.Date);
      if (!home || !away || fthg == null || ftag == null || !date) { skipped++; continue; }

      const id = `fd:${date}:${canonical(home).slice(0, 14)}:${canonical(away).slice(0, 14)}`;

      push(perTeam, home, {
        i: id, d: date, o: away, oi: null, h: 1,
        gf: fthg, ga: ftag, hgf: hthg ?? 0, hga: htag ?? 0, src: 'fd',
        sh: num(r.HS), st: num(r.HST), sha: num(r.AS), sta: num(r.AST),
        od: odds(r, 'H')
      });
      push(perTeam, away, {
        i: id, d: date, o: home, oi: null, h: 0,
        gf: ftag, ga: fthg, hgf: htag ?? 0, hga: hthg ?? 0, src: 'fd',
        sh: num(r.AS), st: num(r.AST), sha: num(r.HS), sta: num(r.HST),
        od: odds(r, 'A')
      });
    }

    /* Match the CSV's team names against what is already stored.

       This used to scan the whole teams collection on every invocation.
       With a few thousand teams that is a few thousand reads per run,
       and a full import needs over a hundred runs — which exhausts the
       50,000 daily reads the Firestore free tier allows after about
       nine leagues. The index is now built once and cached as a single
       document, so a run costs one read instead of thousands. */
    const idx = await teamIndex(D);
    const index = idx.map;

    /* Sorted so the offset means the same thing on every invocation —
       Map iteration order would otherwise depend on insertion. */
    const allTeams = [...perTeam.values()].sort((a, b) => a.name.localeCompare(b.name));
    const entries  = allTeams.slice(to, to + TEAM_CAP);
    const moreTeams = to + TEAM_CAP < allTeams.length;
    const resolved = entries.map(e => {
      const hit = resolve(e.name, index);
      return {
        e, hit,
        docId: hit ? hit.team.id : 'fd_' + canonical(e.name).replace(/\s+/g, '-').slice(0, 60)
      };
    });

    const refs = resolved.map(r => D.doc(`teams/${r.docId}`));
    const prevDocs = refs.length ? await D.getAll(...refs) : [];

    const batch = D.batch();
    let matched = 0, created = 0;
    const unresolved = [];
    const touched = new Set();
    const newTeams = [];

    resolved.forEach((r, i) => {
      if (r.hit) matched++;
      else { created++; unresolved.push(r.e.name); newTeams.push({ id: r.docId, name: r.e.name, lid: 0 }); }
      const prev = prevDocs[i] && prevDocs[i].exists ? prevDocs[i].data() : null;
      if (prev?.lid) touched.add(prev.lid);

      const m = mergeWindow(unpack(prev?.m), r.e.recs);

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
        u:       FV.serverTimestamp()
      }, { merge: true });
    });

    batch.set(D.doc('meta/sync'), {
      lastHistory: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      historySource: 'football-data.co.uk'
    }, { merge: true });

    await batch.commit();
    await extendIndex(D, idx, newTeams);

    /* Rebuild only when this league is finished, so the cost is paid once
       rather than on every slice. Without it the app keeps serving
       pre-import stats and a team shows one match where there are 45. */
    const finishedLeague = !moreTeams && si >= seasons.length - 1;
    const bundles = finishedLeague ? await rebuildLeagues(D, [...touched]) : 0;

    const nx = await advance(metaRef, { li, si, to }, seasons.length, !moreTeams, forced);

    return ok({
      league: `${league.code} — ${league.country} ${league.name}`,
      season,
      fetched,
      matchesParsed: rows.length,
      skippedRows: skipped,
      teamsInFile: allTeams.length,
      teamsWritten: resolved.length,
      teamOffset: to,
      matchedToExisting: matched,
      newTeams: created,
      leagueBundlesRebuilt: bundles,
      nameIndex: idx.built ? `rebuilt from ${idx.size} teams` : `cached (${idx.size} teams)`,
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
   Cached name index: canonical team name -> { id, name, lid }.

   Stored as one packed document. Rebuilt when missing or older than
   six hours, which is the only time the full collection is scanned.
   Teams created during an import are folded in without a rescan.
   ════════════════════════════════════════════════════════════════ */
const INDEX_TTL = 6 * 3600 * 1000;

async function teamIndex(D, force = false) {
  const ref = D.doc('cache/teamindex');
  const snap = await ref.get();
  const v = snap.exists ? snap.data() : null;

  if (!force && v && v.u && (Date.now() - v.u) < INDEX_TTL) {
    return { ref, map: new Map(Object.entries(unpackObj(v.idx))), built: false, size: v.n || 0 };
  }

  const all = [];
  const scan = await D.collection('teams').select('name', 'lid').get();
  scan.forEach(d => all.push({ id: d.id, name: d.data().name, lid: d.data().lid }));

  const map = buildIndex(all);
  await ref.set({
    idx: pack(Object.fromEntries(map)),
    n: all.length,
    u: Date.now()
  });
  return { ref, map, built: true, size: all.length };
}

/* Fold newly created teams into the cached index so the next run can
   match against them without paying for another full scan. */
async function extendIndex(D, idx, added) {
  if (!added.length) return;
  for (const t of added) {
    const c = canonical(t.name);
    if (c && !idx.map.has(c)) idx.map.set(c, t);
  }
  await idx.ref.set({
    idx: pack(Object.fromEntries(idx.map)),
    n: idx.map.size,
    u: Date.now()
  }, { merge: true }).catch(() => {});
}

function push(map, name, rec) {
  const key = canonical(name);
  if (!key) return;
  if (!map.has(key)) map.set(key, { name, recs: [] });
  const e = map.get(key);
  if (e.recs.length < MAX_WINDOW * 2) e.recs.push(rec);
}

/* Move the cursor on: more teams in this season -> bump the offset;
   season finished -> next season; both finished -> next league. */
async function advance(ref, { li, si, to }, seasonCount, teamsDone, forced) {
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
    await ref.set({ ...n, u: Date.now() }, { merge: true }).catch(() => {});
  }
  return {
    ...n,
    league: LEAGUES[n.li].code,
    done: wrapped,
    note: wrapped ? 'every league imported — the cursor wrapped to the start'
                  : `next: ${LEAGUES[n.li].code} season slot ${n.si}, teams from ${n.to}`
  };
}

const num = v => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function odds(r, side) {
  const keys = side === 'H'
    ? ['B365CH', 'PSCH', 'MaxCH', 'AvgCH', 'B365H', 'PSH', 'AvgH']
    : ['B365CA', 'PSCA', 'MaxCA', 'AvgCA', 'B365A', 'PSA', 'AvgA'];
  for (const k of keys) { const v = num(r[k]); if (v && v > 1) return v; }
  return null;
}

function parseDate(s) {
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
  'B365H','B365A','PSH','PSA','AvgH','AvgA'
]);

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
