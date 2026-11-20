/* Lovebird client */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dstr(new Date());
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

const S = {
  token: store.get('lb_token'), me: null, items: [], messages: [], cfg: {}, sock: null,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), sel: todayStr(), tab: 'calendar', unread: 0,
};

// ---------------- utilities ----------------
// api() and io() come from backend.js (Supabase).
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function show(screen) { $$('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== 'screen-' + screen)); }
// Encrypted files are downloaded, decrypted on this phone and shown from a local blob: URL.
const mediaCache = new Map();
function decryptedURL(url, mime) {
  if (!mediaCache.has(url)) {
    mediaCache.set(url, (async () => {
      const plain = await E2EE.openBytes(await downloadBlob(url));
      return URL.createObjectURL(new Blob([plain], { type: mime || 'application/octet-stream' }));
    })().catch((e) => { mediaCache.delete(url); throw e; }));
  }
  return mediaCache.get(url);
}
async function uploadEncrypted(blob) {
  const sealed = await E2EE.sealBytes(await blob.arrayBuffer());
  const url = await uploadBlob(sealed);
  mediaCache.set(url, Promise.resolve(URL.createObjectURL(blob))); // we already have the plain file
  return url;
}
function setAvatar(el, u) {
  if (!el) return;
  const letter = () => {
    el.style.backgroundImage = '';
    [...el.childNodes].forEach((n) => n.nodeType === 3 && n.remove());
    el.prepend(document.createTextNode((u?.name || '?').trim()[0]?.toUpperCase() || '?'));
  };
  el.dataset.src = u?.photo || '';
  if (!u?.photo || (u.photoEnc && !E2EE.ready())) return letter();
  if (!u.photoEnc) { [...el.childNodes].forEach((n) => n.nodeType === 3 && n.remove()); el.style.backgroundImage = `url("${u.photo}")`; return; }
  letter();
  decryptedURL(u.photo, 'image/*').then((src) => {
    if (el.dataset.src !== u.photo) return;
    [...el.childNodes].forEach((n) => n.nodeType === 3 && n.remove());
    el.style.backgroundImage = `url("${src}")`;
  }).catch(() => {});
}
const partner = () => S.me?.partner || { name: 'Partner' };
const whoClass = (a) => (a === 'both' ? 'both' : a === S.me.id ? 'me' : 'pt');
const whoName = (a) => (a === 'both' ? 'Both' : a === S.me.id ? 'Me' : partner().name);
function fmtTime(t) { if (!t) return ''; const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function relDay(ds) {
  const t = todayStr(); const d = new Date(ds + 'T12:00'); const tm = new Date(); tm.setDate(tm.getDate() + 1);
  if (ds === t) return 'Today'; if (ds === dstr(tm)) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// ---------------- sounds ----------------
let actx;
function audioCtx() { actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; }
function beep(freq = 880, dur = 0.09, vol = 0.15, when = 0) {
  try {
    const c = audioCtx(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime + when;
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch {}
}
const chirpOn = () => { beep(1046, 0.06); beep(1318, 0.07, 0.15, 0.07); };
const chirpOff = () => { beep(1318, 0.06); beep(880, 0.08, 0.15, 0.07); };
let ringTimer;
function ring(on, incoming) {
  clearInterval(ringTimer);
  if (!on) return;
  const play = () => incoming ? [0, 0.18, 0.36].forEach((w) => beep(740, 0.14, 0.22, w)) : beep(440, 0.4, 0.1);
  play(); ringTimer = setInterval(play, incoming ? 1600 : 3000);
  if (incoming) navigator.vibrate?.([300, 200, 300]);
}
function notify(title, body) {
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: 'icon.svg', tag: 'lovebird' }); } catch {}
}

// ---------------- boot & auth ----------------
// Where a couple key can come from on this phone:
//   lb_key_<uid>   the couple key, once this phone has it
//   lb_invite_key  the key this phone made for its pairing QR (becomes the couple key when the partner scans it)
//   lb_pend        a key that arrived in a link (#k=…) — an invite, a "link a phone" code, or the demo
const PEND = 'lb_pend', INVITE_KEY = 'lb_invite_key';
const keyName = () => 'lb_key_' + S.me.id;
const pending = () => { try { return JSON.parse(store.get(PEND) || 'null'); } catch { return null; } };
const linkBase = () => (S.cfg.publicUrl || location.origin + location.pathname.replace(/[^/]*$/, '')).replace(/\/$/, '');

async function boot() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('token')) { S.token = h.get('token'); store.set('lb_token', S.token); }
  if (h.get('error')) setTimeout(() => toast(h.get('error'), 4500), 200);
  const pair = new URLSearchParams(location.search).get('pair');
  if (h.get('k') || pair) store.set(PEND, JSON.stringify({ k: h.get('k') || null, code: pair ? pair.toUpperCase() : null }));
  S.startTab = h.get('tab');
  history.replaceState(null, '', location.pathname);
  S.cfg = await api('/api/config').catch(() => ({}));
  $('#googleWrap').classList.toggle('hidden', !S.cfg.googleEnabled);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!E2EE.supported) {
    showAuth();
    return toast('Lovebird needs a secure connection (https) to encrypt your data. Open it with https://', 10000);
  }

  S.token = (await sb.auth.getSession()).data.session?.access_token || null;
  if (!S.token) return showAuth();
  try { S.me = await api('/api/me'); } catch { return showAuth(); }
  connectSocket();
  const p = pending();
  if (p?.code && !S.me.coupleId) {
    if (!p.k) toast('That invite link is from an older version — ask your partner for a fresh QR code', 6000);
    else {
      try { await api('/api/pair', { method: 'POST', body: { code: p.code, keyId: await E2EE.idOf(p.k) } }); S.me = await api('/api/me'); toast(`You're connected with ${partner().name} 💞`); }
      catch (e) { toast(e.message, 5000); }
    }
  }
  route();
}

// Decide which screen to show: pairing -> unlock -> create a passphrase -> the app.
let routeQ = Promise.resolve();
const route = () => (routeQ = routeQ.then(doRoute).catch((e) => toast(e.message, 5000)));
async function doRoute() {
  if (!S.me.coupleId) { S.inApp = false; return showPair(); }
  if ((!E2EE.ready() || E2EE.keyId() !== S.me.keyId) && !(await adoptKey())) { S.inApp = false; return showKey('unlock'); }
  store.set(PEND, null);
  if (!S.me.hasBackup && !S.me.demo) { S.inApp = false; return showKey('create'); }
  if (S.inApp) return;
  await enterApp(S.startTab); S.startTab = null;
}
async function adoptKey() {
  for (const k of [store.get(keyName()), pending()?.k, store.get(INVITE_KEY)]) {
    if (k && (await E2EE.idOf(k)) === S.me.keyId) return useKey(k);
  }
  if (!S.me.keyId) {
    // Connected before encryption existed: the first phone to open the new version makes the key.
    const k = E2EE.newKey();
    try { S.me = await api('/api/couple/key', { method: 'POST', body: { keyId: await E2EE.idOf(k) } }); return useKey(k); }
    catch { S.me = await api('/api/me'); if (S.me.keyId) return adoptKey(); throw new Error('Could not set up encryption — check your connection'); }
  }
  return false;
}
async function useKey(k) {
  await E2EE.use(k);
  store.set(keyName(), k); store.set(INVITE_KEY, null); store.set(PEND, null);
  return true;
}

