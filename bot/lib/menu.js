// A rule-based assistant: no AI, no internet service, works from any country.
// It understands the common things customers ask (prices, address, hours, FAQ, booking) from the
// salon's own data and walks the customer through a booking step by step.
import { norm, keywords, mentions, isYes, isNo } from './arabic.js';
import { assistantName } from './knowledge.js';
import { BookingError } from './booking.js';
import { WEEKDAYS_AR, addDays, weekdayOf } from './time.js';

const FLOW_TTL_MS = 30 * 60e3;
const WEEKDAY = { احد: 0, اثنين: 1, اتنين: 1, تلاتاء: 2, ثلاثاء: 2, تلات: 2, ثلاث: 2, اربعاء: 3, اربع: 3, خميس: 4, جمعه: 5, سبت: 6 };

const W = {
  human: ['موظف', 'صاحبه الصالون', 'صاحبة', 'مديره', 'احكي مع', 'اتكلم مع', 'بدي احكي', 'بدي اتكلم', 'كلمو', 'شخص حقيقي', 'حدا يرد', 'بشري'],
  greet: ['مرحبا', 'مرحبتين', 'اهلا', 'اهلين', 'هلا', 'هلو', 'سلام', 'السلام', 'صباح', 'مساء الخير', 'مسا الخير', 'هاي', 'hi', 'hello', 'هالو', 'تحيه'],
  price: ['سعر', 'اسعار', 'بكم', 'بكام', 'قديش', 'كم سعر', 'كم بتاخد', 'كم الاجار', 'تسعير', 'تكلف', 'كلفه', 'كلفة', 'بتكلف', 'تعرفه', 'اسعاركم'],
  where: ['وين', 'موقع', 'عنوان', 'لوكيشن', 'location', 'خريطه', 'مكانكم', 'كيف اوصل', 'اوصلكم', 'فين', 'عنوانكم'],
  hours: ['دوام', 'ساعات', 'مفتوح', 'بتفتح', 'بتسكر', 'بتفتحو', 'بتسكرو', 'مواعيد العمل', 'متى بتفتح', 'الساعه كم', 'اوقات'],
  pay: ['دفع', 'كاش', 'كارت', 'فيزا', 'تحويل', 'نقدا', 'بطاقه', 'الدفع'],
  mine: ['حجوزاتي', 'مواعيدي', 'موعدي', 'حجزي', 'شو حجزت', 'عندي موعد', 'مواعيد عندي'],
  cancel: ['الغي', 'الغاء موعد', 'الغاء حجز', 'الغاء الموعد', 'الغاء الحجز', 'كنسل', 'بدي الغي', 'الغيلي', 'الغاء'],
  avail: ['فاضي', 'فاضيه', 'متاح', 'متاحه', 'شاغر', 'فراغ', 'اوقات فاضيه'],
  book: ['موعد', 'حجز', 'احجز', 'احجزلي', 'بدي احجز', 'حجزلي', 'بدي موعد', 'اريد موعد', 'اريد حجز'],
};

