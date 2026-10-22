import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createBooking, phoneOfChat } from '../lib/booking.js';
import { createAgent } from '../lib/agent.js';
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

const say = (text) => ({ role: 'model', parts: [{ text }] });
const call = (name, args) => ({ role: 'model', parts: [{ functionCall: { name, args } }] });
function fakeGemini(script) {
  const seen = []; const systems = [];
  return {
    seen, systems,
    async generate({ contents, system }) {
      seen.push(structuredClone(contents)); systems.push(system);
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      if (step instanceof Error) throw step;
      return step;
    },
  };
}
const agentWith = (script) => { const gemini = fakeGemini(script); return { gemini, agent: createAgent({ db, gemini, config, booking, now, aiFirst: true }) }; };   // these tests are about the AI path
const lastResult = (gemini) => gemini.seen.at(-1).at(-1).parts[0].functionResponse.response;

test.beforeEach(async () => {
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

test('a customer books through the assistant: pending, her own phone, confirmation text returned', async () => {
  const { agent, gemini } = agentWith([
    call('check_availability', { date: '2026-10-24' }),
    call('create_booking', { customer_name: 'ليلى', date: '2026-10-24', time: '11:00', service: 'قص شعر', phone: '+999000' }), // model tries to inject a phone
    say('تم الطلب ✅ الموعد بانتظار تأكيد الصالون'),
  ]);
  const reply = await agent.handle({ chatId: LAYLA, text: 'بدي موعد قص السبت الساعة 11', messageId: 'm1' });
  assert.match(reply, /بانتظار تأكيد/);
  const [a] = await appts();
  assert.deepEqual([a.status, a.source, a.phone, a.client_name, a.time, a.wa_notified, a.price], ['pending', 'whatsapp', phoneOfChat(LAYLA), 'ليلى', '11:00', 'pending', 0]);
  assert.deepEqual(a.payments, []);
  assert.equal(gemini.seen.length, 3);
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

test('customers only ever see and cancel their own bookings', async () => {
  const mine = await booking.create({ phone: phoneOfChat(LAYLA), customer_name: 'ليلى', date: '2026-10-24', time: '10:00', service: 'قص شعر' });
  const { agent, gemini } = agentWith([
    call('my_bookings', {}),
    say('ما عندك حجوزات'),
    call('cancel_booking', { booking_id: mine.booking_id }),
    say('ما لقيته'),
  ]);
  await agent.handle({ chatId: RANA, text: 'شو حجوزاتي؟', messageId: 'a1' });
  assert.deepEqual(gemini.seen[1].at(-1).parts[0].functionResponse.response.bookings, []);               // Rana sees nothing of Layla's
  await agent.handle({ chatId: RANA, text: 'الغي الحجز', messageId: 'a2' });
  assert.match(lastResult(gemini).error, /ما لقيت/);
  assert.equal((await appts())[0].status, 'pending');                                                      // untouched

  const own = agentWith([call('cancel_booking', { booking_id: mine.booking_id }), say('تم الإلغاء')]);
  assert.equal(await own.agent.handle({ chatId: LAYLA, text: 'الغي', messageId: 'a3' }), 'تم الإلغاء');
  const [a] = await appts();
  assert.deepEqual([a.status, a.wa_notified], ['cancelled', 'cancelled']);                                  // no WhatsApp echo for her own cancel
});

test('duplicates, groups, voice notes and the owner stepping in', async () => {
  const { agent, gemini } = agentWith([say('أهلين 🌸'), say('مرحبا تاني'), say('بعد ما رجعت')]);
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'هاي', messageId: 'dup' }), 'أهلين 🌸');
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'هاي', messageId: 'dup' }), null);               // same delivery twice
  assert.equal(gemini.seen.length, 1);
  assert.equal(await agent.handle({ chatId: '12345-678@g.us', text: 'hi', messageId: 'g1' }), null);      // groups ignored
  assert.match(await agent.handle({ chatId: RANA, text: '   ', messageId: 'v1' }), /تكتبيلي/);            // voice note / empty
  assert.equal(await agent.handle({ chatId: LAYLA, text: '', fromMe: true, messageId: 'o1' }), null);      // owner typed from the phone
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'm2' }), null);              // bot stays quiet
  clock = new Date(clock.getTime() + 11 * 60e3);
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'رجعت', messageId: 'm3' }), 'مرحبا تاني');       // 11 minutes later it resumes
});