async function showAuth() {
  show('auth');
  const code = pending()?.code;
  if (code) {
    const inv = await api('/api/invite/' + code).catch(() => null);
    if (inv) {
      const b = $('#inviteBanner'); b.classList.remove('hidden');
      b.innerHTML = `<div class="avatar sm"></div><div><b>${esc(inv.name)}</b> invited you to Lovebird. Create an account or sign in to connect.</div>`;
      setAvatar(b.querySelector('.avatar'), inv);
    }
  }
}
let authMode = 'register';
$('#authSeg').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.mode; if (!m) return;
  authMode = m;
  $$('#authSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const f = $('#authForm');
  f.name.classList.toggle('hidden', m === 'login');
  f.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
  f.querySelector('button').textContent = m === 'login' ? 'Sign in' : 'Create account';
});
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button');
  btn.disabled = true;
  try {
    const body = { name: f.name.value, email: f.email.value, password: f.password.value };
    const { token } = await api(authMode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
    S.token = token; store.set('lb_token', token);
    await boot();
  } catch (err) { toast(err.message); }
  btn.disabled = false;
});
// Signing out removes the key from this phone. To sign back in you need your passphrase or your partner's phone.
function logout() {
  if (S.me) { store.set(keyName(), null); store.set('lb_gcal_' + S.me.id, null); }
  store.set('lb_token', null); store.set('lb_walkie', null); store.set(PEND, null); store.set(INVITE_KEY, null);
  E2EE.forget(); GCal.forget();
  S.token = null; S.sock?.disconnect();
  sb.auth.signOut({ scope: 'local' }).catch(() => {}).finally(() => { location.href = linkBase() + '/'; });
}
$('#logoutBtn').onclick = () => {
  if (!S.me?.demo && !confirm('Sign out? To read your messages again on this phone you’ll need your recovery passphrase or your partner’s phone.')) return;
  logout();
};
$('#pairLogout').onclick = logout;
$('#keyLogout').onclick = logout;

// ---------------- QR scanning ----------------
// Uses the built-in barcode reader where there is one (Android Chrome), otherwise jsQR (iPhone).
let scanStream, scanLoop, scanDone;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'vendor/jsqr.min.js'; s.onload = ok; s.onerror = no; document.head.append(s); });
}
async function scanQR() {
  let det = null;
  try { if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) det = new BarcodeDetector({ formats: ['qr_code'] }); } catch {}
  try {
    if (!det) await loadJsQR();
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch { toast('Camera permission is needed to scan'); return null; }
  const v = $('#scanVideo'); v.srcObject = scanStream; await v.play().catch(() => {});
  $('#scanner').classList.remove('hidden');
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  return new Promise((resolve) => {
    scanDone = (val) => { scanDone = null; stopScan(); resolve(val); };
    let busy = false;
    scanLoop = setInterval(async () => {
      if (busy || !v.videoWidth) return;
      busy = true;
      let txt = null;
      try {
        if (det) txt = (await det.detect(v))[0]?.rawValue;
        else {
          const w = 640, hh = Math.round((w * v.videoHeight) / v.videoWidth);
          cv.width = w; cv.height = hh; cx.drawImage(v, 0, 0, w, hh);
          txt = jsQR(cx.getImageData(0, 0, w, hh).data, w, hh, { inversionAttempts: 'dontInvert' })?.data;
        }
      } catch {}
      busy = false;
      if (txt) scanDone?.(txt);
    }, 200);
  });
}
function stopScan() { clearInterval(scanLoop); scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; $('#scanner').classList.add('hidden'); }
$('#stopScan').onclick = () => (scanDone ? scanDone(null) : stopScan());
const keyFromLink = (t) => String(t || '').match(/#(?:.*&)?k=([\w-]{40,})/)?.[1] || null;

// ---------------- pairing ----------------
// This phone makes the couple key and puts it in the QR code after the "#", which is never sent to the server.
async function showPair() {
  show('pair');
  let k = store.get(INVITE_KEY);
  if (!k) { k = E2EE.newKey(); store.set(INVITE_KEY, k); }
  try {
    const { code } = await api('/api/pair/invite', { method: 'POST', body: { keyId: await E2EE.idOf(k) } });
    const url = `${linkBase()}/?pair=${code}#k=${k}`;
    $('#qrImg').src = await QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: '#3b1830', light: '#ffffff' } });
    $('#shareInvite').onclick = async () => {
      const data = { title: 'Lovebird', text: 'Tap to connect with me on Lovebird 💞', url };
      if (navigator.share) navigator.share(data).catch(() => {});
      else { await navigator.clipboard?.writeText(url); toast('Invite link copied — send it only to your partner'); }
    };
  } catch (e) { toast(e.message); }
}
async function pairWith(text) {
  const code = String(text || '').match(/pair=([A-Z0-9]+)/i)?.[1], k = keyFromLink(text);
  if (!code || !k) return toast('That isn’t a Lovebird invite. Ask your partner to open their pairing QR.', 4500);
  store.set(PEND, JSON.stringify({ k })); // the "paired" event picks it up
  try { await api('/api/pair', { method: 'POST', body: { code, keyId: await E2EE.idOf(k) } }); }
  catch (e) { toast(e.message, 5000); }
}
$('#codeForm').addEventListener('submit', (e) => { e.preventDefault(); pairWith(e.target.code.value); e.target.code.value = ''; });
$('#scanBtn').onclick = async () => { const t = await scanQR(); if (t) pairWith(t); };