export function createMenu({ booking, config }) {
  const money = (s) => (s.price != null ? `${s.price} ${config.currency}` : 'حسب الاتفاق');
  const slotsList = (slots) => slots.join('  •  ');
  const bad = (message) => ({ reject: message });

  const menuText = (kb) => `أهلاً فيكي في ${config.name} 🌸\nأنا ${assistantName(kb || { info: {} }, config)}، مساعدتك الافتراضية.
شو بدك؟ اكتبي الرقم:
1️⃣ الأسعار
2️⃣ حجز موعد
3️⃣ العنوان وساعات الدوام
4️⃣ حجوزاتي
5️⃣ التحدث مع الصالون`;

  const pricesText = (kb, only) => {
    const list = only || kb.services;
    if (!list.length) return 'ما عندي قائمة أسعار حالياً، رح أسأل الصالون وبرجعلك 🌸';
    const body = list.map((s) => `• ${s.name}: ${money(s)}${s.note ? ` (${s.note})` : ''}`).join('\n');
    return `${only ? '' : 'أسعارنا 🌸\n'}${body}\n\nللحجز اكتبي: *حجز*`;
  };

  const hoursText = (kb) => {
    const closed = config.closedWeekdays.length ? `\nالعطلة: ${config.closedWeekdays.map((d) => WEEKDAYS_AR[d]).join('، ')}` : '';
    return `🕘 ${kb.info.hours_text || `دوامنا من ${config.openHour}:00 حتى ${config.closeHour}:00`}${kb.info.hours_text ? '' : closed}`;
  };

  const whereText = (kb) => {
    const parts = [];
    if (kb.info.address) parts.push(`📍 ${kb.info.address}`);
    if (kb.info.maps_url) parts.push(kb.info.maps_url);
    parts.push(hoursText(kb));
    return parts.join('\n');
  };

  // ---------- parsing ----------
  function parseDay(n, today, { bare = false } = {}) {
    if (/(^| )بعد (بكر[اه]?|غد|غدا)( |$)/.test(n)) return addDays(today, 2);
    if (/(^| )(بكر[اه]?|غدا|غد|باكر)( |$)/.test(n)) return addDays(today, 1);
    if (/(^| )اليوم( |$)/.test(n)) return today;
    for (const t of n.split(' ')) {
      const dow = WEEKDAY[t.replace(/^(ال|يوم)/, '')];
      if (dow !== undefined) return addDays(today, (dow - weekdayOf(today) + 7) % 7);
    }
    let m = n.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = n.match(/(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?/);
    if (m) {
      const [y0, mo0] = today.split('-').map(Number);
      let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : y0;
      const date = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (!m[3] && date < today) year += 1;                         // "5/1" said in December means next January
      return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    m = bare ? n.match(/^(?:يوم )?(\d{1,2})$/) : null;
    if (m) {
      const [y, mo] = today.split('-').map(Number);
      const make = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const here = make(y, mo);
      return here >= today ? here : (mo === 12 ? make(y + 1, 1) : make(y, mo + 1));
    }
    return null;
  }

  /** "11", "11:30", "3 العصر", "10 صباحا" → one of the salon's slot times, or null. */
  function parseTime(n, slots) {
    const m = n.match(/(\d{1,2})(?:[:.](\d{2}))?/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = m[2] ?? '00';
    if (h > 24) return null;
    const pm = /(مساء|عصر|ظهر|ليل|م$| م )/.test(n);
    const am = /(صباح|صبح|ص$| ص )/.test(n);
    const candidates = [h, h + 12].filter((x) => x < 24).map((x) => `${String(x).padStart(2, '0')}:${min}`).filter((t) => slots.includes(t));
    const preferred = candidates.filter((t) => (pm ? Number(t.slice(0, 2)) >= 12 : am ? Number(t.slice(0, 2)) < 12 : true));
    return (preferred.length ? preferred : candidates)[0] ?? null;
  }

  function matchServices(n, services) {
    const words = keywords(n);
    const scored = services.map((s) => {
      const sw = keywords(s.name);
      const hit = sw.filter((t) => words.some((w) => similar(w, t))).length;
      return { s, score: sw.length ? hit / sw.length : 0, hit };
    }).filter((x) => x.hit > 0);
    const best = Math.max(0, ...scored.map((x) => x.score));
    return scored.filter((x) => x.score === best).map((x) => x.s);
  }

  // same word allowing for plural/feminine endings and a leading letter or two
  const similar = (a, b) => {
    if (a === b || a.includes(b) || b.includes(a)) return true;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return Math.min(a.length, b.length) >= 4 && i >= 4 && i >= 0.7 * Math.min(a.length, b.length);
  };

  function matchFaq(n, faq = []) {
    const words = new Set(keywords(n));
    let best = null;
    for (const f of faq) {
      const qw = keywords(f.q);
      if (!qw.length) continue;
      const hit = qw.filter((t) => [...words].some((w) => similar(w, t))).length;
      const score = hit / qw.length;
      if (hit >= 1 && score >= 0.6 && (!best || score > best.score)) best = { f, score };
    }
    return best?.f ?? null;
  }

  // ---------- booking flow ----------
  const summary = (d) => `📝 طلبك:\n• الخدمة: ${d.service}\n• اليوم: ${WEEKDAYS_AR[weekdayOf(d.date)]} ${d.date}\n• الساعة: ${d.time}\n• الاسم: ${d.name}`;

  async function next(flow, ctx) {
    const d = flow.data;
    if (!d.service) {
      flow.step = 'service';
      return `أي خدمة بدك؟ اكتبي رقمها أو اسمها:\n${ctx.kb.services.map((s, i) => `${i + 1}) ${s.name} — ${money(s)}`).join('\n')}`;
    }
    if (!d.date) { flow.step = 'date'; return 'أي يوم بيناسبك؟ اكتبي: اليوم، بكرا، اسم اليوم، أو تاريخ مثل 25/10'; }
    if (!d.time) {
      flow.step = 'time';
      const av = await booking.checkAvailability({ date: d.date });
      d.slots = av.free_slots;
      if (!d.slots.length) { delete d.date; flow.step = 'date'; return `ما في أوقات فاضية يوم ${av.weekday}. اكتبي يوم تاني.`; }
      return `الأوقات الفاضية يوم ${av.weekday} ${d.date}:\n${slotsList(d.slots)}\n\nاكتبي الساعة اللي بتناسبك (مثلاً 11 أو 3:30).`;
    }
    if (!d.name) { flow.step = 'name'; return 'شو اسمك الكريم؟'; }
    flow.step = 'confirm';
    return `${summary(d)}\n\nاكتبي *نعم* للتأكيد أو *لا* للإلغاء.`;
  }

  /** Takes one customer message while a flow is open; returns the reply (and may reset the flow). */
  async function inFlow(flow, n, raw, ctx) {
    const d = flow.data;
    try {
      switch (flow.step) {
        case 'service': {
          const idx = /^\d+$/.test(n) ? Number(n) - 1 : -1;
          const hit = idx >= 0 ? [ctx.kb.services[idx]].filter(Boolean) : matchServices(n, ctx.kb.services);
          if (hit.length === 1) { d.service = hit[0].name; return next(flow, ctx); }
          if (hit.length > 1) return `قصدك أي وحدة؟\n${hit.map((s) => `• ${s.name}`).join('\n')}\nاكتبي الاسم كامل.`;
          return bad(`ما لقيت هالخدمة. اكتبي رقم من القائمة:\n${ctx.kb.services.map((s, i) => `${i + 1}) ${s.name}`).join('\n')}`);
        }
        case 'date': {
          const date = parseDay(n, ctx.clock.date, { bare: true });
          if (!date) return bad('ما فهمت اليوم 🙏 اكتبي مثلاً: بكرا، السبت، أو 25/10');
          await booking.checkAvailability({ date });                         // throws for closed/past/too far
          d.date = date;
          return next(flow, ctx);
        }
        case 'time': {
          const time = parseTime(n, booking.allSlots());
          if (!time) return bad(`اكتبي الساعة بشكل واضح من هالأوقات:\n${slotsList(d.slots)}`);
          if (!d.slots.includes(time)) return `الساعة ${time} مش فاضية 🙏 الأوقات المتاحة:\n${slotsList(d.slots)}`;
          d.time = time;
          return next(flow, ctx);
        }
        case 'name': {
          const name = raw.trim().replace(/^(اسمي|انا)\s+/, '').slice(0, 40);
          if (name.length < 2 || /^\d+$/.test(name)) return bad('اكتبي اسمك من فضلك 🌸');
          d.name = name; ctx.rememberName(name);
          return next(flow, ctx);
        }
        case 'confirm': {
          if (/^(اسمي|الاسم)\s/.test(n)) { d.name = raw.trim().replace(/^(اسمي|الاسم)\s+/, '').slice(0, 40); return next(flow, ctx); }
          if (isNo(n)) { ctx.reset(); return 'تمام، ألغيت الطلب. اكتبي *قائمة* بأي وقت 🌸'; }
          if (!isYes(n)) return bad('اكتبي *نعم* للتأكيد أو *لا* للإلغاء.');
          const done = await booking.create({ phone: ctx.phone, customer_name: d.name, date: d.date, time: d.time, service: d.service });
          ctx.reset();
          return `تم استلام طلبك ✅\n${WEEKDAYS_AR[weekdayOf(done.date)]} ${done.date} الساعة ${done.time}\nالموعد *بانتظار تأكيد الصالون*، وبتوصلك رسالة هون لما يتأكد 🌸`;
        }
        case 'cancel_pick': {
          const i = Number(n) - 1;
          const b = d.bookings[i];
          if (!b) return bad(`اكتبي رقم الموعد اللي بدك تلغيه:\n${d.bookings.map((x, k) => `${k + 1}) ${x.date} ${x.time} — ${x.service || ''}`).join('\n')}`);
          d.pick = b.booking_id; d.pickText = `${b.date} الساعة ${b.time}`;
          flow.step = 'cancel_confirm';
          return `ألغي موعد ${d.pickText}؟ اكتبي *نعم* أو *لا*.`;
        }
        case 'cancel_confirm': {
          if (isNo(n)) { ctx.reset(); return 'تمام، ما ألغيت شي 🌸'; }
          if (!isYes(n)) return bad('اكتبي *نعم* أو *لا*.');
          await booking.cancel({ phone: ctx.phone, booking_id: d.pick });
          ctx.reset();
          return `تم إلغاء موعد ${d.pickText} ✅`;
        }
        default: return null;
      }
    } catch (e) {
      if (e instanceof BookingError) {
        if (flow.step === 'confirm') { delete d.time; return `${e.message}\n\n${await next(flow, ctx)}`; }
        return `${e.message} 🙏`;
      }
      throw e;
    }
  }

  async function startBooking(n, ctx) {
    const flow = { step: null, data: {}, at: ctx.stamp() };
    const hit = matchServices(n, ctx.kb.services);
    if (hit.length === 1) flow.data.service = hit[0].name;
    if (ctx.savedName) flow.data.name = ctx.savedName;
    ctx.flow = flow;
    const date = /^[1-5]$/.test(n) ? null : parseDay(n, ctx.clock.date);
    if (date) {
      try {
        const { free_slots: slots } = await booking.checkAvailability({ date });
        flow.data.date = date;
        const withoutDate = n.replace(/\d{1,4}[/\-.]\d{1,2}([/\-.]\d{2,4})?/g, ' ');
        const time = /\d/.test(withoutDate) ? parseTime(withoutDate, booking.allSlots()) : null;
        if (time && slots.includes(time)) flow.data.time = time;
      } catch (e) {
        if (!(e instanceof BookingError)) throw e;
        flow.step = 'date';
        return `${e.message} 🙏\nاكتبي يوم تاني.`;
      }
    }
    return next(flow, ctx);
  }

  /**
   * One customer message in, { reply, flow, handoff? } out.
   * ctx: { phone, text, flow, kb, clock, savedName } — flow is the saved conversation step (or null).
   */
  async function reply(input) {
    const n = norm(input.text);
    const nowMs = input.nowMs ?? Date.now();
    const stamp = () => new Date(nowMs).toISOString();
    let flow = input.flow && nowMs - new Date(input.flow.at).getTime() < FLOW_TTL_MS ? input.flow : null;
    let rememberedName = input.savedName;
    const ctx = {
      ...input, flow,
      get savedName() { return rememberedName; },
      rememberName: (v) => { rememberedName = v; },
      reset: () => { ctx.flow = null; },
      stamp,
    };
    const out = (text, extra = {}) => ({ reply: text, flow: ctx.flow ? { ...ctx.flow, at: stamp() } : null, savedName: rememberedName, ...extra });

    if (/^(قائمه|قايمه|القائمه|القايمه|menu|رجوع|ابدا|0)$/.test(n)) { ctx.flow = null; return out(menuText(input.kb)); }
    if (flow && /^(الغاء|الغي|كنسل|cancel|خروج)$/.test(n)) { ctx.flow = null; return out('تمام، رجعنا للقائمة 🌸\n' + menuText(input.kb)); }

    const num = /^[1-5]$/.test(n) ? n : null;
    const faq = num ? null : matchFaq(n, input.kb.info.faq);
    const globalIntent = !!faq || mentions(n, [...W.price, ...W.where, ...W.hours, ...W.human, ...W.pay]);

    let rejected = null;
    if (flow) {
      const res = await inFlow(flow, n, input.text, ctx);
      if (typeof res === 'string') return out(res);
      if (res?.reject) {
        if (!globalIntent) return out(res.reject);       // otherwise answer the question below and keep the booking open
        rejected = res.reject;
      }
    }
    const keepFlow = flow && ctx.flow ? '\n\nنكمّل حجزك؟ اكتبي *قائمة* لإلغائه.' : '';

    if (num === '5' || mentions(n, W.human)) {
      ctx.flow = null;
      return out('تمام 🌸 بلّغت الصالون وبيتواصلوا معك بأقرب وقت.', { handoff: 'الزبونة بدها تحكي مع الصالون' });
    }
    if (faq) return out(faq.a + keepFlow);
    if (num === '1' || (mentions(n, W.price) && !mentions(n, W.cancel))) {
      const hit = num ? [] : matchServices(n, input.kb.services);
      return out(pricesText(input.kb, hit.length && hit.length < input.kb.services.length ? hit : null) + keepFlow);
    }
    if (mentions(n, W.cancel) && /موعد|حجز|الغي|كنسل/.test(n)) {
      const { bookings } = await booking.myBookings({ phone: input.phone });
      if (!bookings.length) return out('ما عندك حجوزات قادمة لإلغائها.');
      ctx.flow = { step: 'cancel_pick', data: { bookings }, at: stamp() };
      return out(`أي موعد بدك تلغي؟ اكتبي رقمه:\n${bookings.map((b, i) => `${i + 1}) ${b.date} الساعة ${b.time} — ${b.service || ''}`).join('\n')}`);
    }
    if (num === '4' || mentions(n, W.mine)) {
      const { bookings } = await booking.myBookings({ phone: input.phone });
      ctx.flow = null;
      return out(bookings.length ? `حجوزاتك:\n${bookings.map((b) => `• ${b.date} الساعة ${b.time} — ${b.service || ''} (${b.status})`).join('\n')}` : 'ما عندك حجوزات قادمة. لحجز موعد اكتبي *حجز* 🌸');
    }
    if (num === '2' || mentions(n, W.avail) || (mentions(n, W.book) && !flow)) return out(await startBooking(n, ctx));
    if (num === '3' || mentions(n, W.where) || mentions(n, W.hours)) {
      const wantsAddress = num === '3' || mentions(n, W.where);
      return out((wantsAddress ? whereText(input.kb) : hoursText(input.kb)) + keepFlow);
    }
    if (mentions(n, W.pay) && input.kb.info.payment) return out(`💳 ${input.kb.info.payment}${keepFlow}`);
    if (mentions(n, W.greet) && n.split(' ').length <= 4 && !flow) return out(menuText(input.kb));
    if (rejected) return out(rejected);

    // not understood: help once, then pass to the salon
    const misses = (input.misses || 0) + 1;
    if (misses >= 2) return out('ما قدرت أفهم طلبك 🙏 بلّغت الصالون وبيتواصلوا معك بأقرب وقت.', { handoff: `رسالة ما فهمها المساعد: «${String(input.text).slice(0, 120)}»`, misses: 0, unknown: true });
    return out(`ما فهمت قصدك 🙏\n${menuText(input.kb)}`, { misses, unknown: true });
  }

  return { reply, menuText, parseDay, parseTime };
}
