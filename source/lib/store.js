// Persistence: local IndexedDB cache (localStorage fallback) + optional Supabase sync.
// The app only calls get / set / backend plus the cloud helpers below.
const DB = 'meal-planner-fodmap'; const STORE = 'kv'; const LS = 'mpf:';
const SUPABASE_URL = 'https://ujxnamgdmadasrwplkdv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_68hnTj86CdMWfpzdT5w7kA_ZqTIeMOC'; // public key; data protected by row level security
const TABLE = 'app_state';

/* ---------- local ---------- */
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('no idb'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function lget(key) {
  try { const db = await open(); return await new Promise((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  catch { const v = localStorage.getItem(LS + key); return v ? JSON.parse(v) : undefined; }
}
async function lset(key, val) {
  try { const db = await open(); await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  catch { localStorage.setItem(LS + key, JSON.stringify(val)); }
}
const meta = () => JSON.parse(localStorage.getItem(LS + 'meta') || '{"t":{},"dirty":{}}');
const saveMeta = m => localStorage.setItem(LS + 'meta', JSON.stringify(m));

/* ---------- cloud state ---------- */
let status = 'local'; let lastSync = null; let lastError = '';
const statusSubs = new Set(); const changeSubs = new Set();
const emit = () => statusSubs.forEach(f => f({ status, lastSync, lastError, user: user() }));
const setStatus = (s, err) => { status = s; lastError = err || ''; emit(); };
export const onStatus = f => { statusSubs.add(f); f({ status, lastSync, lastError, user: user() }); return () => statusSubs.delete(f); };
export const onRemoteChange = f => { changeSubs.add(f); return () => changeSubs.delete(f); };

const getSession = () => { try { return JSON.parse(localStorage.getItem(LS + 'session')); } catch { return null; } };
const putSession = s => s ? localStorage.setItem(LS + 'session', JSON.stringify(s)) : localStorage.removeItem(LS + 'session');
export const user = () => { const s = getSession(); return s && s.user ? { id: s.user.id, email: s.user.email } : null; };

async function authFetch(path, body) {
  const r = await fetch(SUPABASE_URL + '/auth/v1' + path, { method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const m = j.error_description || j.msg || j.message || j.error || `Sign-in failed (${r.status})`; throw new Error(/not confirmed/i.test(m) ? 'Your email isn\u2019t confirmed yet. See Data review \u2192 sync help, or confirm the user in Supabase.' : /invalid login/i.test(m) ? 'Email or password is wrong.' : m); }
  return j;
}
const withExpiry = j => ({ ...j, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600) });

async function token() {
  let s = getSession(); if (!s) return null;
  if (s.expires_at - 60 < Date.now() / 1000) {
    try { s = withExpiry(await authFetch('/token?grant_type=refresh_token', { refresh_token: s.refresh_token })); putSession(s); }
    catch (e) { if (navigator.onLine) { putSession(null); setStatus('signed-out', 'Your session expired. Sign in again.'); } throw e; }
  }
  return s.access_token;
}
async function rest(path, opts = {}) {
  const t = await token(); if (!t) throw new Error('Not signed in');
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { ...opts, headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `Sync failed (${r.status})`); }
  return r.status === 204 ? null : r.json().catch(() => null);
}

export async function signIn(email, password) {
  const j = withExpiry(await authFetch('/token?grant_type=password', { email, password }));
  putSession(j); await syncNow(true); return user();
}
export async function signUp(email, password) {
  const j = await authFetch('/signup', { email, password });
  if (j.access_token) { putSession(withExpiry(j)); await syncNow(true); return { user: user(), confirm: false }; }
  return { user: null, confirm: true };
}
export function signInWithProvider(provider) {
  const back = location.href.split('#')[0];
  const url = SUPABASE_URL + '/auth/v1/authorize?provider=' + provider + '&redirect_to=' + encodeURIComponent(back);
  try { if (window.top !== window) { window.top.location.href = url; return; } } catch {}
  location.href = url;
}
export async function handleRedirect() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('error_description')) { history.replaceState(null, '', location.pathname + location.search); throw new Error(h.get('error_description').replace(/\+/g, ' ')); }
  const at = h.get('access_token'); if (!at) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + at } });
  if (!r.ok) throw new Error('GitHub sign-in failed (' + r.status + ')');
  const u = await r.json();
  putSession(withExpiry({ access_token: at, refresh_token: h.get('refresh_token'), expires_in: +h.get('expires_in') || 3600, expires_at: +h.get('expires_at') || 0, user: u }));
  await syncNow(true); return true;
}
export function signOut() { putSession(null); localStorage.removeItem(LS + 'syncedUser'); setStatus('signed-out'); }