// ---------------- encryption key screens ----------------
let keyMode = 'create';
function showKey(mode) {
  keyMode = mode;
  show('key');
  const f = $('#passForm'), creating = mode !== 'unlock';
  f.reset();
  $('#keyTitle').textContent = creating ? (mode === 'change' ? 'Change recovery passphrase' : 'Create a recovery passphrase') : 'Unlock your messages';
  $('#keyText').innerHTML = creating
    ? 'Your messages, photos, videos and calendar are <b>end-to-end encrypted</b>: only your two phones can read them — not Lovebird’s server, and not the people who run it.<br><br>If you sign in on a new phone, this passphrase unlocks your data. <b>Write it down.</b> No one can reset it for you.'
    : S.me.hasBackup
      ? `This phone doesn’t have your key yet. Enter your recovery passphrase, or ask ${esc(partner().name)} to open <b>Me → Link a phone</b> and scan the code on their screen.`
      : `This phone doesn’t have your key yet. Ask ${esc(partner().name)} to open Lovebird, go to <b>Me → Link a phone</b>, and scan the code on their screen.`;
  f.classList.toggle('hidden', !creating && !S.me.hasBackup);
  f.p1.placeholder = creating ? 'Passphrase (10+ characters)' : 'Recovery passphrase';
  f.p1.autocomplete = creating ? 'new-password' : 'current-password';
  f.p2.classList.toggle('hidden', !creating);
  f.p2.required = creating;
  $('#passBtn').textContent = creating ? 'Save passphrase' : 'Unlock';
  $('#keyScanBtn').classList.toggle('hidden', creating);
  $('#keyBack').classList.toggle('hidden', mode !== 'change');
  $('#keyLogout').classList.toggle('hidden', mode === 'change');
}
$('#passForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, btn = $('#passBtn'), p1 = f.p1.value;
  btn.disabled = true;
  try {
    if (keyMode === 'unlock') {
      btn.textContent = 'Unlocking…';
      const backup = await api('/api/keybackup');
      if (!backup) throw new Error('No passphrase was saved — use your partner’s phone instead');
      const k = await E2EE.unlockWithPassphrase(backup, p1);
      if ((await E2EE.idOf(k)) !== S.me.keyId) throw new Error('That passphrase belongs to an older key — use your partner’s phone instead');
      await useKey(k);
      toast('Unlocked 🔓');
    } else {
      if (p1.length < 10) throw new Error('Use at least 10 characters — a short sentence works well');
      if (p1 !== f.p2.value) throw new Error('The two passphrases don’t match');
      btn.textContent = 'Saving…';
      S.me = await api('/api/keybackup', { method: 'PUT', body: await E2EE.lockWithPassphrase(p1) });
      toast('Passphrase saved 🔒');
      if (keyMode === 'change') { show('main'); setTab('me'); return; }
    }
    route();
  } catch (err) { toast(err.message, 4500); }
  finally { btn.disabled = false; $('#passBtn').textContent = keyMode === 'unlock' ? 'Unlock' : 'Save passphrase'; }
});
$('#keyScanBtn').onclick = async () => {
  const k = keyFromLink(await scanQR());
  if (!k) return;
  if ((await E2EE.idOf(k)) !== S.me.keyId) return toast('That code is for a different couple', 4000);
  await useKey(k);
  toast('Unlocked 🔓');
  route();
};
$('#keyBack').onclick = () => { show('main'); setTab('me'); };

// ---------------- socket ----------------
function connectSocket() {
  if (S.sock) return;
  const s = io({ auth: { token: S.token } });
  S.sock = s;
  s.on('connect_error', (e) => { if (e.message === 'unauthorized') logout(); });
  s.on('connect', () => { if (walkie.on) send('walkie:ready'); });
  s.on('paired', async () => { S.me = await api('/api/me'); stopScan(); toast(`You're connected with ${partner().name} 💞`); route(); });
  s.on('unpaired', () => { store.set(keyName(), null); location.reload(); });
  s.on('profile', refreshMe);
  s.on('toast', (m) => toast(m, 4000));
  s.on('presence', ({ online }) => {
    if (!S.me) return;
    S.me.online = online; renderHeader();
    if (!online) { walkie.partnerOn = false; walkieClosePC(); renderWalkie(); if (call.state !== 'idle') endCall('Call ended'); }
  });
  let itemsSeq = 0;
  s.on('items', async (records) => {
    if (!S.inApp) return;
    const n = ++itemsSeq, list = await openItems(records);
    if (n !== itemsSeq) return;
    const prev = S.items; S.items = list; renderCalendar();
    GCal.onItems(prev, list);
  });
  // Incoming events are decrypted one at a time, in order.
  let rxQ = Promise.resolve();
  s.on('chat:new', (raw) => {
    rxQ = rxQ.then(async () => {
      if (!S.inApp || S.messages.some((x) => x.id === raw.id)) return;
      const m = await openMessage(raw);
      S.messages.push(m); appendMessage(m);
      if (m.from !== S.me.id) {
        if (S.tab !== 'chat' || document.hidden) { S.unread++; renderBadge(); beep(988, 0.08, 0.1); }
        notify(partner().name, m.kind === 'text' ? m.text : { image: '📷 Photo', video: '🎬 Video', audio: '🎙️ Voice message' }[m.kind]);
      }
    });
  });
  let relayQ = Promise.resolve();
  s.on('relay', (raw) => {
    relayQ = relayQ.then(async () => {
      if (!E2EE.ready()) return;
      let d;
      try { d = await E2EE.open(raw.e, 'relay'); } catch { return; } // not from someone holding our key: ignore
      await onRelay({ ...d, from: raw.from });
    });
  });
}
// Everything sent to the partner's phone (call set-up, walkie, typing…) is sealed, in order.
let sendQ = Promise.resolve();
function send(t, d = {}) {
  if (!S.sock || !E2EE.ready()) return;
  const payload = JSON.parse(JSON.stringify({ ...d, t }));
  sendQ = sendQ.then(async () => S.sock.emit('relay', { e: await E2EE.seal(payload, 'relay') })).catch(() => {});
}
// Records from the server -> readable objects (only possible with the couple key).
async function openItem(r) {
  if (!r.enc) return { ...r, legacy: true }; // written before encryption: upgraded in upgradeOldData()
  try { return { ...(await E2EE.open(r.enc, 'item')), id: r.id, createdBy: r.createdBy, updatedAt: r.updatedAt }; }
  catch { return null; }
}
const openItems = async (records) => (await Promise.all(records.map(openItem))).filter(Boolean);
async function openMessage(m) {
  if (!m.enc) return { ...m, legacy: true };
  try { return { id: m.id, from: m.from, ts: m.ts, ...(await E2EE.open(m.enc, 'msg')) }; }
  catch { return { id: m.id, from: m.from, ts: m.ts, kind: 'text', text: '🔒 This message can’t be decrypted on this phone' }; }
}
const ITEM_FIELDS = ['type', 'title', 'notes', 'date', 'startTime', 'endTime', 'allDay', 'done', 'tz', 'assignee', 'source', 'gcal', 'gsync'];
const itemPayload = (it) => Object.fromEntries(ITEM_FIELDS.filter((k) => it[k] !== undefined).map((k) => [k, it[k]]));
// Encrypt an item and save it (creates it when it has no id yet).
async function saveItem(it) {
  const enc = await E2EE.seal(itemPayload(it), 'item');
  const r = it.id ? await api('/api/items/' + it.id, { method: 'PATCH', body: { enc } }) : await api('/api/items', { method: 'POST', body: { enc } });
  const saved = { ...itemPayload(it), id: r.id, createdBy: r.createdBy, updatedAt: r.updatedAt };
  const i = S.items.findIndex((x) => x.id === saved.id);
  i >= 0 ? (S.items[i] = saved) : S.items.push(saved);
  return saved;
}
async function refreshMe() { S.me = await api('/api/me'); renderHeader(); renderMe(); }

