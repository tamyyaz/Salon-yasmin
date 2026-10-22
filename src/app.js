import { config } from './config.js';
import { createStore } from './store.js';
import qrcode from 'qrcode-generator';
import { ymd, parseYmd, addDays } from './logic.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const state = {
  name: config.salonName, currency: config.currency, date: ymd(new Date()),
  openHour: config.openHour, closeHour: config.closeHour, slotMinutes: config.slotMinutes,
};

// On localhost the app talks to the Firebase emulators (see README), never to the real project.
const emulator = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? { host: location.hostname, authPort: 9099, firestorePort: 8080 } : null;
const configured = !config.firebase.apiKey.startsWith('REPLACE');
const store = emulator || configured
  ? createStore({
    firebase: configured ? config.firebase : { apiKey: 'demo', authDomain: 'demo-salon.firebaseapp.com', projectId: 'demo-salon', appId: 'demo' },
    salonEmail: config.salonEmail, emulator,
  })
  : null;
const api = (path, opts) => store.api(path, opts);

const STATUS_LABEL = { pending: 'بانتظار التأكيد', booked: 'محجوز', came: 'حضر', no_show: 'لم يحضر', cancelled: 'ملغي' };
const ROUTES = { today: renderToday, appointments: renderAppointments, clients: renderClients, services: renderServices, notes: renderNotes };

// ---------- helpers ----------
const fmtDate = (s, opts) => parseYmd(s).toLocaleDateString('ar-u-nu-latn', opts || { weekday: 'long', day: 'numeric', month: 'long' });
// ISO timestamps from Firestore
const fmtStamp = (s) => new Date(s).toLocaleString('ar-u-nu-latn', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtNum = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = (n) => `${fmtNum(n)} ${state.currency}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowTime = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const waLink = (phone) => `https://wa.me/${phone.replace(/\D/g, '').replace(/^0+/, '')}`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const setOffline = (off) => $('#offline').classList.toggle('hidden', !off);
addEventListener('offline', () => setOffline(true));
addEventListener('online', () => { setOffline(false); refresh(); });
if (!navigator.onLine) setOffline(true);

// run an action, show errors as toast
async function attempt(fn) {
  try { return await fn(); } catch (e) { toast(e.message); return null; }
}

// ---------- themed confirm (big touch buttons, replaces window.confirm) ----------
function ask(message, { yes = 'نعم', danger = false } = {}) {
  return new Promise((resolve) => {
    const box = $('#ask');
    $('#askText').textContent = message;
    const ok = $('#askYes');
    ok.textContent = yes;
    ok.classList.toggle('btn-danger-solid', danger);
    box.classList.remove('hidden');
    const done = (v) => { box.classList.add('hidden'); ok.onclick = $('#askNo').onclick = box.onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    $('#askNo').onclick = () => done(false);
    box.onclick = (e) => { if (e.target.hasAttribute('data-close')) done(false); };
  });
}

// ---------- modal ----------
function openModal(html, onMount) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount?.($('#modalCard'));
  const first = $('#modalCard input:not([type=hidden]), #modalCard textarea');
  first?.focus({ preventScroll: true });
}
const closeModal = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#ask').classList.contains('hidden')) $('#askNo').click(); else closeModal(); } });

// ---------- auth ----------
const splash = $('#splash');
function showLogin(message = '') {
  splash.classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#password').value = '';
  $('#loginError').textContent = message;
}
function showApp() {
  splash.classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  route();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginForm button');
  $('#loginError').textContent = '';
  btn.disabled = true;
  btn.textContent = 'جارٍ الدخول…';
  try {
    await store.signIn($('#password').value);   // onAuth() takes it from here
  } catch (err) {
    $('#loginError').textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'دخول';
  }
});
$('#logout').addEventListener('click', async () => {
  if (!(await ask('تسجيل الخروج من هذا الجهاز؟', { yes: 'خروج' }))) return;
  await store.signOutAndWipe();   // also clears the offline copy of the data on this device
  location.reload();
});

// ---------- routing ----------
// small count on the "appointments" tab: requests waiting for the salon's confirmation
async function updatePendingBadge() {
  try {
    const n = (await api(`/appointments?status=pending&from=${ymd(new Date())}`)).length;
    const link = $('#nav a[data-route="appointments"]');
    if (n) link.dataset.badge = n; else delete link.dataset.badge;
  } catch { /* offline: keep the previous badge */ }
}

async function route({ silent = false } = {}) {
  const name = (location.hash.replace('#/', '') || 'today').split('?')[0];
  const key = ROUTES[name] ? name : 'today';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
  view.classList.toggle('no-anim', silent);   // background refreshes shouldn't replay the entrance animation
  updatePendingBadge();
  if (!silent) return attempt(() => ROUTES[key]());
  const y = window.scrollY;
  try { await ROUTES[key](); window.scrollTo(0, y); } catch { /* the offline banner already tells the story */ }
}
window.addEventListener('hashchange', () => route());
const reload = () => route({ silent: true });

// ---------- shared pieces ----------
function emptyState(text) {
  return `<div class="card empty"><div class="medallion"><img class="wiggle" src="/art/bouquet.svg" alt=""></div><p>${esc(text)}</p></div>`;
}

