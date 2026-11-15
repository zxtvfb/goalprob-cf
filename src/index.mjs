/* ════════════════════════════════════════════════════════════════
   Worker entry point.

   One Worker serves three things:
     · the app itself, from the static assets binding
     · /admin, a control panel that drives the jobs
     · /jobs/<name>, the jobs themselves

   Cron triggers call scheduled() on the schedules in wrangler.toml.

   Every job gets its own invocation and therefore its own CPU budget.
   The admin page loops by issuing separate HTTP requests rather than
   looping inside one, which is the only way repeated work stays under
   the 10 ms per-invocation limit on the free plan.
   ════════════════════════════════════════════════════════════════ */
import { firestore } from './firestore.mjs';
import { ok, bad, toFixtureRow } from './lib.mjs';

import pull    from './pull.mjs';
import digest  from './digest.mjs';
import seed    from './seed.mjs';
import history from './history.mjs';
import odds    from './odds.mjs';
import cleanup from './cleanup.mjs';
import bundles from './bundles.mjs';
import rekey   from './rekey.mjs';
import picks   from './picks.mjs';
import calib   from './calib.mjs';
import rows    from './rows.mjs';
import algos   from './algos.mjs';
import { PM, ST } from './model.mjs';

const JOBS = { pull, digest, seed, history, odds, cleanup, bundles, rekey, picks, calib, rows, algos };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/admin') {
      return new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    if (path.startsWith('/jobs/')) {
      const name = path.slice(6);
      const job = JOBS[name];
      if (!job) {
        return bad(`unknown job "${name}". Available: ${Object.keys(JOBS).join(', ')}`, 404);
      }
      /* optional shared secret; when ADMIN_KEY is unset the endpoints
         are open, which is fine while setting up and worth closing after */
      if (env.ADMIN_KEY && url.searchParams.get('key') !== env.ADMIN_KEY) {
        return bad('bad or missing key', 401);
      }
      try {
        const D = firestore(env);
        return await job(D, env, url);
      } catch (e) {
        return bad(e.message);
      }
    }

    if (path === '/health') {
      /* Probe the DEPLOYED build rather than trusting the repo.

         A fixture is only matched to a price through the `k` field that
         toFixtureRow writes. If a stale lib.mjs is deployed, pull quietly
         stores fixtures without it: the job reports success, the card
         shows "no bookmaker prices", and nothing anywhere says why. This
         runs the real function on a known fixture and reports what came
         back, so a stale deploy is visible in one request. */
      let ingest;
      try {
        const row = toFixtureRow({
          fixture: { id: 0, timestamp: 0, status: { short: 'NS' } },
          league:  { id: 0, name: 'probe', country: '' },
          teams:   { home: { id: 1, name: 'Inter' }, away: { id: 2, name: 'Arsenal' } }
        });
        ingest = row && row.k
          ? `writes odds keys ("${row.k}")`
          : 'STALE BUILD — fixtures are stored WITHOUT an odds key, so no price ' +
            'can ever match one. Redeploy src/lib.mjs and src/names.mjs, then run Repair odds keys.';
      } catch (e) {
        ingest = 'probe failed: ' + e.message;
      }

      /* The engine is one file deployed twice. If only one copy was
         uploaded the Worker and the page would be running different
         models, so the Worker reports exactly what it has. */
      const engine = {
        profileVersion: PM.PROFILE_V,
        shrinkage: PM.K, halfLife: PM.HALF_LIFE,
        marketWeight: [PM.MARKET_W_SOFT, PM.MARKET_W_SHARP],
        ratings: typeof PM.ratings === 'function'
          ? `from closing prices, weight ${PM.W_RATING}, ${PM.RATING_WINDOW}-day window`
          : 'MISSING — src/model.mjs is an older copy',
        yourBookmaker: 'onexbet (1xBet)', fairFrom: ST.SHARP + ', else consensus'
      };

      /* What the scheduled jobs last did, from their own records. One
         look here says whether fixtures are arriving and why not. */
      let status;
      try {
        const D = firestore(env);
        const [pm, am, pk, dg, sy, od] = await D.getAll(D.doc('meta/pull'), D.doc('meta/algos'), D.doc('meta/picks'),
          D.doc('meta/digest'), D.doc('meta/sync'), D.doc('meta/odds'));
        const v = x => (x && x.exists ? x.data() : {});
        const P = v(pm), A = v(am), K = v(pk), G = v(dg), Y = v(sy), O = v(od);
        const q = Array.isArray(P.q) ? P.q : [];
        const parse = x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };
        status = {
          fixtures: {
            lastFetch: P.last || null,
            fixturesStored: P.cnt || {},
            apiCallsToday: P.day === new Date().toISOString().slice(0, 10) ? (P.calls || 0) : 0,
            apiRemaining: P.rem ?? null,
            waitingToStore: q.reduce((a, e) => a + (e.p ? e.p.length : 0), 0) + ' slice(s)',
            lastError: P.err || null
          },
          strategies: { lists: parse(A.done) || {}, now: (parse(A.pass) || {}).step || 'idle' },
          ledger: { lastRun: K.lastRun || null, flipx2: parse(K.totals), htd: parse(K.htd) },
          teamRecords: { lastDigest: Y.lastDigest || null, leagueBundlesWaiting: (parse(G.dirty) || []).length },
          prices: { lastSweep: O.lastSweep || null, creditsUsedThisMonth: O.used ?? null }
        };
      } catch (e) {
        status = 'could not read the job records: ' + e.message;
      }

      return ok({
        worker: 'goalprob',
        jobs: Object.keys(JOBS),
        status,
        ingest,
        engine,
        config: {
          FIREBASE_PROJECT_ID:   env.FIREBASE_PROJECT_ID   ? 'set' : 'MISSING',
          FIREBASE_CLIENT_EMAIL: env.FIREBASE_CLIENT_EMAIL ? 'set' : 'MISSING',
          FIREBASE_PRIVATE_KEY:  env.FIREBASE_PRIVATE_KEY  ? `set (${env.FIREBASE_PRIVATE_KEY.length} chars)` : 'MISSING',
          APIFOOTBALL_KEY:       env.APIFOOTBALL_KEY       ? 'set' : 'MISSING',
          ODDS_API_KEY:          env.ODDS_API_KEY          ? 'set' : 'not set (odds disabled)',
          ADMIN_KEY:             env.ADMIN_KEY             ? 'set' : 'not set (job URLs are open)'
        }
      });
    }

    /* everything else is the app */
    return env.ASSETS.fetch(req);
  },

  /* Cron triggers. One trigger, every two minutes, carries the whole
     schedule — the free plan allows five per ACCOUNT, shared with any
     other Worker on it. Times are UTC (Mauritius is four hours ahead).

       06:30 to 06:52           odds     the day's sweep of bookmaker prices,
                                         one league a run
       :06 and :36              picks    record and grade both ledgers
       :26 and :56              history  this season's results files
       every other tick         pull first, then the strategies, then
                                team records — the first that has
                                something to do does it, the rest wait
                                for the next tick
       every :x8                strategies and team records go first,
                                so a busy pull cannot starve them

     Every run does one small step. Doing a lot in one run is what got
     runs cut off for CPU, which is how fixtures stopped arriving. */
  async scheduled(event, env, ctx) {
    const D = firestore(env);
    const url = new URL('https://cron.local/?cron=1');
    const at = new Date(event.scheduledTime);
    const m = at.getUTCMinutes(), h = at.getUTCHours();

    let order;
    if (event.cron !== TICK) {
      /* an older wrangler.toml with one trigger per job still works */
      order = m < 10 ? ['pull'] : m < 15 ? ['pull'] : m < 30 ? ['digest'] : m < 35 ? ['history'] : m < 40 ? ['picks'] : ['odds'];
    } else if (h === 6 && m >= 30 && m <= 52) order = ['odds', 'pull', 'algos', 'digest'];
    else if (m % 30 === 6) order = ['picks'];
    else if (m % 30 === 26) order = ['history'];
    else if (m % 10 === 8) order = ['algos', 'digest', 'pull'];
    else if (m % 10 === 4) order = ['pull', 'digest', 'algos'];
    else order = ['pull', 'algos', 'digest'];

    for (const job of order) {
      if (job === 'history') url.searchParams.set('auto', '1');
      let j = {};
      try {
        const res = await JOBS[job](D, env, url);
        j = await res.json().catch(() => ({}));
        console.log(`cron ${job}: ${res.status}${j.idle ? ' (nothing to do)' : ''}`);
      } catch (e) {
        console.error(`cron ${job} failed:`, e.message);
        break;
      }
      /* stop at the first job that did some work, or failed */
      if (!(j.ok && (j.idle || j.skipped))) break;
    }
  }
};