// ---------------- main app ----------------
async function enterApp(tab) {
  show('main');
  S.inApp = true;
  const [items, messages] = await Promise.all([api('/api/items'), api('/api/messages')]);
  S.items = await openItems(items); S.messages = await Promise.all(messages.map(openMessage));
  $('#demoBar').classList.toggle('hidden', !S.me.demo);
  if (S.me.demo) walkie.partnerOn = true;
  renderHeader(); renderCalendar(); renderMessages(); renderMe(); renderWalkie();
  setTab(tab || store.get('lb_tab') || 'calendar');
  GCal.init();
  upgradeOldData();
}
// Plans, messages and photos saved before encryption existed are encrypted by the first phone that has the key.
async function upgradeOldData() {
  const items = S.items.filter((i) => i.legacy), msgs = S.messages.filter((m) => m.legacy);
  const photos = [S.me, S.me.partner].filter((u) => u?.photo?.startsWith('/uploads/') && !u.photoEnc);
  const total = items.length + msgs.length + photos.length;
  if (!total) return;
  let done = 0;
  const tick = () => toast(`🔒 Encrypting your earlier plans and messages… ${++done}/${total}`, 60000);
  try {
    for (const it of items) { await saveItem(it); tick(); }
    for (const m of msgs) {
      const body = { kind: m.kind || 'text', text: m.text || '' }, files = [];
      if (m.url) {
        const r = await fetch(m.url);
        if (r.ok) { const b = await r.blob(); const url = await uploadEncrypted(b); body.file = { url, mime: b.type }; files.push(url); }
        else Object.assign(body, { kind: 'text', text: body.text || '(file no longer available)' });
      }
      await api(`/api/messages/${m.id}/upgrade`, { method: 'POST', body: { enc: await E2EE.seal(body, 'msg'), files } });
      delete m.url; delete m.legacy; Object.assign(m, body); tick();
    }
    for (const u of photos) {
      const r = await fetch(u.photo);
      if (!r.ok) continue;
      const url = await uploadEncrypted(await r.blob());
      if (u.id === S.me.id) await api('/api/me', { method: 'PATCH', body: { photo: url } });
      else await api(`/api/members/${u.id}/photo`, { method: 'POST', body: { photo: url } });
      tick();
    }
    S.me = await api('/api/me');
    renderHeader(); renderMe(); renderMessages(); renderCalendar();
    toast('🔒 Done — everything is now end-to-end encrypted', 3500);
  } catch (e) { toast('Encryption upgrade paused: ' + e.message, 5000); }
}
function setTab(tab) {
  S.tab = tab; store.set('lb_tab', tab);
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tab));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'chat') { S.unread = 0; renderBadge(); scrollChat(); }
}
$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
function renderBadge() { const b = $('#chatBadge'); b.textContent = S.unread; b.classList.toggle('hidden', !S.unread); }
function renderHeader() {
  const p = partner();
  setAvatar($('#partnerAvatar'), p);
  $('#partnerName').textContent = p.name;
  const st = $('#partnerStatus');
  st.textContent = S.me.online ? 'Online' : 'Offline'; st.classList.toggle('on', !!S.me.online);
  $('#legendPartner').textContent = p.name;
}

// ---------------- calendar ----------------
function itemsOn(ds) {
  return S.items.filter((i) => i.date === ds).sort((a, b) =>
    (a.type === 'task') - (b.type === 'task') || (!!b.allDay - !!a.allDay) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
}
function renderCalendar() {
  const m = S.month;
  $('#monthTitle').textContent = m.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const start = new Date(m); start.setDate(1 - m.getDay());
  const weeks = Math.ceil((m.getDay() + new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) / 7);
  const t = todayStr();
  let html = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = dstr(d);
    const kinds = [...new Set(itemsOn(ds).filter((x) => !x.done).map((x) => whoClass(x.assignee)))];
    html += `<button class="day ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${ds === t ? 'today' : ''} ${ds === S.sel ? 'sel' : ''}" data-d="${ds}">
      <span class="num">${d.getDate()}</span><span class="dots">${kinds.map((k) => `<i class="dot ${k}"></i>`).join('')}</span></button>`;
  }
  $('#monthGrid').innerHTML = html;
  $('#dayTitle').textContent = relDay(S.sel);
  const day = itemsOn(S.sel);
  $('#dayList').innerHTML = day.length ? day.map(itemHTML).join('') : `<div class="empty">Nothing planned. Tap + to add something.</div>`;
  const end = new Date(); end.setDate(end.getDate() + 30);
  const up = S.items.filter((i) => i.date >= t && i.date <= dstr(end) && !i.done)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime || '').localeCompare(String(b.startTime || ''))).slice(0, 25);
  let last = '', uh = '';
  for (const i of up) { if (i.date !== last) { uh += `<div class="day-group">${relDay(i.date)}</div>`; last = i.date; } uh += itemHTML(i); }
  $('#upcomingList').innerHTML = uh || `<div class="empty">No upcoming plans in the next 30 days.</div>`;
}
function itemHTML(i) {
  const when = i.type === 'task' ? '' : i.allDay || !i.startTime ? 'All day' : fmtTime(i.startTime) + (i.endTime ? `<br>${fmtTime(i.endTime)}` : '');
  const tick = i.type === 'task' ? `<button class="tick ${i.done ? 'on' : ''}" data-tick="${i.id}" aria-label="Mark done">${i.done ? '✓' : ''}</button>` : `<div class="when">${when}</div>`;
  const meta = [i.type === 'task' ? 'Task' : '', whoName(i.assignee), i.source === 'google' ? 'Google' : '', i.notes ? esc(i.notes.slice(0, 60)) : ''].filter(Boolean).join(' · ');
  return `<div class="item ${whoClass(i.assignee)} ${i.done ? 'done' : ''}" data-id="${i.id}">${tick}<div class="grow"><div class="title">${esc(i.title)}</div><div class="meta">${meta}</div></div></div>`;
}
$('#monthGrid').addEventListener('click', (e) => {
  const d = e.target.closest('.day')?.dataset.d; if (!d) return;
  S.sel = d;
  const dd = new Date(d + 'T12:00');
  if (dd.getMonth() !== S.month.getMonth()) S.month = new Date(dd.getFullYear(), dd.getMonth(), 1);
  renderCalendar();
});
$('#prevMonth').onclick = () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); renderCalendar(); };
$('#nextMonth').onclick = () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); renderCalendar(); };
$('#view-calendar').addEventListener('click', async (e) => {
  const tick = e.target.closest('[data-tick]');
  if (tick) {
    e.stopPropagation();
    const it = S.items.find((x) => x.id === tick.dataset.tick);
    it.done = !it.done; renderCalendar();
    saveItem(it).then(GCal.afterSave).catch((err) => toast(err.message));
    return;
  }
  const row = e.target.closest('.item[data-id]');
  if (row) openSheet(S.items.find((x) => x.id === row.dataset.id));
});

