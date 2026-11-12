/* ════════════════════════════════════════════════════════════════
   odds — bookmaker prices from The Odds API, free tier.

   500 credits a month is the whole design constraint. A credit is
   charged per market per region, so a sweep of N leagues asking for 1X2
   from one region costs N credits.

   What is kept for each match:
     · the price at YOUR bookmaker (1xBet), because a bet is only ever
       placed at one book and an expected value worked out at the best
       price across twenty-seven of them describes a bet you cannot make
     · a fair probability with the margin stripped — from Pinnacle when
       it is quoting, otherwise from the middle of the other books
     · the best price on offer anywhere, for reference

     /jobs/odds                    sweep the next slice of leagues
     /jobs/odds?league=soccer_epl  one league, cursor untouched
     /jobs/odds?list=1             show active soccer leagues, costs nothing

   Needs ODDS_API_KEY. Spends zero API-Football calls.
   ════════════════════════════════════════════════════════════════ */
import { FV, iso, shift, pack, unpackObj, ok, bad } from './lib.mjs';
import { fixtureKey } from './names.mjs';

const BASE    = 'https://api.the-odds-api.com/v4';
const REGION  = 'eu';        // one region only — each extra region costs a credit per league
const MONTHLY = 450;         // stop short of 500 so a mistake cannot exhaust the quota

/* Credits are charged per market per region, so markets are the expensive
   axis. The arithmetic for a daily sweep over 30 days:

     12 leagues x 1 market  = 12/day = 360/month   fits
     12 leagues x 2 markets = 24/day = 720/month   does not

   So 1X2 is fetched for every league every day, and over/under for
   TOTALS_PER_DAY of them — 15 credits a day, 450 a month, the cap.

   Which leagues get over/under ROTATES. It used to be the same three
   every day, so nine leagues never had a totals price at all. That
   matters far more than it sounds: 1X2 says how much better one side is,
   but only a totals price says how many goals to expect, and with both
   the app can rebuild markets nobody quotes. Measured against simulated
   truth, the error on the half-time draw fell from 3.4 points to 1.0
   when a totals price was available, and on both-teams-to-score from
   7.7 to 1.4. A totals line barely moves from day to day, so the last
   one fetched is carried forward until the next. With twelve leagues
   each gets a fresh one every fourth day, and every match is inside the
   stored window for four days, so every match meets one. */
const MARKET_MAIN  = 'h2h';
const MARKET_TOTAL = 'totals';
const TOTALS_PER_DAY = 3;

/* Prices are kept for today and the next few days only. The app shows
   nothing further ahead, and every extra date is another document to
   read and write. */
const AHEAD_DAYS = 3;

/* The bookmaker you actually bet with, as The Odds API names it. */
export const MY_BOOK = 'onexbet';

/* The reference the fair probability is taken from. Pinnacle takes the
   largest stakes at the thinnest margin and moves on information, so
   its price with the margin stripped is the best public estimate of the
   true chance. When it is not quoting, the middle of the other books is
   used instead — never a single soft book, whose price is too far off
   to judge anything by. */
export const SHARP_BOOK = 'pinnacle';
const MIN_CONSENSUS = 4;

/* Leagues swept per invocation.

   The sweep used to try all twelve in one run and stop on a wall-clock
   guard when it ran out of time. It always ran out — The Odds API takes
   three to seven seconds per league — so it only ever reached the first
   three. Those three are the big domestic leagues, which play at
   weekends, so midweek competitions at the bottom of the list were never
   priced at all: on a Tuesday the card looked empty even though the job
   reported success.

   A cursor fixes it properly. Each run takes a slice and records where it
   stopped; the next run resumes there and the list cycles. A slow API
   delays the cycle instead of permanently truncating it. */
const PER_RUN = 3;

/* Leagues to sweep, in priority order. Anything not in season is skipped
   for free, so an over-long list costs nothing. */
