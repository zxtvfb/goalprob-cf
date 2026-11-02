/* ════════════════════════════════════════════════════════════════
   rekey — write the odds lookup key onto fixtures that are missing it.

   Why this exists:

   The ingest computes `k` from the two team names and stores it on each
   fixture row. Prices are stored under the same key, so a fixture without
   `k` can never be matched to a price — the card shows "no bookmaker
   prices" while the prices sit in the database untouched.

   Only `pull` writes `k`, and pull covers three dates (yesterday, today,
   tomorrow), is capped at a daily API budget, and skips a date it
   considers fresh. So any date written before `k` existed keeps its gap
   for good: it scrolls out of pull's three-day window long before the
   staleness timer would have refreshed it.

   The repair needs no API calls at all. `k` is derived from `hname` and
   `aname`, and both are already stored on every row. This walks the
   stored chunks and fills the field in place.

   Open /jobs/rekey to run it. Safe to run repeatedly — rows that already
   carry the right key are left alone and their chunk is not rewritten.

   ?force=1   recompute every key rather than only the missing ones, for
              when names.mjs changes and old keys need rebuilding.
   ════════════════════════════════════════════════════════════════ */
import { pack, unpack, ok, bad } from './lib.mjs';
import { fixtureKey } from './names.mjs';

/* Chunks hold up to 300 fixtures each. Rewriting one is a single write,
   but unpacking and repacking it costs CPU, and a Worker invocation on
   the free plan gets 10ms. Twelve is comfortably inside that and covers
   a normal seven-day window in one or two runs. */
const PER_RUN = 12;

export default async function rekey(D, env, url) {
  const started = Date.now();
  try {
    const force = url.searchParams.get('force') === '1';
    const metaRef = D.doc('meta/rekey');

    if (url.searchParams.get('reset')) {
      await metaRef.set({ after: null }, { merge: true });
      return ok({ reset: true, note: 'cursor cleared' });
    }

    const meta = (await metaRef.get()).data() || {};
    const after = meta.after || null;

    /* Walk the collection by document id. Chunk ids are `${date}__${part}`,
       so ordering by id walks the days in order and the cursor is just the
       last id touched. */
    let q = D.collection('fixtures').orderBy('__name__').limit(PER_RUN);
    if (after) q = q.startAfter(after);
    const snap = await q.get();

    if (snap.empty) {
      await metaRef.set({ after: null, lastFinished: new Date().toISOString() }, { merge: true });
      return ok({ done: true, note: 'every stored fixture chunk now carries an odds key' });
    }

    let chunksSeen = 0, chunksWritten = 0, rowsFixed = 0, rowsTotal = 0, lastId = after;
    const byDate = {};

    for (const d of snap.docs) {
      chunksSeen++;
      lastId = d.id;
      const data = d.data() || {};
      const rows = unpack(data.f);
      if (!rows.length) continue;

      let changed = 0;
      for (const r of rows) {
        rowsTotal++;
        if (!force && r.k) continue;
        if (!r.hname || !r.aname) continue;      // nothing to build a key from
        const k = fixtureKey(r.hname, r.aname);
        if (k && k !== r.k) { r.k = k; changed++; }
      }

      if (changed) {
        /* Only `f` is touched. Merging leaves pend/done/fin alone so the
           digest's progress through this chunk is not disturbed. */
        await d.ref.set({ f: pack(rows) }, { merge: true });
        chunksWritten++;
        rowsFixed += changed;
        const date = data.date || d.id.split('__')[0];
        byDate[date] = (byDate[date] || 0) + changed;
      }
    }

    const more = snap.size === PER_RUN;
    await metaRef.set({ after: more ? lastId : null, u: Date.now() }, { merge: true });

    return ok({
      chunksScanned: chunksSeen,
      chunksRewritten: chunksWritten,
      rowsScanned: rowsTotal,
      keysWritten: rowsFixed,
      byDate,
      done: !more,
      note: more ? 'more chunks remain — run again'
                 : 'finished: every stored fixture chunk carries an odds key',
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('rekey failed:', e);
    return bad(e.message);
  }
}
