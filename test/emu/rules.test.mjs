import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';

let env;
test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-salon-rules',
    firestore: { rules: fs.readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
test.after(() => env.cleanup());
test.beforeEach(() => env.clearFirestore());

const appt = (o = {}) => ({ client_name: 'ليلى', phone: '0791234567', date: '2026-03-01', time: '10:00', service: 'صبغة', price: 100,
  status: 'booked', walk_in: false, note: '', created_at: '2026-03-01T08:00:00.000Z', payments: [], due: 100, ...o });
const salon = () => env.authenticatedContext('u1', { email: 'salon@yasmin.app' }).firestore();
const stranger = () => env.authenticatedContext('u2', { email: 'someone@else.com' }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test('signed-out visitors and other accounts get nothing', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'appointments/a1'), appt()));
  for (const db of [anon(), stranger()]) {
    await assertFails(getDoc(doc(db, 'appointments/a1')));
    await assertFails(setDoc(doc(db, 'appointments/a2'), appt()));
    await assertFails(deleteDoc(doc(db, 'appointments/a1')));
    await assertFails(setDoc(doc(db, 'notes/n1'), { text: 'x', pinned: false, done: false, created_at: 'now' }));
  }
});

test('the salon account can create, read, update and delete appointments', async () => {
  const db = salon();
  await assertSucceeds(setDoc(doc(db, 'appointments/a1'), appt()));
  assert.equal((await assertSucceeds(getDoc(doc(db, 'appointments/a1')))).data().client_name, 'ليلى');
  await assertSucceeds(updateDoc(doc(db, 'appointments/a1'), { status: 'came', due: 0 }));
  await assertSucceeds(deleteDoc(doc(db, 'appointments/a1')));
});

test('malformed appointments are rejected', async () => {
  const db = salon();
  const reject = (o) => assertFails(setDoc(doc(db, 'appointments/x'), o));
  await reject(appt({ client_name: '' }));
  await reject(appt({ client_name: 'x'.repeat(81) }));
  await reject(appt({ date: '1 March' }));
  await reject(appt({ time: '25:00' }));
  await reject(appt({ price: -1 }));
  await reject(appt({ price: '100' }));
  await reject(appt({ status: 'hacked' }));
  await reject(appt({ walk_in: 'yes' }));
  await reject(appt({ payments: 'none' }));
  await reject(appt({ due: -5 }));
  await reject({ ...appt(), extra: 'field' });
  const { phone, ...missing } = appt();
  await reject(missing);
  await assertSucceeds(setDoc(doc(db, 'appointments/ok'), appt({ payments: [{ id: 'p1', amount: 10, paid_at: 'x' }] })));
  await assertFails(updateDoc(doc(db, 'appointments/ok'), { price: -3 }));
});

test('bot-created requests: pending status and the optional source/wa_notified fields', async () => {
  const db = salon();
  await assertSucceeds(setDoc(doc(db, 'appointments/w1'), appt({ status: 'pending', source: 'whatsapp', wa_notified: 'pending' })));
  await assertSucceeds(updateDoc(doc(db, 'appointments/w1'), { status: 'booked' }));      // the salon confirms it
  await assertFails(setDoc(doc(db, 'appointments/w2'), appt({ source: 'telegram' })));
  await assertFails(setDoc(doc(db, 'appointments/w3'), appt({ wa_notified: 5 })));
});

test('bot_status is readable by the salon only and never writable from the app', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'bot_status/main'), { state: 'connected', updatedAt: 'now' }));
  await assertSucceeds(getDoc(doc(salon(), 'bot_status/main')));
  await assertFails(getDoc(doc(stranger(), 'bot_status/main')));
  await assertFails(getDoc(doc(anon(), 'bot_status/main')));
  await assertFails(setDoc(doc(salon(), 'bot_status/main'), { state: 'hacked', updatedAt: 'now' }));
});

test('notes are validated and other collections stay closed', async () => {
  const db = salon();
  await assertSucceeds(setDoc(doc(db, 'notes/n1'), { text: 'مواد صبغة', pinned: false, done: false, created_at: 'now' }));
  await assertFails(setDoc(doc(db, 'notes/n2'), { text: '', pinned: false, done: false, created_at: 'now' }));
  await assertFails(setDoc(doc(db, 'notes/n3'), { text: 'x', pinned: 'no', done: false, created_at: 'now' }));
  await assertFails(setDoc(doc(db, 'secrets/s1'), { a: 1 }));
  await assertFails(getDoc(doc(db, 'secrets/s1')));
});
