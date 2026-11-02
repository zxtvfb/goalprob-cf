/* ════════════════════════════════════════════════════════════════
   Team-name matching.

   football-data.co.uk writes "Man United", "Nott'm Forest",
   "Ein Frankfurt". API-Football writes "Manchester United",
   "Nottingham Forest", "Eintracht Frankfurt". Nothing links them,
   so every imported row has to be matched by name or it lands on
   a second, duplicate team.

   Three passes: exact alias, normalised string, token overlap.
   ════════════════════════════════════════════════════════════════ */

/* Hand-written for the pairs that no algorithm resolves.
   Keys are normalised football-data.co.uk names. */
export const ALIASES = {
  // England
  'man united': 'manchester united', 'man utd': 'manchester united',
  'man city': 'manchester city',
  'nottm forest': 'nottingham forest', 'nott m forest': 'nottingham forest',
  'sheffield weds': 'sheffield wednesday', 'sheffield united': 'sheffield utd',
  'west brom': 'west bromwich albion', 'wolves': 'wolverhampton wanderers',
  'spurs': 'tottenham', 'tottenham hotspur': 'tottenham',
  'newcastle': 'newcastle united', 'leeds': 'leeds united',
  'west ham': 'west ham united', 'brighton': 'brighton hove albion',
  'qpr': 'queens park rangers', 'peterboro': 'peterborough united',
  'birmingham': 'birmingham city', 'blackburn': 'blackburn rovers',
  'bolton': 'bolton wanderers', 'bristol city': 'bristol city',
  'cardiff': 'cardiff city', 'coventry': 'coventry city',
  'derby': 'derby county', 'huddersfield': 'huddersfield town',
  'hull': 'hull city', 'ipswich': 'ipswich town',
  'leicester': 'leicester city', 'luton': 'luton town',
  'norwich': 'norwich city', 'oxford': 'oxford united',
  'plymouth': 'plymouth argyle', 'preston': 'preston north end',
  'stoke': 'stoke city', 'swansea': 'swansea city',
  'wigan': 'wigan athletic', 'charlton': 'charlton athletic',
  'crystal palace': 'crystal palace', 'bournemouth': 'afc bournemouth',

  // Germany
  'ein frankfurt': 'eintracht frankfurt',
  'bayern munich': 'bayern munchen', 'dortmund': 'borussia dortmund',
  'mgladbach': 'borussia monchengladbach', 'm gladbach': 'borussia monchengladbach',
  'leverkusen': 'bayer leverkusen', 'hoffenheim': 'tsg hoffenheim',
  'stuttgart': 'vfb stuttgart', 'werder bremen': 'werder bremen',
  'hertha': 'hertha bsc', 'schalke 04': 'schalke 04',
  'wolfsburg': 'vfl wolfsburg', 'mainz': 'mainz 05',
  'union berlin': 'union berlin', 'rb leipzig': 'rb leipzig',
  'fc koln': 'fc koln', 'augsburg': 'fc augsburg',
  'freiburg': 'sc freiburg', 'bochum': 'vfl bochum',

  // Spain
  'ath madrid': 'atletico madrid', 'atletico madrid': 'atletico madrid',
  'ath bilbao': 'athletic club', 'athletic bilbao': 'athletic club',
  'real madrid': 'real madrid', 'barcelona': 'barcelona',
  'sociedad': 'real sociedad', 'betis': 'real betis',
  'espanol': 'espanyol', 'vallecano': 'rayo vallecano',
  'celta': 'celta vigo', 'alaves': 'alaves',
  'la coruna': 'deportivo la coruna', 'sp gijon': 'sporting gijon',

  // Italy
  // The fixture feed says "Inter"; the odds feed says "Inter Milan". Without
  // this the two keys are inter~x and intermilan~x and the price is filed
  // against a fixture that does not exist — the silent miss this whole
  // alias table is here to prevent.
  'inter': 'inter', 'inter milan': 'inter', 'internazionale': 'inter',
  'fc internazionale milano': 'inter', 'internazionale milano': 'inter',
  'milan': 'ac milan', 'juventus': 'juventus',
  'roma': 'as roma', 'lazio': 'lazio', 'napoli': 'napoli',
  'verona': 'hellas verona', 'parma': 'parma',

  // France
  'paris sg': 'paris saint germain', 'psg': 'paris saint germain',
  'marseille': 'olympique marseille', 'lyon': 'olympique lyonnais',
  'st etienne': 'saint etienne', 'nice': 'ogc nice',
  'rennes': 'stade rennais', 'lille': 'lille',

  // Netherlands / Portugal / Belgium
  // Odds feeds tend to use the short form where fixture feeds use the long
  // one (or the reverse), so both spellings are mapped to one target.
  'psv eindhoven': 'psv', 'ajax': 'ajax', 'afc ajax': 'ajax',
  'feyenoord': 'feyenoord', 'feyenoord rotterdam': 'feyenoord',
  'az': 'az alkmaar', 'az alkmaar': 'az alkmaar',
  'utrecht': 'fc utrecht', 'genk': 'krc genk', 'brugge': 'club brugge',
  'twente': 'fc twente',
  'sp lisbon': 'sporting cp', 'sporting lisbon': 'sporting cp',
  'fc porto': 'porto', 'benfica': 'benfica',
  'sp braga': 'braga', 'guimaraes': 'vitoria guimaraes',
  'club brugge': 'club brugge', 'anderlecht': 'anderlecht',
  'standard': 'standard liege', 'gent': 'kaa gent',
  'sporting braga': 'braga',

  // European competitions. These leagues are swept for prices, so their
  // clubs need both feeds' spellings even though they are not in any of
  // the domestic lists above. Note that an apostrophe normalises to a
  // SPACE, not to nothing: "Borussia M'gladbach" arrives here as
  // "borussia m gladbach", so that is the spelling that has to be mapped.
  'borussia m gladbach': 'borussia monchengladbach',
  'borussia mgladbach': 'borussia monchengladbach',
  'borussia monchengladbach': 'borussia monchengladbach',
  'rb salzburg': 'red bull salzburg', 'fc salzburg': 'red bull salzburg',
  'salzburg': 'red bull salzburg',
  'crvena zvezda': 'red star belgrade', 'fk crvena zvezda': 'red star belgrade',
  'olympiakos piraeus': 'olympiacos', 'olympiakos': 'olympiacos',
  'dinamo zagreb': 'dinamo zagreb', 'gnk dinamo zagreb': 'dinamo zagreb',
  'slavia prague': 'slavia praha', 'sk slavia prague': 'slavia praha',
  'sparta prague': 'sparta praha', 'ac sparta prague': 'sparta praha',
  'shakhtar donetsk': 'shakhtar donetsk', 'fk shakhtar donetsk': 'shakhtar donetsk',
  'bodo glimt': 'bodo glimt', 'fk bodo glimt': 'bodo glimt'
};

