/* ════════════════════════════════════════════════════════════════
   odds — bookmaker prices from The Odds API, free tier.

   500 credits a month, which is the whole design constraint. A credit
   is charged per market per region, so one sweep of N leagues asking
   for 1X2 from one region costs N credits. Twelve leagues daily is
   360 a month and fits; adding over/under would double it and would
   not.

   The /v4/sports listing is free and does not count, so the function
   discovers which leagues are actually in season rather than wasting
   credits on competitions that are not playing.

   Open in a browser:
     /.netlify/functions/odds                 sweep the configured leagues
     /.netlify/functions/odds?league=soccer_epl
     /.netlify/functions/odds?list=1          show active soccer leagues, costs nothing
     /.netlify/functions/odds?budget=5        cap this run at 5 credits

   Needs ODDS_API_KEY in the Netlify environment.
   Spends ZERO API-Football calls.
   ════════════════════════════════════════════════════════════════ */
import { FV, iso, pack, unpackObj, ok, bad } from './lib.mjs';
import { fixtureKey } from './names.mjs';

const BASE    = 'https://api.the-odds-api.com/v4';
const REGION  = 'eu';        // one region only — each extra region costs a credit per league
const MONTHLY = 450;         // stop short of 500 so a mistake cannot exhaust the quota

/* Credits are charged per market per region, so markets are the expensive
   axis. The arithmetic for a daily sweep over 30 days:

     12 leagues x 1 market  = 12/day = 360/month   fits
     12 leagues x 2 markets = 24/day = 720/month   does not

   So only the first FULL_MARKETS leagues get over/under as well as 1X2;
   the rest get 1X2 alone. Default is 3, which costs 15/day = 450/month,
   exactly the cap. Raise it only if you shorten the league list too. */
const MARKET_MAIN  = 'h2h';
const MARKET_TOTAL = 'totals';
const FULL_MARKETS = 3;

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

/* Sharp books first — their prices carry the least margin, so devigging
   one of them gives the most honest fair probability. */
const SHARP = ['pinnacle', 'betfair_ex_eu', 'matchbook', 'smarkets', 'williamhill', 'betfair'];

export default async function odds(D, env, url) {
  const started = Date.now();
  try {
    const key = env.ODDS_API_KEY;
    if (!key) {
      return bad('ODDS_API_KEY is not set. Get a free key at the-odds-api.com ' +
                 '(500 credits/month) and add it in Netlify → Environment variables.', 400);
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

    const forced  = url.searchParams.get('league');
    const cap     = Math.min(Number(url.searchParams.get('budget')) || LEAGUES.length, 20);
    const targets = (forced ? [forced] : LEAGUES).filter(l => live.has(l)).slice(0, cap);

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

    for (let i = 0; i < targets.length; i++) {
      const sport = targets[i];
      if (used >= MONTHLY) { swept.push({ sport, skipped: 'budget' }); break; }
      if (Date.now() - started > 6500) { swept.push({ sport, skipped: 'time' }); break; }

      /* only the highest-priority leagues can afford the second market */
      const withTotals = i < FULL_MARKETS && (used + 2) <= MONTHLY;
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
          const p = priceEvent(ev);
          if (!p) continue;
          const date = (ev.commence_time || '').slice(0, 10);
          if (!date) continue;
          if (!byDate.has(date)) byDate.set(date, {});
          byDate.get(date)[fixtureKey(ev.home_team, ev.away_team)] = p;
          priced++;
        }
        swept.push({ sport, markets, events: events.length, priced });
      } catch (e) {
        swept.push({ sport, error: e.message });
      }
    }

    /* ---- store, one document per date ---- */
    let written = 0;
    for (const [date, map] of byDate) {
      const ref = D.doc(`odds/${date}`);
      const prev = (await ref.get()).data() || {};
      const merged = { ...unpackObj(prev.o), ...map };   // newest price wins
      await ref.set({
        date,
        o: pack(merged),            // JSON string: a day of prices is too big to encode natively
        n: Object.keys(merged).length,
        u: FV.serverTimestamp()
      }, { merge: true });
      written++;
    }

    /* retention: drop odds outside the seven-day fixture window */
    const purged = await purge(D);

    await metaRef.set({
      month, used,
      remaining,
      lastSweep: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      region: REGION, markets: `${MARKET_MAIN} (+${MARKET_TOTAL} on top ${FULL_MARKETS})`
    }, { merge: true });

    return ok({
      swept,
      datesWritten: written,
      matchesPriced: [...byDate.values()].reduce((a, m) => a + Object.keys(m).length, 0),
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

  /* best available price per outcome — what you would actually bet at */
  const best = { h: 0, d: 0, a: 0 };
  const bestBook = { h: null, d: null, a: null };

  /* and the sharpest single book, for devigging */
  let sharp = null, sharpRank = 1e9, sharpOver = 1e9;

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

    for (const k of ['h', 'd', 'a']) {
      if (px[k] > best[k]) { best[k] = px[k]; bestBook[k] = bk.key; }
    }

    const over = 1 / px.h + 1 / px.d + 1 / px.a;
    const rank = SHARP.indexOf(bk.key);
    const r = rank === -1 ? 500 : rank;
    /* prefer a known sharp book; among unknowns prefer the lowest margin */
    if (r < sharpRank || (r === sharpRank && over < sharpOver)) {
      sharpRank = r; sharpOver = over; sharp = { key: bk.key, px, over };
    }
  }

  if (!sharp || !best.h || !best.d || !best.a) return null;

  const fair = devig([sharp.px.h, sharp.px.d, sharp.px.a]);
  const ou   = priceTotals(ev);

  return {
    ...(ou ? { ou } : {}),
    hn: home, an: away,
    ts: ev.commence_time || null,
    bh: round(best.h), bd: round(best.d), ba: round(best.a),     // best prices
    bb: [bestBook.h, bestBook.d, bestBook.a],                    // where each was found
    /* 5dp keeps the three within 1e-5 of summing to 1, which is far below
       anything that affects an edge calculation, while staying compact */
    fh: round(fair[0], 5), fd: round(fair[1], 5), fa: round(fair[2], 5),
    bk: sharp.key,
    ov: round(sharp.over, 4),                                    // that book's overround
    books: ev.bookmakers.length
  };
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

/* Over/under, when the totals market was fetched for this league.
   Only the 2.5 line is kept — it is the one the model prices, and the
   one nearly every book quotes near even money, which is what the
   Flip x2 strategy is looking for. */
export function priceTotals(ev, line = 2.5) {
  let bestOver = 0, bestUnder = 0;
  let sharp = null, sharpRank = 1e9, sharpOver = 1e9;

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

    if (o > bestOver)  bestOver = o;
    if (u > bestUnder) bestUnder = u;

    const over = 1 / o + 1 / u;
    const rank = SHARP.indexOf(bk.key);
    const r = rank === -1 ? 500 : rank;
    if (r < sharpRank || (r === sharpRank && over < sharpOver)) {
      sharpRank = r; sharpOver = over; sharp = { key: bk.key, o, u };
    }
  }

  if (!sharp || !bestOver || !bestUnder) return null;
  const fair = devig([sharp.o, sharp.u]);
  return {
    line,
    bo: round(bestOver), bu: round(bestUnder),
    fo: round(fair[0], 5), fu: round(fair[1], 5)
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