// item sheet
let editing = null, sheetType = 'event', sheetWho = 'both';
function openSheet(it) {
  editing = it || null;
  const f = $('#itemForm');
  sheetType = it?.type || 'event';
  sheetWho = it?.assignee || 'both';
  $('#sheetTitle').textContent = it ? 'Edit' : 'New';
  f.title.value = it?.title || '';
  f.date.value = it?.date || S.sel;
  f.allDay.checked = !!it?.allDay;
  f.startTime.value = it?.startTime || '';
  f.endTime.value = it?.endTime || '';
  f.notes.value = it?.notes || '';
  $('#whoSeg').innerHTML = [['both', 'Both of us'], [S.me.id, 'Me'], [partner().id, partner().name]]
    .map(([v, l]) => `<button type="button" data-v="${v}">${esc(l)}</button>`).join('');
  $('#deleteItem').classList.toggle('hidden', !it);
  syncSheet();
  $('#itemSheet').showModal();
  if (!it) setTimeout(() => f.title.focus(), 50);
}
function syncSheet() {
  $$('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === sheetType));
  $$('#whoSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === sheetWho));
  const f = $('#itemForm');
  $('#timeFields').classList.toggle('hidden', f.allDay.checked || sheetType === 'task');
  f.allDay.closest('label').classList.toggle('hidden', sheetType === 'task');
}
$('#typeSeg').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { sheetType = v; syncSheet(); } };
$('#whoSeg').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { sheetWho = v; syncSheet(); } };
$('#itemForm').allDay.onchange = syncSheet;
$('#addBtn').onclick = () => openSheet();
$('#sheetClose').onclick = () => $('#itemSheet').close();
$('#itemSheet').addEventListener('click', (e) => { if (e.target.id === 'itemSheet') e.target.close(); });
$('#itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const time = (t) => (/^\d{2}:\d{2}$/.test(t) ? t : null);
  const body = { ...(editing || { done: false, gcal: {} }), type: sheetType, title: f.title.value.trim().slice(0, 140), date: f.date.value,
    allDay: sheetType === 'task' ? true : f.allDay.checked, startTime: time(f.startTime.value), endTime: time(f.endTime.value),
    notes: f.notes.value.slice(0, 2000), assignee: sheetWho, tz: TZ };
  try {
    if (!body.title) throw new Error('Please add a title');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error('Pick a date');
    const it = await saveItem(body);
    GCal.afterSave();
    S.sel = it.date; renderCalendar();
    $('#itemSheet').close();
    if (!editing) send('nudge', { text: `added “${it.title}”` });
  } catch (err) { toast(err.message); }
});
$('#deleteItem').onclick = async () => {
  if (!editing || !confirm(`Delete “${editing.title}”?`)) return;
  try { await api('/api/items/' + editing.id, { method: 'DELETE' }); GCal.afterDelete(editing); S.items = S.items.filter((x) => x.id !== editing.id); renderCalendar(); $('#itemSheet').close(); }
  catch (err) { toast(err.message); }
};

// ---------------- chat ----------------
function msgHTML(m) {
  const mine = m.from === S.me.id;
  // Media starts as a placeholder; it is downloaded and decrypted when it scrolls into view.
  const f = m.file || (m.url ? { url: m.url, plain: true } : null);
  const body = m.kind === 'text' || !f ? esc(m.text)
    : `<div class="media-ph" data-kind="${esc(m.kind)}" data-url="${esc(f.url)}" data-mime="${esc(f.mime || '')}" data-plain="${f.plain ? 1 : ''}">${{ image: '📷', video: '🎬', audio: '🎙️' }[m.kind] || '📎'}</div>`;
  const time = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<div class="msg ${mine ? 'me' : ''} ${m.kind !== 'text' ? 'has-media' : ''}">${body}${m.text && m.kind !== 'text' ? `<div>${esc(m.text)}</div>` : ''}<time>${time}</time></div>`;
}
let lastMsgDay = '';
function daySep(m) {
  const d = dstr(new Date(m.ts));
  if (d === lastMsgDay) return '';
  lastMsgDay = d;
  return `<div class="daysep">${relDay(d)}</div>`;
}
function renderMessages() {
  lastMsgDay = '';
  $('#messages').innerHTML = S.messages.length
    ? `<div class="e2ee-note">🔒 Messages, photos and videos are end-to-end encrypted.</div>` + S.messages.map((m) => daySep(m) + msgHTML(m)).join('')
    : `<div class="empty center-text" style="margin:auto">Say hi to ${esc(partner().name)} 👋<br><span class="small">🔒 Everything here is end-to-end encrypted.</span></div>`;
  hydrateMedia(); scrollChat();
}
function appendMessage(m) {
  if (S.messages.length === 1) return renderMessages();
  $('#messages').insertAdjacentHTML('beforeend', daySep(m) + msgHTML(m));
  hydrateMedia(); scrollChat();
}
const mediaObs = new IntersectionObserver((entries) => entries.forEach((e) => {
  if (e.isIntersecting) { mediaObs.unobserve(e.target); loadMedia(e.target); }
}), { root: $('#messages'), rootMargin: '600px 0px' });
function hydrateMedia() { $$('#messages .media-ph:not([data-obs])').forEach((el) => { el.dataset.obs = '1'; mediaObs.observe(el); }); }
async function loadMedia(ph) {
  const { kind, url, mime, plain } = ph.dataset;
  try {
    const src = esc(plain ? url : await decryptedURL(url, mime));
    const el = $('#messages'), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    ph.outerHTML = kind === 'image' ? `<img class="media" src="${src}" alt="Photo">`
      : kind === 'video' ? `<video class="media" src="${src}" controls playsinline preload="metadata"></video>`
      : `<div class="voice">🎙️<audio src="${src}" controls preload="metadata"></audio></div>`;
    if (atBottom) scrollChat();
  } catch { ph.textContent = '⚠️ Couldn’t open this file'; }
}
function scrollChat() { const el = $('#messages'); requestAnimationFrame(() => (el.scrollTop = el.scrollHeight)); }
$('#messages').addEventListener('load', scrollChat, true);
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#msgInput'), text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const enc = await E2EE.seal({ kind: 'text', text: text.slice(0, 4000) }, 'msg');
  S.sock.emit('chat:send', { enc }, (r) => r?.error && toast(r.error));
});
$('#mediaInput').onchange = async (e) => {
  for (const file of e.target.files) await sendMedia(file);
  e.target.value = '';
};
// Photos, videos and voice notes are encrypted on this phone, then uploaded.
async function sendMedia(file, name) {
  const kind = String(file.type || '').split('/')[0];
  if (!['image', 'video', 'audio'].includes(kind)) return toast('Only photos, videos and voice notes can be sent');
  if (file.size > 49 * 1024 * 1024) return toast('That file is too big (max 49 MB)');
  toast('🔒 Encrypting & sending…', 120000);
  try {
    const url = await uploadEncrypted(file);
    const enc = await E2EE.seal({ kind, text: '', file: { url, mime: file.type, name: name || file.name || '' } }, 'msg');
    await new Promise((ok, no) => S.sock.emit('chat:send', { enc, files: [url] }, (r) => (r?.error ? no(new Error(r.error)) : ok())));
    toast('Sent', 1000);
  } catch (err) { toast(err.message); }
}
$('#messages').addEventListener('click', (e) => {
  const img = e.target.closest('img.media'); if (!img) return;
  const lb = $('#lightbox'); lb.querySelector('img').src = img.src; lb.classList.remove('hidden');
});
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');

// ---------------- profile ----------------
function renderMe() {
  setAvatar($('#myAvatar'), S.me);
  $('#nameInput').value = S.me.name;
  $('#myEmail').textContent = S.me.email || '';
  const gc = GCal.status();
  $('#gcalStatus').textContent = S.me.demo ? 'Not available in the demo'
    : !gc.available ? 'Not set up on this server yet (see README)'
    : gc.connected ? `Connected on this phone${gc.email ? ' · ' + gc.email : ''}`
    : 'Send your shared plans to your Google Calendar and bring your events in. This phone talks to Google directly, so your events never pass through Lovebird’s server.';
  $('#gcalBtn').classList.toggle('hidden', !gc.available || gc.connected);
  $('#gcalRow2').classList.toggle('hidden', !gc.connected);
  $('#safetyCode').textContent = E2EE.safetyCode();
  setAvatar($('#partnerAvatar2'), partner());
  $('#partnerName2').textContent = partner().name;
  $('#notifBtn').textContent = window.Notification?.permission === 'granted' ? 'On' : 'Enable';
}
$('#photoInput').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Please choose a photo');
  try {
    const url = await uploadEncrypted(file);
    S.me = await api('/api/me', { method: 'PATCH', body: { photo: url } }); renderMe(); toast('Photo updated');
  } catch (err) { toast(err.message); }
  e.target.value = '';
};
$('#nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { S.me = await api('/api/me', { method: 'PATCH', body: { name: $('#nameInput').value } }); renderMe(); toast('Saved'); } catch (err) { toast(err.message); }
});
$('#gcalBtn').onclick = async () => {
  try { const r = await GCal.connect(); renderMe(); toast(`Google Calendar connected · ${r.pushed} sent, ${r.imported} imported`, 4000); }
  catch (e) { toast(e.message, 4500); }
};
$('#gcalSync').onclick = async () => {
  toast('Syncing…', 30000);
  try { const r = await GCal.sync(); toast(`Synced · ${r.pushed} sent, ${r.imported} imported`); }
  catch (e) { toast(e.message, 4500); }
};
$('#gcalDisconnect').onclick = () => { GCal.disconnect(); renderMe(); toast('Google Calendar disconnected on this phone'); };
// "Link a phone": show the couple key as a QR so a new phone (yours or your partner's) can read your data.
$('#linkPhoneBtn').onclick = async () => {
  $('#linkQr').src = await QRCode.toDataURL(`${linkBase()}/#k=${E2EE.rawKey()}`, { margin: 1, width: 480, color: { dark: '#3b1830', light: '#ffffff' } });
  $('#linkSheet').showModal();
};
$('#linkClose').onclick = () => { $('#linkQr').removeAttribute('src'); $('#linkSheet').close(); };
$('#changePassBtn').onclick = () => (S.me.demo ? toast('Not needed in the demo') : showKey('change'));
$('#notifBtn').onclick = async () => { if (!('Notification' in window)) return toast('Notifications are not supported here'); await Notification.requestPermission(); renderMe(); };
$('#unpairBtn').onclick = async () => {
  if (!confirm(`Disconnect from ${partner().name}? This permanently deletes your shared calendar, chat, photos and videos for both of you. It can’t be undone.`)) return;
  await api('/api/unpair', { method: 'POST' }); location.reload();
};

