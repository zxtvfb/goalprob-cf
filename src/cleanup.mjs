/* ════════════════════════════════════════════════════════════════
   cleanup — one-off maintenance. Spends ZERO API calls.

     /.netlify/functions/cleanup?women=1    delete women's teams, and
                                            strip women's fixtures from
                                            the stored day chunks
     /.netlify/functions/cleanup?seed=1     write the bookmaker league
                                            list to config/leagues
     /.netlify/functions/cleanup?dry=1      report what would change,
                                            change nothing

   The women's sweep is cursor-based: it works through the teams
   collection a batch at a time, so run it repeatedly until it reports
   done:true. New ingests are already filtered, so this only has to
   clear what was stored before the filter existed.
   ════════════════════════════════════════════════════════════════ */
import { FV, isWomens, pack, unpack, ok, bad } from './lib.mjs';

const TEAM_BATCH  = 300;
const CHUNK_BATCH = 40;

export default async function cleanup(D, env, url) {
  const started = Date.now();
  try {
    const dry = url.searchParams.get('dry') === '1';

    if (url.searchParams.get('seed')) return seedLeagues(D, dry);
    if (!url.searchParams.get('women')) {
      return ok({
        usage: {
          'cleanup?women=1': 'delete women\'s teams and strip them from fixtures (run until done:true)',
          'cleanup?seed=1':  'write the bookmaker league list to config/leagues',
          'add &dry=1':      'report without changing anything'
        }
      });
    }

    const metaRef = D.doc('meta/cleanup');
    const meta = (await metaRef.get()).data() || {};
    const after = url.searchParams.get('restart') ? null : (meta.cursor || null);

    /* ---- 1. teams ---- */
    let q = D.collection('teams').orderBy('__name__').limit(TEAM_BATCH);
    if (after) q = q.startAfter(after);
    const snap = await q.get();

    const doomed = [];
    let last = null;
    snap.forEach(d => {
      last = d.id;
      const v = d.data();
      if (isWomens(v.name)) doomed.push({ id: d.id, name: v.name });
    });

    if (!dry && doomed.length) {
      const batch = D.batch();
      for (const t of doomed) batch.delete(D.doc(`teams/${t.id}`));
      await batch.commit();
    }

    const done = snap.size < TEAM_BATCH;

    /* ---- 2. fixtures: rewrite day chunks without women's rows ---- */
    let rowsDropped = 0, chunksTouched = 0;
    if (done) {
      const chunks = await D.collection('fixtures').limit(CHUNK_BATCH).get();
      for (const c of chunks.docs) {
        const v = c.data();
        const rows = unpack(v.f);
        if (!rows.length) continue;
        const keep = rows.filter(r => !isWomens(r.lname, r.hname, r.aname));
        if (keep.length === rows.length) continue;

        rowsDropped += rows.length - keep.length;
        chunksTouched++;
        if (!dry) {
          await c.ref.set({
            f: pack(keep),
            fin: keep.filter(r => ['FT','AET','PEN'].includes(r.st)).length,
            u: FV.serverTimestamp()
          }, { merge: true });
        }
      }
    }

    if (!dry) {
      await metaRef.set({
        cursor: done ? null : last,
        lastRun: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        removedTotal: FV.increment(doomed.length)
      }, { merge: true });
    }

    return ok({
      dryRun: dry,
      scannedTeams: snap.size,
      womensTeamsRemoved: doomed.length,
      sample: doomed.slice(0, 10).map(t => t.name),
      fixtureChunksCleaned: chunksTouched,
      womensFixtureRowsRemoved: rowsDropped,
      done,
      next: done ? 'finished — new ingests are filtered at source'
                 : 'run again to continue through the teams collection',
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('cleanup failed:', e);
    return bad(e.message);
  }
}

/* ════════════════════════════════════════════════════════════════
   Bookmaker league list.

   This is a starting list of competitions a large international book
   reliably carries — it is NOT scraped from any bookmaker, and no
   such feed is publicly available. Treat it as a sensible default to
   edit rather than a guarantee.

   The list is stored at config/leagues as API-Football league ids, so
   it can be changed in the Firebase console without redeploying. To
   add one, find its id in the app (a fixture's league) or in the API,
   and append it to the `ids` array.
   ════════════════════════════════════════════════════════════════ */
const BOOK_LEAGUES = [
  // England
  39, 40, 41, 42, 43, 45, 48,
  // Spain
  140, 141, 143,
  // Germany
  78, 79, 81,
  // Italy
  135, 136, 137,
  // France
  61, 62, 66,
  // Netherlands, Portugal, Belgium
  88, 89, 94, 95, 144, 147,
  // Scotland, Ireland, Wales
  179, 180, 181, 357,
  // Turkey, Greece, Switzerland, Austria
  203, 204, 197, 199, 207, 209, 218, 219,
  // Nordics
  113, 114, 103, 104, 119, 120, 244, 245,
  // Eastern Europe
  106, 107, 283, 284, 345, 346, 271, 172, 169, 333, 235, 236, 242,
  // Rest of Europe
  210, 211, 318, 319, 262, 263, 286, 287, 98, 99,
  // South America
  71, 72, 128, 129, 265, 266, 239, 240, 281, 282, 268, 269, 250, 299,
  // North America
  253, 262, 263,
  // Asia / Oceania
  98, 99, 292, 293, 188, 189, 307, 308, 17, 169,
  // Africa
  200, 201, 186, 233, 288,
  // Continental and international
  2, 3, 848, 11, 13, 1, 4, 5, 9, 10, 15, 531, 960
];

async function seedLeagues(D, dry) {
  const ids = [...new Set(BOOK_LEAGUES)].sort((a, b) => a - b);
  if (!dry) {
    await D.doc('config/leagues').set({
      ids,
      note: 'Edit this array in the Firebase console to match what your bookmaker covers. ' +
            'League ids are API-Football ids. Removing the document hides the toggle.',
      u: FV.serverTimestamp()
    });
  }
  return ok({
    dryRun: dry,
    seededLeagueIds: ids.length,
    storedAt: 'config/leagues',
    caution: 'This is a starting list of competitions a large international book usually carries. ' +
             'It is not read from any bookmaker — no public feed exists — so check it against ' +
             'what you can actually bet on and edit the array in the Firebase console.'
  });
}

