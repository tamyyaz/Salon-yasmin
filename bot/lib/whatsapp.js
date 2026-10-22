// Our own WhatsApp connection (Baileys): no middleman service. The salon's number is linked as a
// "linked device" (like WhatsApp Web) and this process reads/answers messages directly.
//
// Behaviour kept deliberately human-like and low-volume: it only replies to people who wrote first,
// shows "typing…" in proportion to the reply length, and never sends faster than one message per 2.5 s.
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = ['audioMessage', 'imageMessage', 'videoMessage', 'documentMessage'];

export const digitsOf = (jid) => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
export const chatIdOf = (jid) => `${digitsOf(jid)}@c.us`;
export const pnJidOf = (chatId) => `${digitsOf(chatId)}@s.whatsapp.net`;

const unwrap = (m) => m?.ephemeralMessage?.message ?? m?.viewOnceMessage?.message ?? m?.viewOnceMessageV2?.message ?? m;

/**
 * Turns a raw Baileys message into what the agent needs, or null when it's not a private chat message
 * worth handling (groups, status, reactions, protocol noise, or a "hidden" LID we can't map to a phone).
 */
export async function parseIncoming(msg, { sock, now = Date.now(), maxAgeMs = 6 * 3600e3 } = {}) {
  const key = msg?.key;
  if (!key?.remoteJid || !key.id || !msg.message) return null;
  let jid = key.remoteJid;
  if (jid.endsWith('@lid')) {                                    // privacy IDs: find the real phone number
    const pn = key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? key.remoteJidAlt
      : await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid).catch(() => null);
    if (!pn) return null;
    jid = pn;
  }
  if (!jid.endsWith('@s.whatsapp.net')) return null;             // groups, broadcasts, newsletters
  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) * 1000;
  if (ts && now - ts > maxAgeMs) return null;

  const m = unwrap(msg.message);
  const text = m?.conversation ?? m?.extendedTextMessage?.text ?? null;
  const hasMedia = MEDIA.some((k) => m?.[k]);
  if (text == null && !hasMedia) return null;
  return { jid: key.remoteJid, chatId: chatIdOf(jid), text: text ?? '', hasMedia, messageId: key.id, fromMe: !!key.fromMe, key };
}

export function createWhatsApp({
  baileys, authDir, onMessage, onStatus = () => {}, pairNumber = null, log = () => {}, logger, printQr = () => {},
  sleep = sleepDefault, random = Math.random,
}) {
  const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;
  let sock = null;
  let stopped = false;
  let attempt = 0;
  let pairingAsked = false;
  const sentIds = new Set();            // ids of messages we sent ourselves, so we don't treat the echo as the owner typing
  const jidByChat = new Map();          // reply to the exact JID the customer used (PN or LID)
  const queues = new Map();             // one message at a time per chat
  let lastSendAt = 0;

  const enqueue = (chatId, job) => {
    const next = (queues.get(chatId) || Promise.resolve()).then(job).catch((e) => log('handler-failed', chatId, e));
    queues.set(chatId, next);
    next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
    return next;
  };

  async function connect() {
    onStatus({ state: 'connecting' });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    sock = makeWASocket({
      auth: state, version, browser: Browsers.macOS('Desktop'), markOnlineOnConnect: false, syncFullHistory: false,
      printQRInTerminal: false, logger,
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        if (pairNumber && !state.creds?.registered && !pairingAsked) {
          pairingAsked = true;
          try { onStatus({ state: 'pairing', pairingCode: await sock.requestPairingCode(digitsOf(pairNumber)) }); }
          catch (e) { log('pairing-failed', e); pairingAsked = false; }
        } else if (!pairNumber) { printQr(u.qr); onStatus({ state: 'qr', qr: u.qr }); }
      }
      if (u.connection === 'open') { attempt = 0; pairingAsked = false; onStatus({ state: 'connected', number: digitsOf(sock.user?.id || '') }); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { stopped = true; onStatus({ state: 'logged_out' }); return; }
        if (stopped) return;
        onStatus({ state: 'offline' });
        const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(60000, 2000 * 2 ** attempt++);
        log('reconnecting in', wait, 'ms (code', code, ')');
        await sleep(wait);
        if (!stopped) connect().catch((e) => log('connect-failed', e));
      }
    });

    sock.ev.on('messages.upsert', ({ messages = [], type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        if (sentIds.has(msg.key?.id)) { sentIds.delete(msg.key.id); continue; }
        parseIncoming(msg, { sock }).then((m) => {
          if (!m) return;
          if (!m.fromMe) jidByChat.set(m.chatId, m.jid);
          if (m.fromMe && type === 'append') return;                  // history sync of old own messages
          return enqueue(m.chatId, async () => {
            if (!m.fromMe) sock.readMessages([m.key]).catch(() => {});      // don't wait for the receipt
            await onMessage(m);
          });
        }).catch((e) => log('parse-failed', e));
      }
    });
  }

  /** Sends with typing indicator and a minimum gap between messages. */
  async function send(chatId, text) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const jid = jidByChat.get(chatId) || pnJidOf(chatId);
    const gap = lastSendAt + 1200 - Date.now();
    if (gap > 0) await sleep(gap);
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await sleep(Math.min(2500, 350 + text.length * 10) + random() * 300);
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) sentIds.add(sent.key.id);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    lastSendAt = Date.now();
    return sent;
  }

  return {
    start: () => { stopped = false; return connect(); },
    stop: () => { stopped = true; try { sock?.end?.(undefined); } catch { /* already closed */ } },
    send,
    get socket() { return sock; },
  };
}