// ---------------- WebRTC helpers ----------------
async function handleRtc(conn, d, makePC) {
  if (d.sdp) {
    if (d.sdp.type === 'offer') {
      const pc = await makePC();
      await pc.setRemoteDescription(d.sdp);
      await flushIce(conn);
      await pc.setLocalDescription(await pc.createAnswer());
      send('rtc', { ch: d.ch, sdp: pc.localDescription });
    } else if (conn.pc) {
      await conn.pc.setRemoteDescription(d.sdp);
      await flushIce(conn);
    }
  } else if (d.ice) {
    if (conn.pc?.remoteDescription) conn.pc.addIceCandidate(d.ice).catch(() => {});
    else conn.ice.push(d.ice);
  }
}
async function flushIce(conn) { for (const c of conn.ice.splice(0)) await conn.pc.addIceCandidate(c).catch(() => {}); }

// ---------------- calls ----------------
const call = { state: 'idle', pc: null, local: null, video: false, ice: [], timer: null, facing: 'user' };
function callUI(mode) {
  const ui = $('#callUI');
  ui.classList.remove('hidden');
  ui.classList.toggle('audio', !call.video);
  ui.classList.toggle('live', mode === 'live');
  $('#callBtnsIncoming').classList.toggle('hidden', mode !== 'incoming');
  $('#callBtnsActive').classList.toggle('hidden', mode === 'incoming');
  setAvatar($('#callAvatar'), partner());
  $('#callName').textContent = partner().name;
  $('#localVideo').srcObject = call.local;
}
const callState = (t) => ($('#callState').textContent = t);
async function getMedia(video) {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { facingMode: call.facing, width: { ideal: 1280 } } : false });
}
async function startCall(video) {
  if (call.state !== 'idle') return;
  if (S.me.demo) return demoCall(video, false);
  if (!S.me.online) return toast(`${partner().name} is offline right now`);
  call.video = video; call.state = 'calling';
  try { call.local = await getMedia(video); } catch { call.state = 'idle'; return toast('Please allow microphone' + (video ? ' and camera' : '') + ' access'); }
  callUI('outgoing'); callState(video ? 'Video calling…' : 'Calling…');
  send('call:invite', { video });
  ring(true, false);
  call.timer = setTimeout(() => { if (call.state === 'calling') { send('call:end'); endCall('No answer'); } }, 45000);
}
function makeCallPC() {
  call.pc?.close();
  const pc = new RTCPeerConnection(ICE);
  call.pc = pc;
  call.local.getTracks().forEach((t) => pc.addTrack(t, call.local));
  pc.onicecandidate = (e) => e.candidate && send('rtc', { ch: 'call', ice: e.candidate });
  pc.ontrack = (e) => { const v = $('#remoteVideo'); if (v.srcObject !== e.streams[0]) { v.srcObject = e.streams[0]; v.play().catch(() => {}); } };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { call.state = 'live'; callUI('live'); startTimer(); }
    if (pc.connectionState === 'failed') { send('call:end'); endCall('Connection lost'); }
  };
  return pc;
}
let callStart, callTick;
function startTimer() {
  callStart = Date.now(); clearInterval(callTick);
  callTick = setInterval(() => { const s = Math.floor((Date.now() - callStart) / 1000); callState(`${Math.floor(s / 60)}:${pad(s % 60)}`); }, 1000);
}
function endCall(reason) {
  ring(false); clearTimeout(call.timer); clearInterval(callTick);
  demoStopVideo();
  call.pc?.close(); call.pc = null; call.ice = [];
  call.local?.getTracks().forEach((t) => t.stop()); call.local = null;
  $('#remoteVideo').srcObject = null;
  if (call.state !== 'idle' && reason) { callState(reason); setTimeout(() => $('#callUI').classList.add('hidden'), 1200); }
  else $('#callUI').classList.add('hidden');
  call.state = 'idle';
  $('#muteBtn').classList.remove('off'); $('#camBtn').classList.remove('off');
}
$('#audioCallBtn').onclick = () => startCall(false);
$('#videoCallBtn').onclick = () => startCall(true);
$('#hangupBtn').onclick = () => { send('call:end'); endCall('Call ended'); };
$('#declineBtn').onclick = () => { send('call:reject'); endCall(); };
$('#acceptBtn').onclick = async () => {
  ring(false);
  if (S.me.demo) return demoGoLive();
  try { call.local = await getMedia(call.video); } catch { send('call:reject'); endCall(); return toast('Microphone/camera access is needed'); }
  call.state = 'connecting';
  callUI('outgoing'); callState('Connecting…');
  send('call:accept');
};
$('#muteBtn').onclick = (e) => { const t = call.local?.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; e.currentTarget.classList.toggle('off', !t.enabled); };
$('#camBtn').onclick = (e) => { const t = call.local?.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; e.currentTarget.classList.toggle('off', !t.enabled); };
$('#flipBtn').onclick = async () => {
  if (!call.local || !call.pc) return;
  call.facing = call.facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: call.facing } });
    const nt = s.getVideoTracks()[0];
    const sender = call.pc.getSenders().find((x) => x.track?.kind === 'video');
    await sender?.replaceTrack(nt);
    const old = call.local.getVideoTracks()[0]; call.local.removeTrack(old); old.stop(); call.local.addTrack(nt);
    $('#localVideo').style.transform = call.facing === 'user' ? 'scaleX(-1)' : 'none';
  } catch { toast('Could not switch camera'); }
};

