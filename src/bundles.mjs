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
import { rebuildLeagues, unpack, iso, shift, ok, bad } from './lib.mjs';

const PER_RUN = 8;

export default async function bundles(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/bundles');

    if (url.searchParams.get('reset')) {
      await metaRef.set({ cursor: 0, leagues: null }, { merge: true });
      return ok({ reset: true, note: 'league list and cursor cleared' });
    }

    const meta = (await metaRef.get()).data() || {};
    let leagues = unpack(meta.leagues);
    let cursor  = Number(meta.cursor || 0);

    /* Collect the league ids once, from the stored fixture window, then
       work through that list rather than re-reading fixtures each time. */
    if (!leagues.length || cursor === 0) {
      const seen = new Set();
      for (const off of [-1, 0, 1, 2, 3]) {
        const date = shift(off);
        const snap = await D.collection('fixtures').where('date', '==', date).get();
        snap.forEach(d => {
          for (const f of unpack(d.data().f)) if (f.lid) seen.add(f.lid);
        });
      }
      leagues = [...seen].sort((a, b) => a - b);
      cursor = 0;
      await metaRef.set({ leagues: JSON.stringify(leagues), cursor: 0 }, { merge: true });
    }

    if (cursor >= leagues.length) {
      await metaRef.set({ cursor: 0, lastFinished: iso() }, { merge: true });
      return ok({ done: true, leagues: leagues.length,
                  note: 'every league with fixtures now has a bundle' });
    }

    const slice = leagues.slice(cursor, cursor + PER_RUN);
    const built = await rebuildLeagues(D, slice);
    const next  = cursor + slice.length;

    await metaRef.set({ cursor: next, u: Date.now() }, { merge: true });

    return ok({
      leaguesTotal: leagues.length,
      processed: `${next} / ${leagues.length}`,
      thisRun: slice,
      bundlesBuilt: built,
      done: next >= leagues.length,
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('bundles failed:', e);
    return bad(e.message);
  }
}