function hero({ title, sub, tone = 'a', actions = '' }) {
  return `<section class="hero hero-${tone}">
    <img class="hd hd-rose" src="/art/rose.svg" alt="">
    <img class="hd hd-blossom" src="/art/blossom.svg" alt="">
    <img class="hd hd-daisy" src="/art/daisy.svg" alt="">
    <img class="hd hd-heart" src="/art/heart.svg" alt="">
    <img class="hd hd-spark s1" src="/art/sparkle.svg" alt="">
    <img class="hd hd-spark s2" src="/art/sparkle.svg" alt="">
    <img class="hd hd-fly" src="/art/butterfly.svg" alt="">
    <div class="hero-text"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <div class="hero-actions">${actions}</div>
  </section>`;
}

function apptCard(a, { showDate = false } = {}) {
  const phone = a.phone
    ? `<a href="tel:${esc(a.phone)}">${esc(a.phone)}</a><a href="${waLink(a.phone)}" target="_blank" rel="noopener">واتساب</a>`
    : '';
  const remClass = a.remaining > 0 ? 'rem-due' : 'rem-ok';
  const done = a.status === 'came';
  return `<article class="card appt is-${a.status}" data-id="${a.id}">
    <div class="appt-time">${esc(a.time)}${showDate ? `<div class="muted" style="font-size:.75rem;font-family:var(--sans)">${esc(fmtDate(a.date, { day: 'numeric', month: 'short' }))}</div>` : ''}</div>
    <div>
      <div class="appt-name">${esc(a.client_name)}
        <span class="chip chip-${a.status}">${STATUS_LABEL[a.status]}</span>
        ${a.walk_in ? '<span class="chip chip-walkin">زبون مفاجئ</span>' : ''}
        ${a.source === 'whatsapp' ? '<span class="chip chip-wa">واتساب</span>' : ''}
      </div>
      <div class="appt-meta">${a.service ? `<span>${esc(a.service)}</span>` : ''}${phone}</div>
      ${a.note ? `<div class="appt-note">📝 ${esc(a.note)}</div>` : ''}
      <div class="money">
        <span>السعر: <b>${money(a.price)}</b></span>
        <span>المدفوع: <b>${money(a.paid)}</b></span>
        ${['cancelled', 'no_show', 'pending'].includes(a.status) ? '' : `<span class="${remClass}">المتبقي: <b>${money(a.remaining)}</b></span>`}
      </div>
    </div>
    <div class="actions">
      ${a.status === 'pending' ? `<button class="btn btn-ok btn-sm" data-act="status" data-status="booked">تأكيد ✓</button>
        <button class="btn btn-danger btn-sm" data-act="reject">رفض</button>
        <button class="btn btn-sm" data-act="edit">تعديل</button>` : `
      ${done ? '' : `<button class="btn btn-ok btn-sm" data-act="status" data-status="came">حضر ✓</button>`}
      ${a.status === 'booked' ? `<button class="btn btn-danger btn-sm" data-act="status" data-status="no_show">لم يحضر</button>` : ''}
      ${['came', 'no_show', 'cancelled'].includes(a.status) ? `<button class="btn btn-sm" data-act="status" data-status="booked">إعادة للحجز</button>` : ''}
      <button class="btn btn-primary btn-sm" data-act="pay">دفعات</button>
      <button class="btn btn-sm" data-act="edit">تعديل</button>
      ${a.status === 'booked' ? `<button class="btn btn-sm" data-act="status" data-status="cancelled">إلغاء</button>` : ''}`}
    </div>
  </article>`;
}

// delegated handler for appointment-card buttons inside #view
view.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const card = e.target.closest('[data-id]');
  if (!btn || !card || !card.classList.contains('appt')) return;
  const id = card.dataset.id;
  if (btn.dataset.act === 'status') {
    const a = await attempt(() => api(`/appointments/${id}`, { method: 'PATCH', body: { status: btn.dataset.status } }));
    if (a) {
      if (a.status === 'came' && a.remaining > 0) toast(`تم التسجيل — المتبقي على ${a.client_name}: ${money(a.remaining)}`);
      reload();
    }
  } else if (btn.dataset.act === 'reject') {
    if (!(await ask('رفض هذا الحجز؟ (يُلغى ويتحرّر الوقت)', { yes: 'رفض', danger: true }))) return;
    if (await attempt(() => api(`/appointments/${id}`, { method: 'PATCH', body: { status: 'cancelled' } }))) reload();
  } else if (btn.dataset.act === 'pay') {
    openPayments(id);
  } else if (btn.dataset.act === 'edit') {
    const a = await attempt(() => api(`/appointments/${id}`));
    if (a) openAppointmentForm(a);
  }
});

