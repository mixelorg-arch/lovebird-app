/* Lovebird end-to-end encryption.
 *
 * Each couple shares one secret 256-bit "couple key". It is created on a phone and only ever leaves a phone
 *   - inside the pairing QR code / invite link (after the #, which browsers never send to the server), or
 *   - locked with someone's recovery passphrase (PBKDF2, 600k rounds) so a new phone can unlock it.
 * Everything private (messages, photos, videos, voice notes, calendar items, profile photos, call signalling)
 * is sealed with AES-256-GCM before it leaves the phone. The server only stores and forwards ciphertext.
 */
const E2EE = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = globalThis.crypto?.subtle;
  const b64u = {
    enc(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
  };
  const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  const aad = (ctx) => te.encode('lb1:' + ctx);
  let key = null, keyId = null, rawB64 = null;

  async function idOf(raw) {
    const bytes = typeof raw === 'string' ? b64u.dec(raw) : raw;
    const h = await subtle.digest('SHA-256', cat(te.encode('lovebird-key-id:'), bytes));
    return b64u.enc(new Uint8Array(h).slice(0, 12));
  }
  const importKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function encryptWith(k, bytes, ctx) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ctx) }, k, bytes));
    return { iv, ct };
  }
  async function decryptWith(k, iv, ct, ctx) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(ctx) }, k, ct));
  }

  return {
    supported: !!subtle,
    b64u,
    idOf,
    ready: () => !!key,
    keyId: () => keyId,
    rawKey: () => rawB64,
    newKey: () => b64u.enc(crypto.getRandomValues(new Uint8Array(32))),
    async use(raw) { const k = await importKey(b64u.dec(raw)); key = k; rawB64 = raw; keyId = await idOf(raw); return keyId; },
    forget() { key = keyId = rawB64 = null; },
    /** "Safety code" both phones can compare: same code = same key. */
    safetyCode: () => keyId ? keyId.slice(0, 8).toUpperCase().replace(/[-_]/g, '0').replace(/(.{4})/, '$1 ') : '',

    // JSON in, "v1.<iv>.<ciphertext>" out. ctx binds the data to its purpose (an item can't be passed off as a message).
    async seal(obj, ctx) {
      const { iv, ct } = await encryptWith(key, te.encode(JSON.stringify(obj)), ctx);
      return `v1.${b64u.enc(iv)}.${b64u.enc(ct)}`;
    },
    async open(str, ctx) {
      const [v, iv, ct] = String(str).split('.');
      if (v !== 'v1') throw new Error('Unknown format');
      return JSON.parse(td.decode(await decryptWith(key, b64u.dec(iv), b64u.dec(ct), ctx)));
    },
    // Files: iv (12 bytes) followed by the ciphertext.
    async sealBytes(buf) {
      const { iv, ct } = await encryptWith(key, new Uint8Array(buf), 'file');
      return cat(iv, ct);
    },
    async openBytes(buf) {
      const b = new Uint8Array(buf);
      return decryptWith(key, b.slice(0, 12), b.slice(12), 'file');
    },

    // Recovery: lock the couple key with a passphrase. The server stores only this locked copy.
    async lockWithPassphrase(pass) {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 600000;
      const k = await passKey(pass, salt, iter);
      const { iv, ct } = await encryptWith(k, b64u.dec(rawB64), 'backup');
      return { v: 1, salt: b64u.enc(salt), iter, iv: b64u.enc(iv), ct: b64u.enc(ct), keyId };
    },
    async unlockWithPassphrase(backup, pass) {
      const k = await passKey(pass, b64u.dec(backup.salt), backup.iter);
      try { return b64u.enc(await decryptWith(k, b64u.dec(backup.iv), b64u.dec(backup.ct), 'backup')); }
      catch { throw new Error('That passphrase is not right'); }
    },
  };
  async function passKey(pass, salt, iter) {
    const base = await subtle.importKey('raw', te.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
})();