const LEAGUES = [
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_germany_bundesliga',
  'soccer_italy_serie_a',
  'soccer_france_ligue_one',
  'soccer_netherlands_eredivisie',
  'soccer_portugal_primeira_liga',
  'soccer_belgium_first_div',
  'soccer_england_efl_cham',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_turkey_super_league'
];

export default async function odds(D, env, url) {
  const started = Date.now();
  try {
    const key = env.ODDS_API_KEY;
    if (!key) {
      return bad('ODDS_API_KEY is not set. Get a free key at the-odds-api.com ' +
                 '(500 credits/month) and add it to the Worker as a secret.', 400);
    }

    const metaRef = D.doc('meta/odds');
    const meta = (await metaRef.get()).data() || {};

    /* monthly quota resets on the 1st */
    const month = iso().slice(0, 7);
    let used = meta.month === month ? (meta.used || 0) : 0;

    /* ---- free listing of what is actually in season ---- */
    const sportsRes = await fetch(`${BASE}/sports?apiKey=${key}`, { signal: AbortSignal.timeout(7000) });
    if (!sportsRes.ok) {
      const body = await sportsRes.text().catch(() => '');
      return bad(`Odds API rejected the key (HTTP ${sportsRes.status}). ${body.slice(0, 120)}`, 502);
    }
    const sports = await sportsRes.json();
    const live = new Set(sports.filter(s => s.active).map(s => s.key));

    if (url.searchParams.get('list')) {
      return ok({
        creditsSpent: 0,
        note: 'the /sports listing is free and does not count against the quota',
        activeSoccerLeagues: sports.filter(s => s.active && s.key.startsWith('soccer_'))
          .map(s => ({ key: s.key, title: s.title })),
        configured: LEAGUES,
        configuredAndInSeason: LEAGUES.filter(l => live.has(l))
      });
    }

    const forced   = url.searchParams.get('league');
    const inSeason = LEAGUES.filter(l => live.has(l));

    /* Resume where the last run stopped. Out-of-season leagues are filtered
       before the cursor is applied, so a competition going out of season
       shifts the list rather than leaving a dead slot in the rotation. */
    let cursor = Number(meta.cursor || 0);
    if (!Number.isFinite(cursor) || cursor >= inSeason.length) cursor = 0;

    const cap = Math.min(Number(url.searchParams.get('budget')) || PER_RUN, 20);
    const startIdx = forced ? 0 : cursor;
    const targets  = forced
      ? [forced].filter(l => live.has(l))
      : inSeason.slice(cursor, cursor + cap);

    if (!targets.length) {
      return ok({
        swept: [], creditsSpent: 0,
        note: forced ? `${forced} is not in season or not a valid key` :
                       'none of the configured leagues are currently in season'
      });
    }
    if (used >= MONTHLY) {
      return ok({ skipped: 'monthly odds budget reached', used, limit: MONTHLY });
    }

    /* ---- sweep ---- */
    const byDate = new Map();       // "YYYY-MM-DD" -> { key: priced }
    const swept  = [];
    let remaining = null;

    let processed = 0;

    /* Today's over/under leagues, by position in the in-season list. The
       same answer on every invocation of the day, so the four slices of
       one sweep agree with each other. */
    const dayNo = Math.floor(Date.now() / 864e5);
    const totalsToday = new Set();
    for (let j = 0; j < Math.min(TOTALS_PER_DAY, inSeason.length); j++)
      totalsToday.add((dayNo * TOTALS_PER_DAY + j) % inSeason.length);
    const lastDay = shift(AHEAD_DAYS), now = Date.now();
    let inPlay = 0, tooFar = 0;

    for (let i = 0; i < targets.length; i++) {
      const sport = targets[i];
      if (used >= MONTHLY) { swept.push({ sport, skipped: 'budget' }); break; }
      /* Safety net only. PER_RUN is what bounds the run now, so hitting
         this means the API is unusually slow — the cursor stays put and
         the next invocation picks up this same league. */
      if (Date.now() - started > 22000) { swept.push({ sport, skipped: 'time' }); break; }

      /* Counted before the call, not after: a league that errors or returns
         a bad status still advances the cursor. Retrying it on every run
         would stall the rotation on one broken league and the competitions
         behind it would never be priced — the failure this whole cursor
         exists to prevent. */
      processed++;

      const withTotals = (forced ? url.searchParams.get('totals') === '1'
                                 : totalsToday.has(startIdx + i)) && (used + 2) <= MONTHLY;
      const markets = withTotals ? `${MARKET_MAIN},${MARKET_TOTAL}` : MARKET_MAIN;

      try {
        const q = `${BASE}/sports/${sport}/odds?apiKey=${key}` +
                  `&regions=${REGION}&markets=${markets}&oddsFormat=decimal`;
        const res = await fetch(q, { signal: AbortSignal.timeout(7000) });

        const spent = Number(res.headers.get('x-requests-last'));
        used += Number.isFinite(spent) && spent > 0 ? spent : (withTotals ? 2 : 1);
        const rem = Number(res.headers.get('x-requests-remaining'));
        if (Number.isFinite(rem)) remaining = rem;

        if (!res.ok) { swept.push({ sport, error: `HTTP ${res.status}` }); continue; }

        const events = await res.json();
        let priced = 0;

        for (const ev of events) {
          const date = (ev.commence_time || '').slice(0, 10);
          if (!date) continue;
          /* A match that has kicked off is quoted at in-play prices.
             Storing those would overwrite the pre-match price with one
             that already knows the score. */
          if (Date.parse(ev.commence_time) <= now) { inPlay++; continue; }
          if (date > lastDay) { tooFar++; continue; }
          const p = priceEvent(ev);
          if (!p) continue;
          /* the league it came from: lets a provisional fixture list be
             built for a day the fixture feed cannot reach yet */
          p.sk = sport;
          if (!byDate.has(date)) byDate.set(date, {});
          byDate.get(date)[fixtureKey(ev.home_team, ev.away_team)] = p;
          priced++;
        }
        swept.push({ sport, markets, events: events.length, priced });
      } catch (e) {
        swept.push({ sport, error: e.message });
      }
    }

    /* ---- store, one document per date ----
       All dates are read in one request and written in one. Doing a
       read and a write per date put a busy sweep within a few calls of
       the fifty-subrequest ceiling a free Worker is allowed. */
    const dates = [...byDate.keys()];
    const refs  = dates.map(d => D.doc(`odds/${d}`));
    const prevs = refs.length ? await D.getAll(...refs) : [];
    const batch = D.batch();
    let carried = 0;
    dates.forEach((date, i) => {
      const prev = prevs[i] && prevs[i].exists ? unpackObj(prevs[i].data().o) : {};
      const map = byDate.get(date);
      for (const [k, p] of Object.entries(map)) {
        /* no totals fetched for this league today: keep the last one */
        if (!p.ou && prev[k] && prev[k].ou) { p.ou = { ...prev[k].ou, c: 1 }; carried++; }
      }
      const merged = { ...prev, ...map };              // newest price wins
      batch.set(refs[i], {
        date,
        o: pack(merged),            // JSON string: a day of prices is too big to encode natively
        n: Object.keys(merged).length,
        u: FV.serverTimestamp()
      }, { merge: true });
    });
    if (dates.length) await batch.commit();
    const written = dates.length;

    /* retention: drop odds outside the seven-day fixture window */
    const purged = await purge(D);

    /* A forced single-league run is a manual spot check, so it must not
       disturb the rotation the scheduled runs depend on. */
    const nextCursor = forced
      ? cursor
      : (inSeason.length ? (startIdx + processed) % inSeason.length : 0);

    await metaRef.set({
      month, used,
      remaining,
      cursor: nextCursor,
      lastSweep: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      region: REGION, markets: `${MARKET_MAIN} (+${MARKET_TOTAL} for ${TOTALS_PER_DAY} leagues a day, rotating)`
    }, { merge: true });

    return ok({
      swept,
      datesWritten: written,
      matchesPriced: [...byDate.values()].reduce((a, m) => a + Object.keys(m).length, 0),
      withYourBookmaker: [...byDate.values()].reduce((a, m) => a + Object.values(m).filter(p => p.x).length, 0),
      fairFromSharpBook: [...byDate.values()].reduce((a, m) => a + Object.values(m).filter(p => p.bk === SHARP_BOOK).length, 0),
      totalsCarriedForward: carried,
      skipped: { alreadyKickedOff: inPlay, beyondWindow: tooFar },
      leaguesThisRun: `${startIdx + 1}-${startIdx + processed} of ${inSeason.length} in season`,
      nextRunStartsAt: forced ? '(unchanged — single-league run)' : inSeason[nextCursor] || '(start)',
      cycleComplete: !forced && nextCursor === 0,
      creditsUsedThisMonth: used,
      creditsRemaining: remaining,
      monthlyCap: MONTHLY,
      purgedDates: purged,
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('odds failed:', e);
    return bad(e.message);
  }
}

/* ════════════════════════════════════════════════════════════════
   Turn one event's bookmaker list into a single priced record.
   ════════════════════════════════════════════════════════════════ */
export function priceEvent(ev) {
  const home = ev.home_team, away = ev.away_team;
  if (!home || !away || !Array.isArray(ev.bookmakers) || !ev.bookmakers.length) return null;

  /* every book with a complete 1X2 quote */
  const quotes = [];
  for (const bk of ev.bookmakers) {
    const m = (bk.markets || []).find(x => x.key === 'h2h');
    if (!m || !Array.isArray(m.outcomes)) continue;
    const px = { h: 0, d: 0, a: 0 };
    for (const o of m.outcomes) {
      const v = Number(o.price);
      if (!Number.isFinite(v) || v <= 1) continue;
      if (o.name === home) px.h = v;
      else if (o.name === away) px.a = v;
      else if (/draw/i.test(o.name)) px.d = v;
    }
    if (!px.h || !px.d || !px.a) continue;
    quotes.push({ key: bk.key, px: [px.h, px.d, px.a], over: 1 / px.h + 1 / px.d + 1 / px.a });
  }
  if (!quotes.length) return null;

  const best = [0, 0, 0], bestBook = [null, null, null];
  for (const q of quotes) for (let k = 0; k < 3; k++)
    if (q.px[k] > best[k]) { best[k] = q.px[k]; bestBook[k] = q.key; }

  const ref  = reference(quotes);
  const mine = quotes.find(q => q.key === MY_BOOK);
  const ou   = priceTotals(ev);

  return {
    ...(ou ? { ou } : {}),
    hn: home, an: away,
    ts: ev.commence_time || null,
    t: Math.round(Date.now() / 60000),                           // when fetched, epoch minutes
    ...(mine ? { x: mine.px.map(v => round(v)) } : {}),          // your bookmaker's prices
    bh: round(best[0]), bd: round(best[1]), ba: round(best[2]),  // best anywhere
    bb: bestBook,
    /* 5dp keeps the three within 1e-5 of summing to 1, which is far below
       anything that affects an expected value, while staying compact */
    fh: round(ref.fair[0], 5), fd: round(ref.fair[1], 5), fa: round(ref.fair[2], 5),
    bk: ref.src,                                                 // 'pinnacle', 'consensus', or a lone book
    ov: round(ref.over, 4),
    books: quotes.length
  };
}

const median = a => {
  const b = [...a].sort((x, y) => x - y), n = b.length;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
};

/* The fair probabilities for one market, and where they came from.

   Pinnacle when it is quoting. Otherwise the median, outcome by outcome,
   of every other book's devigged price — with your own bookmaker left
   out of it, since its price is the thing being judged. Only when there
   are too few books for a median to mean anything does it fall back to
   the single book with the thinnest margin, and it says so. */
export function reference(quotes) {
  const sharp = quotes.find(q => q.key === SHARP_BOOK);
  if (sharp) return { fair: devig(sharp.px), src: SHARP_BOOK, over: sharp.over };

  const others = quotes.filter(q => q.key !== MY_BOOK);
  const pool = others.length >= MIN_CONSENSUS ? others : quotes;
  if (pool.length >= MIN_CONSENSUS) {
    const dv = pool.map(q => devig(q.px));
    const mid = dv[0].map((_, k) => median(dv.map(d => d[k])));
    const tot = mid.reduce((a, b) => a + b, 0);
    return { fair: mid.map(p => p / tot), src: 'consensus', over: median(pool.map(q => q.over)) };
  }
  const thin = [...pool].sort((a, b) => a.over - b.over)[0];
  return { fair: devig(thin.px), src: thin.key, over: thin.over };
}

/* ════════════════════════════════════════════════════════════════
   Strip the bookmaker margin.

   Implied probabilities from decimal odds sum to more than 1 — that
   excess is the margin. Dividing each by the total (the "proportional"
   method) is the obvious fix and the wrong one: it shaves the same
   fraction off every outcome, which over-corrects favourites and
   under-corrects longshots, because margin is not spread evenly.

   The power method solves for k where sum(p_i^k) = 1. It takes more
   from longshots than favourites, which matches how books actually
   price, and it is what the favourite-longshot literature supports.
   ════════════════════════════════════════════════════════════════ */
export function devig(decimals) {
  const raw = decimals.map(o => 1 / o);
  const over = raw.reduce((a, b) => a + b, 0);
  if (!(over > 1)) return raw.map(p => p / over);   // no margin: just normalise

  let lo = 0.5, hi = 3;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    const s = raw.reduce((a, p) => a + Math.pow(p, k), 0);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const out = raw.map(p => Math.pow(p, k));
  const tot = out.reduce((a, b) => a + b, 0);
  return out.map(p => p / tot);                      // tidy any residual
}

/* Over/under 2.5, when the totals market was fetched for this league.
   Only that line is kept: it is the one nearly every book quotes near
   even money, and the one that says most about expected goals. */
export function priceTotals(ev, line = 2.5) {
  const quotes = [];
  for (const bk of ev.bookmakers || []) {
    const m = (bk.markets || []).find(x => x.key === 'totals');
    if (!m || !Array.isArray(m.outcomes)) continue;
    let o = 0, u = 0;
    for (const x of m.outcomes) {
      if (Number(x.point) !== line) continue;
      const v = Number(x.price);
      if (!Number.isFinite(v) || v <= 1) continue;
      if (/over/i.test(x.name)) o = v;
      else if (/under/i.test(x.name)) u = v;
    }
    if (!o || !u) continue;
    quotes.push({ key: bk.key, px: [o, u], over: 1 / o + 1 / u });
  }
  if (!quotes.length) return null;

  const ref  = reference(quotes);
  const mine = quotes.find(q => q.key === MY_BOOK);
  return {
    line,
    t: Math.round(Date.now() / 60000),
    ...(mine ? { x: mine.px.map(v => round(v)) } : {}),
    bo: round(Math.max(...quotes.map(q => q.px[0]))),
    bu: round(Math.max(...quotes.map(q => q.px[1]))),
    fo: round(ref.fair[0], 5), fu: round(ref.fair[1], 5),
    bk: ref.src, books: quotes.length
  };
}

export { fixtureKey };          // re-exported for tests

const round = (v, dp = 2) => +Number(v).toFixed(dp);

async function purge(D) {
  const cut = new Date(); cut.setUTCDate(cut.getUTCDate() - 4);
  const snap = await D.collection('odds').where('date', '<', cut.toISOString().slice(0, 10)).limit(30).get();
  if (snap.empty) return 0;
  const batch = D.batch();
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

