/* ════════════════════════════════════════════════════════════════
   bundles — build a stats bundle for every league that has fixtures.

   The app reads one bundle per league instead of two documents per
   fixture. When a league has no bundle it falls back to reading each
   team, which on a 235-fixture card is hundreds of round trips at
   ~230ms each — minutes of waiting.

   digest only rebuilds three bundles per run, so with a hundred-plus
   leagues on a card coverage never catches up. This walks the whole
   set. Run it once from the admin page; the hourly digest keeps the
   busy leagues fresh afterwards.

   Zero API calls. Reads up to 60 team documents per league, so it is
   cursored: a slice per invocation, looped as separate requests.
   ════════════════════════════════════════════════════════════════ */
import { rebuildLeagues, emptyAcc, averageOf, unpack, unpackObj, iso, shift, ok, bad } from './lib.mjs';

/* Four leagues a run. A league whose stat blocks were built by an older
   engine is re-profiled from its teams' stored matches as it passes
   through, which costs about a millisecond for a full 24-team league —
   so the first pass after an engine change is the expensive one, and
   later passes cost what they always did. */
const PER_RUN = 4;

export default async function bundles(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/bundles');

    if (url.searchParams.get('reset')) {
      await metaRef.set({ cursor: 0, leagues: null, acc: null }, { merge: true });
      return ok({ reset: true, note: 'league list and cursor cleared' });
    }

    const meta = (await metaRef.get()).data() || {};
    let leagues = unpack(meta.leagues);
    let cursor  = Number(meta.cursor || 0);
    /* Running totals across every league visited this pass. The global
       average used to be measured at the very end by reading each bundle
       back, one request per league — several hundred requests in one
       invocation, where a free Worker is allowed fifty. That last step
       therefore failed every time, the average was never stored, and the
       cursor was never reset, so the job could not be run again either.
       The totals are now gathered as the bundles are built. */
    let acc = { ...emptyAcc(), ...unpackObj(meta.acc) };

    /* Collect the league ids once, from the stored fixture window, then
       work through that list rather than re-reading fixtures each time.
       A cursor at or past the end means the previous pass never closed
       properly (the old final step could not) — start again rather than
       report a finish that rebuilt nothing. */
    if (!leagues.length || cursor === 0 || cursor >= leagues.length) {
      const seen = new Set();
      for (const off of [-1, 0, 1, 2, 3]) {
        const date = shift(off);
        const snap = await D.collection('fixtures').where('date', '==', date).get();
        snap.forEach(d => {
          for (const f of unpack(d.data().f)) if (f.lid) seen.add(f.lid);
        });
      }
      leagues = [...seen].sort((a, b) => a - b);
      acc = emptyAcc();
      if (!leagues.length) {
        await metaRef.set({ leagues: '[]', cursor: 0, acc: JSON.stringify(acc) }, { merge: true });
        return ok({ done: true, leagues: 0, note: 'no fixtures stored, so there is nothing to bundle' });
      }
      /* Reading five days of fixtures is this run's whole CPU allowance;
         the bundles themselves start on the next one. The cursor is set
         to -1 so that "0" can keep meaning "collect first". */
      await metaRef.set({ leagues: JSON.stringify(leagues), cursor: -1, acc: JSON.stringify(acc) }, { merge: true });
      return ok({ leaguesTotal: leagues.length, processed: `0 / ${leagues.length}`,
                  note: 'league list collected', done: false, ms: Date.now() - started });
    }
    if (cursor < 0) cursor = 0;

    const slice = leagues.slice(cursor, cursor + PER_RUN);
    const before = acc.reprofiled || 0;
    const built = await rebuildLeagues(D, slice, 60, { reprofile: true, writeBack: true, acc });
    const next  = cursor + slice.length;
    const finished = next >= leagues.length;

    /* The pass closes in the same invocation as its last slice. It used
       to need one more run to store the average and reset the cursor —
       and the admin page stops looping the moment it is told "done". */
    const avg = finished ? averageOf(acc) : null;
    const batch = D.batch();
    batch.set(metaRef, finished
      ? { cursor: 0, acc: JSON.stringify(acc), lastFinished: iso(), u: Date.now() }
      : { cursor: next, acc: JSON.stringify(acc), u: Date.now() }, { merge: true });
    if (avg) {
      batch.set(D.doc('meta/model'), {
        avg: JSON.stringify(avg), leaguesMeasured: acc.leagues, u: Date.now()
      }, { merge: true });
    }
    await batch.commit();

    return ok({
      leaguesTotal: leagues.length,
      processed: `${next} / ${leagues.length}`,
      thisRun: slice,
      bundlesBuilt: built,
      statBlocksRebuilt: (acc.reprofiled || 0) - before,
      ...(finished ? {
        globalAverage: avg || 'not enough data yet',
        measuredFrom: acc.leagues + ' leagues',
        statBlocksRebuiltThisPass: acc.reprofiled || 0
      } : {}),
      done: finished,
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('bundles failed:', e);
    return bad(e.message);
  }
}