/* must match the trigger in wrangler.toml exactly */
const TICK = '*/2 * * * *';

/* ════════════════════════════════════════════════════════════════
   Admin page. Each button fires repeated fetches from the browser,
   one HTTP request per iteration, so the CPU budget resets each time.
   ════════════════════════════════════════════════════════════════ */
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>GoalProb admin</title>
<style>
:root{--bg:#0b0f14;--bg2:#121820;--bg3:#1a222d;--line:#232d3a;--fg:#e8eef5;
      --mut:#8b9bb0;--dim:#5d6b7e;--acc:#2dd4a7;--bad:#f4525f;--warn:#f5a524}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);padding:16px 12px 40px;
     font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:680px;margin:0 auto}
h1{font-size:19px;margin:0 0 4px;letter-spacing:-.3px}
h1 span{color:var(--acc)}
p.sub{color:var(--dim);font-size:12px;margin:0 0 16px}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:13px;margin:10px 0}
.card h2{font-size:14px;margin:0 0 3px}
.card p{font-size:12px;color:var(--dim);margin:0 0 10px;line-height:1.55}
button{width:100%;background:var(--acc);color:#04231b;border:0;border-radius:8px;
       padding:11px;font:inherit;font-weight:700;cursor:pointer}
button.alt{background:var(--bg3);color:var(--fg);border:1px solid var(--line)}
button:disabled{opacity:.45}
input{width:100%;background:var(--bg3);border:1px solid var(--line);color:var(--fg);
      border-radius:8px;padding:10px;font:inherit;margin-bottom:9px}