// ---------- views ----------
async function renderToday() {
  const date = state.date;
  const todayStr = ymd(new Date());
  const [dayList, stats, pending] = await Promise.all([
    api(`/appointments?date=${date}`), api(`/stats?date=${date}`), api(`/appointments?status=pending&from=${todayStr}`),
  ]);
  const list = dayList.filter((a) => a.status !== 'pending' || a.date < todayStr);   // upcoming requests live in their own section
  const isToday = date === todayStr;
  view.innerHTML = `
    ${hero({
      title: isToday ? 'اليوم' : fmtDate(date),
      sub: isToday ? fmtDate(date) : 'مواعيد اليوم المحدد',
      tone: 'a',
      actions: `<button class="btn icon-btn" data-nav="-1" title="اليوم السابق">›</button>
                <input type="date" id="dayPicker" value="${date}">
                <button class="btn icon-btn" data-nav="1" title="اليوم التالي">‹</button>
                ${isToday ? '' : '<button class="btn btn-sm" data-today>اليوم</button>'}`,
    })}
    <div class="today-layout">
    <section class="today-main">
      ${pending.length ? `<div class="section-title"><h3>بانتظار تأكيدك (${pending.length})</h3></div>
      <div class="list pending-list">${pending.map((a) => apptCard(a, { showDate: true })).join('')}</div>` : ''}
      <div class="section-title"><h3>مواعيد اليوم</h3></div>
      <div class="list">${list.length ? list.map((a) => apptCard(a)).join('') : emptyState('لا توجد مواعيد في هذا اليوم')}</div>
    </section>
    <aside class="today-side"><div class="stats">
      <div class="card stat"><b>${stats.total}</b><span>إجمالي الحجوزات</span></div>
      <div class="card stat"><b>${stats.came}</b><span>حضروا</span></div>
      <div class="card stat"><b>${stats.booked}</b><span>بانتظارهم</span></div>
      <div class="card stat"><b>${stats.no_show}</b><span>لم يحضروا</span></div>
      <div class="card stat"><b>${stats.walk_in}</b><span>زبائن مفاجئون</span></div>
      <div class="card stat"><b>${fmtNum(stats.collected)}</b><span>محصّل اليوم (${esc(state.currency)})</span></div>
      <div class="card stat warn"><b>${fmtNum(stats.outstanding)}</b><span>متبقي على الزبائن (${esc(state.currency)})</span></div>
    </div></aside>
    </div>`;

  view.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { state.date = addDays(state.date, Number(b.dataset.nav)); reload(); }));
  $('[data-today]', view)?.addEventListener('click', () => { state.date = ymd(new Date()); reload(); });
  $('#dayPicker', view).addEventListener('change', (e) => { if (e.target.value) { state.date = e.target.value; reload(); } });
}

let apptFilter = { range: 'upcoming', q: '', status: '' };
async function renderAppointments() {
  const today = ymd(new Date());
  const params = new URLSearchParams();
  if (apptFilter.range === 'upcoming') params.set('from', today);
  if (apptFilter.range === 'past') params.set('to', addDays(today, -1));
  if (apptFilter.q) params.set('q', apptFilter.q);
  if (apptFilter.status) params.set('status', apptFilter.status);
  let list = await api(`/appointments?${params}`);
  if (apptFilter.range === 'past') list = list.reverse();

  const groups = [];
  for (const a of list) {
    const g = groups[groups.length - 1];
    if (g && g.date === a.date) g.items.push(a); else groups.push({ date: a.date, items: [a] });
  }

  view.innerHTML = `
    ${hero({ title: 'المواعيد', sub: 'كل الحجوزات في مكان واحد', tone: 'b' })}
    <div class="filters">
      <div class="tabs">
        ${[['upcoming', 'القادمة'], ['past', 'السابقة'], ['all', 'الكل']]
          .map(([k, l]) => `<button class="btn btn-sm tab ${apptFilter.range === k ? 'active' : ''}" data-range="${k}">${l}</button>`).join('')}
      </div>
      <input type="search" id="q" placeholder="بحث بالاسم أو الرقم…" value="${esc(apptFilter.q)}">
      <select id="statusFilter">
        <option value="">كل الحالات</option>
        ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${apptFilter.status === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${groups.length ? groups.map((g) => `
      <div class="section-title"><h3>${esc(fmtDate(g.date))}</h3></div>
      <div class="list">${g.items.map((a) => apptCard(a)).join('')}</div>`).join('') : emptyState('لا توجد مواعيد مطابقة')}`;

  view.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { apptFilter.range = b.dataset.range; reload(); }));
  $('#statusFilter', view).addEventListener('change', (e) => { apptFilter.status = e.target.value; reload(); });
  let t;
  $('#q', view).addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(async () => { apptFilter.q = e.target.value.trim(); await reload(); $('#q').focus(); $('#q').setSelectionRange(1e4, 1e4); }, 350);
  });
}

let clientQuery = '';
async function renderClients() {
  const list = await api(`/clients${clientQuery ? `?q=${encodeURIComponent(clientQuery)}` : ''}`);
  const totalDue = list.reduce((s, c) => s + c.remaining, 0);
  view.innerHTML = `
    ${hero({ title: 'الزبائن', sub: `إجمالي المتبقي على الزبائن: ${money(totalDue)}`, tone: 'c' })}
    <div class="filters"><input type="search" id="q" placeholder="ابحث باسم الزبون أو رقمه…" value="${esc(clientQuery)}"></div>
    <div class="list">
      ${list.length ? list.map((c, i) => `
        <article class="card client" data-i="${i}">
          <div>
            <div class="appt-name">${esc(c.name)}</div>
            <div class="appt-meta">
              ${c.phone ? `<span dir="ltr">${esc(c.phone)}</span>` : '<span>بدون رقم</span>'}
              <span>${c.visits} زيارة</span><span>حضر ${c.came || 0}</span>
              ${c.no_show ? `<span>لم يحضر ${c.no_show}</span>` : ''}
              <span>آخر موعد: ${esc(fmtDate(c.last_date, { day: 'numeric', month: 'short', year: 'numeric' }))}</span>
            </div>
          </div>
          ${c.remaining > 0 ? `<div class="badge-due">متبقي ${money(c.remaining)}</div>` : '<div class="badge-clear">لا يوجد متبقي</div>'}
        </article>`).join('') : emptyState('لا يوجد زبائن بعد')}
    </div>`;
  view.querySelectorAll('.client').forEach((el) => el.addEventListener('click', () => openClientHistory(list[Number(el.dataset.i)])));
  let t;
  $('#q', view).addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(async () => { clientQuery = e.target.value.trim(); await reload(); $('#q').focus(); $('#q').setSelectionRange(1e4, 1e4); }, 350);
  });
}

