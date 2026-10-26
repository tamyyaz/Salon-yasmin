import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createInbox } from '../lib/inbox.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const PROJECT = 'demo-salon-bot';
const db = openDb({ projectId: PROJECT });
const LAYLA = '962791234567@c.us';
const KEY = '962791234567';
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 22, 10, 0, tick++));

test.beforeEach(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});
const thread = async () => (await db.collection('wa_threads').doc(KEY).get()).data();
const messages = async () => (await db.collection('wa_threads').doc(KEY).collection('messages').orderBy('at').get()).docs.map((d) => d.data());
const until = async (fn) => { for (let i = 0; i < 80; i += 1) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('every message is mirrored: thread summary, unread count, who wrote it', async () => {
  const inbox = createInbox({ db, now });
  inbox.record({ chatId: LAYLA, dir: 'in', by: 'customer', text: 'بدي موعد', messageId: 'a1', name: 'ليلى' });
  inbox.record({ chatId: LAYLA, dir: 'in', by: 'customer', text: 'بكرا؟', messageId: 'a2' });
  inbox.record({ chatId: LAYLA, dir: 'out', by: 'bot', text: 'أهلاً فيكي' });
  await inbox.flush();
  let t = await thread();
  assert.deepEqual([t.phone, t.name, t.unread, t.lastText, t.lastDir, t.lastBy], ['+962791234567', 'ليلى', 2, 'أهلاً فيكي', 'out', 'bot']);   // the bot answering doesn't mark it read
  inbox.record({ chatId: LAYLA, dir: 'out', by: 'staff', text: 'تفضلي' });
  await inbox.flush();
  t = await thread();
  assert.equal(t.unread, 0);                                                                  // a human answered
  assert.deepEqual((await messages()).map((m) => [m.dir, m.by, m.text]), [
    ['in', 'customer', 'بدي موعد'], ['in', 'customer', 'بكرا؟'], ['out', 'bot', 'أهلاً فيكي'], ['out', 'staff', 'تفضلي']]);
});

test('a message delivered twice is stored once', async () => {
  const inbox = createInbox({ db, now });
  inbox.record({ chatId: LAYLA, dir: 'in', by: 'customer', text: 'هاي', messageId: 'dup' });
  inbox.record({ chatId: LAYLA, dir: 'in', by: 'customer', text: 'هاي', messageId: 'dup' });
  await inbox.flush();
  assert.equal((await messages()).length, 1);
  assert.equal((await thread()).unread, 1);
});

test('a reply typed in the app is sent once through WhatsApp, recorded, and removed from the queue', async () => {
  const inbox = createInbox({ db, now });
  const sent = []; const staffReplied = [];
  const stop = inbox.watchOutbox({ send: async (chatId, text) => sent.push([chatId, text]), onSent: (c) => staffReplied.push(c) });
  await db.collection('wa_outbox').add({ phone: '+962791234567', text: 'أهلاً، موعدك مؤكد', status: 'queued', created_at: now().toISOString() });
  assert.ok(await until(async () => sent.length === 1 && (await db.collection('wa_outbox').get()).empty));
  await inbox.flush();
  assert.deepEqual(sent, [[LAYLA, 'أهلاً، موعدك مؤكد']]);
  assert.deepEqual(staffReplied, [LAYLA]);
  assert.deepEqual((await messages()).map((m) => [m.by, m.text, m.status ?? null]), [['staff', 'أهلاً، موعدك مؤكد', null]]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, 1);                                                               // not sent again
  stop();
});

test('replies are sent in order; a failed send is shown as failed and does not block the next', async () => {
  const inbox = createInbox({ db, now });
  const sent = [];
  const stop = inbox.watchOutbox({ send: async (chatId, text) => { if (text === 'bad') throw new Error('WhatsApp is not connected'); sent.push(text); } });
  for (const text of ['one', 'bad', 'two']) await db.collection('wa_outbox').add({ phone: '+962791234567', text, status: 'queued', created_at: now().toISOString() });
  assert.ok(await until(async () => (await db.collection('wa_outbox').get()).empty));
  await inbox.flush();
  assert.deepEqual(sent, ['one', 'two']);
  const failed = (await messages()).filter((m) => m.status === 'failed');
  assert.deepEqual(failed.map((m) => [m.text, m.error]), [['bad', 'WhatsApp is not connected']]);
  stop();
});

test('a reply left "sending" by a crash is marked failed, never sent twice', async () => {
  const inbox = createInbox({ db, now });
  await db.collection('wa_outbox').add({ phone: '+962791234567', text: 'half sent', status: 'sending', created_at: now().toISOString() });
  const sent = [];
  const stop = inbox.watchOutbox({ send: async (c, t) => sent.push(t) });
  assert.ok(await until(async () => (await db.collection('wa_outbox').get()).empty));
  await inbox.flush();
  assert.deepEqual(sent, []);
  assert.equal((await messages())[0].status, 'failed');
  stop();
});
