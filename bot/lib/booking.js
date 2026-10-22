// What the assistant is allowed to do. Every function takes the customer's phone from the WhatsApp
// chat itself — the model can never pick another customer's number.
import { WEEKDAYS_AR, localNow, weekdayOf, isValidDate, addDays, minutesOf } from './time.js';

const HOLDING = ['pending', 'booked', 'came'];   // statuses that occupy a slot
const OPEN = ['pending', 'booked'];              // statuses a customer may still change

/** Problems the model may be told about verbatim (bad date, slot taken…). Anything else stays generic. */
export class BookingError extends Error {}

export const phoneOfChat = (chatId) => `+${String(chatId).replace(/@.*$/, '').replace(/\D/g, '')}`;
export const chatOfPhone = (phone) => `${String(phone).replace(/\D/g, '')}@c.us`;

export function createBooking({ db, config, now = () => new Date() }) {
  const appts = db.collection('appointments');
  const clock = () => localNow(config.timezone, now());

  function allSlots() {
    const out = [];
    for (let m = config.openHour * 60; m <= config.closeHour * 60 - config.slotMinutes; m += config.slotMinutes) {
      out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    return out;
  }

  /** Throws a short, model-readable Error when the date can't be booked at all. */
  function checkDate(date) {
    const t = clock();
    if (!isValidDate(date)) throw new BookingError('التاريخ لازم يكون بصيغة YYYY-MM-DD');
    if (date < t.date) throw new BookingError('هاد التاريخ مضى');
    if (date > addDays(t.date, config.maxDaysAhead)) throw new BookingError(`بنحجز بس خلال ${config.maxDaysAhead} يوم من اليوم`);
    if (config.closedWeekdays.includes(weekdayOf(date))) throw new BookingError(`الصالون مسكّر يوم ${WEEKDAYS_AR[weekdayOf(date)]}`);
  }

  const bookable = (date, time) => {
    const t = clock();
    return date !== t.date || minutesOf(time) >= minutesOf(t.time) + config.minLeadMinutes;
  };

  async function takenTimes(date, tx) {
    const q = appts.where('date', '==', date);
    const snap = await (tx ? tx.get(q) : q.get());
    return new Set(snap.docs.filter((d) => HOLDING.includes(d.data().status)).map((d) => d.data().time));
  }

  async function checkAvailability({ date }) {
    checkDate(date);
    const taken = await takenTimes(date);
    const free = allSlots().filter((t) => !taken.has(t) && bookable(date, t));
    return { date, weekday: WEEKDAYS_AR[weekdayOf(date)], free_slots: free, note: free.length ? undefined : 'ما في أوقات فاضية بهاليوم' };
  }

  async function activeFor(phone) {
    const snap = await appts.where('phone', '==', phone).get();
    const today = clock().date;
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => OPEN.includes(a.status) && a.date >= today);
  }

  async function myBookings({ phone }) {
    const list = await activeFor(phone);
    return { bookings: list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map((a) => ({ booking_id: a.id, date: a.date, time: a.time, service: a.service, status: a.status === 'pending' ? 'بانتظار تأكيد الصالون' : 'مؤكد' })) };
  }

  async function create({ phone, customer_name, date, time, service, note }) {
    const name = String(customer_name || '').trim().slice(0, 80);
    if (!name) throw new BookingError('لازم اسم الزبون');
    checkDate(date);
    if (!allSlots().includes(time)) throw new BookingError(`الوقت لازم يكون من هالأوقات: ${allSlots().join(', ')}`);
    if (!bookable(date, time)) throw new BookingError('هاد الوقت قريب جداً أو مضى، اختاروا وقت أبعد');
    if ((await activeFor(phone)).length >= config.maxActivePerCustomer) {
      throw new BookingError(`عندك ${config.maxActivePerCustomer} حجوزات مفتوحة، لازم تلغي واحد أو تستنى لحد ما تمر`);
    }
    const known = config.services.find((s) => s.name === service);
    const ref = appts.doc();
    // a transaction re-checks the slot, so two customers can't take the same time
    await db.runTransaction(async (tx) => {
      if ((await takenTimes(date, tx)).has(time)) throw new BookingError('هاد الوقت انحجز للتو، اختاروا وقت تاني');
      tx.create(ref, {
        client_name: name, phone, date, time, service: String(service || '').slice(0, 120), price: known?.price ?? 0,
        status: 'pending', walk_in: false, note: String(note || '').slice(0, 500), created_at: now().toISOString(),
        payments: [], due: 0, source: 'whatsapp', wa_notified: 'pending',
      });
    });
    return { ok: true, booking_id: ref.id, status: 'بانتظار تأكيد الصالون', date, time, weekday: WEEKDAYS_AR[weekdayOf(date)] };
  }

  async function cancel({ phone, booking_id }) {
    const ref = appts.doc(String(booking_id));
    const snap = await ref.get();
    const a = snap.exists ? snap.data() : null;
    if (!a || a.phone !== phone || !OPEN.includes(a.status)) throw new BookingError('ما لقيت هالحجز بين حجوزاتك');
    await ref.update({ status: 'cancelled', wa_notified: 'cancelled', note: `${a.note ? `${a.note} — ` : ''}ألغاه الزبون عبر واتساب` });
    return { ok: true, cancelled: { date: a.date, time: a.time } };
  }

  /** Leaves a pinned note for the salon and tells the agent to stay quiet on this chat for a while. */
  async function handoff({ phone, reason }) {
    await db.collection('notes').add({
      text: `📲 واتساب ${phone}: بدو يحكي مع الصالون — ${String(reason || 'بدون سبب').slice(0, 300)}`,
      pinned: true, done: false, created_at: now().toISOString(),
    });
    return { ok: true };
  }

  return { allSlots, checkAvailability, myBookings, create, cancel, handoff, clock };
}