// ---------------- walkie-talkie ----------------
// While both phones have it switched on, they keep a live audio-only WebRTC link open with the mic muted.
// Pressing the button un-mutes your mic, so your voice plays instantly from your partner's speaker.
// If your partner's walkie is off or they're offline, your clip is saved as a voice message in chat instead.
const walkie = { on: false, partnerOn: false, pc: null, mic: null, track: null, ice: [], talking: false, hearing: false, rec: null, chunks: [], pressAt: 0 };
async function walkieEnable() {
  try {
    walkie.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    if (!S.me?.demo) { toast('Please allow microphone access for the walkie-talkie'); store.set('lb_walkie', null); renderWalkie(); return false; }
    walkie.mic = audioCtx().createMediaStreamDestination().stream; // demo without a mic: silent stand-in
  }
  walkie.track = walkie.mic.getAudioTracks()[0];
  walkie.track.enabled = false;
  walkie.on = true; store.set('lb_walkie', '1');
  audioCtx(); $('#walkieAudio').play().catch(() => {});
  send('walkie:ready');
  renderWalkie();
  return true;
}
function walkieDisable() {
  walkie.on = false; store.set('lb_walkie', null);
  send('walkie:off');
  walkieClosePC();
  walkie.mic?.getTracks().forEach((t) => t.stop()); walkie.mic = walkie.track = null;
  renderWalkie();
}
function walkieClosePC() { walkie.pc?.close(); walkie.pc = null; walkie.ice = []; setHearing(false); }
function makeWalkiePC() {
  walkieClosePC();
  const pc = new RTCPeerConnection(ICE);
  walkie.pc = pc;
  pc.addTrack(walkie.track, walkie.mic);
  pc.onicecandidate = (e) => e.candidate && send('rtc', { ch: 'walkie', ice: e.candidate });
  pc.ontrack = (e) => { const a = $('#walkieAudio'); a.srcObject = e.streams[0] || new MediaStream([e.track]); a.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { renderWalkie(); if (pc.connectionState === 'failed') walkieClosePC(); };
  return pc;
}
async function walkieConnect() {
  const pc = makeWalkiePC();
  await pc.setLocalDescription(await pc.createOffer());
  send('rtc', { ch: 'walkie', sdp: pc.localDescription });
}
const walkieLive = () => (S.me?.demo ? walkie.on : walkie.pc?.connectionState === 'connected');
function setHearing(on) {
  walkie.hearing = on;
  $('#talkingBar').classList.toggle('hidden', !on);
  $('#talkingText').textContent = `${partner().name} is talking…`;
  renderWalkie();
}
function renderWalkie() {
  $('#walkieToggle').checked = walkie.on;
  const st = $('#walkieStatus'), btn = $('#pttBtn');
  st.textContent = !walkie.on ? 'Off — turn on to talk and hear instantly'
    : walkieLive() ? `Live with ${partner().name} 🟢`
    : walkie.partnerOn ? 'Connecting…'
    : `On · ${partner().name}'s walkie is off — clips go to chat as voice notes`;
  btn.classList.toggle('off', !walkie.on);
  btn.classList.toggle('talking', walkie.talking);
  btn.classList.toggle('hearing', walkie.hearing);
  $('#pttLabel').textContent = !walkie.on ? 'Tap to turn on' : walkie.talking ? (walkieLive() ? 'Talking…' : 'Recording…') : walkie.hearing ? 'Listening…' : 'Hold to talk';
}
$('#walkieToggle').onchange = (e) => (e.target.checked ? walkieEnable() : walkieDisable());
function pttDown(e) {
  e.preventDefault();
  if (!walkie.on) { walkieEnable(); return; }
  if (walkie.talking) return;
  walkie.talking = true; walkie.pressAt = Date.now();
  $('#pttBtn').setPointerCapture?.(e.pointerId);
  navigator.vibrate?.(30);
  walkie.track.enabled = true;
  if (walkieLive()) { send('ptt', { on: true }); }
  else {
    walkie.chunks = [];
    try {
      walkie.rec = new MediaRecorder(walkie.mic);
      walkie.rec.ondataavailable = (ev) => ev.data.size && walkie.chunks.push(ev.data);
      walkie.rec.start();
    } catch { walkie.rec = null; }
  }
  chirpOn();
  renderWalkie();
}
function pttUp() {
  if (!walkie.talking) return;
  walkie.talking = false;
  walkie.track.enabled = false;
  chirpOff();
  if (walkie.rec) {
    const rec = walkie.rec; walkie.rec = null;
    const short = Date.now() - walkie.pressAt < 500;
    rec.onstop = () => {
      if (short) return toast('Hold the button while you talk');
      const type = rec.mimeType || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      sendMedia(new Blob(walkie.chunks, { type }), `voice.${ext}`);
    };
    rec.stop();
  } else send('ptt', { on: false });
  renderWalkie();
  if (S.me.demo) setTimeout(() => demoJamieTalks(), 1200);
}
const ptt = $('#pttBtn');
ptt.addEventListener('pointerdown', pttDown);
ptt.addEventListener('pointerup', pttUp);
ptt.addEventListener('pointercancel', pttUp);
ptt.addEventListener('contextmenu', (e) => e.preventDefault());
// Spacebar works as push-to-talk on a computer when the walkie tab is open
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && S.tab === 'walkie' && !e.repeat && e.target === document.body) pttDown(e); });
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && S.tab === 'walkie') pttUp(); });
// Browsers need a tap before they allow sound/mic again after a reload: re-enable the walkie on the first touch.
document.addEventListener('pointerdown', () => {
  audioCtx();
  if (store.get('lb_walkie') && !walkie.on && S.me?.coupleId) walkieEnable();
}, { once: true, capture: true });