test('resume tool lifts the pause so the assistant answers again; the log says why it was quiet', async () => {
  const logs = [];
  const gemini = fakeGemini([say('أهلين'), say('رجعت أرد')]);
  const agent = createAgent({ db, gemini, config, booking, now: () => new Date(), aiFirst: true, log: (...a) => logs.push(a.join(' ')) });
  await agent.handle({ chatId: LAYLA, text: '', fromMe: true, messageId: 'own1' });                      // owner typed in the chat
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'c1' }), null);
  assert.ok(logs.some((l) => /paused for \+?962791234567|paused for 962791234567/.test(l) && /npm run resume/.test(l)), 'the log explains the silence');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, ['tools/resume.mjs', '962791234567'], { env: { ...process.env, FIREBASE_PROJECT_ID: PROJECT }, encoding: 'utf8' });
  assert.match(run.stdout, /resumed: 962791234567/);
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'مرحبا', messageId: 'c2' }), 'أهلين');
  const again = spawnSync(process.execPath, ['tools/resume.mjs'], { env: { ...process.env, FIREBASE_PROJECT_ID: PROJECT }, encoding: 'utf8' });
  assert.match(again.stdout, /Nothing was paused/);
});

test('hand-off leaves a pinned note and silences the bot on that chat', async () => {
  const { agent } = agentWith([call('handoff_to_human', { reason: 'شكوى عن صبغة' }), say('رح يتواصل معك الصالون'), say('x')]);
  assert.match(await agent.handle({ chatId: LAYLA, text: 'عندي شكوى', messageId: 'h1' }), /الصالون/);
  const notes = (await db.collection('notes').get()).docs.map((d) => d.data());
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].pinned, notes[0].done], [true, false]);
  assert.match(notes[0].text, /شكوى عن صبغة/);
  assert.equal(await agent.handle({ chatId: LAYLA, text: 'ألو؟', messageId: 'h2' }), null);
});

test('rate limit: one notice, then silence', async () => {
  const script = Array.from({ length: 40 }, () => say('تمام'));
  const { agent } = agentWith(script);
  let replies = 0; let notice = 0; let silent = 0;
  for (let i = 0; i < 28; i += 1) {
    const r = await agent.handle({ chatId: RANA, text: `msg ${i}`, messageId: `r${i}` });
    if (r === 'تمام') replies += 1; else if (r) notice += 1; else silent += 1;
  }
  assert.deepEqual([replies, notice, silent], [25, 1, 2]);
});

test('a model failure never leaks details: the menu assistant answers instead', async () => {
  const { agent } = agentWith([new Error('Gemini 500: internal secret details')]);
  const reply = await agent.handle({ chatId: LAYLA, text: 'بدي موعد', messageId: 'f1' });
  assert.ok(!/secret|Gemini/.test(reply));
  assert.match(reply, /أي خدمة بدك/);                                       // booking flow started by the fallback
  assert.equal((await db.collection('notes').get()).size, 0);              // nothing for the owner to worry about
});

test('answers come from what the owner wrote in the app: prices, info, FAQ — and stay current', async () => {
  await db.collection('services').add({ name: 'صبغة', price: 80, note: 'السعر يزيد للشعر الطويل', active: true });
  await db.collection('services').add({ name: 'سيشوار', price: null, note: '', active: true });
  await db.collection('services').add({ name: 'خدمة مخفية', price: 5, note: '', active: false });
  await db.doc('settings/salon').set({ about: 'صالون نسائي', address: 'دمشق، المزة', maps_url: 'https://maps.app.goo.gl/xyz', hours_text: 'يومياً 9 صباحاً حتى 9 مساءً',
    payment: 'كاش فقط', policies: 'الإلغاء قبل 24 ساعة', faq: [{ q: 'بتقبلوا كارت؟', a: 'لا، كاش فقط' }] });
  const { agent, gemini } = agentWith([say('الصبغة 80')]);
  await agent.handle({ chatId: LAYLA, text: 'قديش الصبغة؟', messageId: 'k1' });
  const p = gemini.systems[0];
  for (const must of ['صبغة: 80 ₪ (السعر يزيد للشعر الطويل)', 'سيشوار: السعر بيتحدد بالصالون', 'دمشق، المزة', 'https://maps.app.goo.gl/xyz', 'كاش فقط', 'الإلغاء قبل 24 ساعة', 'س: بتقبلوا كارت؟', 'ج: لا، كاش فقط']) {
    assert.ok(p.includes(must), `prompt should contain: ${must}`);
  }
  assert.ok(!p.includes('خدمة مخفية'));                                        // hidden services are not offered
  assert.ok(!p.includes('قص شعر'));                                             // the file's sample list is replaced once the app has services
  assert.match(p, /لا تخمني/);                                                  // unknown → ask the salon, don't guess
  assert.match(p, /اسمك ليان/);                                                 // persona
  assert.match(p, /ما تدّعي إنك إنسانة/);                                       // never pretends to be a person
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
