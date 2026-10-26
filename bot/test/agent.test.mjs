import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createBooking, phoneOfChat } from '../lib/booking.js';
import { createAgent as makeAgent } from '../lib/agent.js';
import { watchConfirmations, messageFor } from '../lib/notify.js';
import baseConfig from '../salon.config.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const PROJECT = 'demo-salon-bot';
const db = openDb({ projectId: PROJECT });
const config = { ...baseConfig, timezone: 'Asia/Amman', closedWeekdays: [5], minLeadMinutes: 60, maxDaysAhead: 45, maxActivePerCustomer: 3 };
// Thursday 2026-10-22, 13:00 salon time (UTC+3)
let clock = new Date('2026-10-22T10:00:00Z');
const now = () => clock;

const LAYLA = '962791234567@c.us';
const RANA = '962777654321@c.us';
const booking = createBooking({ db, config, now });

const agents = [];                                     // background saves of finished tests must land before the database is wiped
const createAgent = (o) => { const a = makeAgent(o); agents.push(a); return a; };
const newAgent = (extra = {}) => createAgent({ db, config, booking, now, ...extra });

test.beforeEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.flush()));
  clock = new Date('2026-10-22T10:00:00Z');
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});

const appts = async () => (await db.collection('appointments').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

test('availability hides taken slots, past times, closed days and bad dates', async () => {
  await db.collection('appointments').add({ date: '2026-10-24', time: '10:00', status: 'pending' });
  await db.collection('appointments').add({ date: '2026-10-24', time: '10:30', status: 'cancelled' });   // cancelled frees the slot
  const sat = await booking.checkAvailability({ date: '2026-10-24' });
  assert.ok(!sat.free_slots.includes('10:00'));
  assert.ok(sat.free_slots.includes('10:30'));
  assert.equal(sat.weekday, 'السبت');
  const today = await booking.checkAvailability({ date: '2026-10-22' });                                  // 13:00 now + 60 min lead
  assert.ok(!today.free_slots.includes('13:30') && today.free_slots.includes('14:00'));
  await assert.rejects(booking.checkAvailability({ date: '2026-10-23' }), /مسكّر/);                       // Friday
  await assert.rejects(booking.checkAvailability({ date: '2026-10-21' }), /مضى/);
  await assert.rejects(booking.checkAvailability({ date: '2027-03-01' }), /خلال/);
  await assert.rejects(booking.checkAvailability({ date: 'tomorrow' }), /YYYY-MM-DD/);
});

test('two customers cannot take the same slot, and one phone has a cap', async () => {
  const slot = { customer_name: 'x', date: '2026-10-24', time: '12:00', service: 'قص شعر' };
  await booking.create({ phone: phoneOfChat(LAYLA), ...slot });
  await assert.rejects(booking.create({ phone: phoneOfChat(RANA), ...slot }), /انحجز/);
  for (const time of ['13:00', '14:00']) await booking.create({ phone: phoneOfChat(LAYLA), ...slot, time });
  await assert.rejects(booking.create({ phone: phoneOfChat(LAYLA), ...slot, time: '15:00' }), /3 حجوزات/);
  await assert.rejects(booking.create({ phone: phoneOfChat(RANA), ...slot, time: '09:15' }), /الوقت لازم/);
  await assert.rejects(booking.create({ phone: phoneOfChat(RANA), ...slot, time: '13:30', date: '2026-10-23' }), /مسكّر/);
  await assert.rejects(booking.create({ phone: phoneOfChat(RANA), ...slot, time: '09:00', customer_name: '  ' }), /اسم/);
});


test('duplicates, groups, voice notes and the owner stepping in', async () => {
  const agent = newAgent();
  assert.match(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'dup' }), /أهلاً/);
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'dup' }), null);             // same delivery twice
  assert.equal(await agent.handle({ chatId: '12345-678@g.us', text: 'hi', messageId: 'g1' }), null);      // groups ignored
  assert.match(await agent.handle({ chatId: RANA, text: '   ', messageId: 'v1' }), /تكتبيلي/);            // voice note / empty
  assert.equal(await agent.handle({ chatId: LAYLA, text: '', fromMe: true, messageId: 'o1' }), null);      // owner typed from the phone
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'm2' }), null);              // bot stays quiet
  clock = new Date(clock.getTime() + 11 * 60e3);
  assert.match(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'm3' }), /أهلاً/);           // 11 minutes later it resumes
});

