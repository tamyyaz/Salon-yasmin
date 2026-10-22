import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createBooking, phoneOfChat } from '../lib/booking.js';
import { createAgent } from '../lib/agent.js';
import { createMenu } from '../lib/menu.js';
import { createKnowledge } from '../lib/knowledge.js';
import { norm, keywords } from '../lib/arabic.js';
import baseConfig from '../salon.config.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const PROJECT = 'demo-salon-bot';
const db = openDb({ projectId: PROJECT });
const config = { ...baseConfig, timezone: 'Asia/Amman', closedWeekdays: [5], minLeadMinutes: 60, maxDaysAhead: 45, maxActivePerCustomer: 3 };
let clock = new Date('2026-10-22T10:00:00Z');                 // Thursday 13:00 salon time
const now = () => clock;
const LAYLA = '962791234567@c.us';
const knowledge = createKnowledge({ db, config, ttlMs: 0 });
const booking = createBooking({ db, config, now, getServices: async () => (await knowledge.load()).services });
const pure = createMenu({ booking: { allSlots: booking.allSlots }, config });

const sayTo = (agent, chatId = LAYLA) => { let n = 0; return (text) => agent.handle({ chatId, text, messageId: `m${Date.now()}-${n++}-${Math.random()}` }); };
const newAgent = (extra = {}) => createAgent({ db, config, booking, knowledge, now, ...extra });
const seed = async () => {
  await db.collection('services').add({ name: 'صبغة', price: 80, note: 'يزيد للشعر الطويل', active: true });
  await db.collection('services').add({ name: 'قص شعر', price: 25, note: '', active: true });
  await db.collection('services').add({ name: 'تنظيف بشرة', price: null, note: '', active: true });
  await db.doc('settings/salon').set({ about: '', address: 'دمشق، المزة', maps_url: 'https://maps.app.goo.gl/xyz', hours_text: 'يومياً 9 صباحاً حتى 9 مساءً (عدا الجمعة)',
    payment: 'كاش فقط', policies: '', faq: [{ q: 'بتعملوا تسريحات عرايس؟', a: 'أكيد، بنعمل تسريحات عرايس بالحجز المسبق 💍' }] });
};

test.beforeEach(async () => {
  clock = new Date('2026-10-22T10:00:00Z');
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await seed();
});
const appts = async () => (await db.collection('appointments').get()).docs.map((d) => ({ id: d.id, ...d.data() }));

test('Arabic normalisation and keywords', () => {
  assert.equal(norm('  مَرْحَباً!! بدّي موعد ١٠:٣٠ بُكرة؟ '), 'مرحبا بدي موعد 10:30 بكره');
  assert.deepEqual(keywords('قديش سعر القص؟'), ['قديش', 'سعر', 'قص']);
});

test('day and time parsing', () => {
  const day = (t, opts) => pure.parseDay(norm(t), '2026-10-22', opts);                       // a Thursday
  assert.equal(day('اليوم'), '2026-10-22');
  assert.equal(day('بكرا'), '2026-10-23');
  assert.equal(day('بكرة'), '2026-10-23');
  assert.equal(day('بعد بكرا'), '2026-10-24');
  assert.equal(day('السبت'), '2026-10-24');
  assert.equal(day('يوم الخميس'), '2026-10-22');
  assert.equal(day('الاثنين'), '2026-10-26');
  assert.equal(day('25/10'), '2026-10-25');
  assert.equal(day('١/١١'), '2026-11-01');
  assert.equal(day('5/1'), '2027-01-05');                                         // already passed this year → next year
  assert.equal(day('2026-12-03'), '2026-12-03');
  assert.equal(day('30', { bare: true }), '2026-10-30');
  assert.equal(day('2'), null);                                                    // a menu digit is not a date
  assert.equal(day('الساعة واحدة'), null);                                        // "واحد" is not Sunday
  assert.equal(day('هلا'), null);
  const slots = booking.allSlots();
  const time = (t) => pure.parseTime(norm(t), slots);
  assert.equal(time('11'), '11:00');
  assert.equal(time('11:30'), '11:30');
  assert.equal(time('3 العصر'), '15:00');
  assert.equal(time('3'), '15:00');                                               // 03:00 is closed, so it can only be 15:00
  assert.equal(time('10 صباحا'), '10:00');
  assert.equal(time('٩'), '09:00');
  assert.equal(time('8 مساء'), '20:00');
  assert.equal(time('11:15'), null);                                              // not a slot
  assert.equal(time('بكرا'), null);
});