async function renderServices() {
  const [services, info] = await Promise.all([api('/services'), api('/settings')]);
  const infoFields = [
    ['about', 'نبذة عن الصالون', 'textarea'], ['address', 'العنوان', 'input'], ['maps_url', 'رابط الموقع على الخريطة', 'input'],
    ['hours_text', 'ساعات الدوام (نص يظهر للزبائن)', 'input'], ['payment', 'طرق الدفع', 'input'], ['policies', 'سياسة الإلغاء والمواعيد', 'textarea'],
  ];
  view.innerHTML = `
    ${hero({ title: 'الخدمات والأسعار', sub: 'مساعد واتساب بيجاوب الزبائن من هالمعلومات بالضبط', tone: 'c',
      actions: '<button class="btn" id="addService" type="button">＋ خدمة جديدة</button>' })}
    <div class="section-title"><h3>الخدمات</h3></div>
    <div class="list">
      ${services.length ? services.map((s) => `
        <article class="card client" data-svc="${s.id}" style="cursor:default">
          <div>
            <div class="appt-name">${esc(s.name)} ${s.active ? '' : '<span class="chip chip-cancelled">مخفية</span>'}</div>
            <div class="appt-meta"><span><b>${s.price == null ? 'حسب الاتفاق' : money(s.price)}</b></span>${s.note ? `<span>${esc(s.note)}</span>` : ''}</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm" data-s="edit">تعديل</button>
            <button class="btn btn-sm" data-s="toggle">${s.active ? 'إخفاء' : 'إظهار'}</button>
            <button class="btn btn-danger btn-sm" data-s="del">حذف</button>
          </div>
        </article>`).join('') : emptyState('ما في خدمات بعد — أضيفي أول خدمة')}
    </div>

    <div class="section-title"><h3>معلومات الصالون</h3></div>
    <form class="card" id="infoForm">
      ${infoFields.map(([k, label, kind]) => `<label class="field"><span>${label}</span>${kind === 'textarea'
        ? `<textarea name="${k}" maxlength="800">${esc(info[k])}</textarea>` : `<input name="${k}" maxlength="300" value="${esc(info[k])}">`}</label>`).join('')}
      <div class="modal-actions"><button class="btn btn-primary" type="submit">حفظ المعلومات</button></div>
    </form>

    <div class="section-title"><h3>أسئلة شائعة</h3><button class="btn btn-sm" id="addFaq" type="button">＋ سؤال</button></div>
    <div class="list">
      ${info.faq.length ? info.faq.map((f, i) => `
        <article class="card client" data-faq="${i}" style="cursor:default">
          <div><div class="appt-name">${esc(f.q)}</div><div class="appt-meta"><span>${esc(f.a)}</span></div></div>
          <div class="actions"><button class="btn btn-sm" data-f="edit">تعديل</button><button class="btn btn-danger btn-sm" data-f="del">حذف</button></div>
        </article>`).join('') : '<p class="muted">مثال: «بتقبلوا كارت؟» ← «لا، كاش فقط». المساعد بيستعملها لما الزبونة تسأل.</p>'}
    </div>`;

  const serviceForm = (s = {}) => openModal(`
    <form id="svcForm">
      <h3>${s.id ? 'تعديل الخدمة' : 'خدمة جديدة'}</h3>
      <label class="field"><span>اسم الخدمة *</span><input name="name" value="${esc(s.name)}" required maxlength="80"></label>
      <label class="field"><span>السعر (${esc(state.currency)}) — اتركيه فاضي إذا بيتحدد بالصالون</span><input type="number" inputmode="decimal" name="price" min="0" step="0.01" value="${s.price ?? ''}"></label>
      <label class="field"><span>ملاحظة تظهر للزبونة (مثلاً: السعر يزيد للشعر الطويل)</span><input name="note" maxlength="300" value="${esc(s.note)}"></label>
      <p class="error" id="formError" role="alert"></p>
      <div class="modal-actions"><button class="btn" type="button" data-close>إلغاء</button><button class="btn btn-primary" type="submit">حفظ</button></div>
    </form>`, (card) => {
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    $('#svcForm', card).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try { await api(s.id ? `/services/${s.id}` : '/services', { method: s.id ? 'PATCH' : 'POST', body }); closeModal(); reload(); }
      catch (err) { $('#formError').textContent = err.message; }
    });
  });

  const faqForm = (i = null) => {
    const f = i == null ? { q: '', a: '' } : info.faq[i];
    openModal(`
      <form id="faqForm">
        <h3>${i == null ? 'سؤال شائع' : 'تعديل السؤال'}</h3>
        <label class="field"><span>السؤال *</span><input name="q" value="${esc(f.q)}" required maxlength="200"></label>
        <label class="field"><span>الجواب *</span><textarea name="a" required maxlength="600">${esc(f.a)}</textarea></label>
        <div class="modal-actions"><button class="btn" type="button" data-close>إلغاء</button><button class="btn btn-primary" type="submit">حفظ</button></div>
      </form>`, (card) => {
      card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
      $('#faqForm', card).addEventListener('submit', async (e) => {
        e.preventDefault();
        const next = Object.fromEntries(new FormData(e.target));
        const cur = await api('/settings');                       // always the latest, so saved info isn't overwritten
        const faq = [...cur.faq];
        if (i == null) faq.push(next); else faq[i] = next;
        if (await attempt(() => api('/settings', { method: 'PUT', body: { ...cur, faq } }))) { closeModal(); reload(); }
      });
    });
  };

  $('#addService', view).addEventListener('click', () => serviceForm());
  $('#addFaq', view).addEventListener('click', () => faqForm());
  $('#infoForm', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = await api('/settings');
    if (await attempt(() => api('/settings', { method: 'PUT', body: { ...cur, ...Object.fromEntries(new FormData(e.target)) } }))) toast('تم حفظ المعلومات ✓');
  });
  const onListClick = async (e) => {
    const sBtn = e.target.closest('[data-s]');
    const fBtn = e.target.closest('[data-f]');
    if (sBtn) {
      const s = services.find((x) => x.id === sBtn.closest('[data-svc]').dataset.svc);
      if (sBtn.dataset.s === 'edit') serviceForm(s);
      if (sBtn.dataset.s === 'toggle') { await attempt(() => api(`/services/${s.id}`, { method: 'PATCH', body: { active: !s.active } })); reload(); }
      if (sBtn.dataset.s === 'del' && await ask(`حذف خدمة «${s.name}»؟`, { yes: 'حذف', danger: true })) { await attempt(() => api(`/services/${s.id}`, { method: 'DELETE' })); reload(); }
    } else if (fBtn) {
      const i = Number(fBtn.closest('[data-faq]').dataset.faq);
      if (fBtn.dataset.f === 'edit') faqForm(i);
      if (fBtn.dataset.f === 'del' && await ask('حذف هذا السؤال؟', { yes: 'حذف', danger: true })) {
        const cur = await api('/settings');
        await attempt(() => api('/settings', { method: 'PUT', body: { ...cur, faq: cur.faq.filter((_, k) => k !== i) } })); reload();
      }
    }
  };
  view.querySelectorAll('[data-svc], [data-faq]').forEach((el) => el.addEventListener('click', onListClick));  // per element: re-created on every render
}

