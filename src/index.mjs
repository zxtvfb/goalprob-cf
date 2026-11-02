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
import { ok, bad }   from './lib.mjs';

import pull    from './pull.mjs';
import digest  from './digest.mjs';
import seed    from './seed.mjs';
import history from './history.mjs';
import odds    from './odds.mjs';
import cleanup from './cleanup.mjs';
import bundles from './bundles.mjs';
import rekey   from './rekey.mjs';

const JOBS = { pull, digest, seed, history, odds, cleanup, bundles, rekey };

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
      return ok({
        worker: 'goalprob',
        jobs: Object.keys(JOBS),
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

  /* Cron triggers. wrangler.toml decides the cadence; this picks the
     job by the minute the trigger fires on, because a Worker receives
     all of its crons through one handler. */
  async scheduled(event, env, ctx) {
    const D = firestore(env);
    const url = new URL('https://cron.local/?cron=1');
    const minute = new Date(event.scheduledTime).getUTCMinutes();

    let job = 'pull';
    if (minute >= 15 && minute < 35) job = 'digest';
    else if (minute >= 35)           job = 'odds';

    try {
      const res = await JOBS[job](D, env, url);
      console.log(`cron ${job}: ${res.status}`);
    } catch (e) {
      console.error(`cron ${job} failed:`, e.message);
    }
  }
};

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
  <p>Confirms the Worker is up and every secret is in place. Touches nothing.</p>
  <button class="alt" onclick="go('/health',1)">Check configuration</button>
</div>

<div class="card">
  <h2><span class="step">1</span>Remove women's competitions</h2>
  <p>Dry run first and read the sample. Then delete — it loops until the collection is clear.</p>
  <div class="row">
    <button class="alt" onclick="go('/jobs/cleanup?women=1&dry=1',1)">Dry run</button>
    <button onclick="loop('/jobs/cleanup?women=1',40,r=>r.done===true)">Delete</button>
  </div>
</div>

<div class="card">
  <h2><span class="step">2</span>Seed the bookmaker league list</h2>
  <p>Writes the editable league list to config/leagues. Once only.</p>
  <button class="alt" onclick="go('/jobs/cleanup?seed=1',1)">Seed list</button>
</div>

<div class="card">
  <h2><span class="step">3</span>Fetch fixtures</h2>
  <p>Pulls yesterday, today and tomorrow. Costs up to 3 API-Football calls.</p>
  <button onclick="go('/jobs/pull?force=1',1)">Pull fixtures</button>
</div>

<div class="card">
  <h2><span class="step">4</span>Build team records</h2>
  <p>Turns finished matches into rolling 45-match windows. No API calls, so it loops freely.</p>
  <button onclick="loop('/jobs/digest',60,r=>r.idle===true)">Run digest until idle</button>
</div>

<div class="card">
  <h2><span class="step">5</span>Import 45-match history</h2>
  <p>Reads football-data.co.uk for 20 leagues across two seasons. No API-Football calls. This is the long one — around 100 requests, a couple of minutes.</p>
  <button onclick="loop('/jobs/history',260,r=>r.done===true)">Import all leagues</button>
</div>

<div class="card">
  <h2><span class="step">6</span>Build league bundles</h2>
  <p>Gives every league on the card a single stats document. Without this the app reads two documents per fixture, which is hundreds of round trips. No API calls — run it after any import.</p>
  <button onclick="loop('/jobs/bundles',40,r=>r.done===true)">Build all bundles</button>
</div>

<div class="card">
  <h2><span class="step">6b</span>Repair odds keys</h2>
  <p>Writes the price-lookup key onto any stored fixture missing it. Fixtures written before
     that key existed can never be matched to a price, and <b>pull only refreshes three dates</b>,
     so older days stay broken on their own. Costs no API calls — the key is rebuilt from the
     team names already stored. Run it if the diagnostics page shows a date with fixtures but
     <i>with key</i> at zero.</p>
  <div class="row">
    <button onclick="loop('/jobs/rekey',30,r=>r.done===true)">Repair missing keys</button>
    <button class="alt" onclick="loop('/jobs/rekey?force=1',30,r=>r.done===true)">Rebuild all keys</button>
  </div>
</div>

<div class="card">
  <h2><span class="step">7</span>Fetch bookmaker prices</h2>
  <p>Needs ODDS_API_KEY. Free tier is 500 credits a month; one sweep costs about 15.</p>
  <div class="row">
    <button class="alt" onclick="go('/jobs/odds?list=1',1)">List leagues (free)</button>
    <button onclick="go('/jobs/odds',1)">Fetch odds</button>
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
        json.leaguesThisRun && ('leagues ' + json.leaguesThisRun),
        json.matchesPriced != null && (json.matchesPriced + ' priced')
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