test('prices, address, hours, payment, FAQ and greetings come from the owner\'s data', async () => {
  const say = sayTo(newAgent());
  assert.match(await say('مرحبا'), /1️⃣ الأسعار/);
  const one = await say('قديش سعر الصبغة؟');
  assert.match(one, /صبغة: 80 ₪ \(يزيد للشعر الطويل\)/);
  assert.ok(!one.includes('قص شعر'));                                             // only the asked service
  const all = await say('الاسعار');
  for (const x of ['صبغة: 80 ₪', 'قص شعر: 25 ₪', 'تنظيف بشرة: حسب الاتفاق']) assert.ok(all.includes(x), x);
  const where = await say('وين الصالون؟');
  assert.ok(where.includes('دمشق، المزة') && where.includes('https://maps.app.goo.gl/xyz'));
  assert.match(await say('الساعة كم بتفتحوا'), /يومياً 9 صباحاً/);
  assert.match(await say('بتقبلوا كارت؟'), /كاش فقط/);
  assert.match(await say('بتعملوا تسريحة عروس؟'), /تسريحات عرايس بالحجز المسبق/);   // FAQ matched by meaning of key words
  assert.match(await say('3'), /دمشق، المزة/);                                    // menu number
});

test('step-by-step booking, saved as a pending request with the owner\'s price', async () => {
  const say = sayTo(newAgent());
  assert.match(await say('2'), /أي خدمة بدك/);
  assert.match(await say('صبغة'), /أي يوم/);
  const slots = await say('السبت');
  assert.match(slots, /الأوقات الفاضية يوم السبت 2026-10-24/);
  assert.ok(slots.includes('11:00'));
  assert.match(await say('١١'), /شو اسمك/);                                        // Arabic-Indic digits
  const sum = await say('ليلى');
  assert.match(sum, /الخدمة: صبغة/);
  assert.match(sum, /السبت 2026-10-24/);
  assert.match(sum, /الساعة: 11:00/);
  assert.match(await say('اي'), /بانتظار تأكيد الصالون/);
  const [a] = await appts();
  assert.deepEqual([a.status, a.source, a.phone, a.client_name, a.service, a.time, a.price], ['pending', 'whatsapp', phoneOfChat(LAYLA), 'ليلى', 'صبغة', '11:00', 80]);
});

test('everything in one message: service + day + time are picked up, only the name is asked', async () => {
  const say = sayTo(newAgent());
  assert.match(await say('بدي موعد قص السبت الساعة 3 العصر'), /شو اسمك/);
  assert.match(await say('رنا'), /الساعة: 15:00/);
  assert.match(await say('نعم'), /بانتظار تأكيد/);
  assert.equal((await appts())[0].time, '15:00');
  assert.match(await sayTo(newAgent())('بدي موعد'), /أي خدمة/);                   // a returning customer still starts from the top
});

test('a returning customer is not asked her name again', async () => {
  const agent = newAgent();
  const say = sayTo(agent);
  await say('بدي موعد قص السبت 10'); await say('رنا'); await say('نعم');
  assert.match(await say('بدي موعد صبغة الاحد 11'), /اسمك|الاسم: رنا/);
  const again = await say('نعم');
  assert.ok(again.includes('بانتظار تأكيد') || again.includes('اكتبي'));
});

test('a question in the middle of a booking is answered and the booking stays open', async () => {
  const say = sayTo(newAgent());
  await say('2'); await say('قص');
  const mid = await say('قديش الصبغة؟');
  assert.match(mid, /صبغة: 80 ₪/);
  assert.match(mid, /نكمّل حجزك/);
  assert.match(await say('السبت'), /الأوقات الفاضية/);                           // still on the date step
  assert.match(await say('قائمة'), /1️⃣ الأسعار/);                                 // can always go back
  assert.match(await say('11'), /ما فهمت|أهلاً/);                                  // flow is gone
});

test('closed day, past time and taken slot are explained', async () => {
  const say = sayTo(newAgent());
  await say('2'); await say('قص');
  assert.match(await say('بكرا'), /مسكّر/);                                       // Friday
  await booking.create({ phone: phoneOfChat(RANA), customer_name: 'ثانية', date: '2026-10-24', time: '11:00', service: 'قص شعر' });
  assert.match(await say('السبت'), /الأوقات الفاضية/);
  assert.match(await say('11'), /مش فاضية/);
  assert.match(await say('11:30'), /شو اسمك/);
});
const RANA = '962777654321@c.us';

