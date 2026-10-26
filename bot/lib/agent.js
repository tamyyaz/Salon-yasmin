// The automatic assistant: guards (duplicates, rate limits, human takeover) + the rule-based menu.
// It can be switched off in the app (settings/salon.auto_reply = false): then people answer from the Messages screen.
import { phoneOfChat } from './booking.js';
import { createKnowledge } from './knowledge.js';
import { createMenu } from './menu.js';

const MAX_TEXT = 800;
const HOURLY_LIMIT = 25;          // messages one customer may send per hour
const HANDOFF_MINUTES = Number(process.env.HANDOFF_PAUSE_MINUTES ?? 30);   // silence after a hand-off to the salon
const OWNER_REPLY_MINUTES = Number(process.env.OWNER_PAUSE_MINUTES ?? 10);  // silence after the owner types in the chat herself (0 = never pause)

export function createAgent({
  db, config, booking, knowledge = createKnowledge({ db, config }), menu = createMenu({ booking, config }),
  now = () => new Date(), log = () => {},
}) {
  const chats = db.collection('wa_chats');

  // ---- in-memory state: replies must not wait for the network ----
  // Chat state lives in memory while the bot runs and is saved to Firestore in the background (write-behind).
  const mem = new Map();          // phone -> chat state
  const memAt = new Map();        // phone -> when it was last read from Firestore
  const seen = new Set();         // message ids already handled (WhatsApp can deliver one twice)
  let writes = Promise.resolve();

  const persist = (ref, patch) => {
    writes = writes.then(() => ref.set(patch, { merge: true })).catch((e) => log('save-failed', e.message));
    return writes;
  };
  const setChat = (phone, ref, patch) => { mem.set(phone, { ...(mem.get(phone) || {}), ...patch }); return persist(ref, patch); };
  async function getChat(phone, ref, nowMs) {
    const cached = mem.get(phone);
    // a paused chat is re-read now and then so `npm run resume` (done from another terminal) takes effect
    if (cached && !((cached.humanUntil || 0) > nowMs && nowMs - (memAt.get(phone) || 0) > 15000)) return cached;
    const data = (await ref.get()).data() || {};
    mem.set(phone, data); memAt.set(phone, nowMs);
    return data;
  }
  const alreadySeen = (id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    db.collection('wa_messages').doc(String(id).replace(/\W/g, '_')).create({ at: new Date().toISOString() }).catch(() => {});
    return false;
  };

  /** Loads all chat states and recent message ids once, so even a customer's first message needs no lookup. */
  async function warm() {
    const [chatSnap, msgSnap] = await Promise.all([
      db.collection('wa_chats').limit(5000).get(),
      db.collection('wa_messages').where('at', '>', new Date(Date.now() - 3600e3).toISOString()).limit(5000).get(),
    ]);
    chatSnap.docs.forEach((d) => { mem.set(d.id, d.data()); memAt.set(d.id, Date.now()); });
    msgSnap.docs.forEach((d) => seen.add(d.id));
    return { chats: chatSnap.size, messages: msgSnap.size };
  }

  async function handle({ chatId, text, messageId, fromMe = false }) {
    if (!String(chatId).endsWith('@c.us')) { log('skipped: not a private chat', chatId); return null; }   // no groups, no status/broadcast
    const phone = phoneOfChat(chatId);
    const key = phone.slice(1);
    const chatRef = chats.doc(key);
    const t = now();
    const t0 = Date.now();

    if (messageId && alreadySeen(messageId)) { log('skipped: duplicate delivery', messageId); return null; }
    if (fromMe) {                                                        // the owner is chatting herself: step back
      if (OWNER_REPLY_MINUTES > 0) {
        setChat(key, chatRef, { humanUntil: t.getTime() + OWNER_REPLY_MINUTES * 60e3 });
        log(`you typed in this chat → assistant stays quiet with ${phone} for ${OWNER_REPLY_MINUTES} min (run: npm run resume)`);
      }
      return null;
    }
    const [chat, kbResult] = await Promise.all([getChat(key, chatRef, t.getTime()), knowledge.load().catch((e) => e)]);
    const tPrep = Date.now() - t0;
    if (!(kbResult instanceof Error) && kbResult.info?.auto_reply === false) return null;     // switched off in the app: people answer from the Messages screen
    if ((chat.humanUntil || 0) > t.getTime()) {
      log(`skipped: assistant is paused for ${phone} until ${new Date(chat.humanUntil).toISOString()} (you typed in the chat, or a hand-off) — run: npm run resume`);
      return null;
    }

    // per-customer rate limit (the counters are saved together with the rest of the state)
    const windowFresh = chat.windowStart && t.getTime() - chat.windowStart < 3600e3;
    const count = (windowFresh ? chat.count || 0 : 0) + 1;
    const rate = { windowStart: windowFresh ? chat.windowStart : t.getTime(), count };
    if (count > HOURLY_LIMIT) {
      setChat(key, chatRef, rate);
      log('rate-limited', phone);
      return count === HOURLY_LIMIT + 1 ? 'وصلتي للحد الأقصى من الرسائل هالساعة، رح نرد عليك قريباً 🌸' : null;
    }

    const clean = String(text || '').trim().slice(0, MAX_TEXT);
    if (!clean) return 'ممكن تكتبيلي رسالتك كتابة؟ 🌸';

    if (kbResult instanceof Error) {
      log('knowledge-failed', kbResult);
      await booking.handoff({ phone, reason: 'تعذّر على المساعد قراءة بيانات الصالون (خلل تقني)' }).catch(() => {});
      return 'عذراً، صار عندي خلل بسيط 🙏 رح يتواصل معك الصالون بأقرب وقت.';
    }
    const kb = kbResult;

    let reply = null;
    let flow = chat.flow ?? null;
    let savedName = chat.name ?? null;
    let misses = chat.misses || 0;
    let handoff = null;

    const askMenu = async () => {
      try {
        const r = await menu.reply({ phone, text: clean, flow, kb, clock: booking.clock(), nowMs: t.getTime(), savedName, misses });
        savedName = r.savedName ?? savedName;
        return r;
      } catch (e) {
        log('menu-failed', e);
        await booking.handoff({ phone, reason: 'تعذّر على المساعد الرد (خلل تقني)' }).catch(() => {});
        return { reply: 'عذراً، صار عندي خلل بسيط 🙏 رح يتواصل معك الصالون بأقرب وقت.' };
      }
    };

    const tBrain0 = Date.now();
    const menuAnswer = await askMenu();
    if (menuAnswer) {
      ({ reply, flow, handoff } = menuAnswer);
      misses = menuAnswer.misses ?? 0;
    }
    if (handoff) {
      await booking.handoff({ phone, reason: handoff });
      setChat(key, chatRef, { humanUntil: t.getTime() + HANDOFF_MINUTES * 60e3 });
    }

    setChat(key, chatRef, {                                              // saved in the background: the reply doesn't wait for it
      ...rate,
      flow: flow ?? null, name: savedName ?? null, misses, lastSeen: t.toISOString(),
    });
    log(`timing: prep=${tPrep}ms brain=${Date.now() - tBrain0}ms total=${Date.now() - t0}ms`);
    return reply.slice(0, 1500);
  }

  return {
    handle, warm,
    /** The salon answered the customer herself (from the app): stay quiet in that chat for a while. */
    pauseFor(chatId) {
      if (OWNER_REPLY_MINUTES <= 0) return;
      const key = phoneOfChat(chatId).slice(1);
      setChat(key, chats.doc(key), { humanUntil: now().getTime() + OWNER_REPLY_MINUTES * 60e3 });
    },
    /** Waits for background saves (used by tests and on shutdown). */
    flush: () => writes,
    /** Forget cached chat state, e.g. after it was changed from outside (`npm run resume`). */
    invalidate: () => { mem.clear(); memAt.clear(); },
  };
}
