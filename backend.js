/* Lovebird's backend: Supabase (database, sign-in, file storage and the live connection).
 * There is no Lovebird server any more. This file gives app.js the same two things it used before:
 *   api(path, opts)  — the old REST calls, now answered by Supabase
 *   io()             — the old live socket, now a Supabase Realtime channel
 * Everything private is still sealed by e2ee.js on the phone before it reaches Supabase,
 * and Row Level Security (supabase/migrations) keeps each couple's rows to that couple.
 */
const LB = window.LOVEBIRD_CONFIG || {};
const sb = supabase.createClient(LB.supabaseUrl, LB.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  realtime: { params: { eventsPerSecond: 40 } },
});
const BUCKET = 'lovebird';
const NOT_SIGNED_IN = 'Please sign in again';

const ms = (t) => (t == null ? null : typeof t === 'number' ? t : Date.parse(t));
const itemOut = (r) => ({ id: r.id, coupleId: r.couple_id, createdBy: r.created_by, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), enc: r.enc });
const msgOut = (r) => ({ id: r.id, coupleId: r.couple_id, from: r.sender, ts: Number(r.ts), enc: r.enc, files: r.files || [] });
const pubOut = (p) => p && { id: p.id, name: p.name, email: p.email, photo: p.photo || null, photoEnc: !!p.photo };
function check({ data, error }, fallback) {
  if (error) {
    if (error.status === 401 || /JWT|not authenticated/i.test(error.message)) throw Object.assign(new Error(NOT_SIGNED_IN), { auth: true });
    throw new Error(error.message || fallback || 'Something went wrong');
  }
  return data;
}
async function uid() {
  const { data } = await sb.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) throw Object.assign(new Error(NOT_SIGNED_IN), { auth: true });
  return id;
}
const appUrl = () => location.origin + location.pathname.replace(/[^/]*$/, '');

// ---------- "me" ----------
let lastMe = null, pendingName = null;
async function meView() {
  const id = await uid();
  const rows = check(await sb.from('lovebird_profiles').select('id,name,email,photo,couple_id'));
  let me = rows.find((r) => r.id === id);
  if (!me) { // first time in Lovebird (this sign-in is shared with other apps in the same Supabase project)
    check(await sb.rpc('lovebird_ensure_profile', { p_name: pendingName }));
    return meView();
  }
  const p = me.couple_id ? rows.find((r) => r.id !== id && r.couple_id === me.couple_id) : null;
  let keyId = null, backupKey = null;
  if (me.couple_id) {
    keyId = check(await sb.from('lovebird_couples').select('key_id').eq('id', me.couple_id).maybeSingle())?.key_id || null;
    backupKey = check(await sb.from('lovebird_key_backups').select('key_id').eq('user_id', id).maybeSingle())?.key_id || null;
  }
  lastMe = { ...pubOut(me), coupleId: me.couple_id || null, keyId, hasBackup: !!(keyId && backupKey === keyId),
    partner: pubOut(p) || null, online: Live.partnerOnline(p?.id), demo: false };
  Live.setCouple(lastMe.coupleId, p?.id || null);
  return lastMe;
}

// ---------- encrypted files ----------
const rnd = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function uploadBlob(bytes) {
  const cid = lastMe?.coupleId;
  if (!cid) throw new Error('Connect with your partner first');
  const path = `${cid}/${rnd()}.bin`;
  check(await sb.storage.from(BUCKET).upload(path, new Blob([bytes], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false }), 'Upload failed');
  return path;
}
async function downloadBlob(path) {
  const blob = check(await sb.storage.from(BUCKET).download(path), 'File not found');
  return blob.arrayBuffer();
}
async function removeBlobs(paths) {
  const list = paths.filter((p) => typeof p === 'string' && /^[0-9a-f-]{36}\/[0-9a-f]{32}\.bin$/.test(p));
  if (list.length) await sb.storage.from(BUCKET).remove(list).catch(() => {});
}
async function removeCoupleFolder(cid) {
  for (let i = 0; i < 50; i++) {
    const files = check(await sb.storage.from(BUCKET).list(cid, { limit: 1000 }));
    if (!files?.length) return;
    check(await sb.storage.from(BUCKET).remove(files.map((f) => `${cid}/${f.name}`)));
  }
}