test('answering from the app silences the automatic assistant in that chat for a while', async () => {
  const agent = newAgent();
  agent.pauseFor(LAYLA);
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 's1' }), null);
  assert.match(await agent.handle({ chatId: RANA, text: 'مرحبا', messageId: 's2' }), /أهلاً/);             // other chats are unaffected
  clock = new Date(clock.getTime() + 11 * 60e3);
  assert.match(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 's3' }), /أهلاً/);
});

test('the automatic assistant can be switched off in the app', async () => {
  await db.doc('settings/salon').set({ auto_reply: false });
  const agent = newAgent();
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'x1' }), null);
  assert.equal((await db.collection('appointments').get()).size, 0);
  await db.doc('settings/salon').set({ auto_reply: true });
  agent.invalidate?.();
  const fresh = newAgent();
  assert.match(await fresh.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'x2' }), /أهلاً/);
});

test('resume tool lifts the pause so the assistant answers again; the log says why it was quiet', async () => {
  const logs = [];
  const agent = createAgent({ db, config, booking, now: () => new Date(), log: (...a) => logs.push(a.join(' ')) });
  await agent.handle({ chatId: LAYLA, text: '', fromMe: true, messageId: 'own1' });                      // owner typed in the chat
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'c1' }), null);
  await agent.flush();
  assert.ok(logs.some((l) => /paused for \+?962791234567|paused for 962791234567/.test(l) && /npm run resume/.test(l)), 'the log explains the silence');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, ['tools/resume.mjs', '962791234567'], { env: { ...process.env, FIREBASE_PROJECT_ID: PROJECT }, encoding: 'utf8' });
  assert.match(run.stdout, /resumed: 962791234567/);
  agent.invalidate();                                                                                     // (the running bot re-reads paused chats every 15 s)
  assert.match(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'c2' }), /أهلاً/);
  const again = spawnSync(process.execPath, ['tools/resume.mjs'], { env: { ...process.env, FIREBASE_PROJECT_ID: PROJECT }, encoding: 'utf8' });
  assert.match(again.stdout, /Nothing was paused/);
});

test('rate limit: one notice, then silence', async () => {
  const agent = newAgent();
  let replies = 0; let notice = 0; let silent = 0;
  for (let i = 0; i < 28; i += 1) {
    const r = await agent.handle({ chatId: RANA, text: 'مرحبا', messageId: `r${i}` });
    if (!r) silent += 1; else if (/وصلتي للحد/.test(r)) notice += 1; else replies += 1;
  }
  assert.deepEqual([replies, notice, silent], [25, 1, 2]);
});

test('a booking takes its price from the service list the owner maintains', async () => {
  await db.collection('services').add({ name: 'صبغة', price: 80, note: '', active: true });
  const kb = (await import('../lib/knowledge.js')).createKnowledge({ db, config, ttlMs: 0 });
  const priced = createBooking({ db, config, now, getServices: async () => (await kb.load()).services });
  await priced.create({ phone: phoneOfChat(LAYLA), customer_name: 'ليلى', date: '2026-10-24', time: '11:00', service: 'صبغة' });
  await priced.create({ phone: phoneOfChat(LAYLA), customer_name: 'ليلى', date: '2026-10-24', time: '12:00', service: 'شي مش بالقائمة' });
  const prices = Object.fromEntries((await appts()).map((a) => [a.service, a.price]));
  assert.deepEqual(prices, { 'صبغة': 80, 'شي مش بالقائمة': 0 });
});

test('confirmation / decline messages are sent once per change', async () => {
  const mine = await booking.create({ phone: phoneOfChat(LAYLA), customer_name: 'ليلى', date: '2026-10-24', time: '10:00', service: 'قص شعر' });
  const sent = [];
  const stop = watchConfirmations({ db, send: async (chatId, text) => sent.push([chatId, text]), now });
  const waitFor = async (n) => { for (let i = 0; i < 60 && sent.length < n; i += 1) await new Promise((r) => setTimeout(r, 100)); };
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 0);                                                                            // still pending: nothing to say
  await db.collection('appointments').doc(mine.booking_id).update({ status: 'booked' });                  // salon confirms in the app
  await waitFor(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], LAYLA);
  assert.match(sent[0][1], /تم تأكيد موعدك/);
  assert.match(sent[0][1], /السبت 2026-10-24 الساعة 10:00/);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(sent.length, 1);                                                                            // not repeated
  await db.collection('appointments').doc(mine.booking_id).update({ status: 'cancelled' });
  await waitFor(2);
  assert.equal(sent.length, 2);
  assert.match(sent[1][1], /ما قدرنا|عذراً/);
  stop();
  assert.match(messageFor({ status: 'booked', date: '2026-10-24', time: '10:00', service: '' }), /بنستناك/);
});
