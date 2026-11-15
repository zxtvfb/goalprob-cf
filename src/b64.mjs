/* Base64 for raw API replies, done by native code wherever the runtime
   has it. A day of fixtures is ~2 MB; encoding it a character at a time
   in JavaScript would cost several times the 10 ms a run is allowed.

   Buffer comes from node:buffer, which Cloudflare provides natively: a
   compatibility date of 2026-08-04 or later turns Node.js compatibility
   on by default (wrangler.toml also sets nodejs_compat). The fallbacks
   below are only for a runtime without it. */
import { Buffer as NodeBuffer } from 'node:buffer';
export const NB = NodeBuffer || globalThis.Buffer;
const U8 = Uint8Array.prototype;

export const hasBuffer = !!(NB && NB.prototype && NB.prototype.indexOf);

export function encode(bytes) {
  if (typeof U8.toBase64 === 'function') return bytes.toBase64();
  if (hasBuffer) return NB.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 16384) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 16384));
  return btoa(s);
}

export function decodeToText(b64) {
  if (hasBuffer) return NB.from(b64, 'base64').toString('utf8');
  let bytes;
  if (typeof Uint8Array.fromBase64 === 'function') bytes = Uint8Array.fromBase64(b64);
  else {
    const s = atob(b64);
    bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