/* ---------- sync ---------- */
let flushTimer = null; let syncing = null;
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(() => flush().catch(() => {}), 800); }

async function flush() {
  if (!user()) return;
  const m = meta(); const keys = Object.keys(m.dirty); if (!keys.length) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  setStatus('syncing');
  try {
    const uid = user().id; const rows = [];
    for (const k of keys) rows.push({ user_id: uid, key: k, value: (await lget(k)) ?? null, updated_at: new Date(m.t[k] || Date.now()).toISOString() });
    await rest(`${TABLE}?on_conflict=user_id,key`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    const m2 = meta(); for (const k of keys) if (m2.t[k] === m.t[k]) delete m2.dirty[k]; saveMeta(m2);
    lastSync = new Date(); setStatus(Object.keys(m2.dirty).length ? 'syncing' : 'synced');
    if (Object.keys(m2.dirty).length) scheduleFlush();
  } catch (e) { setStatus(navigator.onLine ? 'error' : 'offline', e.message); }
}

// Pull remote rows, apply newer ones locally, then push local changes.
export function syncNow(firstLogin) {
  if (syncing) return syncing;
  syncing = (async () => {
    if (!user()) { setStatus('signed-out'); return []; }
    if (!navigator.onLine) { setStatus('offline'); return []; }
    setStatus('syncing');
    const changed = [];
    try {
      const uid = user().id; const fresh = firstLogin || localStorage.getItem(LS + 'syncedUser') !== uid;
      const rows = await rest(`${TABLE}?select=key,value,updated_at`);
      const m = meta(); const remoteKeys = new Set();
      for (const r of rows || []) {
        remoteKeys.add(r.key); const rt = Date.parse(r.updated_at);
        const localNewer = !fresh && m.dirty[r.key] && (m.t[r.key] || 0) > rt;
        if (!localNewer && (fresh || rt > (m.t[r.key] || 0))) { await lset(r.key, r.value); m.t[r.key] = rt; delete m.dirty[r.key]; changed.push(r.key); }
      }
      // first sign-in on this device: upload local keys the cloud doesn't have yet
      for (const k of KNOWN_KEYS) if (!remoteKeys.has(k) && (await lget(k)) !== undefined) { m.dirty[k] = true; m.t[k] = m.t[k] || Date.now(); }
      saveMeta(m); localStorage.setItem(LS + 'syncedUser', uid);
      lastSync = new Date(); setStatus('synced');
      if (changed.length) changeSubs.forEach(f => f(changed));
      await flush();
    } catch (e) { setStatus(navigator.onLine ? 'error' : 'offline', e.message); }
    return changed;
  })().finally(() => { syncing = null; });
  return syncing;
}

let KNOWN_KEYS = [];
export function init(keys) {
  KNOWN_KEYS = keys;
  if (!user()) { setStatus('signed-out'); return; }
  if (init.done) { syncNow(); return; } init.done = true;
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); else flush().catch(() => {}); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  syncNow();
}

/* ---------- public API ---------- */
export const get = lget;
export async function set(key, val) {
  await lset(key, val);
  const m = meta(); m.t[key] = Date.now(); m.dirty[key] = true; saveMeta(m);
  if (user()) scheduleFlush();
}
export async function backend() { try { await open(); return 'IndexedDB'; } catch { return 'localStorage'; } }
export const cloudConfigured = true;