async function renderNotes() {
  const notes = await api('/notes');
  view.innerHTML = `
    ${hero({ title: 'الملاحظات', sub: 'تذكيرات وأفكار الصالون', tone: 'd' })}
    <form class="note-form" id="noteForm">
      <textarea id="noteText" maxlength="2000" placeholder="اكتب ملاحظة جديدة…" required></textarea>
      <button class="btn btn-primary" type="submit">إضافة</button>
    </form>
    <div class="list">
      ${notes.length ? notes.map((n) => `
        <article class="card note ${n.done ? 'done' : ''} ${n.pinned ? 'pinned' : ''}" data-note="${n.id}">
          <input class="check" type="checkbox" data-n="done" ${n.done ? 'checked' : ''} title="تم">
          <div><div class="note-text">${esc(n.text)}</div><div class="note-date">${esc(fmtStamp(n.created_at))}</div></div>
          <div class="actions">
            <button class="btn btn-sm" data-n="pin">${n.pinned ? 'إلغاء التثبيت' : '📌 تثبيت'}</button>
            <button class="btn btn-danger btn-sm" data-n="del">حذف</button>
          </div>
        </article>`).join('') : emptyState('لا توجد ملاحظات')}
    </div>
    <div class="backup"><button class="btn btn-sm" id="backupBtn" type="button">⬇ تحميل نسخة احتياطية من كل البيانات</button></div>`;
  $('#backupBtn', view).addEventListener('click', downloadBackup);

  $('#noteForm', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('/notes', { method: 'POST', body: { text: $('#noteText').value } }))) reload();
  });
  view.querySelectorAll('[data-note]').forEach((el) => {
    const id = el.dataset.note;
    const n = notes.find((x) => String(x.id) === id);
    el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-n]')?.dataset.n;
      if (!act) return;
      if (act === 'del') { if (!(await ask('حذف هذه الملاحظة؟', { yes: 'حذف', danger: true }))) return; await attempt(() => api(`/notes/${id}`, { method: 'DELETE' })); }
      if (act === 'pin') await attempt(() => api(`/notes/${id}`, { method: 'PATCH', body: { pinned: !n.pinned } }));
      if (act === 'done') await attempt(() => api(`/notes/${id}`, { method: 'PATCH', body: { done: e.target.checked } }));
      reload();
    });
  });
}

