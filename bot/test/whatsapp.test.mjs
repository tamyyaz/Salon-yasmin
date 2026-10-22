import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIncoming, createWhatsApp, chatIdOf, pnJidOf } from '../lib/whatsapp.js';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const ts = (offsetMs = 0) => Math.floor((NOW + offsetMs) / 1000);
const incoming = (over = {}) => ({ key: { remoteJid: '962791234567@s.whatsapp.net', id: 'ID1', fromMe: false }, messageTimestamp: ts(-1000), message: { conversation: 'مرحبا' }, ...over });

test('parseIncoming: text variants, media and what must be ignored', async () => {
  const p = (m, opts = {}) => parseIncoming(m, { now: NOW, ...opts });
  assert.deepEqual(await p(incoming()).then((r) => [r.chatId, r.text, r.fromMe, r.messageId]), ['962791234567@c.us', 'مرحبا', false, 'ID1']);
  assert.equal((await p(incoming({ message: { extendedTextMessage: { text: 'رابط' } } }))).text, 'رابط');
  assert.equal((await p(incoming({ message: { ephemeralMessage: { message: { conversation: 'مؤقتة' } } } }))).text, 'مؤقتة');
  const voice = await p(incoming({ message: { audioMessage: {} } }));
  assert.deepEqual([voice.text, voice.hasMedia], ['', true]);
  assert.equal(await p(incoming({ message: { reactionMessage: { text: '👍' } } })), null);          // reactions
  assert.equal(await p(incoming({ message: { protocolMessage: {} } })), null);
  assert.equal(await p(incoming({ key: { remoteJid: '1203-456@g.us', id: 'G' } })), null);          // groups
  assert.equal(await p(incoming({ key: { remoteJid: 'status@broadcast', id: 'S' } })), null);       // status
  assert.equal(await p(incoming({ messageTimestamp: ts(-7 * 3600e3) })), null);                     // stale backlog
  assert.equal((await p(incoming({ key: { remoteJid: '962791234567:12@s.whatsapp.net', id: 'D' } }))).chatId, '962791234567@c.us'); // device suffix
  assert.equal((await p(incoming({ key: { remoteJid: '962791234567@s.whatsapp.net', id: 'M', fromMe: true } }))).fromMe, true);
});

test('hidden (LID) contacts are resolved to a real phone number, or skipped', async () => {
  const lid = { key: { remoteJid: '99887766@lid', id: 'L1', remoteJidAlt: '962777654321@s.whatsapp.net' }, messageTimestamp: ts(), message: { conversation: 'hi' } };
  const viaAlt = await parseIncoming(lid, { now: NOW });
  assert.deepEqual([viaAlt.chatId, viaAlt.jid], ['962777654321@c.us', '99887766@lid']);            // reply goes to the original JID
  const sock = { signalRepository: { lidMapping: { getPNForLID: async () => '962788000111@s.whatsapp.net' } } };
  const noAlt = { ...lid, key: { remoteJid: '99887766@lid', id: 'L2' } };
  assert.equal((await parseIncoming(noAlt, { now: NOW, sock })).chatId, '962788000111@c.us');       // via the mapping table
  assert.equal(await parseIncoming(noAlt, { now: NOW }), null);                                      // unresolvable: never guess a number
});

