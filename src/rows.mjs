/* ════════════════════════════════════════════════════════════════
   rows — hands the backtest page one season of real results.

   The backtest runs in the browser, where there is no CPU limit, but a
   browser cannot read football-data.co.uk directly (the site sends no
   cross-origin header). So the page asks the Worker, the Worker fetches
   the file, and passes back only the columns the model uses. Nothing is
   read from or written to the database.

     /jobs/rows?list=1                  the leagues and seasons to ask for
     /jobs/rows?league=E0&season=2526   one season of one league

   Each row is
     [date, home, away, FT home, FT away, HT home, HT away,
      shots home, shots away, on target home, on target away,
      [closing home, draw, away] | null, [closing over, under 2.5] | null]

   Only the twenty leagues the import knows and a four-digit season are
   accepted, so this cannot be used to fetch anything else.
   ════════════════════════════════════════════════════════════════ */
import { LEAGUES, BASE, parseCSV, parseDate, num, closing, seasonFolders } from './history.mjs';
import { bad } from './lib.mjs';

const json = (body, maxAge) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json', 'cache-control': `private, max-age=${maxAge}` }
});

export default async function rows(D, env, url) {
  /* what the backtest should ask for: the leagues the import knows, and
     this season plus the three before it */
  if (url.searchParams.get('list')) {
    const cur = seasonFolders()[0];
    const y = 2000 + Number(cur.slice(0, 2));
    const f = n => String(n % 100).padStart(2, '0') + String((n + 1) % 100).padStart(2, '0');
    return json({ ok: true, leagues: LEAGUES.map(l => ({ code: l.code, name: `${l.country} ${l.name}` })),
                  seasons: [f(y - 3), f(y - 2), f(y - 1), cur] }, 600);
  }

  const code = String(url.searchParams.get('league') || '').toUpperCase();
  const league = LEAGUES.find(l => l.code.toUpperCase() === code);
  if (!league) {
    return bad(`unknown league "${code}". Codes: ${LEAGUES.map(l => l.code).join(', ')}`, 400);
  }
  const current = seasonFolders()[0];
  const season = url.searchParams.get('season') || current;
  if (!/^\d{4}$/.test(season)) return bad('season must be four digits, e.g. 2526', 400);

  /* a finished season never changes; the current one is updated twice a week */
  const maxAge = season === current ? 3600 : 86400;
  const head = { ok: true, league: league.code, name: `${league.country} ${league.name}`, season };

  let res;
  try { res = await fetch(`${BASE}/${season}/${league.code}.csv`); }
  catch (e) { return json({ ...head, n: 0, rows: [], note: 'fetch failed: ' + e.message }, 60); }
  if (!res.ok) return json({ ...head, n: 0, rows: [], note: `HTTP ${res.status} — no file for this season` }, 600);

  const out = [];
  for (const r of parseCSV(await res.text())) {
    const date = parseDate(r.Date);
    const gh = num(r.FTHG), ga = num(r.FTAG);
    if (!date || gh == null || ga == null || !r.HomeTeam || !r.AwayTeam) continue;
    const c = closing(r);
    out.push([date, r.HomeTeam, r.AwayTeam, gh, ga, num(r.HTHG), num(r.HTAG),
              num(r.HS), num(r.AS), num(r.HST), num(r.AST), c.x, c.t]);
  }
  return json({ ...head, n: out.length, rows: out }, maxAge);
}