async function downloadBackup() {
  const data = await attempt(() => store.exportAll());
  if (!data) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  link.download = `salon-backup-${ymd(new Date())}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  toast('تم تنزيل النسخة الاحتياطية');
}

// ---------- modals ----------
async function openAppointmentForm(a = null, defaults = {}) {
  const isEdit = !!a;
  const svc = (await api('/services').catch(() => [])).filter((s) => s.active);
  const v = a || { client_name: '', phone: '', date: state.date, time: '10:00', service: '', price: '', note: '', status: 'booked', ...defaults };
  openModal(`
    <form id="apptForm">
      <h3>${isEdit ? 'تعديل الموعد' : 'حجز جديد'}</h3>
      <label class="field"><span>رقم الزبون</span><input type="tel" inputmode="tel" name="phone" value="${esc(v.phone)}" placeholder="مثال: 0790000000"></label>
      <label class="field"><span>اسم الزبون *</span><input name="client_name" value="${esc(v.client_name)}" required maxlength="80"></label>
      <div class="row">
        <label class="field"><span>التاريخ *</span><input type="date" name="date" value="${esc(v.date)}" required></label>
        <label class="field"><span>الساعة *</span><input type="time" name="time" value="${esc(v.time)}" required></label>
      </div>
      <div class="slots" id="slots" aria-label="ساعات سريعة"></div>
      <label class="field"><span>الخدمة</span><input name="service" value="${esc(v.service)}" maxlength="120" placeholder="قص، صبغة، تسريحة…" list="svcList" autocomplete="off"><datalist id="svcList">${svc.map((s) => `<option value="${esc(s.name)}"></option>`).join('')}</datalist></label>
      <div class="row">
        <label class="field"><span>السعر (${esc(state.currency)})</span><input type="number" inputmode="decimal" name="price" min="0" step="0.01" value="${esc(v.price)}"></label>
        ${isEdit
          ? `<label class="field"><span>الحالة</span><select name="status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
          : `<label class="field"><span>عربون مدفوع</span><input type="number" inputmode="decimal" name="deposit" min="0" step="0.01" placeholder="0"></label>`}
      </div>
      <label class="field"><span>ملاحظة</span><textarea name="note" maxlength="1000">${esc(v.note)}</textarea></label>
      <p class="error" id="formError" role="alert"></p>
      <div class="modal-actions">
        ${isEdit ? '<button class="btn btn-danger" type="button" id="delAppt">حذف الموعد</button>' : ''}
        <button class="btn" type="button" data-close>إلغاء</button>
        <button class="btn btn-primary" type="submit">${isEdit ? 'حفظ' : 'حجز'}</button>
      </div>
    </form>`, (card) => {
    const form = $('#apptForm', card);
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));

    // one-tap time slots; booked ones are dimmed but still selectable
    const slotsEl = $('#slots', card);
    const times = [];
    for (let m = state.openHour * 60; m <= state.closeHour * 60 - state.slotMinutes; m += state.slotMinutes) {
      times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
    let taken = new Set();
    const paintSlots = () => {
      slotsEl.innerHTML = times.map((t) => `<button type="button" class="slot ${taken.has(t) ? 'taken' : ''} ${form.time.value === t ? 'active' : ''}" data-t="${t}" ${taken.has(t) ? 'title="محجوز"' : ''}>${t}</button>`).join('');
    };
    const loadTaken = async () => {
      try {
        const day = await api(`/appointments?date=${form.date.value}`);
        taken = new Set(day.filter((x) => x.id !== a?.id && !['cancelled', 'no_show'].includes(x.status)).map((x) => x.time));
      } catch { taken = new Set(); }
      paintSlots();
    };
    slotsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (b) { form.time.value = b.dataset.t; paintSlots(); }
    });
    form.date.addEventListener('change', loadTaken);
    form.time.addEventListener('input', paintSlots);
    paintSlots();
    loadTaken();

    // picking a listed service fills in its price (never overwrites one you typed)
    form.service.addEventListener('change', () => {
      const hit = svc.find((s) => s.name === form.service.value.trim());
      if (hit && hit.price != null && !form.price.value) form.price.value = hit.price;
    });

    // typing a known phone number fills in the name
    form.phone.addEventListener('change', async () => {
      if (form.client_name.value || form.phone.value.length < 6) return;
      const found = await api(`/clients?q=${encodeURIComponent(form.phone.value)}`).catch(() => []);
      if (found[0]) form.client_name.value = found[0].name;
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      $('#formError').textContent = '';
      try {
        if (!isEdit) {
          const same = (await api(`/appointments?date=${body.date}`)).filter((x) => x.time === body.time && !['cancelled', 'no_show'].includes(x.status));
          if (same.length && !(await ask(`يوجد حجز آخر الساعة ${body.time} (${same[0].client_name}). هل تريد المتابعة؟`, { yes: 'متابعة' }))) return;
        }
        await api(isEdit ? `/appointments/${a.id}` : '/appointments', { method: isEdit ? 'PATCH' : 'POST', body });
        closeModal();
        if (body.date && !isEdit) state.date = body.date;
        toast(isEdit ? 'تم الحفظ' : 'تم الحجز ✓');
        reload();
      } catch (err) { $('#formError').textContent = err.message; }
    });

    $('#delAppt', card)?.addEventListener('click', async () => {
      if (!(await ask('حذف هذا الموعد نهائياً مع دفعاته؟', { yes: 'حذف', danger: true }))) return;
      if (await attempt(() => api(`/appointments/${a.id}`, { method: 'DELETE' }))) { closeModal(); toast('تم الحذف'); reload(); }
    });
  });
}