pre{background:#060a0e;border:1px solid var(--line);border-radius:8px;padding:11px;
    font-size:11px;line-height:1.5;overflow:auto;max-height:320px;white-space:pre-wrap;
    word-break:break-word;color:var(--mut);margin:10px 0 0}
.ok{color:var(--acc)} .err{color:var(--bad)} .warn{color:var(--warn)}
.row{display:flex;gap:8px} .row button{flex:1}
.step{display:inline-block;width:20px;height:20px;border-radius:50%;background:var(--bg3);
      color:var(--acc);font-size:11px;font-weight:700;text-align:center;line-height:20px;margin-right:7px}
</style></head><body><div class="wrap">

<h1>Goal<span>Prob</span> admin</h1>
<p class="sub">Each run is a separate request, so every job gets its own CPU budget. Leave the page open while a loop runs.</p>

<input id="key" placeholder="ADMIN_KEY (leave blank if you did not set one)" autocomplete="off">

<div class="card">
  <h2><span class="step">0</span>Health check</h2>
  <p>Confirms the Worker is up and every secret is in place, and shows what the scheduled jobs last did:
     when fixtures were last fetched, how many are stored for each day, API calls used today, and the
     last error if there was one. Touches nothing.</p>
  <button class="alt" onclick="go('/health',1)">Check configuration and status</button>
</div>

<div class="card">
  <h2><span class="step">1</span>Remove women's competitions</h2>
  <p>Dry run first and read the sample. Then delete — it loops until the collection is clear.</p>
  <div class="row">
    <button class="alt" onclick="go('/jobs/cleanup?women=1&dry=1',1)">Dry run</button>
    <button onclick="loop('/jobs/cleanup?women=1',150,r=>r.done===true)">Delete</button>
  </div>
</div>

<div class="card">
  <h2><span class="step">2</span>Seed the bookmaker league list</h2>
  <p>Writes the editable league list to config/leagues. Once only.</p>
  <button class="alt" onclick="go('/jobs/cleanup?seed=1',1)">Seed list</button>
</div>

<div class="card">
  <h2><span class="step">3</span>Fetch fixtures</h2>
  <p>Fetches yesterday, today and tomorrow now and stores them — one API-Football call per day, then a
     short run for every 180 fixtures (a Saturday is about thirty runs in all, under a minute). It also
     happens by itself all day; use this after an update, or if a day looks empty.</p>
  <button onclick="loop('/jobs/pull?force=1',80,r=>r.done===true)">Pull fixtures</button>
</div>

<div class="card">
  <h2><span class="step">4</span>Build team records</h2>
  <p>Turns finished matches into rolling 45-match windows. No API calls, so it loops freely.</p>
  <button onclick="loop('/jobs/digest',150,r=>r.idle===true)">Run digest until idle</button>
</div>

