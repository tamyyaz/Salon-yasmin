// Tells the customer when the salon confirms or declines a request made through WhatsApp.
// Works by watching Firestore, so it also catches changes made while the bot was offline.
import { chatOfPhone } from './booking.js';
import { WEEKDAYS_AR, weekdayOf } from './time.js';

export function messageFor(a) {
  const when = `${WEEKDAYS_AR[weekdayOf(a.date)]} ${a.date} الساعة ${a.time}`;
  if (a.status === 'booked') return `تم تأكيد موعدك ✅\n${when}${a.service ? `\nالخدمة: ${a.service}` : ''}\nبنستناكِ 🌸`;
  return `عذراً، ما قدرنا نأكد موعد ${when} 🙏\nإذا بدك نختار وقت تاني ابعتيلنا.`;
}

export function watchConfirmations({ db, send, now = () => new Date(), log = () => {} }) {
  const col = db.collection('appointments');
  return col.where('source', '==', 'whatsapp').onSnapshot((snap) => {
    for (const doc of snap.docs) {
      const a = doc.data();
      if (!['booked', 'cancelled'].includes(a.status) || a.wa_notified === a.status) continue;
      if (a.date < now().toISOString().slice(0, 10)) continue;           // old news
      // claim it first so two bot instances can't both send
      col.firestore.runTransaction(async (tx) => {
        const fresh = (await tx.get(doc.ref)).data();
        if (!fresh || fresh.wa_notified === fresh.status) return false;
        tx.update(doc.ref, { wa_notified: fresh.status });
        return fresh;
      }).then(async (fresh) => {
        if (fresh) await send(chatOfPhone(fresh.phone), messageFor(fresh));
      }).catch((e) => log('notify-failed', doc.id, e));
    }
  }, (e) => log('notify-watch-error', e));
}