function openWalkin() {
  openModal(`
    <form id="walkForm">
      <h3>زبون مفاجئ</h3>
      <p class="muted" style="margin-top:-.6rem">يُسجَّل كحاضر الآن (${esc(nowTime())})</p>
      <label class="field"><span>الاسم</span><input name="client_name" maxlength="80" placeholder="اختياري"></label>
      <label class="field"><span>رقم الزبون</span><input type="tel" inputmode="tel" name="phone" placeholder="اختياري"></label>
      <label class="field"><span>الخدمة</span><input name="service" maxlength="120"></label>
      <div class="row">
        <label class="field"><span>السعر (${esc(state.currency)})</span><input type="number" inputmode="decimal" name="price" min="0" step="0.01"></label>
        <label class="field"><span>دفع الآن</span><input type="number" inputmode="decimal" name="deposit" min="0" step="0.01"></label>
      </div>
      <label class="field"><span>ملاحظة</span><textarea name="note" maxlength="1000"></textarea></label>
      <p class="error" id="formError" role="alert"></p>
      <div class="modal-actions">
        <button class="btn" type="button" data-close>إلغاء</button>
        <button class="btn btn-primary" type="submit">تسجيل</button>
      </div>
    </form>`, (card) => {
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    $('#walkForm', card).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      body.client_name = body.client_name.trim() || 'زبون مفاجئ';
      Object.assign(body, { date: ymd(new Date()), time: nowTime(), status: 'came', walk_in: true });
      try {
        await api('/appointments', { method: 'POST', body });
        closeModal();
        state.date = body.date;
        toast('تم تسجيل الزبون المفاجئ ✓');
        location.hash.startsWith('#/today') || !location.hash ? reload() : (location.hash = '#/today');
      } catch (err) { $('#formError').textContent = err.message; }
    });
  });
}

async function openPayments(id) {
  const appt = await attempt(async () => {
    const [a, payments] = await Promise.all([api(`/appointments/${id}`), api(`/appointments/${id}/payments`)]);
    return { a, payments };
  });
  if (!appt) return;
  const { a, payments } = appt;
  openModal(`
    <h3>دفعات — ${esc(a.client_name)}</h3>
    <div class="summary">
      <div><b>${fmtNum(a.price)}</b><span>السعر</span></div>
      <div><b>${fmtNum(a.paid)}</b><span>المدفوع</span></div>
      <div><b>${fmtNum(a.remaining)}</b><span>المتبقي</span></div>
    </div>
    <div id="payList">
      ${payments.length ? payments.map((p) => `
        <div class="pay-row"><span>${fmtNum(p.amount)} ${esc(state.currency)} <span class="muted">· ${esc(fmtStamp(p.paid_at))}</span></span>
        <button class="btn btn-danger btn-sm" data-delpay="${p.id}">حذف</button></div>`).join('') : '<p class="muted">لا توجد دفعات بعد</p>'}
    </div>
    <form id="payForm" style="margin-top:1rem">
      <div class="row">
        <label class="field"><span>دفعة جديدة (${esc(state.currency)})</span><input type="number" inputmode="decimal" name="amount" min="0.01" step="0.01" required value="${a.remaining > 0 ? a.remaining : ''}"></label>
        <div style="align-self:end;margin-bottom:.9rem"><button class="btn btn-primary btn-block" type="submit">تسجيل دفعة</button></div>
      </div>
      <p class="error" id="formError" role="alert"></p>
    </form>
    <div class="modal-actions"><button class="btn" type="button" id="closePay">إغلاق</button></div>`, (card) => {
    $('#closePay', card).addEventListener('click', () => { closeModal(); reload(); });
    $('#payForm', card).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/appointments/${id}/payments`, { method: 'POST', body: { amount: e.target.amount.value } });
        toast('تم تسجيل الدفعة ✓');
        openPayments(id);
      } catch (err) { $('#formError').textContent = err.message; }
    });
    card.querySelectorAll('[data-delpay]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await ask('حذف هذه الدفعة؟', { yes: 'حذف', danger: true }))) return;
      if (await attempt(() => api(`/payments/${b.dataset.delpay}`, { method: 'DELETE' }))) openPayments(id);
    }));
  });
}

async function openClientHistory(c) {
  const qs = c.phone ? `phone=${encodeURIComponent(c.phone)}` : `name=${encodeURIComponent(c.name)}`;
  const list = await attempt(() => api(`/clients/history?${qs}`));
  if (!list) return;
  openModal(`
    <h3>${esc(c.name)}</h3>
    <div class="summary">
      <div><b>${fmtNum(c.total)}</b><span>إجمالي الخدمات</span></div>
      <div><b>${fmtNum(c.paid)}</b><span>المدفوع</span></div>
      <div><b>${fmtNum(c.remaining)}</b><span>المتبقي</span></div>
    </div>
    <div class="list" id="hist">
      ${list.map((a) => `
        <div class="pay-row" style="align-items:flex-start;gap:.6rem">
          <div>
            <b>${esc(fmtDate(a.date, { day: 'numeric', month: 'short', year: 'numeric' }))} · ${esc(a.time)}</b>
            <div class="muted">${esc(a.service || '—')} ${a.note ? '· ' + esc(a.note) : ''}</div>
            <span class="chip chip-${a.status}">${STATUS_LABEL[a.status]}</span>
          </div>
          <div style="text-align:end;white-space:nowrap">${money(a.price)}<div class="${a.remaining > 0 ? 'badge-due' : 'badge-clear'}" style="font-size:.85rem">${a.remaining > 0 ? 'متبقي ' + money(a.remaining) : 'مسدّد'}</div>
          ${a.remaining > 0 ? `<button class="btn btn-primary btn-sm" data-pay="${a.id}">دفعة</button>` : ''}</div>
        </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" type="button" id="newForClient">حجز جديد لهذا الزبون</button>
      <button class="btn" type="button" data-close>إغلاق</button>
    </div>`, (card) => {
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    card.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => openPayments(b.dataset.pay)));
    $('#newForClient', card).addEventListener('click', () => openAppointmentForm(null, { client_name: c.name, phone: c.phone }));
  });
}

// ---------- boot ----------
document.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openAppointmentForm()));
document.querySelectorAll('[data-walkin]').forEach((b) => b.addEventListener('click', openWalkin));