<div class="card">
  <h2><span class="step">5</span>Import 45-match history</h2>
  <p>Reads football-data.co.uk for 20 leagues across two seasons. No API-Football calls. This is the long one — around 100 requests, a couple of minutes.</p>
  <button onclick="loop('/jobs/history',260,r=>r.done===true)">Import all leagues</button>
</div>

<div class="card">
  <h2><span class="step">5b</span>Refresh this season's results</h2>
  <p>Re-reads the current season only. This is where shots and half-time scores come from — the live feed has neither for most leagues — and where each team's <b>rating from closing prices</b> is worked out. It runs by itself twice an hour, one league at a time, and rewrites only the teams with new results; the button does a full pass now.</p>
  <button class="alt" onclick="loop('/jobs/history?auto=1',60,r=>r.done===true)">Refresh now</button>
</div>

<div class="card">
  <h2><span class="step">6</span>Build league bundles</h2>
  <p>Gives every league on the card a single stats document, rebuilds any team figures made by an older version of the model, and measures the scoring average used for leagues that have none of their own. No API calls. The team-records job keeps the bundles up to date by itself; run this after an update to the model — one league a request, a few hundred short requests on a busy weekend.</p>
  <button onclick="loop('/jobs/bundles',400,r=>r.done===true)">Build all bundles</button>
</div>

<div class="card">
  <h2><span class="step">6b</span>Repair odds keys</h2>
  <p>Writes the price-lookup key onto any stored fixture of the twelve priced leagues that is
     missing it (no other league is ever priced, so no other needs one). Costs no API calls — the
     key is rebuilt from the team names already stored. Run it if the diagnostics page shows a date
     with priced-league fixtures but <i>with key</i> at zero.</p>
  <div class="row">
    <button onclick="loop('/jobs/rekey',80,r=>r.done===true)">Repair missing keys</button>
    <button class="alt" onclick="loop('/jobs/rekey?force=1',80,r=>r.done===true)">Rebuild all keys</button>
  </div>
</div>

<div class="card">
  <h2><span class="step">7</span>Fetch bookmaker prices</h2>
  <p>Needs ODDS_API_KEY. Free tier is 500 credits a month. The sweep runs by itself every morning from 06:30 UTC
     (10:30 your time), one league every two minutes, about 15 credits a day. Each press here prices the next league
     in that rotation, and the log says how many matches came with a 1xBet price.</p>
  <div class="row">
    <button class="alt" onclick="go('/jobs/odds?list=1',1)">List leagues (free)</button>
    <button onclick="go('/jobs/odds',1)">Fetch odds</button>
  </div>
</div>

<div class="card">
  <h2><span class="step">8</span>Algorithm ledger</h2>
  <p>Writes down what Flip x2 selected <b>before</b> kick-off — at your bookmaker's price — then grades it once the result is in.
     A selection is never rewritten afterwards; that is what makes the win rate mean anything.
     Runs every half hour on its own; this button is for catching up. No API calls.</p>
  <div class="row">
    <button onclick="go('/jobs/picks',1)">Record &amp; settle now</button>
    <button class="alt" onclick="if(confirm('Clear the running totals? Recorded days are kept.'))go('/jobs/picks?reset=1',1)">Reset totals</button>
  </div>
</div>

<div class="card">
  <h2><span class="step">8b</span>Refresh the strategies now</h2>
  <p>Flip x2 and HTD run by themselves, for tomorrow, today and the day after: a list is worked out again
     whenever that day's fixtures or prices change, and every six hours regardless. The app shows what they
     saved without anything to press. Use this only to get fresh lists straight away — after an update, or after
     fetching odds by hand. No API calls.</p>
  <button class="alt" onclick="loop('/jobs/algos?force=1',250,r=>r.done===true)">Work the lists out now</button>
</div>

<div class="card">
  <h2><span class="step">9</span>Measure the model against real results</h2>
  <p>Replays four seasons of real results from twenty leagues, compares what the model said with what happened, and works out a correction for each market. Run it once now, and again every month or so. It opens in its own page and does the work in your browser.</p>
  <div class="row">
    <button class="alt" onclick="location.href='/backtest'">Open the backtest</button>
    <button class="alt" onclick="go('/jobs/calib',1)">Show stored corrections</button>
  </div>
</div>

<div class="card">
  <h2>Open the app</h2>
  <p>Everything above feeds this.</p>
  <button class="alt" onclick="location.href='/'">Go to GoalProb</button>
</div>

<pre id="out">Ready.</pre>

