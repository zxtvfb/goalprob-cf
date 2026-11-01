/* ════════════════════════════════════════════════════════════════
   Firestore for Cloudflare Workers.

   firebase-admin cannot run here: it needs Node internals and a gRPC
   transport that the Workers runtime does not provide. This module
   talks to the Firestore REST API instead, and deliberately mirrors
   the small slice of the admin SDK the jobs already use — doc(),
   collection().where().limit().get(), batch(), getAll() — so the job
   files port across almost unchanged.

   Two things are tuned for the 10ms CPU budget on the Workers free
   plan:

   1. The OAuth access token is cached in module scope. It survives
      between invocations in the same isolate, so the RSA signature
      is computed rarely rather than on every request.

   2. Large nested values are stored as JSON strings by the callers,
      not as native Firestore arrays and maps. Encoding a day of
      fixtures into typed Firestore values means building tens of
      thousands of small objects; one JSON.stringify does not.
   ════════════════════════════════════════════════════════════════ */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE     = 'https://www.googleapis.com/auth/datastore';

let cachedToken = null;      // { token, expires }
let cachedKey   = null;      // imported CryptoKey

/* ---------- base64url helpers ---------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlStr = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* PEM -> ArrayBuffer of the DER body */
function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/* ---------- access token ---------- */
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expires > now + 60) return cachedToken.token;

  const email = (env.FIREBASE_CLIENT_EMAIL || '').trim();
  const key   = normaliseKey(env.FIREBASE_PRIVATE_KEY || '');
  if (!email || !key) {
    throw new Error('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY');
  }

  if (!cachedKey) {
    cachedKey = await crypto.subtle.importKey(
      'pkcs8', pemToDer(key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  }

  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlStr(JSON.stringify({
    iss: email, scope: SCOPE, aud: TOKEN_URL,
    iat: now, exp: now + 3600
  }));
  const signed = `${header}.${claims}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cachedKey, new TextEncoder().encode(signed));
  const jwt = `${signed}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    cachedKey = null;
    throw new Error(`Google rejected the service account (${res.status}). ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  cachedToken = { token: j.access_token, expires: now + (j.expires_in || 3600) };
  return cachedToken.token;
}

/* Accepts the key with literal \n, real newlines, or wrapping quotes. */
export function normaliseKey(k) {
  return String(k).trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim() + '\n';
}

/* ════════════════════════════════════════════════════════════════
   Value encoding.

   Only the shapes the app actually stores. Big arrays and maps are
   JSON strings by the time they arrive here, so this stays cheap.
   ════════════════════════════════════════════════════════════════ */
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  const t = typeof v;
  if (t === 'boolean') return { booleanValue: v };
  if (t === 'string')  return { stringValue: v };
  if (t === 'number') {
    if (!Number.isFinite(v)) return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v))  return { arrayValue: { values: v.map(toValue) } };
  if (t === 'object')    return { mapValue: { fields: toFields(v) } };
  return { nullValue: null };
}

export function toFields(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (v && v.__sentinel) continue;          // transforms are handled separately
    out[k] = toValue(v);
  }
  return out;
}

export function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue'      in v) return null;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue'       in v) return fromFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}

export function fromFields(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = fromValue(fields[k]);
  return out;
}

/* ---------- field transforms (serverTimestamp / increment) ---------- */
export const FV = {
  serverTimestamp: () => ({ __sentinel: 'ts' }),
  increment: n => ({ __sentinel: 'inc', n })
};

function transformsOf(obj) {
  const out = [];
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (!v || !v.__sentinel) continue;
    if (v.__sentinel === 'ts')  out.push({ fieldPath: k, setToServerValue: 'REQUEST_TIME' });
    if (v.__sentinel === 'inc') out.push({ fieldPath: k, increment: toValue(v.n) });
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════
   Client
   ════════════════════════════════════════════════════════════════ */
export function firestore(env) {
  const project = (env.FIREBASE_PROJECT_ID || '').trim();
  if (!project) throw new Error('Missing FIREBASE_PROJECT_ID');

  const root = `projects/${project}/databases/(default)/documents`;
  const api  = `https://firestore.googleapis.com/v1/${root}`;

  async function call(path, init = {}) {
    const token = await accessToken(env);
    const res = await fetch(path, {
      ...init,
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers || {})
      }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Firestore ${res.status} on ${path.replace(api, '')}: ${t.slice(0, 200)}`);
    }
    return res.json();
  }

  /* one write entry for :commit */
  function writeFor(path, data, opts = {}) {
    const name = `${root}/${path}`;
    const transforms = transformsOf(data);
    const fields = toFields(data);
    const w = { update: { name, fields } };
    /* merge:true writes only the named fields; without it the document
       is replaced wholesale, which is what set(..., {merge:false}) means */
    if (opts.merge) w.updateMask = { fieldPaths: Object.keys(fields) };
    if (transforms.length) w.updateTransforms = transforms;
    return w;
  }

  async function commit(writes) {
    if (!writes.length) return;
    /* Firestore caps a commit at 500 writes */
    for (let i = 0; i < writes.length; i += 500) {
      await call(`${api}:commit`, {
        method: 'POST',
        body: JSON.stringify({ writes: writes.slice(i, i + 500) })
      });
    }
  }

  const snapOf = (path, json) => ({
    id: path.split('/').pop(),
    exists: !!json,
    data: () => json ? fromFields(json.fields || {}) : undefined
  });

  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      async get() {
        const j = await call(`${api}/${path}`);
        return snapOf(path, j);
      },
      async set(data, opts = {}) { return commit([writeFor(path, data, opts)]); },
      async update(data)         { return commit([writeFor(path, data, { merge: true })]); },
      async delete()             { return commit([{ delete: `${root}/${path}` }]); }
    };
  }

  function queryFor(collectionId, state = {}) {
    const q = {
      where: state.where || [],
      order: state.order || [],
      lim:   state.lim,
      after: state.after,
      sel:   state.sel
    };
    const next = patch => queryFor(collectionId, { ...q, ...patch });

    return {
      where(field, op, value) {
        const OPS = { '==':'EQUAL', '<':'LESS_THAN', '<=':'LESS_THAN_OR_EQUAL',
                      '>':'GREATER_THAN', '>=':'GREATER_THAN_OR_EQUAL', '!=':'NOT_EQUAL' };
        return next({ where: [...q.where, { field, op: OPS[op] || 'EQUAL', value }] });
      },
      orderBy(field, dir = 'asc') {
        return next({ order: [...q.order, { field, dir }] });
      },
      limit(n)       { return next({ lim: n }); },
      startAfter(id) { return next({ after: id }); },
      select(...f)   { return next({ sel: f }); },

      async get() {
        const sq = { from: [{ collectionId }] };

        if (q.where.length === 1) {
          sq.where = { fieldFilter: {
            field: { fieldPath: q.where[0].field },
            op: q.where[0].op,
            value: toValue(q.where[0].value) } };
        } else if (q.where.length > 1) {
          sq.where = { compositeFilter: { op: 'AND', filters: q.where.map(w => ({
            fieldFilter: { field: { fieldPath: w.field }, op: w.op, value: toValue(w.value) } })) } };
        }

        if (q.order.length) {
          sq.orderBy = q.order.map(o => ({
            field: { fieldPath: o.field },
            direction: o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }));
        }
        if (q.after != null) {
          /* only used with orderBy('__name__'), so the cursor is a
             document reference rather than a field value */
          sq.startAt = {
            values: [{ referenceValue: `${root}/${collectionId}/${q.after}` }],
            before: false
          };
          if (!sq.orderBy) sq.orderBy = [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }];
        }
        if (q.lim) sq.limit = q.lim;
        if (q.sel) sq.select = { fields: q.sel.map(f => ({ fieldPath: f })) };

        const rows = await call(`${api}:runQuery`, {
          method: 'POST', body: JSON.stringify({ structuredQuery: sq })
        }) || [];

        const docs = rows.filter(r => r.document).map(r => {
          const name = r.document.name;
          const id = name.split('/').pop();
          return {
            id,
            ref: docRef(`${collectionId}/${id}`),
            exists: true,
            data: () => fromFields(r.document.fields || {})
          };
        });

        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach: fn => docs.forEach(fn)
        };
      }
    };
  }

  return {
    doc: path => docRef(path),
    collection: id => queryFor(id),

    /* batched reads — one round trip for many documents */
    async getAll(...refs) {
      if (!refs.length) return [];
      const documents = refs.map(r => `${root}/${r.path}`);
      const rows = await call(`${api}:batchGet`, {
        method: 'POST', body: JSON.stringify({ documents })
      }) || [];
      const byName = new Map();
      for (const r of rows) {
        if (r.found) byName.set(r.found.name, r.found);
        else if (r.missing) byName.set(r.missing, null);
      }
      return refs.map(r => {
        const j = byName.get(`${root}/${r.path}`) ?? null;
        return snapOf(r.path, j);
      });
    },

    batch() {
      const writes = [];
      return {
        set(ref, data, opts = {}) { writes.push(writeFor(ref.path, data, opts)); return this; },
        update(ref, data)         { writes.push(writeFor(ref.path, data, { merge: true })); return this; },
        delete(ref)               { writes.push({ delete: `${root}/${ref.path}` }); return this; },
        commit()                  { return commit(writes); }
      };
    }
  };
}