// ---------- the old REST calls ----------
const routes = [
  ['GET', /^\/api\/config$/, async () => ({ googleEnabled: false, googleClientId: LB.googleClientId || null, publicUrl: LB.publicUrl || null })],

  ['POST', /^\/api\/register$/, async (b) => {
    if (!b.name?.trim()) throw new Error('Please enter your name');
    if (!/^\S+@\S+\.\S+$/.test(b.email || '')) throw new Error('Please enter a valid email');
    if (!b.password || b.password.length < 6) throw new Error('Password must be at least 6 characters');
    pendingName = b.name.trim().slice(0, 60);
    const { data, error } = await sb.auth.signUp({ email: b.email.trim(), password: b.password,
      options: { data: { name: b.name.trim().slice(0, 60) }, emailRedirectTo: appUrl() } });
    if (error) throw new Error(/registered|exists/i.test(error.message) ? 'That email already has an account — sign in instead' : error.message);
    if (data.user && !data.user.identities?.length) throw new Error('That email already has an account — sign in instead');
    if (!data.session) throw new Error('Check your email and tap the link to confirm your account, then sign in');
    return { token: data.session.access_token };
  }],
  ['POST', /^\/api\/login$/, async (b) => {
    const { data, error } = await sb.auth.signInWithPassword({ email: String(b.email || '').trim(), password: String(b.password || '') });
    if (error) throw new Error(/confirm/i.test(error.message) ? 'Please confirm your email first (check your inbox)' : 'Wrong email or password');
    return { token: data.session.access_token };
  }],

  ['GET', /^\/api\/me$/, () => meView()],
  ['PATCH', /^\/api\/me$/, async (b) => {
    const id = await uid(), patch = {}, old = lastMe?.photo;
    if (b.name?.trim()) patch.name = b.name.trim().slice(0, 60);
    if (b.photo !== undefined) patch.photo = b.photo;
    if (Object.keys(patch).length) check(await sb.from('lovebird_profiles').update(patch).eq('id', id));
    if (b.photo !== undefined && old && old !== b.photo) removeBlobs([old]);
    Live.tell('profile');
    return meView();
  }],
  ['POST', /^\/api\/members\/[^/]+\/photo$/, async () => ({ ok: false })], // only needed for data from the old server

  ['POST', /^\/api\/couple\/key$/, async (b) => { check(await sb.rpc('lovebird_set_couple_key', { p_key_id: b.keyId })); return meView(); }],
  ['GET', /^\/api\/keybackup$/, async () => {
    const id = await uid();
    return check(await sb.from('lovebird_key_backups').select('backup').eq('user_id', id).maybeSingle())?.backup || null;
  }],
  ['PUT', /^\/api\/keybackup$/, async (b) => { check(await sb.rpc('lovebird_put_key_backup', { b })); return meView(); }],

  ['GET', /^\/api\/invite\/([^/]+)$/, async (_, [code]) => check(await sb.rpc('lovebird_invite_info', { p_code: decodeURIComponent(code) })) || null],
  ['POST', /^\/api\/pair\/invite$/, async (b) => ({ code: check(await sb.rpc('lovebird_pair_invite', { p_key_id: b.keyId })) })],
  ['POST', /^\/api\/pair$/, async (b) => { check(await sb.rpc('lovebird_pair', { p_code: String(b.code || ''), p_key_id: b.keyId })); return meView(); }],
  ['POST', /^\/api\/unpair$/, async () => {
    const me = lastMe || (await meView());
    if (!me.coupleId) throw new Error('Connect with your partner first');
    await removeCoupleFolder(me.coupleId); // photos, videos and voice notes
    check(await sb.rpc('lovebird_unpair'));
    return { ok: true };
  }],

  ['GET', /^\/api\/items$/, async () => check(await sb.from('lovebird_items').select('*')).map(itemOut)],
  ['POST', /^\/api\/items$/, async (b) => {
    if (!lastMe?.coupleId) throw new Error('Connect with your partner first');
    const r = check(await sb.from('lovebird_items').insert({ couple_id: lastMe.coupleId, enc: b.enc }).select().single(), 'Could not save');
    Live.tell('items');
    return itemOut(r);
  }],
  ['PATCH', /^\/api\/items\/([^/]+)$/, async (b, [id]) => {
    const r = check(await sb.from('lovebird_items').update({ enc: b.enc }).eq('id', id).select().maybeSingle(), 'Could not save');
    if (!r) throw new Error('Not found');
    Live.tell('items');
    return itemOut(r);
  }],
  ['DELETE', /^\/api\/items\/([^/]+)$/, async (_, [id]) => {
    check(await sb.from('lovebird_items').delete().eq('id', id));
    Live.tell('items');
    return { ok: true };
  }],

  ['GET', /^\/api\/messages$/, async () => check(await sb.from('lovebird_messages').select('*').order('ts', { ascending: false }).limit(300)).reverse().map(msgOut)],
  ['POST', /^\/api\/messages\/[^/]+\/upgrade$/, async () => ({ ok: false })], // only needed for data from the old server
];

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  for (const [m, re, fn] of routes) {
    const hit = m === method && path.match(re);
    if (!hit) continue;
    try { return await fn(opts.body || {}, hit.slice(1)); }
    catch (e) {
      // Signed out for real (not just a network hiccup): back to the sign-in screen.
      if (e.auth && S.token && !(await sb.auth.getSession()).data.session) logout();
      throw e;
    }
  }
  throw new Error('Not available in this version');
}