// ---------- fake Baileys ----------
function fakeBaileys({ registered = false } = {}) {
  const socks = [];
  return {
    socks,
    makeWASocket: () => {
      const handlers = {};
      const sock = {
        sent: [], presence: [], read: [], user: { id: '962790000000:5@s.whatsapp.net' },
        ev: { on: (name, fn) => { handlers[name] = fn; }, emit: (name, payload) => handlers[name]?.(payload) },
        sendMessage: async (jid, content) => { sock.sent.push([jid, content.text]); return { key: { id: `OUT${sock.sent.length}` } }; },
        sendPresenceUpdate: async (type, jid) => { sock.presence.push([type, jid]); },
        readMessages: async (keys) => { sock.read.push(...keys); },
        requestPairingCode: async () => 'ABCD-1234',
        end() {},
      };
      socks.push(sock);
      return sock;
    },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    useMultiFileAuthState: async () => ({ state: { creds: { registered } }, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    Browsers: { macOS: () => ['Mac OS', 'Desktop', '14'] },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const harness = async (opts = {}) => {
  const baileys = fakeBaileys(opts.baileys);
  const got = []; const statuses = []; const sleeps = [];
  const wa = createWhatsApp({
    baileys, authDir: '/unused', onStatus: (s) => statuses.push(s), onMessage: async (m) => { got.push(m); await opts.onMessage?.(m); },
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, ...opts.wa,
  });
  await wa.start();
  return { wa, baileys, sock: baileys.socks[0], got, statuses, sleeps };
};
const upsert = (sock, msgs, type = 'notify') => sock.ev.emit('messages.upsert', { messages: msgs, type });
const recent = (over) => incoming({ messageTimestamp: Math.floor(Date.now() / 1000), ...over });

test('inbound text is read, handed over once, per chat in order', async () => {
  const order = [];
  const { sock, got } = await harness({ onMessage: async (m) => { await new Promise((r) => setTimeout(r, m.text === 'first' ? 40 : 1)); order.push(m.text); } });
  upsert(sock, [recent({ key: { remoteJid: '962791234567@s.whatsapp.net', id: 'A' }, message: { conversation: 'first' } }),
    recent({ key: { remoteJid: '962791234567@s.whatsapp.net', id: 'B' }, message: { conversation: 'second' } })]);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(order, ['first', 'second']);                       // the slow first message doesn't get overtaken
  assert.equal(got.length, 2);
  assert.equal(sock.read.length, 2);                                   // marked as read
});

test('sending: typing indicator, human-like pause, own echo ignored, owner typing detected', async () => {
  const { wa, sock, got, sleeps } = await harness();
  const sent = await wa.send('962791234567@c.us', 'أهلين 🌸');
  assert.deepEqual(sock.sent, [['962791234567@s.whatsapp.net', 'أهلين 🌸']]);
  assert.deepEqual(sock.presence.map((p) => p[0]), ['composing', 'paused']);
  assert.ok(sleeps.some((ms) => ms >= 350 && ms <= 3000));           // typing pause scales with length, capped
  upsert(sock, [recent({ key: { remoteJid: '962791234567@s.whatsapp.net', id: sent.key.id, fromMe: true }, message: { conversation: 'أهلين 🌸' } })]);
  await flush();
  assert.equal(got.length, 0);                                         // our own message coming back is not "the owner typing"
  upsert(sock, [recent({ key: { remoteJid: '962791234567@s.whatsapp.net', id: 'HUMAN', fromMe: true }, message: { conversation: 'مرحبا من الصالون' } })]);
  await flush();
  assert.deepEqual([got[0].fromMe, got[0].chatId], [true, '962791234567@c.us']);
  upsert(sock, [recent({ key: { remoteJid: '962791234567@s.whatsapp.net', id: 'OLDOWN', fromMe: true } })], 'append');
  await flush();
  assert.equal(got.length, 1);                                         // history sync of old own messages is ignored
});

test('messages go back to the JID the customer used (hidden LID contacts)', async () => {
  const { wa, sock } = await harness();
  upsert(sock, [recent({ key: { remoteJid: '55667788@lid', id: 'LL', remoteJidAlt: '962777654321@s.whatsapp.net' }, message: { conversation: 'hi' } })]);
  await flush();
  await wa.send('962777654321@c.us', 'رد');
  assert.equal(sock.sent[0][0], '55667788@lid');
});

test('there is always a pause between consecutive messages', async () => {
  const { wa, sleeps } = await harness();
  await wa.send('962791234567@c.us', 'one');
  await wa.send('962791234567@c.us', 'two');
  assert.ok(sleeps.some((ms) => ms > 800));                          // the gap between messages kicked in for the second one
});

test('connection lifecycle: QR, pairing code, reconnect with back-off, logged-out stops', async () => {
  const qrs = [];
  const h1 = await harness({ wa: { printQr: (q) => qrs.push(q) } });
  h1.sock.ev.emit('connection.update', { qr: 'QRDATA' });
  await flush();
  assert.deepEqual(qrs, ['QRDATA']);
  assert.equal(h1.statuses.at(-1).state, 'qr');

  const h2 = await harness({ wa: { pairNumber: '+962 79 000 0000' } });
  h2.sock.ev.emit('connection.update', { qr: 'QRDATA' });
  await flush();
  assert.deepEqual([h2.statuses.at(-1).state, h2.statuses.at(-1).pairingCode], ['pairing', 'ABCD-1234']);
  h2.sock.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.deepEqual([h2.statuses.at(-1).state, h2.statuses.at(-1).number], ['connected', '962790000000']);

  h2.sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });   // dropped
  await flush();
  assert.equal(h2.baileys.socks.length, 2);                            // it reconnected by itself
  assert.equal(h2.statuses.some((s) => s.state === 'offline'), true);

  const h3 = await harness();
  h3.sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });    // unlinked from the phone
  await flush();
  assert.equal(h3.baileys.socks.length, 1);                            // no reconnect loop on a logged-out session
  assert.equal(h3.statuses.at(-1).state, 'logged_out');
});

test('id helpers', () => {
  assert.equal(chatIdOf('962791234567:7@s.whatsapp.net'), '962791234567@c.us');
  assert.equal(pnJidOf('962791234567@c.us'), '962791234567@s.whatsapp.net');
});