<script>
const out = document.getElementById('out');
const keyEl = document.getElementById('key');
try { keyEl.value = localStorage.getItem('gp_admin_key') || ''; } catch {}
keyEl.addEventListener('input', () => { try { localStorage.setItem('gp_admin_key', keyEl.value); } catch {} });

let running = false;
const setBusy = b => { running = b; document.querySelectorAll('button').forEach(x => x.disabled = b); };
const log = (msg, cls) => {
  out.innerHTML = (cls ? '<span class="' + cls + '">' + msg + '</span>' : msg) + '\\n' + out.innerHTML;
  if (out.innerHTML.length > 60000) out.innerHTML = out.innerHTML.slice(0, 60000);
};

function withKey(path) {
  const k = keyEl.value.trim();
  if (!k) return path;
  return path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(k);
}

async function call(path) {
  const res = await fetch(withKey(path));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, json, text };
}

async function go(path, _n) {
  if (running) return;
  setBusy(true);
  out.textContent = '';
  log('→ ' + path);
  try {
    const { res, json, text } = await call(path);
    if (json) log(JSON.stringify(json, null, 2), res.ok && json.ok !== false ? 'ok' : 'err');
    else log('HTTP ' + res.status + '\\n' + text.slice(0, 1200), 'err');
  } catch (e) {
    log('request failed: ' + e.message, 'err');
  }
  setBusy(false);
}

/* Repeats the call as separate requests until done() says stop. */
async function loop(path, max, done) {
  if (running) return;
  setBusy(true);
  out.textContent = '';
  log('→ ' + path + '  (up to ' + max + ' runs)');
  let i = 0;
  try {
    for (; i < max; i++) {
      const { res, json, text } = await call(path);
      if (!json) { log('run ' + (i+1) + ': HTTP ' + res.status + ' ' + text.slice(0, 300), 'err'); break; }
      if (json.ok === false) { log('run ' + (i+1) + ' failed: ' + json.error, 'err'); break; }

      const summary = [
        json.league && ('league ' + json.league.split(' ')[0]),
        json.season && ('season ' + json.season),
        json.teamsWritten != null && (json.teamsWritten + ' teams'),
        json.matches != null && (json.matches + ' matches'),
        json.womensTeamsRemoved != null && (json.womensTeamsRemoved + ' removed'),
        json.remaining != null && (json.remaining + ' left'),
        json.scannedTeams != null && ('scanned ' + json.scannedTeams),
        json.processed && json.processed,
        json.bundlesBuilt != null && (json.bundlesBuilt + ' bundles'),
        json.keysWritten != null && (json.keysWritten + ' keys on ' +
          (json.chunksRewritten || 0) + ' chunk(s)'),
        json.statBlocksRebuilt ? (json.statBlocksRebuilt + ' teams re-profiled') : '',
        json.ratings && json.ratings.teamsRatedThisRun != null && (json.ratings.teamsRatedThisRun + ' rated'),
        json.leaguesThisRun && ('leagues ' + json.leaguesThisRun),
        json.matchesPriced != null && (json.matchesPriced + ' priced'),
        json.withYourBookmaker != null && (json.withYourBookmaker + ' with a 1xBet price'),
        json.fairFromSharpBook != null && (json.fairFromSharpBook + ' with Pinnacle'),
        json.pass && json.step && ('strategies ' + (json.date || '') + ': ' + json.step + (json.progress ? ' ' + json.progress : '')),
        json.step === 'fetch' && ('fetched ' + json.date + ': ' + json.fixtures + ' fixtures, ' + json.queued),
        json.step === 'process' && ('stored ' + json.date + ' slice ' + json.slices.join(',') + ': ' + json.fixturesStored + ' fixtures'),
        json.cleared && ('chunk ' + json.cleared + ' up to date'),
        json.bundles && ('rebuilt ' + json.bundlesBuilt + ' league bundle(s)')
      ].filter(Boolean).join(' · ');
      log('run ' + (i+1) + ': ' + (summary || 'ok'));

      if (done(json)) { log('finished after ' + (i+1) + ' runs', 'ok'); break; }
      if (json.skipped) { log('stopped: ' + json.skipped, 'warn'); break; }
      await new Promise(r => setTimeout(r, 120));
    }
    if (i >= max) log('hit the run limit — press again to continue', 'warn');
  } catch (e) {
    log('loop failed: ' + e.message, 'err');
  }
  setBusy(false);
}
</script>
</div></body></html>`;
