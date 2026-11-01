/* digest — folds finished matches into each team's rolling window.
   Zero API calls. Batch size is smaller than the Netlify build because
   the Workers free plan allows 10 ms of CPU per invocation; run it more
   often rather than asking it to do more per run. */
import { FV, profile, mergeWindow, isFinished, isWomens, rebuildLeagues,
         pack, unpack, ok, bad } from './lib.mjs';

const MATCH_BATCH  = 30;
const LEAGUE_BATCH = 3;

function rowToPair(r) {
  if (!r.hid || !r.aid) return null;
  const d  = r.ts ? new Date(r.ts * 1000).toISOString().slice(0, 10) : '';
  const gh = r.gh ?? 0, ga = r.ga ?? 0;
  const hh = r.hth ?? 0, ha = r.hta ?? 0;
  return {
    lid: r.lid, ctry: r.ctry,
    home: { id: r.hid, name: r.hname, logo: r.hlogo },
    away: { id: r.aid, name: r.aname, logo: r.alogo },
    hRec: { i: r.id, d, oi: r.aid, o: r.aname, h: 1, gf: gh, ga, hgf: hh, hga: ha, l: r.lid },
    aRec: { i: r.id, d, oi: r.hid, o: r.hname, h: 0, gf: ga, ga: gh, hgf: ha, hga: hh, l: r.lid }
  };
}

export default async function digest(D) {
  const started = Date.now();
  try {
    const snap = await D.collection('fixtures').where('pend', '==', true).limit(1).get();
    if (snap.empty) return ok({ idle: true, note: 'nothing pending' });

    const chunkDoc = snap.docs[0];
    const chunk    = chunkDoc.data();
    const rows     = unpack(chunk.f);
    const finished = rows.filter(r => isFinished(r.st));
    const from     = chunk.done || 0;
    const slice    = finished.slice(from, from + MATCH_BATCH);

    if (!slice.length) {
      await chunkDoc.ref.set({ pend: false, done: finished.length }, { merge: true });
      return ok({ cleared: chunkDoc.id });
    }

    const byTeam = new Map();
    const leagues = new Set();

    for (const r of slice) {
      if (isWomens(r.lname, r.hname, r.aname)) continue;
      const p = rowToPair(r);
      if (!p) continue;
      leagues.add(p.lid);
      for (const [side, rec] of [['home', p.hRec], ['away', p.aRec]]) {
        const t = p[side];
        if (!byTeam.has(t.id)) byTeam.set(t.id, { meta: { ...t, lid: p.lid, ctry: p.ctry }, recs: [] });
        byTeam.get(t.id).recs.push(rec);
      }
    }

    const ids  = [...byTeam.keys()];
    const refs = ids.map(id => D.doc(`teams/${id}`));
    const docs = refs.length ? await D.getAll(...refs) : [];

    const batch = D.batch();
    let created = 0;

    docs.forEach((snapshot, i) => {
      const id = ids[i];
      const { meta, recs } = byTeam.get(id);
      const prev = snapshot.exists ? snapshot.data() : null;
      if (!prev) created++;

      const m = mergeWindow(unpack(prev?.m), recs);

      batch.set(refs[i], {
        name:    meta.name,
        search:  String(meta.name || '').toLowerCase(),
        logo:    meta.logo || null,
        country: prev?.country || meta.ctry || null,
        lid:     prev?.lid || meta.lid || 0,
        sd:      prev?.sd === true,
        m:       pack(m),
        s:       profile(m),
        u:       FV.serverTimestamp()
      }, { merge: true });
    });

    const done = from + slice.length;
    batch.set(chunkDoc.ref, { done, pend: done < finished.length }, { merge: true });
    batch.set(D.doc('meta/sync'), {
      lastDigest: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      matchCount: FV.increment(slice.length),
      teamCount:  FV.increment(created)
    }, { merge: true });

    await batch.commit();

    const refreshed = await rebuildLeagues(D, [...leagues].slice(0, LEAGUE_BATCH));

    return ok({
      chunk: chunkDoc.id, matches: slice.length, teams: ids.length,
      newTeams: created, remaining: finished.length - done,
      leaguesRefreshed: refreshed, ms: Date.now() - started
    });
  } catch (e) {
    console.error('digest failed:', e);
    return bad(e.message);
  }
}