// ---------- the live connection ----------
// lovebird-user:<me>       "paired" / "unpaired" (sent by the database)
// lovebird-couple:<ours>   new messages, plan changes, profile changes, who's online, sealed call / walkie-talkie signalling
const Live = (() => {
  const handlers = {};
  let me = null, userCh = null, coupleCh = null, coupleId = null, partnerId = null, online = false, joinedOnce = false, started = false;
  const fire = (ev, ...a) => (handlers[ev] || []).forEach((f) => { try { f(...a); } catch (e) { console.error(e); } });
  const opts = (extra) => ({ config: { private: true, ...extra } });

  async function start() {
    if (started) return;
    started = true;
    me = await uid().catch(() => null);
    if (!me) { started = false; return fire('connect_error', new Error('unauthorized')); }
    await sb.realtime.setAuth();
    userCh = sb.channel('lovebird-user:' + me, opts())
      .on('broadcast', { event: 'paired' }, () => fire('paired'))
      .on('broadcast', { event: 'unpaired' }, () => fire('unpaired'))
      .subscribe();
    if (coupleId) joinCouple();
    // Phones pause apps in the background; catch up on anything missed when Lovebird comes back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') catchUp(); });
  }
  function setOnline(v) {
    if (v === online) return;
    online = v;
    fire('presence', { online: v });
  }
  function joinCouple() {
    if (!started || !me || !coupleId) return;
    if (coupleCh?.topic === 'realtime:lovebird-couple:' + coupleId) return;
    if (coupleCh) sb.removeChannel(coupleCh);
    joinedOnce = false;
    const ch = sb.channel('lovebird-couple:' + coupleId, opts({ broadcast: { self: false, ack: false }, presence: { key: me } }));
    coupleCh = ch;
    ch.on('broadcast', { event: 'relay' }, ({ payload }) => fire('relay', payload))
      .on('broadcast', { event: 'chat' }, ({ payload }) => fire('chat:new', payload))
      .on('broadcast', { event: 'items' }, () => refreshItems())
      .on('broadcast', { event: 'profile' }, () => fire('profile'))
      .on('presence', { event: 'sync' }, () => setOnline(!!partnerId && !!ch.presenceState()[partnerId]?.length))
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED' || ch !== coupleCh) return;
        await ch.track({ at: Date.now() });
        if (joinedOnce) catchUp();
        joinedOnce = true;
        fire('connect');
      });
  }
  let itemsSeq = 0;
  async function refreshItems() {
    const n = ++itemsSeq;
    const list = await api('/api/items').catch(() => null);
    if (list && n === itemsSeq) fire('items', list);
  }
  async function catchUp() {
    if (!coupleId) return;
    const msgs = await api('/api/messages').catch(() => null);
    msgs?.forEach((m) => fire('chat:new', m)); // app.js skips ones it already has
    refreshItems();
  }
  return {
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    start,
    setCouple(cid, pid) {
      partnerId = pid;
      if (cid === coupleId) return;
      coupleId = cid;
      if (!cid) { if (coupleCh) sb.removeChannel(coupleCh); coupleCh = null; setOnline(false); return; }
      joinCouple();
    },
    partnerOnline(pid) { return !!pid && !!coupleCh?.presenceState()[pid]?.length; },
    tell(event, payload = {}) { coupleCh?.send({ type: 'broadcast', event, payload }).catch(() => {}); },
    async sendMessage(body) {
      if (!coupleId) throw new Error('Connect with your partner first');
      const r = msgOut(check(await sb.from('lovebird_messages').insert({ couple_id: coupleId, enc: body.enc, files: body.files || [] }).select().single(), 'Not sent'));
      fire('chat:new', r);
      this.tell('chat', r);
      return r;
    },
    relay(e) { if (me) this.tell('relay', { e, from: me }); },
    stop() { sb.removeAllChannels(); started = false; coupleCh = userCh = null; coupleId = null; },
  };
})();

// The small socket-like object app.js expects.
function io() {
  const s = {
    on: (ev, fn) => { Live.on(ev, fn); return s; },
    emit(ev, data, ack) {
      if (ev === 'chat:send') Live.sendMessage(data || {}).then((m) => ack?.(m), (e) => ack?.({ error: e.message || 'Not sent' }));
      else if (ev === 'relay') Live.relay(data?.e);
    },
    disconnect: () => Live.stop(),
  };
  setTimeout(() => Live.start(), 0);
  return s;
}
