/* Google Calendar sync — runs entirely on this phone.
 * The phone gets a short-lived Google token (Google Identity Services) and talks to the Calendar API directly,
 * so event details never pass through Lovebird's server, and the server keeps no Google tokens.
 * Each person syncs their own Google account from their own phone: items for "Me" or "Both of us" go to it,
 * and their next 60 days of Google events come into the shared (encrypted) calendar.
 * Uses globals from app.js: S, store, toast, saveItem, whoName, todayStr.
 */
const GCal = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
  let token = null, exp = 0, running = null, timer = null;
  const K = () => 'lb_gcal_' + S.me.id;
  const DEL = () => 'lb_gdel_' + S.me.id;
  const state = () => { try { return JSON.parse(store.get(K()) || 'null'); } catch { return null; } };
  const queuedDeletes = () => { try { return JSON.parse(store.get(DEL()) || '[]'); } catch { return []; } };
  const queueDelete = (id) => store.set(DEL(), JSON.stringify([...new Set([...queuedDeletes(), id])]));
  const available = () => !!S.cfg.googleClientId && !S.me?.demo;
  const connected = () => available() && !!state();
  const haveToken = () => token && exp > Date.now();

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return (loadGis.p ||= new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = ok; s.onerror = () => { loadGis.p = null; no(new Error('Could not reach Google')); };
      document.head.append(s);
    }));
  }
  // Needs a tap (Google shows a pop-up the first time, later it usually closes by itself).
  async function getToken(prompt = '') {
    if (haveToken()) return token;
    await loadGis();
    return new Promise((ok, no) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: S.cfg.googleClientId, scope: SCOPE, hint: state()?.email || undefined,
        callback: (r) => {
          if (r.error || !r.access_token) return no(new Error('Google did not allow access'));
          token = r.access_token; exp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
          ok(token);
        },
        error_callback: (e) => no(new Error(e?.type === 'popup_closed' ? 'Google sign-in was closed' : 'Google sign-in failed — allow pop-ups and try again')),
      });
      tc.requestAccessToken({ prompt });
    });
  }
  async function gapi(method, p, body) {
    const r = await fetch('https://www.googleapis.com/calendar/v3' + p, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { token = null; throw new Error('Google sign-in expired — tap Sync now'); }
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || 'Google Calendar error ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  const evPath = (id) => `/calendars/primary/events/${encodeURIComponent(id)}`;
  const del = (id) => gapi('DELETE', evPath(id)).catch((e) => { if (e.status !== 404 && e.status !== 410) throw e; });

  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const addHour = (t) => { const [h, m] = t.split(':').map(Number); return `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(h >= 23 ? 59 : m).padStart(2, '0')}`; };
  function toGoogle(it) {
    const who = it.assignee === 'both' ? 'Both of us' : whoName(it.assignee);
    const summary = (it.type === 'task' ? (it.done ? '✅ ' : '☐ ') : '') + it.title;
    const description = [it.notes, `For: ${who}`, '— from Lovebird'].filter(Boolean).join('\n');
    const extendedProperties = { private: { lovebird: '1' } };
    if (it.allDay || !it.startTime) return { summary, description, extendedProperties, start: { date: it.date }, end: { date: addDays(it.date, 1) } };
    const end = it.endTime && it.endTime > it.startTime ? it.endTime : addHour(it.startTime);
    const tz = it.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { summary, description, extendedProperties, start: { dateTime: `${it.date}T${it.startTime}:00`, timeZone: tz }, end: { dateTime: `${it.date}T${end}:00`, timeZone: tz } };
  }
  const hash = (o) => { let h = 2166136261; for (const c of JSON.stringify(o)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
  const relevant = (it, uid) => it.assignee === 'both' || it.assignee === uid;
  function partsInTz(iso) {
    const d = new Date(iso);
    return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
  }

  async function syncNow() {
    const me = S.me.id;
    let pushed = 0, imported = 0;
    for (const id of queuedDeletes()) { await del(id); store.set(DEL(), JSON.stringify(queuedDeletes().filter((x) => x !== id))); }
    const cutoff = addDays(todayStr(), -1);
    // 1) our shared plans -> my Google Calendar
    for (const it of [...S.items]) {
      if (it.legacy) continue;
      const gid = it.gcal?.[me];
      if (!relevant(it, me)) {
        if (gid) { await del(gid); const gcal = { ...it.gcal }, gsync = { ...it.gsync }; delete gcal[me]; delete gsync[me]; await saveItem({ ...it, gcal, gsync }); }
        continue;
      }
      const body = toGoogle(it), h = hash(body);
      if (gid && it.gsync?.[me] === h) continue;
      if (!gid && it.date < cutoff) continue;
      let id = gid;
      if (gid) { try { await gapi('PATCH', evPath(gid), body); } catch (e) { if (e.status === 404 || e.status === 410) id = null; else throw e; } }
      if (!id) id = (await gapi('POST', '/calendars/primary/events', body)).id;
      await saveItem({ ...it, gcal: { ...it.gcal, [me]: id }, gsync: { ...it.gsync, [me]: h } });
      pushed++;
    }
    // 2) my next 60 days of Google events -> our shared calendar
    const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 60 * 864e5).toISOString() });
    const j = await gapi('GET', '/calendars/primary/events?' + q);
    const known = new Set(S.items.map((i) => i.gcal?.[me]).filter(Boolean));
    for (const ev of j.items || []) {
      if (ev.status === 'cancelled' || known.has(ev.id) || ev.extendedProperties?.private?.lovebird) continue;
      const allDay = !!ev.start?.date;
      const s = allDay ? { date: ev.start.date, time: null } : partsInTz(ev.start.dateTime);
      const e = allDay ? { time: null } : partsInTz(ev.end.dateTime);
      const it = { type: 'event', title: ev.summary || 'Busy', notes: ev.description || '', date: s.date, startTime: s.time, endTime: e.time,
        allDay, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, done: false, assignee: me, source: 'google', gcal: { [me]: ev.id } };
      it.gsync = { [me]: hash(toGoogle(it)) };
      await saveItem(it);
      imported++;
    }
    return { pushed, imported };
  }
  function run() {
    if (!running) running = syncNow().finally(() => { running = null; });
    return running;
  }
  // Quietly keep Google up to date while we still have a token (no pop-ups).
  function soon() {
    if (!connected() || !haveToken()) return;
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((e) => console.warn('[gcal]', e.message)), 1500);
  }

  return {
    status: () => ({ available: available(), connected: connected(), email: state()?.email || null }),
    init() { if (connected()) loadGis().catch(() => {}); },
    async connect() {
      await getToken('consent');
      const cal = await gapi('GET', '/calendars/primary');
      store.set(K(), JSON.stringify({ email: cal.id }));
      return run();
    },
    async sync() { await getToken(); return run(); },
    disconnect() {
      if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
      token = null; store.set(K(), null); store.set(DEL(), null);
    },
    afterSave: soon,
    afterDelete(it) {
      const id = it?.gcal?.[S.me.id];
      if (connected() && id) { queueDelete(id); soon(); }
    },
    // Your partner deleted something that is also in your Google Calendar: remove it there too.
    onItems(prev, next) {
      if (!connected()) return;
      const ids = new Set(next.map((i) => i.id));
      for (const it of prev) if (!ids.has(it.id) && it.gcal?.[S.me.id]) queueDelete(it.gcal[S.me.id]);
      soon();
    },
    forget() { token = null; },
  };
})();