/* Words that carry no identifying information once removed consistently. */
const NOISE = new Set([
  'fc','afc','cf','sc','ac','as','ss','ssc','us','usc','rc','cd','ud','sd',
  'club','calcio','futbol','football','fussball','sv','vfb','vfl','tsg','bsc',
  'de','of','the','und','and','1899','1900','1901','1904','1905','1906','1907',
  '1908','1909','1910','1911','1912','1913','04','05','07','08','09','96','98'
]);

/* Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalise(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // é -> e
    .toLowerCase()
    .replace(/['’`.]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Normalise, resolve a known alias, then drop noise words.
   Short numeric tokens ("1." in "1. FC Köln", "04" in "Schalke 04") are
   ordinals or founding-year fragments and carry no identity. Four-digit
   numbers are kept, because for 1860 München the number IS the name.

   Memoised: a season's worth of records mentions the same two dozen
   opponents over and over, and the NFD normalisation plus regexes cost
   about 4 microseconds a call — which adds up fast against the 10 ms
   CPU budget a Worker invocation gets on the free plan. */
const CANON = new Map();

export function canonical(name) {
  const raw = String(name || '');
  const hit = CANON.get(raw);
  if (hit !== undefined) return hit;

  const n = normalise(raw);
  const aliased = ALIASES[n] || n;
  const tokens = normalise(aliased).split(' ').filter(t =>
    t && !NOISE.has(t) && !/^\d{1,2}$/.test(t)
  );
  const out = tokens.length ? tokens.join(' ') : normalise(aliased);

  /* bounded so a long-lived isolate cannot grow it without limit */
  if (CANON.size > 5000) CANON.clear();
  CANON.set(raw, out);
  return out;
}

/* A stable key for one fixture, from its two canonical team names.

   This MUST be computed in exactly one place. An earlier version
   recomputed it in the browser and the two implementations drifted —
   the server produced "arsenal~wolverhamptonwanderers" while the client
   produced "arsenal~wolves", so no bookmaker price ever matched a
   fixture and nothing reported an error. The key is now written onto
   each fixture row by the ingest and simply read by the app. */
export const fixtureKey = (home, away) =>
  canonical(home).replace(/\s+/g, '') + '~' + canonical(away).replace(/\s+/g, '');

/* Jaccard-style token overlap, 0..1. */
export function similarity(a, b) {
  const A = new Set(canonical(a).split(' ').filter(Boolean));
  const B = new Set(canonical(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

/* Build a lookup from existing team docs: canonical name -> {id, name}.
   `teams` is [{id, name}, ...]. */
export function buildIndex(teams) {
  const idx = new Map();
  for (const t of teams) {
    const c = canonical(t.name);
    if (c && !idx.has(c)) idx.set(c, t);
  }
  return idx;
}

/* Resolve one imported name against the index.
   Returns {team, score, how} or null when nothing is close enough. */
export function resolve(name, index, minScore = 0.67) {
  const c = canonical(name);
  if (!c) return null;

  // 1. exact canonical hit
  if (index.has(c)) return { team: index.get(c), score: 1, how: 'exact' };

  // 2. one canonical name contains the other, and the shorter is distinctive
  for (const [key, team] of index) {
    if (key.length < 4 || c.length < 4) continue;
    if (key.startsWith(c + ' ') || c.startsWith(key + ' ') ||
        key.endsWith(' ' + c) || c.endsWith(' ' + key)) {
      return { team, score: 0.9, how: 'prefix' };
    }
  }

  // 3. best token overlap above the floor
  let best = null, bestScore = 0;
  for (const [key, team] of index) {
    const s = similarity(c, key);
    if (s > bestScore) { bestScore = s; best = team; }
  }
  return bestScore >= minScore ? { team: best, score: +bestScore.toFixed(2), how: 'fuzzy' } : null;
}
