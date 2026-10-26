// Pure salon logic: validation, balances, client ledger, stats.
// No Firebase or DOM in here so it can be unit-tested directly.

// `pending` = requested by a customer (e.g. through the WhatsApp assistant), waiting for the salon to confirm
export const STATUSES = ['pending', 'booked', 'came', 'no_show', 'cancelled'];
const OWING = ['booked', 'came']; // cancelled / no-show appointments never count as money owed

// ---------- local-date helpers (the salon thinks in the tablet's own calendar) ----------
export const ymd = (d) => {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };

export class ValidationError extends Error {}
const bad = (msg) => new ValidationError(msg);

export const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const normPhone = (p) => str(p, 30).replace(/[^\d+]/g, '');
const round2 = (n) => Math.round(n * 100) / 100;

export function money(v, field) {
  const n = Number(v === '' || v == null ? 0 : v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw bad(`قيمة غير صالحة: ${field}`);
  return round2(n);
}

/** Validates an appointment form body. `partial` allows PATCH-style bodies. */
export function parseAppointment(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('client_name')) {
    out.client_name = str(body.client_name, 80);
    if (!out.client_name) throw bad('اسم الزبون مطلوب');
  }
  if (!partial || has('phone')) out.phone = normPhone(body.phone);
  if (!partial || has('date')) {
    if (!isDate(body.date)) throw bad('تاريخ غير صالح');
    out.date = body.date;
  }
  if (!partial || has('time')) {
    if (!isTime(body.time)) throw bad('وقت غير صالح');
    out.time = body.time;
  }
  if (!partial || has('service')) out.service = str(body.service, 120);
  if (!partial || has('price')) out.price = money(body.price, 'السعر');
  if (!partial || has('note')) out.note = str(body.note, 1000);
  if (has('status')) {
    if (!STATUSES.includes(body.status)) throw bad('حالة غير صالحة');
    out.status = body.status;
  }
  return out;
}

// ---------- services, salon info & FAQ (the WhatsApp assistant answers from these) ----------
export function parseService(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    out.name = str(body.name, 80);
    if (!out.name) throw bad('اسم الخدمة مطلوب');
  }
  if (!partial || has('price')) out.price = body.price === '' || body.price == null ? null : money(body.price, 'السعر');
  if (!partial || has('note')) out.note = str(body.note, 300);
  if (!partial || has('active')) out.active = body.active === undefined ? true : !!body.active;
  return out;
}

export function parseSettings(body) {
  const field = (k, max) => str(body[k], max);
  const faq = (Array.isArray(body.faq) ? body.faq : []).slice(0, 30)
    .map((f) => ({ q: str(f?.q, 200), a: str(f?.a, 600) })).filter((f) => f.q && f.a);
  return {
    auto_reply: body.auto_reply !== false, mask_phones: body.mask_phones === true, assistant_name: field('assistant_name', 40), about: field('about', 600), address: field('address', 300), maps_url: field('maps_url', 300),
    hours_text: field('hours_text', 300), payment: field('payment', 300), policies: field('policies', 800), faq,
  };
}

export const sortServices = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ar'));

// ---------- balances ----------
export const paidOf = (a) => round2((a.payments || []).reduce((s, p) => s + p.amount, 0));
export const dueOf = (a) => (OWING.includes(a.status) ? Math.max(0, round2(a.price - paidOf(a))) : 0);
export const withBalance = (a) => ({ ...a, walk_in: !!a.walk_in, paid: paidOf(a), remaining: dueOf(a) });

const byDateTime = (x, y) => (x.date + x.time).localeCompare(y.date + y.time);
const contains = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

export function filterAppointments(list, { date, from, to, q, status } = {}) {
  let rows = list;
  if (date) rows = rows.filter((a) => a.date === date);
  if (from) rows = rows.filter((a) => a.date >= from);
  if (to) rows = rows.filter((a) => a.date <= to);
  if (status) rows = rows.filter((a) => a.status === status);
  if (q) rows = rows.filter((a) => contains(a.client_name, q) || contains(a.phone, q));
  return [...rows].sort(byDateTime).slice(0, 500);
}

// ---------- clients (grouped by phone; walk-ins without a phone are grouped by name) ----------
const clientKey = (a) => (a.phone ? a.phone : `name:${a.client_name}`);

export function groupClients(list, q) {
  const groups = new Map();
  const rows = q ? list.filter((a) => contains(a.client_name, q) || contains(a.phone, q)) : list;
  for (const a of [...rows].sort(byDateTime)) {
    const key = clientKey(a);
    const g = groups.get(key) || { key, name: a.client_name, phone: a.phone, visits: 0, came: 0, no_show: 0, last_date: '', total: 0, paid: 0 };
    g.name = a.client_name; // rows are date-ordered, so this ends up as the most recent spelling
    g.visits += 1;
    if (a.status === 'came') g.came += 1;
    if (a.status === 'no_show') g.no_show += 1;
    g.last_date = a.date;
    if (OWING.includes(a.status)) { g.total += a.price; g.paid += paidOf(a); }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, total: round2(g.total), paid: round2(g.paid), remaining: Math.max(0, round2(g.total - g.paid)) }))
    .sort((x, y) => y.last_date.localeCompare(x.last_date))
    .slice(0, 500);
}

export function clientHistory(list, { phone, name }) {
  const rows = phone ? list.filter((a) => a.phone === phone) : list.filter((a) => !a.phone && a.client_name === name);
  return [...rows].sort((x, y) => byDateTime(y, x));
}

// ---------- stats ----------
export function dayStats(list, date) {
  const day = list.filter((a) => a.date === date);
  const count = (s) => day.filter((a) => a.status === s).length;
  return {
    total: day.length,
    pending: count('pending'),
    booked: count('booked'),
    came: count('came'),
    no_show: count('no_show'),
    cancelled: count('cancelled'),
    walk_in: day.filter((a) => a.walk_in).length,
    collected: round2(day.reduce((s, a) => s + paidOf(a), 0)),
    outstanding: round2(list.reduce((s, a) => s + dueOf(a), 0)),
  };
}

// ---------- notes ----------
export const sortNotes = (notes) =>
  [...notes].sort((a, b) => (a.done - b.done) || (b.pinned - a.pinned) || b.created_at.localeCompare(a.created_at));
