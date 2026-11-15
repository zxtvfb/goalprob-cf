/* seed — back-fill a team's history from API-Football. On the free plan
   both ?last= and recent seasons are blocked, so this disables itself
   after the first refusal rather than spending calls on a guaranteed
   rejection. football-data.co.uk (the history job) is the free route. */
import { FV, apiGet, iso, profile, mergeWindow, isFinished, MAX_WINDOW,
         pack, unpack, ok, bad } from './lib.mjs';

const PER_RUN = 3;
const BUDGET  = 95;

const SEASON = (() => {
  const d = new Date();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
})();

export default async function seed(D, env, url) {
  const started = Date.now();
  try {
    const metaRef = D.doc('meta/sync');
    const meta = (await metaRef.get()).data() || {};

    const today = iso();
    let used = meta.apiDay === today ? (meta.apiToday || 0) : 0;
    if (used + PER_RUN > BUDGET) return ok({ skipped: 'daily API budget reached', used });

    if (meta.seedDisabled && !url.searchParams.get('force')) {
      return ok({ skipped: 'seeding disabled', reason: meta.seedDisabledReason });
    }

    const forced = url.searchParams.get('team');
    let targets = [];
    if (forced) {
      targets = forced.split(',').map(s => s.trim()).filter(Boolean).slice(0, PER_RUN);
    } else {
      const snap = await D.collection('teams').where('sd', '==', false).limit(PER_RUN).get();
      snap.forEach(d => targets.push(d.id));
    }
    if (!targets.length) return ok({ idle: true, note: 'seed queue empty' });

    const results = [];

    for (const id of targets) {
      try {
        let data, remaining;
        try {
          ({ data, remaining } = await apiGet(env, '/fixtures', { team: id, last: MAX_WINDOW }));
          used++;
        } catch (e) {
          if (!/plan limit/i.test(e.message)) throw e;
          used++;
          ({ data, remaining } = await apiGet(env, '/fixtures', { team: id, season: SEASON }));
          used++;
        }

        const recs = [];
        let name = null, logo = null, lid = 0, ctry = null;

        for (const x of data) {
          if (!isFinished(x.fixture?.status?.short)) continue;
          const H = x.teams?.home, A = x.teams?.away;
          if (!H?.id || !A?.id) continue;
          const home = String(H.id) === String(id);
          const me = home ? H : A, opp = home ? A : H;
          const gh = x.goals?.home ?? 0, ga = x.goals?.away ?? 0;
          const hh = x.score?.halftime?.home ?? 0, ha = x.score?.halftime?.away ?? 0;

          name = name || me.name; logo = logo || me.logo;
          if (!lid && x.league?.id) { lid = x.league.id; ctry = x.league.country || null; }

          recs.push({
            i: x.fixture.id, d: (x.fixture?.date || '').slice(0, 10),
            oi: opp.id, o: opp.name, h: home ? 1 : 0,
            gf: home ? gh : ga, ga: home ? ga : gh,
            hgf: home ? hh : ha, hga: home ? ha : hh,
            l: x.league?.id ?? 0
          });
        }

        const ref  = D.doc(`teams/${id}`);
        const prev = (await ref.get()).data();
        const m    = mergeWindow(unpack(prev?.m), recs);

        await ref.set({
          name:    prev?.name    || name || `Team ${id}`,
          search:  String(prev?.name || name || '').toLowerCase(),
          logo:    prev?.logo    || logo || null,
          country: prev?.country || ctry || null,
          lid:     prev?.lid     || lid  || 0,
          sd: true,
          m: pack(m),
          s: profile(m),
          u: FV.serverTimestamp()
        }, { merge: true });

        results.push({ id, name: name || prev?.name, matches: m.length, apiRemaining: remaining });
      } catch (e) {
        console.warn('seed', id, e.message);
        results.push({ id, error: e.message });

        if (/plan limit/i.test(e.message)) {
          await metaRef.set({
            seedDisabled: true,
            seedDisabledReason:
              'This API plan has no historical fixture access (both ?last= and ?season= are blocked). ' +
              'Use the history job, which reads football-data.co.uk for free.',
            apiDay: today, apiToday: used
          }, { merge: true }).catch(() => {});
          return ok({
            seedDisabled: true,
            reason: 'no historical fixture access on this API plan',
            detail: e.message,
            advice: 'Run the history job instead — it imports 45 matches per team from ' +
                    'football-data.co.uk at no API cost.',
            apiUsedToday: used
          });
        }
        await D.doc(`teams/${id}`).set({ sd: true }, { merge: true }).catch(() => {});
      }
    }

    await metaRef.set({
      apiDay: today, apiToday: used,
      lastSeed: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    }, { merge: true });

    return ok({ seeded: results, apiUsedToday: used, ms: Date.now() - started });
  } catch (e) {
    console.error('seed failed:', e);
    return bad(e.message);
  }
}
