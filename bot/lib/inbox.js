// The Messages screen's side of the bot: every WhatsApp message is mirrored into Firestore so the staff can read it
// in the app, and replies typed in the app (collection `wa_outbox`) are sent from here through WhatsApp.
//   wa_threads/{digits}                 one per customer: last message, unread count
//   wa_threads/{digits}/messages/{id}   the messages (dir: 'in' | 'out', by: 'customer' | 'bot' | 'staff' | 'phone')
//   wa_outbox/{id}                      replies waiting to be sent (written by the app, removed once handled)
import { FieldValue } from 'firebase-admin/firestore';
import { phoneOfChat, chatOfPhone } from './booking.js';

export const MEDIA_TEXT = '📎 رسالة غير نصية (صوت / صورة / ملف) — افتحيها من واتساب';
const isAlreadyExists = (e) => e?.code === 6 || /ALREADY_EXISTS/.test(String(e?.message));

export function createInbox({ db, now = () => new Date(), log = () => {} }) {
  const threads = db.collection('wa_threads');
  let writes = Promise.resolve();                       // writes happen in order, in the background
  const queue = (fn) => { writes = writes.then(fn).catch((e) => log('inbox-write-failed', e.message)); return writes; };

  /** Saves one message and refreshes its thread. `by`: customer | bot | staff | phone. */
  function record({ chatId, dir, by, text, messageId = null, name = null, status = null, error = null }) {
    const key = phoneOfChat(chatId).slice(1);
    const at = now().toISOString();
    const body = String(text || '').slice(0, 2000);
    return queue(async () => {
      const col = threads.doc(key).collection('messages');
      const msg = { dir, by, text: body, at, ...(status ? { status } : {}), ...(error ? { error: String(error).slice(0, 200) } : {}) };
      if (messageId) {
        try { await col.doc(String(messageId).replace(/\W/g, '_')).create(msg); }
        catch (e) { if (isAlreadyExists(e)) return; throw e; }   // WhatsApp delivered it twice
      } else {
        await col.add(msg);
      }
      await threads.doc(key).set({
        phone: `+${key}`, chatId, ...(name ? { name } : {}),
        lastText: body.slice(0, 120), lastAt: at, lastDir: dir, lastBy: by,
        unread: dir === 'in' ? FieldValue.increment(1) : by === 'bot' ? FieldValue.increment(0) : 0,   // answering herself means she has seen it
      }, { merge: true });
    });
  }

  /** Sends what the staff typed in the app. Calls `send(chatId, text)` one at a time and records the outcome. */
  function watchOutbox({ send, onSent = () => {} }) {
    const col = db.collection('wa_outbox');
    const busy = new Set();
    let turn = Promise.resolve();

    const handle = async (doc) => {
      const claimed = await db.runTransaction(async (tx) => {
        const d = (await tx.get(doc.ref)).data();
        if (!d || d.status !== 'queued') return null;
        tx.update(doc.ref, { status: 'sending' });        // claimed: a second bot instance can't send it too
        return d;
      });
      if (!claimed) return;
      const chatId = chatOfPhone(claimed.phone);
      try {
        await send(chatId, claimed.text);
        await record({ chatId, dir: 'out', by: 'staff', text: claimed.text });
        onSent(chatId);
      } catch (e) {
        log('outbox-send-failed', e.message);
        await record({ chatId, dir: 'out', by: 'staff', text: claimed.text, status: 'failed', error: e.message });
      }
      await doc.ref.delete();
    };

    // a reply left "sending" by a crash is not sent again (it might have gone out): it's marked as failed instead
    const interrupted = async (doc) => {
      const d = doc.data();
      await record({ chatId: chatOfPhone(d.phone), dir: 'out', by: 'staff', text: d.text, status: 'failed', error: 'انقطع الإرسال' });
      await doc.ref.delete();
    };

    return col.onSnapshot((snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed' || busy.has(ch.doc.id)) continue;
        const status = ch.doc.data().status;
        if (status !== 'queued' && status !== 'sending') continue;
        busy.add(ch.doc.id);
        turn = turn.then(() => (status === 'queued' ? handle(ch.doc) : interrupted(ch.doc)))
          .catch((e) => log('outbox-failed', ch.doc.id, e.message));
        if (busy.size > 500) busy.delete(busy.values().next().value);   // ids stay remembered for a while: late snapshot events must not trigger a second send
      }
    }, (e) => log('outbox-watch-error', e));
  }

  return { record, watchOutbox, flush: () => writes };
}
