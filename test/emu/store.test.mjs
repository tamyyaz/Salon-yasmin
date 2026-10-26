import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/store.js';
import { addDays, ymd } from '../../src/logic.js';

const emulator = { host: '127.0.0.1', authPort: 9099, firestorePort: 8080 };
const firebase = { apiKey: 'demo-key', authDomain: 'demo-salon.firebaseapp.com', projectId: 'demo-salon' };
const PASSWORD = 'salon-test-pass';
let n = 0;

async function open(opts = {}) {
  const store = createStore({ firebase, salonEmail: 'salon@yasmin.app', emulator, persistent: false, appName: `t${++n}`, ...opts });
  await store.signIn(PASSWORD);
  await store.start();
  return store;
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const today = ymd(new Date());
const open_ = [];
test.after(async () => { for (const s of open_) await s.dispose(); });
const track = async (opts) => { const s = await open(opts); open_.push(s); return s; };

test('wrong password is refused with a friendly message', async () => {
  await track();                                           // first sign-in creates the emulator account
  const other = createStore({ firebase, salonEmail: 'salon@yasmin.app', emulator, persistent: false, appName: 'wrong' });
  open_.push(other);
  await assert.rejects(other.signIn('not-the-password'), /كلمة السر غير صحيحة/);
});

test('appointment lifecycle with payments, balances, clients and stats', async () => {
  const s = await track();
  const created = await s.api('/appointments', { method: 'POST', body: {
    client_name: 'ليلى', phone: '0791 234 567', date: today, time: '14:30', service: 'صبغة', price: 100, deposit: 30 } });
  assert.equal(created.phone, '0791234567');
  assert.equal(created.paid, 30);
  assert.equal(created.remaining, 70);

  const afterPay = await s.api(`/appointments/${created.id}/payments`, { method: 'POST', body: { amount: 20 } });
  assert.equal(afterPay.remaining, 50);
  await s.api(`/appointments/${created.id}`, { method: 'PATCH', body: { status: 'came' } });

  // a second device (fresh memory) receives the final state through Firestore, rules included
  const other = await track();
  const seen = await until(async () => {
    const l = await other.api(`/appointments?date=${today}`);
    return l.length === 1 && l[0].status === 'came' && l[0].paid === 50 && l[0];
  });
  assert.equal(seen.remaining, 50);

  const clients = await s.api('/clients');
  assert.equal(clients.find((c) => c.phone === '0791234567').remaining, 50);
  const stats = await s.api(`/stats?date=${today}`);
  assert.equal(stats.came, 1);
  assert.equal(stats.collected, 50);
  assert.equal(stats.outstanding, 50);

  const payments = await s.api(`/appointments/${created.id}/payments`);
  assert.equal(payments.length, 2);
  const del = await s.api(`/payments/${payments[0].id}`, { method: 'DELETE' });
  assert.equal(del.paid, 20);                                                           // the 30 deposit is gone
  assert.equal(del.remaining, 80);

  assert.equal((await s.api(`/appointments/${created.id}`, { method: 'PATCH', body: { status: 'no_show' } })).remaining, 0);
  await s.api(`/appointments/${created.id}`, { method: 'DELETE' });
  await assert.rejects(s.api(`/appointments/${created.id}`), /غير موجود/);
});

test('walk-in without a phone is grouped by name and validation errors surface', async () => {
  const s = await track();
  const w = await s.api('/appointments', { method: 'POST', body: { client_name: 'زبون مفاجئ', date: today, time: '11:05', price: 40, status: 'came', walk_in: true, deposit: 40 } });
  assert.equal(w.walk_in, true);
  assert.equal(w.remaining, 0);
  const hist = await s.api(`/clients/history?name=${encodeURIComponent('زبون مفاجئ')}`);
  assert.ok(hist.length >= 1);
  const base = { client_name: 'x', date: today, time: '10:00', price: 0 };
  await assert.rejects(s.api('/appointments', { method: 'POST', body: { ...base, client_name: ' ' } }), /اسم الزبون/);
  await assert.rejects(s.api('/appointments', { method: 'POST', body: { ...base, time: '25:00' } }), /وقت/);
  await assert.rejects(s.api('/appointments', { method: 'POST', body: { ...base, price: -5 } }), /السعر/);
  await assert.rejects(s.api('/appointments/nope/payments', { method: 'POST', body: { amount: 5 } }), /غير موجود/);
});

test('old debts stay visible and old days load on demand (outside the live window)', async () => {
  const writer = await track({ recentDays: 30 });
  const longAgo = addDays(today, -300);
  const debt = await writer.api('/appointments', { method: 'POST', body: { client_name: 'دين قديم', phone: '0780000001', date: longAgo, time: '10:00', price: 90, status: 'came' } });
  await writer.api('/appointments', { method: 'POST', body: { client_name: 'مدفوع قديم', phone: '0780000002', date: addDays(today, -200), time: '10:00', price: 50, status: 'came', deposit: 50 } });
  await new Promise((r) => setTimeout(r, 1500));                                       // let writes reach the server

  const reader = await track({ recentDays: 30 });                                       // fresh device: nothing in memory yet
  assert.equal((await reader.api(`/stats?date=${today}`)).outstanding >= 90, true);    // unpaid listener brought the old debt
  assert.ok((await reader.api('/clients')).some((c) => c.phone === '0780000001' && c.remaining === 90));
  assert.equal((await reader.api(`/stats?date=${addDays(today, -200)}`)).total, 1);     // old day fetched on demand
  assert.equal((await reader.api(`/appointments?date=${addDays(today, -200)}`)).length, 1);
  assert.equal((await reader.api('/clients/history?phone=0780000002')).length, 1);

  // paying the old debt in full must not make the appointment vanish from under the UI
  const paid = await reader.api(`/appointments/${debt.id}/payments`, { method: 'POST', body: { amount: 90 } });
  assert.equal(paid.remaining, 0);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await reader.api(`/appointments/${debt.id}`)).remaining, 0);
});