// ---------- always-on tablet behaviour ----------
const pref = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// keep the screen awake while the page is open (needs HTTPS and a browser that supports it)
let wakeLock = null;
const wantsWake = () => pref.get('wake') !== 'off';
function paintUtils() {
  $('#wakeBtn').classList.toggle('off', !wantsWake());
  $('#fxBtn').classList.toggle('off', !window.salonFx?.enabled);
}
async function acquireWake() {
  if (!wantsWake() || !navigator.wakeLock || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* denied or unsupported: the tablet's own screen-timeout setting still applies */ }
}
$('#wakeBtn').addEventListener('click', () => {
  const on = !wantsWake();
  pref.set('wake', on ? 'on' : 'off');
  if (on) { acquireWake(); toast(navigator.wakeLock ? 'الشاشة ستبقى مفتوحة' : 'المتصفح لا يدعم إبقاء الشاشة — فعّلها من إعدادات التابلت'); }
  else { wakeLock?.release(); toast('عاد انطفاء الشاشة التلقائي'); }
  paintUtils();
});
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

// WhatsApp assistant status (the bot writes a heartbeat; the button stays hidden if no bot was ever set up)
const BOT_TEXT = {
  connected: 'متصل ويرد على الزبائن ✅', connecting: 'عم يتصل…', qr: 'بانتظار ربط الرقم (QR بشاشة جهاز البوت)',
  pairing: 'بانتظار ربط الرقم بكود', offline: 'غير متصل', logged_out: 'انفصل الرقم عن واتساب — لازم تعيدي الربط',
};
function botHealth() {
  const s = store?.botStatus;
  if (!s) return null;
  const fresh = Date.now() - new Date(s.updatedAt).getTime() < 5 * 60 * 1000;
  const level = !fresh ? 'off' : s.state === 'connected' ? 'ok' : ['connecting', 'qr', 'pairing'].includes(s.state) ? 'warn' : 'off';
  return { s, fresh, level };
}
function paintBot() {
  const btn = $('#botBtn');
  const h = botHealth();
  btn.classList.toggle('hidden', !h);
  if (h) { btn.classList.remove('ok', 'warn', 'off'); btn.classList.add(h.level); }
}
$('#botBtn').addEventListener('click', () => {
  const h = botHealth();
  if (!h) return;
  const { s, fresh } = h;
  openModal(`
    <h3>مساعد واتساب</h3>
    <p><b>${fresh ? BOT_TEXT[s.state] || esc(s.state) : 'غير متصل — جهاز البوت مطفي أو بلا إنترنت ⚠️'}</b></p>
    ${s.number ? `<p class="muted">الرقم: <span dir="ltr">+${esc(s.number)}</span></p>` : ''}
    ${s.qr ? `<p>على موبايل الصالون: واتساب ← الأجهزة المرتبطة ← <b>ربط جهاز</b> ← امسحي هالرمز:</p><div class="qr-box">${qrSvg(s.qr)}</div>` : ''}
    ${s.pairingCode ? `<p>على الموبايل: واتساب ← الأجهزة المرتبطة ← ربط جهاز ← <b>الربط برقم الهاتف</b> وأدخلي:</p><div class="pair-code">${esc(s.pairingCode)}</div>` : ''}
    <p class="muted">آخر إشارة: ${esc(fmtStamp(s.updatedAt))}</p>
    <div class="modal-actions"><button class="btn" type="button" data-close>إغلاق</button></div>`,
    (card) => card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal)));
});
setInterval(paintBot, 30000);

$('#fxBtn').addEventListener('click', () => {
  window.salonFx?.setEnabled(!window.salonFx.enabled);
  paintUtils();
});

// quietly re-read the data so a second device (or a new day) shows up without touching anything
let lastDay = ymd(new Date());
function refresh() {
  if (document.hidden || $('#app').classList.contains('hidden')) return;
  const today = ymd(new Date());
  if (today !== lastDay) {                        // midnight passed while the tablet sat open
    if (state.date === lastDay) state.date = today;
    lastDay = today;
  }
  const busy = !$('#modal').classList.contains('hidden') || !$('#ask').classList.contains('hidden');
  const typing = [...view.querySelectorAll('input, textarea')].some((el) => el.value !== el.defaultValue);
  if (busy || typing) return;
  route({ silent: true });
}
setInterval(refresh, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { acquireWake(); refresh(); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// changes made on any device arrive live; re-draw quietly (the same guards as the timer apply)
store?.subscribe(() => { paintBot(); refresh(); });
store?.onError((err) => {
  console.error(err);
  toast(err?.code === 'permission-denied' ? 'لا توجد صلاحية لحفظ هذا التغيير' : 'تعذّر حفظ آخر تغيير، تحقق من الاتصال');
});

document.title = state.name;
document.querySelectorAll('.brand-name').forEach((el) => { el.textContent = state.name; });
paintUtils();
acquireWake();

if (!store) {
  showLogin('الموقع غير مُعدّ بعد: ضع إعدادات Firebase في src/config.js (انظر README)');
} else {
  store.onAuth(async (signedIn) => {
    if (!signedIn) { store.stop(); showLogin(); return; }
    await store.start();
    showApp();
    const btn = $('#loginForm button');
    btn.disabled = false;
    btn.textContent = 'دخول';
  });
}
