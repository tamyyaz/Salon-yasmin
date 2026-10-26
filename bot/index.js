// Salon WhatsApp assistant — run this on a computer at the salon that stays on:   npm start
// First run: link the salon's number (pairing code or QR) — see README.md.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import * as baileys from '@whiskeysockets/baileys';
import { config as web } from '../src/config.js';
import config from './salon.config.js';
import { openDb } from './lib/db.js';
import { createBooking } from './lib/booking.js';
import { createKnowledge } from './lib/knowledge.js';
import { createAgent } from './lib/agent.js';
import { createInbox, MEDIA_TEXT } from './lib/inbox.js';
import { watchConfirmations } from './lib/notify.js';
import { createWhatsApp } from './lib/whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* variables may come from the system instead */ }

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(stamp(), ...a);
const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT) {
  fail('ضع GOOGLE_APPLICATION_CREDENTIALS (مسار ملف مفتاح حساب الخدمة) في bot/.env');
}

const db = openDb({ projectId: web.firebase.projectId });
const knowledge = createKnowledge({ db, config });
const booking = createBooking({ db, config, getServices: async () => (await knowledge.load()).services });
const agent = createAgent({ db, config, booking, knowledge, log })
const inbox = createInbox({ db, log });
const statusRef = db.collection('bot_status').doc('main');
const startedAt = new Date().toISOString();
let status = { state: 'connecting' };

// the app shows this: green when fresh and connected, so the owner knows if the bot silently dropped
const publish = (patch = {}) => {
  status = { ...status, ...patch };
  const doc = { state: status.state, pairingCode: status.pairingCode ?? null, qr: status.state === 'qr' ? status.qr ?? null : null, number: status.number ?? null, startedAt, updatedAt: new Date().toISOString() };
  return statusRef.set(doc).catch((e) => log('status-write-failed', e.message));
};

const wa = createWhatsApp({
  baileys,
  authDir: process.env.WA_AUTH_DIR || path.join(here, 'auth'),   // the linked-device session; keep it private
  pairNumber: process.env.WA_PAIR_NUMBER || null,                // salon number, international format, to link with a code instead of a QR
  logger: pino({ level: 'warn' }),
  printQr: (qr) => { console.log('\nامسحي هالـ QR من واتساب ← الأجهزة المرتبطة ← ربط جهاز:\n'); qrcode.generate(qr, { small: true }); },
  log,
  onStatus: (s) => {
    log('whatsapp:', s.state, s.pairingCode ? `— كود الربط: ${s.pairingCode}` : '');
    publish({ pairingCode: null, qr: null, ...s });
  },
  onMessage: async (m) => {
    log(m.fromMe ? 'you typed to' : 'message from', m.chatId.slice(0, -5), m.hasMedia ? '(media)' : `(${m.text.length} chars)`);
    const shown = m.text || MEDIA_TEXT;
    if (m.fromMe) {                                                // typed on the phone itself
      inbox.record({ chatId: m.chatId, dir: 'out', by: 'phone', text: shown, messageId: m.messageId });
      await agent.handle({ chatId: m.chatId, fromMe: true, messageId: m.messageId });
      return;
    }
    inbox.record({ chatId: m.chatId, dir: 'in', by: 'customer', text: shown, messageId: m.messageId, name: m.name });
    const t0 = Date.now();
    const reply = await agent.handle({ chatId: m.chatId, text: m.text, messageId: m.messageId });
    const tBrain = Date.now();
    if (reply) { await sendAsBot(m.chatId, reply); log('replied to', m.chatId.slice(0, -5), `(thinking ${tBrain - t0}ms, sending ${Date.now() - tBrain}ms)`); }
  },
});

// the assistant's own messages also show up in the Messages screen
const sendAsBot = async (chatId, text) => {
  const sent = await wa.send(chatId, text);
  inbox.record({ chatId, dir: 'out', by: 'bot', text });
  return sent;
};
// replies typed in the app can arrive while WhatsApp is still (re)connecting: give it a moment
const sendWhenReady = async (chatId, text) => {
  for (let i = 0; i < 60 && status.state !== 'connected'; i += 1) await new Promise((r) => setTimeout(r, 500));
  return wa.send(chatId, text);
};

const stopWatching = watchConfirmations({ db, log, send: sendAsBot });
const stopOutbox = inbox.watchOutbox({ send: sendWhenReady, onSent: (chatId) => agent.pauseFor(chatId) });
const heartbeat = setInterval(() => publish(), 120000);

// tidy up old de-duplication records once a day
const cleanup = async () => {
  const old = await db.collection('wa_messages').where('at', '<', new Date(Date.now() - 7 * 864e5).toISOString()).limit(400).get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));
};
cleanup().catch(() => {});
const cleaner = setInterval(() => cleanup().catch(() => {}), 864e5);

const shutdown = async () => {
  clearInterval(heartbeat); clearInterval(cleaner); stopWatching(); stopOutbox(); wa.stop();
  await Promise.all([agent.flush(), inbox.flush()]).catch(() => {});
  await publish({ state: 'offline', pairingCode: null }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// keep prices/FAQ and chat state in memory so a reply never waits on a database round trip
await knowledge.start().catch((e) => log('knowledge-live-failed', e.message));
await agent.warm().catch((e) => log('warm-failed', e.message));

log(`${config.name} — المساعد يبدأ (الرسائل تظهر بالموقع، والرد الآلي بالقوائم يُتحكم فيه من شاشة «الرسائل»)`);
await publish();
await wa.start();