test('two devices adding payments at the same moment lose nothing', async () => {
  const a = await track();
  const b = await track();
  const appt = await a.api('/appointments', { method: 'POST', body: { client_name: 'تزامن', phone: '0770000009', date: today, time: '16:00', price: 100 } });
  await until(async () => (await b.api(`/appointments/${appt.id}`)).id === appt.id);
  await Promise.all([
    a.api(`/appointments/${appt.id}/payments`, { method: 'POST', body: { amount: 10 } }),
    b.api(`/appointments/${appt.id}/payments`, { method: 'POST', body: { amount: 25 } }),
  ]);
  for (const side of [a, b]) {
    await until(async () => (await side.api(`/appointments/${appt.id}`)).paid === 35);
    assert.equal((await side.api(`/appointments/${appt.id}`)).remaining, 65);
  }
});

test('notes: create, pin, complete, delete; export contains everything', async () => {
  const s = await track();
  const { id } = await s.api('/notes', { method: 'POST', body: { text: 'اطلب مواد صبغة' } });
  await s.api(`/notes/${id}`, { method: 'PATCH', body: { pinned: true, done: true } });
  const list = await s.api('/notes');
  const mine = list.find((x) => x.id === id);
  assert.equal(mine.pinned, true);
  assert.equal(mine.done, true);
  await assert.rejects(s.api('/notes', { method: 'POST', body: { text: '  ' } }), /اكتب نص/);
  await until(async () => (await s.exportAll()).notes.some((x) => x.id === id));
  const dump = await s.exportAll();
  assert.ok(dump.appointments.length > 0);
  await s.api(`/notes/${id}`, { method: 'DELETE' });
  assert.equal((await s.api('/notes')).some((x) => x.id === id), false);
});

test('services and salon info round-trip through Firestore to another device', async () => {
  const a = await track();
  const b = await track();
  const { id } = await a.api('/services', { method: 'POST', body: { name: 'صبغة', price: '60', note: 'حسب الطول' } });
  await a.api('/services', { method: 'POST', body: { name: 'سيشوار', price: '' } });
  await a.api(`/services/${id}`, { method: 'PATCH', body: { price: 70 } });
  await assert.rejects(a.api('/services', { method: 'POST', body: { name: ' ' } }), /اسم الخدمة/);
  const seen = await until(async () => { const l = await b.api('/services'); return l.length === 2 && l.find((x) => x.id === id)?.price === 70 && l; });
  assert.deepEqual(seen.map((x) => x.name), ['سيشوار', 'صبغة']);
  assert.equal(seen[0].price, null);
  await a.api('/settings', { method: 'PUT', body: { address: 'المزة', faq: [{ q: 'بتقبلوا كارت؟', a: 'لا، كاش فقط' }] } });
  const info = await until(async () => { const s = await b.api('/settings'); return s.address === 'المزة' && s; });
  assert.equal(info.faq[0].a, 'لا، كاش فقط');
  await a.api(`/services/${id}`, { method: 'DELETE' });
  await until(async () => (await b.api('/services')).length === 1);
  assert.ok((await a.exportAll()).services.length >= 1);
});

test('WhatsApp conversations: threads and messages arrive live, a reply is queued for the bot, read marks clear the badge', async () => {
  const s = await track();
  assert.equal(s.unreadThreads, 0);
  // the bot (Admin SDK) is simulated with the REST emulator endpoint that bypasses rules
  const admin = async (path, fields) => fetch(`http://127.0.0.1:8080/v1/projects/demo-salon/databases/(default)/documents/${path}`, {
    method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ fields }),
  });
  const str = (v) => ({ stringValue: v });
  await admin('wa_threads/962791234567', { phone: str('+962791234567'), name: str('ليلى'), lastText: str('بدي موعد'), lastAt: str('2026-10-22T10:00:00.000Z'), unread: { integerValue: '2' } });
  await admin('wa_threads/962791234567/messages/m1', { dir: str('in'), by: str('customer'), text: str('بدي موعد'), at: str('2026-10-22T10:00:00.000Z') });
  await until(() => s.threads.length === 1 && s.unreadThreads === 1);
  assert.equal(s.threads[0].name, 'ليلى');
  s.openThread('962791234567');
  await until(() => s.messages.length === 1);
  assert.equal(s.messages[0].text, 'بدي موعد');
  s.sendReply('962791234567', '  أهلاً فيكي  ');
  assert.throws(() => s.sendReply('962791234567', '   '), /اكتبي/);
  const queued = s.outbox;
  assert.deepEqual(queued.map((o) => [o.phone, o.text, o.status]), [['+962791234567', 'أهلاً فيكي', 'queued']]);
  s.markRead('962791234567');
  await until(() => s.unreadThreads === 0);
  s.closeThread();
  assert.deepEqual(s.messages, []);
});

test('unknown routes fail clearly', async () => {
  const s = await track();
  await assert.rejects(s.api('/nope'), /غير موجود/);
});