test('my bookings and cancelling one', async () => {
  const say = sayTo(newAgent());
  assert.match(await say('حجوزاتي'), /ما عندك حجوزات/);
  const mine = await booking.create({ phone: phoneOfChat(LAYLA), customer_name: 'ليلى', date: '2026-10-24', time: '12:00', service: 'قص شعر' });
  assert.match(await say('4'), /2026-10-24 الساعة 12:00/);
  assert.match(await say('بدي الغي موعدي'), /اكتبي رقمه/);
  assert.match(await say('1'), /ألغي موعد 2026-10-24/);
  assert.match(await say('نعم'), /تم إلغاء/);
  const [a] = await appts();
  assert.deepEqual([a.id, a.status], [mine.booking_id, 'cancelled']);
  assert.match(await say('لا'), /ما فهمت|أهلاً/);
});

test('unknown messages: one hint, then the salon is told; "talk to someone" goes straight to the salon', async () => {
  const say = sayTo(newAgent());
  assert.match(await say('كيف الطقس بالصين'), /ما فهمت قصدك/);
  assert.match(await say('شي غريب تاني'), /بلّغت الصالون/);
  const notes = (await db.collection('notes').get()).docs.map((d) => d.data());
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /شي غريب تاني/);
  assert.equal(await say('هل في أحد؟'), null);                                   // now paused for the salon to reply
  await db.collection('wa_chats').doc('962791234567').update({ humanUntil: 0 });
  assert.match(await say('بدي احكي مع موظفة'), /بلّغت الصالون/);
  assert.equal((await db.collection('notes').get()).size, 2);
});

test('AI unreachable from this country: the menu answers and the model is not retried on every message', async () => {
  let calls = 0;
  const gemini = { generate: async () => { calls += 1; throw new Error('Gemini 400 (gemini-flash-lite-latest): User location is not supported for the API use.'); } };
  const say = sayTo(newAgent({ gemini }));
  assert.match(await say('قديش سعر القص؟'), /قص شعر: 25 ₪/);                      // known intent: instant, no model call at all
  assert.equal(calls, 0);
  assert.match(await say('كيف الطقس بالصين'), /ما فهمت قصدك/);                     // unknown: the model is tried once…
  assert.match(await say('2'), /أي خدمة/);
  assert.match(await say('هاد كلام غريب كمان'), /ما لقيت هالخدمة/);       // inside a booking step the menu answers, no model
  assert.equal(calls, 1);                                                          // …and the refusal is remembered
});

test('menu first: known questions never wait for the AI; unknown ones are handed to it', async () => {
  const seen = [];
  const gemini = { generate: async ({ contents }) => { seen.push(contents.at(-1).parts[0].text); return { role: 'model', parts: [{ text: 'رد من الذكاء الاصطناعي' }] }; } };
  const say = sayTo(newAgent({ gemini }));
  assert.match(await say('قديش سعر القص'), /قص شعر: 25 ₪/);
  assert.match(await say('وين الصالون'), /دمشق/);
  assert.match(await say('2'), /أي خدمة/);
  assert.deepEqual(seen, []);                                                      // none of that touched the model
  assert.equal(await sayTo(newAgent({ gemini }), RANA)('بتعملوا تمديد رموش؟'), 'رد من الذكاء الاصطناعي');
  assert.deepEqual(seen, ['بتعملوا تمديد رموش؟']);
});

test('ai-first mode still available for owners who prefer it', async () => {
  const gemini = { generate: async () => ({ role: 'model', parts: [{ text: 'رد من الذكاء الاصطناعي' }] }) };
  assert.equal(await sayTo(newAgent({ gemini, aiFirst: true }))('قديش القص'), 'رد من الذكاء الاصطناعي');
});

test('an unfinished booking is forgotten after 30 minutes of silence', async () => {
  const say = sayTo(newAgent());
  await say('2'); await say('قص');
  clock = new Date(clock.getTime() + 31 * 60e3);
  assert.match(await say('السبت'), /ما فهمت|أهلاً/);                               // starts over instead of continuing
});