// ---------------- relay (signalling from partner) ----------------
async function onRelay(d) {
  try {
    switch (d.t) {
      case 'call:invite':
        if (call.state !== 'idle') return send('call:busy');
        call.state = 'ringing'; call.video = !!d.video;
        callUI('incoming'); callState(d.video ? 'Incoming video call' : 'Incoming call');
        ring(true, true);
        notify(partner().name, d.video ? '📹 Incoming video call' : '📞 Incoming call');
        break;
      case 'call:accept':
        if (call.state !== 'calling') return;
        ring(false); clearTimeout(call.timer);
        call.state = 'connecting'; callState('Connecting…');
        { const pc = makeCallPC(); await pc.setLocalDescription(await pc.createOffer()); send('rtc', { ch: 'call', sdp: pc.localDescription }); }
        break;
      case 'call:reject': endCall('Declined'); break;
      case 'call:busy': endCall(`${partner().name} is on another call`); break;
      case 'call:end': endCall(call.state === 'ringing' ? 'Missed call' : 'Call ended'); break;
      case 'rtc':
        if (d.ch === 'call') { if (call.local) await handleRtc(call, d, makeCallPC); }
        else if (d.ch === 'walkie' && walkie.on) await handleRtc(walkie, d, makeWalkiePC);
        break;
      case 'walkie:ready':
        walkie.partnerOn = true;
        if (walkie.on) {
          if (!d.reply) send('walkie:ready', { reply: true });
          // Exactly one side makes the offer. A reply never restarts a connection that's already under way
          // (both phones switching on at once would otherwise dial twice and the two attempts collide).
          const busy = walkie.pc && !['failed', 'closed', 'disconnected'].includes(walkie.pc.connectionState);
          if (S.me.id < d.from && !(d.reply && busy)) walkieConnect();
        }
        renderWalkie();
        break;
      case 'walkie:off': walkie.partnerOn = false; walkieClosePC(); renderWalkie(); break;
      case 'ptt':
        setHearing(!!d.on);
        if (d.on) { chirpOn(); navigator.vibrate?.(40); $('#walkieAudio').play().catch(() => {}); } else chirpOff();
        break;
      case 'nudge': toast(`${partner().name} ${d.text}`); notify(partner().name, d.text); break;
      case 'typing': {
        const st = $('#partnerStatus'); st.textContent = 'typing…';
        clearTimeout(onRelay.typingT); onRelay.typingT = setTimeout(renderHeader, 1600);
        break;
      }
    }
  } catch (err) { console.error(err); }
}

// ---------------- demo: a simulated partner ----------------
let demoAnim = null;
function demoVideoStream() {
  const cv = document.createElement('canvas'); cv.width = 480; cv.height = 720;
  const x = cv.getContext('2d'); let t = 0;
  const draw = () => {
    t += 0.03;
    const g = x.createLinearGradient(0, 0, 480, 720);
    g.addColorStop(0, `hsl(${330 + Math.sin(t) * 20},70%,62%)`); g.addColorStop(1, `hsl(${270 + Math.cos(t) * 20},55%,45%)`);
    x.fillStyle = g; x.fillRect(0, 0, 480, 720);
    const r = 92 + Math.sin(t * 3) * 4;
    x.fillStyle = 'rgba(255,255,255,.95)'; x.beginPath(); x.arc(240, 330, r, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#9a5bd6'; x.font = 'bold 96px sans-serif'; x.textAlign = 'center'; x.fillText('J', 240, 364);
    x.fillStyle = '#fff'; x.font = '600 26px sans-serif'; x.fillText('Jamie’s camera (demo)', 240, 500);
    x.font = '40px sans-serif'; x.fillText(['👋', '😘', '💕', '😄'][Math.floor(t / 2) % 4], 240, 570);
  };
  draw(); demoAnim = setInterval(draw, 50);
  return cv.captureStream(20);
}
function demoStopVideo() { clearInterval(demoAnim); demoAnim = null; }
function demoCall(video, incoming) {
  call.video = video; call.state = incoming ? 'ringing' : 'calling';
  callUI(incoming ? 'incoming' : 'outgoing');
  callState(incoming ? (video ? 'Incoming video call' : 'Incoming call') : video ? 'Video calling…' : 'Calling…');
  ring(true, incoming);
  if (!incoming) call.timer = setTimeout(demoGoLive, 2500);
}
async function demoGoLive() {
  ring(false);
  try { call.local = await getMedia(call.video); } catch { call.local = null; } // works without a camera too
  call.state = 'live';
  const rv = $('#remoteVideo'); rv.srcObject = demoVideoStream(); rv.play().catch(() => {});
  callUI('live'); startTimer();
}
const DEMO_WALKIE = ['Hey babe, I’m leaving work now.', 'Copy that! See you at seven.', 'Can you grab some milk on the way home?', 'I love you! Over and out.', 'Dinner is almost ready.'];
let demoWalkieIdx = 0;
function demoJamieTalks() {
  if (walkie.hearing) return;
  const text = DEMO_WALKIE[demoWalkieIdx++ % DEMO_WALKIE.length];
  setHearing(true); chirpOn(); navigator.vibrate?.(40);
  let done = false;
  const finish = () => { if (done) return; done = true; setHearing(false); chirpOff(); };
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.onend = finish; u.onerror = finish;
    setTimeout(() => speechSynthesis.speak(u), 250);
    setTimeout(finish, 9000);
  } else setTimeout(finish, 2500);
  toast(`📻 Jamie: “${text}”`, 4000);
}
$('#demoBar').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-demo]')?.dataset.demo; if (!a) return;
  audioCtx();
  if (a === 'call' || a === 'video') { if (call.state === 'idle') demoCall(a === 'video', true); }
  else if (a === 'walkie') { setTab('walkie'); if (!walkie.on) await walkieEnable(); demoJamieTalks(); }
  else if (a === 'message') { setTab('calendar'); toast('Jamie will message you in a moment… (watch the Chat badge)'); setTimeout(() => api('/api/demo/partner-message', { method: 'POST' }).catch((err) => toast(err.message)), 1500); }
  else if (a === 'pair') { showPair(); $('#pairBack').classList.remove('hidden'); }
});
$('#demoExit').onclick = logout;
$('#pairBack').onclick = () => { show('main'); $('#pairBack').classList.add('hidden'); };

boot();
