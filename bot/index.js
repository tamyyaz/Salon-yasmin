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
import { createGemini } from './lib/gemini.js';
import { createBooking } from './lib/booking.js';
import { createAgent } from './lib/agent.js';
import { watchConfirmations } from './lib/notify.js';
import { createWhatsApp } from './lib/whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, '.env')); } catch { /* variables may come from the system instead */ }

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(stamp(), ...a);
const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

if (!process.env.GEMINI_API_KEY) fail('ضع GEMINI_API_KEY في bot/.env (من https://aistudio.google.com/apikey)');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT) {
  fail('ضع GOOGLE_APPLICATION_CREDENTIALS (مسار ملف مفتاح حساب الخدمة) في bot/.env');
}

const db = openDb({ projectId: web.firebase.projectId });
const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY });
const booking = createBooking({ db, config });
const agent = createAgent({ db, gemini, config, booking, log });
const statusRef = db.collection('bot_status').doc('main');
const startedAt = new Date().toISOString();
let status = { state: 'connecting' };

// the app shows this: green when fresh and connected, so the owner knows if the bot silently dropped
const publish = (patch = {}) => {
  status = { ...status, ...patch };
  const doc = { state: status.state, pairingCode: status.pairingCode ?? null, number: status.number ?? null, startedAt, updatedAt: new Date().toISOString(), model: gemini.model };
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
    publish({ pairingCode: null, ...s });
  },
  onMessage: async (m) => {
    if (m.fromMe) { await agent.handle({ chatId: m.chatId, fromMe: true, messageId: m.messageId }); return; }
    const reply = await agent.handle({ chatId: m.chatId, text: m.text, messageId: m.messageId });
    if (reply) { await wa.send(m.chatId, reply); log('replied to', m.chatId.slice(0, -5)); }
  },
});

const stopWatching = watchConfirmations({ db, log, send: (chatId, text) => wa.send(chatId, text) });
const heartbeat = setInterval(() => publish(), 120000);

// tidy up old de-duplication records once a day
const cleanup = async () => {
  const old = await db.collection('wa_messages').where('at', '<', new Date(Date.now() - 7 * 864e5).toISOString()).limit(400).get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));
};
cleanup().catch(() => {});
const cleaner = setInterval(() => cleanup().catch(() => {}), 864e5);

const shutdown = async () => {
  clearInterval(heartbeat); clearInterval(cleaner); stopWatching(); wa.stop();
  await publish({ state: 'offline', pairingCode: null }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`${config.name} — المساعد يبدأ (${gemini.model})`);
await publish();
await wa.start();
