/* ════════════════════════════════════════════════════════════════
   digest — folds finished matches into each team's rolling window,
   and keeps each league's stats bundle up to date. Zero API calls.

   Small batches, many runs: the Workers free plan allows 10 ms of CPU
   a run, and a team's record is 45 matches to merge and re-profile.

     matches   up to six finished matches not yet folded in, from one
               stored chunk. Which have been is kept per day in
               dg/<date>, so a chunk rewritten by a later pull does not
               start over from the beginning.
     bundles   the leagues those teams play in are marked; every third
               run (or whenever no match is waiting) two of them get
               their bundle rebuilt — the one document the app and the
               strategies read for a league.
   ════════════════════════════════════════════════════════════════ */
import { FV, profile, mergeWindow, isFinished, isWomens, rebuildLeagues, teamLogo,
         pack, unpack, ok, bad } from './lib.mjs';

const MATCH_BATCH  = 6;     // twelve teams' 45-match windows to merge and re-profile
const BUNDLE_BATCH = 2;

function rowToPair(r) {
  if (!r.hid || !r.aid) return null;
  const d = r.ts ? new Date(r.ts * 1000).toISOString().slice(0, 10) : '';

  /* A finished match with no score reported teaches nothing, and used
     to be recorded as a 0-0 draw. */
  if (r.gh == null || r.ga == null) return null;
  const gh = r.gh, ga = r.ga;

  /* A missing half-time score stays missing. Stored as 0-0 it made every
     team in a league without half-time scores look as if it never
     scored before the break, and the half-time draw came out near-
     certain. A half-time score larger than the final one is treated as
     absent too. */
  let hh = r.hth ?? null, ha = r.hta ?? null;
  if (hh == null || ha == null || hh > gh || ha > ga) { hh = null; ha = null; }

  return {
    lid: r.lid, ctry: r.ctry,
    home: { id: r.hid, name: r.hname, logo: r.hlogo || teamLogo(r.hid) },
    away: { id: r.aid, name: r.aname, logo: r.alogo || teamLogo(r.aid) },
    hRec: { i: r.id, d, oi: r.aid, o: r.aname, h: 1, gf: gh, ga, hgf: hh, hga: ha, l: r.lid },
    aRec: { i: r.id, d, oi: r.hid, o: r.hname, h: 0, gf: ga, ga: gh, hgf: ha, hga: hh, l: r.lid }
  };
}

export default async function digest(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/digest');
    const meta = (await metaRef.get()).data() || {};
    const dirty = unpack(meta.dirty);
    const runs = (meta.runs || 0) + 1;

    const wantBundles = dirty.length && (runs % 3 === 0 || url.searchParams.get('bundles') === '1');
    const snap = wantBundles ? null : await D.collection('fixtures').where('pend', '==', true).limit(1).get();

    if (wantBundles || !snap || snap.empty) {
      if (!dirty.length) {
        await metaRef.set({ runs }, { merge: true });
        return ok({ idle: true, note: 'nothing pending' });
      }
      const lids = dirty.slice(0, BUNDLE_BATCH);
      const built = await rebuildLeagues(D, lids, 60, {});
      await metaRef.set({ runs, dirty: pack(dirty.slice(BUNDLE_BATCH)) }, { merge: true });
      return ok({ bundles: lids, bundlesBuilt: built, leaguesWaiting: dirty.length - lids.length, ms: Date.now() - started });
    }

    const chunkDoc = snap.docs[0];
    const chunk = chunkDoc.data();
    const date = chunk.date;
    const dgRef = D.doc(`dg/${date}`);
    const dgSnap = await dgRef.get();
    const dgIds = unpack(dgSnap.exists ? dgSnap.data().ids : null);
    const dg = new Set(dgIds.map(String));

    const waiting = unpack(chunk.f).filter(r => isFinished(r.st) && !dg.has(String(r.id)));
    const slice = waiting.slice(0, MATCH_BATCH);
    if (!slice.length) {
      await chunkDoc.ref.set({ pend: false }, { merge: true });
      await metaRef.set({ runs }, { merge: true });
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

    const ids = [...byTeam.keys()];
    const refs = ids.map(id => D.doc(`teams/${id}`));
    const docs = refs.length ? await D.getAll(...refs) : [];

    const batch = D.batch();
    let created = 0, unchanged = 0;
    docs.forEach((snapshot, i) => {
      const { meta: tm, recs } = byTeam.get(ids[i]);
      const prev = snapshot.exists ? snapshot.data() : null;
      if (!prev) created++;
      const had = unpack(prev?.m);
      /* already folded in (a match digested before this layout kept its
         own record): nothing to rewrite */
      const known = new Set(had.map(m => String(m.i)));
      const fresh = recs.filter(r => !known.has(String(r.i)));
      if (prev && !fresh.length) { unchanged++; return; }

      const m = mergeWindow(had, fresh);
      batch.set(refs[i], {
        name:    tm.name,
        search:  String(tm.name || '').toLowerCase(),
        logo:    prev?.logo || tm.logo || null,
        country: prev?.country || tm.ctry || null,
        lid:     prev?.lid || tm.lid || 0,
        sd:      prev?.sd === true,
        m:       pack(m),
        s:       profile(m),
        u:       FV.serverTimestamp()
      }, { merge: true });
    });

    const nowDone = dgIds.concat(slice.map(r => r.id));
    batch.set(dgRef, { date, ids: pack(nowDone), u: Date.now() }, { merge: true });
    batch.set(chunkDoc.ref, { pend: waiting.length > slice.length }, { merge: true });
    const moreDirty = [...new Set([...dirty, ...leagues])].slice(0, 400);
    batch.set(metaRef, { runs, dirty: pack(moreDirty) }, { merge: true });
    batch.set(D.doc('meta/sync'), {
      lastDigest: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      matchCount: FV.increment(slice.length),
      teamCount:  FV.increment(created)
    }, { merge: true });
    await batch.commit();

    return ok({
      chunk: chunkDoc.id, matches: slice.length, teams: ids.length - unchanged, alreadyIn: unchanged || undefined,
      newTeams: created, remaining: waiting.length - slice.length, leaguesWaiting: moreDirty.length,
      ms: Date.now() - started
    });
  } catch (e) {
    console.error('digest failed:', e);
    return bad(e.message);
  }
}
