/* ════════════════════════════════════════════════════════════════
   calib — store the corrections the backtest page measured.

   The backtest runs in the browser, where there is no CPU limit: it
   replays real seasons, compares what the model said with what
   happened, and fits a correction for each market. Only the Worker can
   write to the database, so the page hands the result here.

   What arrives is a few dozen numbers, and every one is checked before
   it is stored — this is the one place where something computed outside
   the Worker changes every prediction the app makes.

     /jobs/calib             show what is stored
     /jobs/calib?set=<json>  store a calibration
     /jobs/calib?clear=1     remove it (the model runs uncorrected)

   A calibration is
     n        matches it was fitted on
     m        lines for a forecast built on goals and shots on target
     g        lines for a forecast built on goals alone
     r        lines for a forecast built on ratings from closing prices
     mi       lines for the markets rebuilt from 1X2 + over/under prices
     m1       lines for the markets rebuilt from a 1X2 price alone
     base     how often each outcome happens (for "above average")
     shotMix  share of the shot signal taken from total shots
     h1Blend  weight on the scaled full-match figure for first halves
     wr       weight on the closing-price ratings
   Every part but n is optional; each line is [shift, slope] in log-odds.
   ════════════════════════════════════════════════════════════════ */
import { ok, bad } from './lib.mjs';

const MARKETS = ['hw', 'dr', 'aw', 'h1w', 'h1d', 'h1a', 'btts', 'o15', 'o25', 'o35'];
const BASES   = ['h', 'd', 'a', 'h1h', 'h1d', 'h1a', 'btts', 'o15', 'o25', 'o35'];
const TABLES  = ['m', 'g', 'r', 'mi', 'm1'];
const MIN_MATCHES = 400;

const num = v => typeof v === 'number' && Number.isFinite(v);

function table(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`"${name}" is not a table of corrections`);
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!MARKETS.includes(k)) throw new Error(`${name}: unknown market "${k}"`);
    const c = raw[k];
    if (!Array.isArray(c) || c.length !== 2 || !num(c[0]) || !num(c[1]))
      throw new Error(`${name}.${k} is not a pair of numbers`);
    /* A fitted line this far from "no correction" is a broken fit, not a
       finding, and applied to every prediction it would do real damage. */
    if (Math.abs(c[0]) > 1.0) throw new Error(`${name}.${k}: shift ${c[0]} is out of range`);
    if (c[1] < 0.35 || c[1] > 1.6) throw new Error(`${name}.${k}: slope ${c[1]} is out of range`);
    out[k] = [+c[0].toFixed(4), +c[1].toFixed(4)];
  }
  return out;
}

const fraction = (raw, key, lo, hi) => {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (!num(v) || v < lo || v > hi) throw new Error(`${key} = ${v} is outside ${lo}–${hi}`);
  return +v.toFixed(2);
};

/* Returns a cleaned copy, or throws with the reason. */
export function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  if (!num(raw.n) || raw.n < MIN_MATCHES)
    throw new Error(`fitted on ${raw.n || 0} matches; at least ${MIN_MATCHES} are needed for the corrections to mean anything`);

  const out = { v: 2, n: Math.round(raw.n), at: new Date().toISOString().slice(0, 16) + 'Z' };

  let lines = 0;
  for (const t of TABLES) {
    if (raw[t] === undefined || raw[t] === null) continue;
    const clean = table(raw[t], t);
    if (Object.keys(clean).length) { out[t] = clean; lines += Object.keys(clean).length; }
  }

  if (raw.base && typeof raw.base === 'object') {
    out.base = {};
    for (const k of BASES) {
      const v = raw.base[k];
      if (v === undefined) continue;
      if (!num(v) || v <= 0.02 || v >= 0.98) throw new Error(`base rate "${k}" = ${v} is not a plausible frequency`);
      out.base[k] = +v.toFixed(4);
    }
    if (!Object.keys(out.base).length) delete out.base;
  }

  const shotMix = fraction(raw, 'shotMix', 0, 0.5);
  const h1Blend = fraction(raw, 'h1Blend', 0, 1);
  const wr      = fraction(raw, 'wr', 0, 1);
  if (shotMix !== undefined) out.shotMix = shotMix;
  if (h1Blend !== undefined) out.h1Blend = h1Blend;
  if (wr !== undefined)      out.wr = wr;

  if (!lines && !out.base && shotMix === undefined && h1Blend === undefined && wr === undefined)
    throw new Error('nothing to store: no corrections, base rates or settings');

  if (raw.note) out.note = String(raw.note).slice(0, 200);
  return out;
}

export default async function calib(D, env, url) {
  try {
    const ref = D.doc('meta/model');

    if (url.searchParams.get('clear')) {
      await ref.set({ cal: null }, { merge: true });
      return ok({ cleared: true, note: 'the model now runs without measured corrections' });
    }

    const set = url.searchParams.get('set');
    if (set) {
      let raw;
      try { raw = JSON.parse(set); } catch { return bad('the calibration was not valid JSON', 400); }
      let cal;
      try { cal = validate(raw); } catch (e) { return bad('calibration rejected: ' + e.message, 400); }
      await ref.set({ cal: JSON.stringify(cal), calAt: Date.now() }, { merge: true });
      return ok({ stored: true, calibration: cal });
    }

    const cur = (await ref.get()).data() || {};
    let cal = null, avg = null;
    try { cal = cur.cal ? JSON.parse(cur.cal) : null; } catch {}
    try { avg = cur.avg ? (typeof cur.avg === 'string' ? JSON.parse(cur.avg) : cur.avg) : null; } catch {}
    return ok({ calibration: cal || 'none stored', globalAverage: avg || 'none stored' });
  } catch (e) {
    console.error('calib failed:', e);
    return bad(e.message);
  }
}
