// Firebase data layer (Auth + Firestore) exposing the same `api(path, {method, body})`
// contract the UI was written against, so the screens don't care where data lives.
//
// Design notes
// - Firestore keeps an offline cache; writes are applied locally at once and synced when online.
// - Only a recent window of appointments (+ every unpaid one) is kept live, so Firestore reads
//   stay small even after years of use. Older history is fetched on demand (per day / per client).
// - Money safety: payments are changed with arrayUnion/arrayRemove, never by overwriting the whole
//   array, so two devices adding payments at the same moment can't lose one.

import { initializeApp, deleteApp } from 'firebase/app';
import {
  initializeAuth, inMemoryPersistence, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, connectAuthEmulator,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, connectFirestoreEmulator,
  terminate, clearIndexedDbPersistence, collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, getDocsFromCache,
  onSnapshot, query, where, arrayUnion, arrayRemove,
} from 'firebase/firestore';
import {
  STATUSES, parseAppointment, money, str, normPhone, dueOf, withBalance, filterAppointments, groupClients,
  clientHistory, dayStats, sortNotes, ymd, addDays, isDate, parseService, parseSettings, sortServices,
} from './logic.js';

const nowISO = () => new Date().toISOString();
const randomId = () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const newPayment = (amount) => ({ id: randomId(), amount, paid_at: nowISO() });
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

const AUTH_ERRORS = {
  'auth/invalid-credential': 'كلمة السر غير صحيحة',
  'auth/wrong-password': 'كلمة السر غير صحيحة',
  'auth/user-not-found': 'كلمة السر غير صحيحة',
  'auth/invalid-email': 'كلمة السر غير صحيحة',
  'auth/too-many-requests': 'محاولات كثيرة، حاول بعد قليل',
  'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت',
};

export function createStore({
  firebase, salonEmail, emulator = null, persistent = true, appName = '[DEFAULT]', recentDays = 120, today = () => ymd(new Date()),
}) {
  const app = initializeApp(firebase, appName);
  const auth = initializeAuth(app, {
    persistence: persistent ? [indexedDBLocalPersistence, browserLocalPersistence] : inMemoryPersistence,
  });
  const db = initializeFirestore(app, {
    localCache: persistent ? persistentLocalCache({ tabManager: persistentMultipleTabManager() }) : memoryLocalCache(),
    experimentalAutoDetectLongPolling: true, // survives proxies that break streaming connections
  });
  if (emulator) {
    connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
    connectFirestoreEmulator(db, emulator.host, emulator.firestorePort);
  }
  const apptCol = collection(db, 'appointments');
  const notesCol = collection(db, 'notes');

  // ---------- live state ----------
  const docs = new Map();          // id -> appointment (recent + unpaid + anything fetched on demand)
  const inRecent = new Set();
  const inUnpaid = new Set();
  const notes = new Map();
  const services = new Map();
  let settings = null;
  let botStatus = null;            // heartbeat written by the WhatsApp bot, if one is running
  const listeners = new Set();
  const errorHandlers = new Set();
  let unsubs = [];
  let windowStart = addDays(today(), -recentDays);
  let notifyTimer;

  const notify = () => {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => listeners.forEach((fn) => fn()), 120);
    notifyTimer.unref?.();
  };
  const reportError = (err) => errorHandlers.forEach((fn) => fn(err));

  // a doc that left a query may have been deleted, or may just have stopped matching: ask once
  async function reconcile(id) {
    try {
      const snap = await getDoc(doc(apptCol, id));
      if (snap.exists()) docs.set(id, { id, ...snap.data() }); else docs.delete(id);
    } catch { /* offline: keep what we have */ }
    notify();
  }

  function applyAppointments(snap, set) {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === 'removed') {
        set.delete(id);
        if (!inRecent.has(id) && !inUnpaid.has(id)) reconcile(id);
        continue;
      }
      const data = ch.doc.data();
      set.add(id);
      docs.set(id, { id, ...data });
      // self-heal: `due` powers the "unpaid" query, keep it equal to what the payments say
      if (!ch.doc.metadata.hasPendingWrites && data.due !== dueOf(data)) {
        updateDoc(ch.doc.ref, { due: dueOf(data) }).catch(() => {});
      }
    }
  }

  const applyNotes = (snap) => {
    notes.clear();
    snap.docs.forEach((d) => notes.set(d.id, { id: d.id, ...d.data() }));
  };

  async function start() {
    stop();
    windowStart = addDays(today(), -recentDays);
    // A listener that is refused (e.g. security rules still rolling out after a deploy, or a token refresh
    // in flight) is retried with growing delays before it is reported as a real failure.
    const listen = (label, q, onChange) => new Promise((resolve) => {
      let first = true;
      let stopped = false;
      let off = () => {};
      let tries = 0;
      const settle = () => { if (first) { first = false; resolve(); } };
      const attach = () => {
        off = onSnapshot(q, (snap) => { tries = 0; onChange(snap); notify(); settle(); }, (err) => {
          console.warn(`[firestore listener failed: ${label}]`, err.code, err.message);
          settle();
          if (!stopped && tries < 5) { tries += 1; setTimeout(() => { if (!stopped) attach(); }, Math.min(30000, 3000 * 2 ** (tries - 1))); } else reportError(err);
        });
      };
      unsubs.push(() => { stopped = true; off(); });
      attach();
    });
    // resolve once the first data (cache or server) has arrived; never block the UI for long
    await withTimeout(Promise.all([
      listen('recent appointments', query(apptCol, where('date', '>=', windowStart)), (s) => applyAppointments(s, inRecent)),
      listen('unpaid appointments', query(apptCol, where('due', '>', 0)), (s) => applyAppointments(s, inUnpaid)),
      listen('notes', notesCol, applyNotes),
      listen('services', collection(db, 'services'), (s) => { services.clear(); s.docs.forEach((d) => services.set(d.id, { id: d.id, ...d.data() })); }),
      listen('salon settings', doc(db, 'settings', 'salon'), (s) => { settings = s.exists() ? s.data() : null; }),
      listen('bot status', doc(db, 'bot_status', 'main'), (snap) => { botStatus = snap.exists() ? snap.data() : null; }),
    ]), 8000).catch(() => {});
  }

  function stop() {
    unsubs.forEach((fn) => fn());
    unsubs = [];
    docs.clear(); inRecent.clear(); inUnpaid.clear(); notes.clear(); services.clear(); settings = null;
  }

  // ---------- on-demand fetches ----------
  async function fetchInto(q) {
    let snap;
    try { snap = await withTimeout(getDocs(q), 6000); } catch { snap = await getDocsFromCache(q); }
    snap.docs.forEach((d) => docs.set(d.id, { id: d.id, ...d.data() }));
  }
  const ensureDay = (date) => fetchInto(query(apptCol, where('date', '==', date)));
  const all = () => [...docs.values()];

  async function loadAppt(id) {
    if (!docs.has(id)) await reconcile(id);
    const a = docs.get(id);
    if (!a) throw new Error('الموعد غير موجود');
    return a;
  }

  // ---------- appointment operations ----------
  async function listAppointments(q) {
    if (q.date && isDate(q.date) && q.date < windowStart) await ensureDay(q.date);
    return filterAppointments(all(), q).map(withBalance);
  }

  function createAppointment(body) {
    const fields = parseAppointment(body);
    const status = STATUSES.includes(body.status) ? body.status : 'booked';
    const deposit = money(body.deposit, 'العربون');
    const ref = doc(apptCol);
    const data = { ...fields, status, walk_in: !!body.walk_in, created_at: nowISO(), payments: deposit > 0 ? [newPayment(deposit)] : [] };
    data.due = dueOf(data);
    docs.set(ref.id, { id: ref.id, ...data });
    notify();
    setDoc(ref, data).catch(reportError);
    return withBalance(docs.get(ref.id));
  }

  async function patchAppointment(id, body) {
    const cur = await loadAppt(id);
    const fields = parseAppointment(body, { partial: true });
    const next = { ...cur, ...fields };
    const due = dueOf(next);
    docs.set(id, { ...next, due });
    notify();
    updateDoc(doc(apptCol, id), { ...fields, due }).catch(reportError);
    return withBalance(docs.get(id));
  }

  async function removeAppointment(id) {
    await loadAppt(id);
    docs.delete(id); inRecent.delete(id); inUnpaid.delete(id);
    notify();
    deleteDoc(doc(apptCol, id)).catch(reportError);
    return { ok: true };
  }

  async function addPayment(id, body) {
    const cur = await loadAppt(id);
    const amount = money(body.amount, 'المبلغ');
    if (amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
    const payment = newPayment(amount);
    const next = { ...cur, payments: [...(cur.payments || []), payment] };
    const due = dueOf(next);
    docs.set(id, { ...next, due });
    notify();
    updateDoc(doc(apptCol, id), { payments: arrayUnion(payment), due }).catch(reportError);
    return withBalance(docs.get(id));
  }

  function removePayment(paymentId) {
    const cur = all().find((a) => (a.payments || []).some((p) => p.id === paymentId));
    if (!cur) throw new Error('الدفعة غير موجودة');
    const payment = cur.payments.find((p) => p.id === paymentId);
    const next = { ...cur, payments: cur.payments.filter((p) => p.id !== paymentId) };
    const due = dueOf(next);
    docs.set(cur.id, { ...next, due });
    notify();
    updateDoc(doc(apptCol, cur.id), { payments: arrayRemove(payment), due }).catch(reportError);
    return withBalance(docs.get(cur.id));
  }

  async function history(q) {
    const phone = normPhone(q.phone);
    const name = str(q.name, 80);
    if (!phone && !name) throw new Error('مطلوب رقم أو اسم');
    await fetchInto(query(apptCol, where('phone', '==', phone)));
    return clientHistory(all(), { phone, name }).map(withBalance);
  }

  async function stats(q) {
    if (!isDate(q.date)) throw new Error('تاريخ غير صالح');
    if (q.date < windowStart) await ensureDay(q.date);
    return dayStats(all(), q.date);
  }

  // ---------- notes ----------
  function createNote(body) {
    const text = str(body.text, 2000);
    if (!text) throw new Error('اكتب نص الملاحظة');
    const ref = doc(notesCol);
    const data = { text, pinned: false, done: false, created_at: nowISO() };
    notes.set(ref.id, { id: ref.id, ...data });
    notify();
    setDoc(ref, data).catch(reportError);
    return { id: ref.id };
  }

  function patchNote(id, body) {
    const cur = notes.get(id);
    if (!cur) throw new Error('الملاحظة غير موجودة');
    const changes = {};
    if (body.text !== undefined) {
      changes.text = str(body.text, 2000);
      if (!changes.text) throw new Error('اكتب نص الملاحظة');
    }
    if (body.pinned !== undefined) changes.pinned = !!body.pinned;
    if (body.done !== undefined) changes.done = !!body.done;
    notes.set(id, { ...cur, ...changes });
    notify();
    updateDoc(doc(notesCol, id), changes).catch(reportError);
    return { ok: true };
  }

  function removeNote(id) {
    notes.delete(id);
    notify();
    deleteDoc(doc(notesCol, id)).catch(reportError);
    return { ok: true };
  }

  // ---------- services & salon info ----------
  function createService(body) {
    const data = parseService(body);
    const ref = doc(collection(db, 'services'));
    services.set(ref.id, { id: ref.id, ...data });
    notify();
    setDoc(ref, data).catch(reportError);
    return { id: ref.id, ...data };
  }

  function patchService(id, body) {
    const cur = services.get(id);
    if (!cur) throw new Error('الخدمة غير موجودة');
    const changes = parseService(body, { partial: true });
    services.set(id, { ...cur, ...changes });
    notify();
    updateDoc(doc(db, 'services', id), changes).catch(reportError);
    return { ok: true };
  }

  function removeService(id) {
    services.delete(id);
    notify();
    deleteDoc(doc(db, 'services', id)).catch(reportError);
    return { ok: true };
  }

  function saveSettings(body) {
    settings = parseSettings(body);
    notify();
    setDoc(doc(db, 'settings', 'salon'), settings).catch(reportError);
    return settings;
  }

  // ---------- REST-shaped router ----------
  async function api(path, { method = 'GET', body = {} } = {}) {
    const [p, qs = ''] = path.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs));
    let m;
    if (p === '/appointments') {
      if (method === 'GET') return listAppointments(q);
      if (method === 'POST') return createAppointment(body);
    } else if ((m = p.match(/^\/appointments\/([^/]+)$/))) {
      if (method === 'GET') return withBalance(await loadAppt(m[1]));
      if (method === 'PATCH') return patchAppointment(m[1], body);
      if (method === 'DELETE') return removeAppointment(m[1]);
    } else if ((m = p.match(/^\/appointments\/([^/]+)\/payments$/))) {
      if (method === 'GET') return [...((await loadAppt(m[1])).payments || [])].sort((a, b) => a.paid_at.localeCompare(b.paid_at));
      if (method === 'POST') return addPayment(m[1], body);
    } else if ((m = p.match(/^\/payments\/([^/]+)$/)) && method === 'DELETE') {
      return removePayment(m[1]);
    } else if (p === '/clients' && method === 'GET') {
      return groupClients(all(), q.q);
    } else if (p === '/clients/history' && method === 'GET') {
      return history(q);
    } else if (p === '/stats' && method === 'GET') {
      return stats(q);
    } else if (p === '/services') {
      if (method === 'GET') return sortServices([...services.values()]);
      if (method === 'POST') return createService(body);
    } else if ((m = p.match(/^\/services\/([^/]+)$/))) {
      if (method === 'PATCH') return patchService(m[1], body);
      if (method === 'DELETE') return removeService(m[1]);
    } else if (p === '/settings') {
      if (method === 'GET') return settings || parseSettings({});
      if (method === 'PUT') return saveSettings(body);
    } else if (p === '/notes') {
      if (method === 'GET') return sortNotes([...notes.values()]);
      if (method === 'POST') return createNote(body);
    } else if ((m = p.match(/^\/notes\/([^/]+)$/))) {
      if (method === 'PATCH') return patchNote(m[1], body);
      if (method === 'DELETE') return removeNote(m[1]);
    }
    throw new Error('غير موجود');
  }

  // ---------- auth ----------
  async function signIn(password) {
    try {
      await signInWithEmailAndPassword(auth, salonEmail, password);
    } catch (err) {
      // emulator convenience only: the first sign-in creates the account
      if (emulator && ['auth/user-not-found', 'auth/invalid-credential'].includes(err.code)) {
        try { await createUserWithEmailAndPassword(auth, salonEmail, password); return; } catch { /* exists: wrong password */ }
      }
      throw new Error(AUTH_ERRORS[err.code] || 'تعذّر تسجيل الدخول');
    }
  }

  async function signOutAndWipe() {
    stop();
    await signOut(auth);
    if (persistent) {
      try { await terminate(db); await clearIndexedDbPersistence(db); } catch { /* best effort */ }
    }
  }

  async function exportAll() {
    const [a, n, sv, st] = await Promise.all([getDocs(apptCol), getDocs(notesCol), getDocs(collection(db, 'services')), getDoc(doc(db, 'settings', 'salon'))]);
    return {
      exported_at: nowISO(),
      appointments: a.docs.map((d) => ({ id: d.id, ...d.data() })),
      notes: n.docs.map((d) => ({ id: d.id, ...d.data() })),
      services: sv.docs.map((d) => ({ id: d.id, ...d.data() })),
      settings: st.exists() ? st.data() : null,
    };
  }

  async function dispose() {
    stop();
    await terminate(db).catch(() => {});
    await deleteApp(app).catch(() => {});
  }

  return {
    api, start, stop, signIn, signOutAndWipe, exportAll, dispose,
    onAuth: (cb) => onAuthStateChanged(auth, (user) => cb(!!user)),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    onError: (fn) => { errorHandlers.add(fn); return () => errorHandlers.delete(fn); },
    get windowStart() { return windowStart; },
    get botStatus() { return botStatus; },
  };
}
