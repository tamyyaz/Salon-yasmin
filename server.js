'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env is optional */ }

const PORT = Number(process.env.PORT) || 3000;
const SALON_NAME = process.env.SALON_NAME || 'صالون ياسمين';
const CURRENCY = process.env.CURRENCY || '₪';
const PASSWORD = process.env.SALON_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 90; // the salon tablet stays signed in; the cookie is renewed while in use
const OPEN_HOUR = Number(process.env.OPEN_HOUR) || 9;
const CLOSE_HOUR = Number(process.env.CLOSE_HOUR) || 21;
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES) || 30;
const COOKIE = 'salon_session';

if (!PASSWORD || PASSWORD.length < 6) {
  console.error('ضع كلمة سر (6 أحرف على الأقل) في SALON_PASSWORD داخل ملف .env — انظر .env.example');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- session secret (persisted so logins survive restarts) ----------
const secretFile = path.join(DATA_DIR, '.session-secret');
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(secretFile, 'utf8');
}

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const PASSWORD_HASH = sha(PASSWORD);
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = String(exp);
  return `${payload}.${sign(payload)}`;
}

function validToken(token) {
  if (typeof token !== 'string') return false;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return false;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  return Number(payload) > Date.now();
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// ---------- database ----------
const db = new Database(path.join(DATA_DIR, 'salon.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','came','no_show','cancelled')),
    walk_in INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, time);
  CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments(phone);
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    paid_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pay_appt ON payments(appointment_id);
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// An appointment counts toward money owed unless it was cancelled or the client didn't show up.
const APPT_SELECT = `
  SELECT a.*,
    COALESCE((SELECT SUM(amount) FROM payments p WHERE p.appointment_id = a.id), 0) AS paid
  FROM appointments a`;

const withBalance = (row) => ({
  ...row,
  walk_in: !!row.walk_in,
  remaining: ['cancelled', 'no_show'].includes(row.status) ? 0 : Math.max(0, row.price - row.paid),
});

// ---------- backups ----------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;

async function makeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  await db.backup(path.join(BACKUP_DIR, `salon-${new Date().toISOString().slice(0, 10)}.db`));
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^salon-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -BACKUP_KEEP);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
}

// ---------- validation ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const STATUSES = ['booked', 'came', 'no_show', 'cancelled'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (v, field) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw bad(`قيمة غير صالحة: ${field}`);
  return Math.round(n * 100) / 100;
};
const normPhone = (p) => str(p, 30).replace(/[^\d+]/g, '');

function parseAppointment(body, { partial = false } = {}) {
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

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'",
  });
  next();
});

// login throttling: 5 failures per IP -> 15 min lockout
const attempts = new Map();
function throttled(ip) {
  const rec = attempts.get(ip);
  return rec && rec.count >= 5 && rec.until > Date.now();
}
function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else rec.count += 1;
}

const isAuthed = (req) => validToken(readCookie(req, COOKIE));
const sessionCookie = (req, token, maxAge) => `${COOKIE}=${token}; Max-Age=${maxAge}; ${cookieOpts(req)}`;
const cookieOpts = (req) =>
  `HttpOnly; SameSite=Strict; Path=/${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ name: SALON_NAME, currency: CURRENCY, openHour: OPEN_HOUR, closeHour: CLOSE_HOUR, slotMinutes: SLOT_MINUTES, authed: isAuthed(req) }));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد 15 دقيقة' });
  const given = sha(typeof req.body?.password === 'string' ? req.body.password : '');
  if (!crypto.timingSafeEqual(given, PASSWORD_HASH)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'كلمة السر غير صحيحة' });
  }
  attempts.delete(ip);
  res.set('Set-Cookie', sessionCookie(req, makeToken(), SESSION_DAYS * 86400));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

// everything below requires login
const requireAuth = (req, res, next) => {
  const token = readCookie(req, COOKIE);
  if (!validToken(token)) return res.status(401).json({ error: 'سجّل الدخول أولاً' });
  // sliding session: reissue once the cookie is more than a day old
  if (Number(token.split('.')[0]) - Date.now() < (SESSION_DAYS - 1) * 864e5) {
    res.set('Set-Cookie', sessionCookie(req, makeToken(), SESSION_DAYS * 86400));
  }
  next();
};
const api = express.Router();
api.use(requireAuth);

const getAppt = (id) => {
  const row = db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'الموعد غير موجود');
  return withBalance(row);
};
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw bad('معرّف غير صالح');
  return id;
};

// --- appointments ---
api.get('/appointments', (req, res) => {
  const { date, from, to, q, status } = req.query;
  const where = [];
  const args = [];
  if (date) { if (!isDate(date)) throw bad('تاريخ غير صالح'); where.push('a.date = ?'); args.push(date); }
  if (from) { if (!isDate(from)) throw bad('تاريخ غير صالح'); where.push('a.date >= ?'); args.push(from); }
  if (to) { if (!isDate(to)) throw bad('تاريخ غير صالح'); where.push('a.date <= ?'); args.push(to); }
  if (status) { if (!STATUSES.includes(status)) throw bad('حالة غير صالحة'); where.push('a.status = ?'); args.push(status); }
  if (q) {
    where.push('(a.client_name LIKE ? OR a.phone LIKE ?)');
    args.push(`%${String(q).slice(0, 40)}%`, `%${String(q).slice(0, 40)}%`);
  }
  const sql = `${APPT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.date, a.time LIMIT 500`;
  res.json(db.prepare(sql).all(...args).map(withBalance));
});

api.get('/appointments/:id', (req, res) => res.json(getAppt(idParam(req))));

api.post('/appointments', (req, res) => {
  const a = parseAppointment(req.body);
  const status = req.body.status && STATUSES.includes(req.body.status) ? req.body.status : 'booked';
  const info = db.prepare(
    `INSERT INTO appointments (client_name, phone, date, time, service, price, status, walk_in, note)
     VALUES (@client_name, @phone, @date, @time, @service, @price, @status, @walk_in, @note)`,
  ).run({ ...a, status, walk_in: req.body.walk_in ? 1 : 0 });
  const id = Number(info.lastInsertRowid);
  const deposit = money(req.body.deposit, 'العربون');
  if (deposit > 0) db.prepare('INSERT INTO payments (appointment_id, amount) VALUES (?, ?)').run(id, deposit);
  res.status(201).json(getAppt(id));
});

api.patch('/appointments/:id', (req, res) => {
  const id = idParam(req);
  getAppt(id);
  const fields = parseAppointment(req.body, { partial: true });
  const keys = Object.keys(fields);
  if (keys.length) {
    db.prepare(`UPDATE appointments SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...fields, id });
  }
  res.json(getAppt(id));
});

api.delete('/appointments/:id', (req, res) => {
  const id = idParam(req);
  getAppt(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- payments ---
api.get('/appointments/:id/payments', (req, res) => {
  const id = idParam(req);
  getAppt(id);
  res.json(db.prepare('SELECT * FROM payments WHERE appointment_id = ? ORDER BY id').all(id));
});

api.post('/appointments/:id/payments', (req, res) => {
  const id = idParam(req);
  getAppt(id);
  const amount = money(req.body.amount, 'المبلغ');
  if (amount <= 0) throw bad('المبلغ يجب أن يكون أكبر من صفر');
  db.prepare('INSERT INTO payments (appointment_id, amount) VALUES (?, ?)').run(id, amount);
  res.status(201).json(getAppt(id));
});

api.delete('/payments/:id', (req, res) => {
  const id = idParam(req);
  const row = db.prepare('SELECT appointment_id FROM payments WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'الدفعة غير موجودة');
  db.prepare('DELETE FROM payments WHERE id = ?').run(id);
  res.json(getAppt(row.appointment_id));
});

// --- clients (grouped by phone; walk-ins without a phone are grouped by name) ---
const CLIENT_KEY = `CASE WHEN a.phone != '' THEN a.phone ELSE 'name:' || a.client_name END`;

api.get('/clients', (req, res) => {
  const q = req.query.q ? `%${String(req.query.q).slice(0, 40)}%` : null;
  const rows = db.prepare(`
    SELECT ${CLIENT_KEY} AS key, MAX(a.client_name) AS name, a.phone AS phone,
      COUNT(*) AS visits,
      SUM(a.status = 'came') AS came,
      SUM(a.status = 'no_show') AS no_show,
      MAX(a.date) AS last_date,
      SUM(CASE WHEN a.status IN ('booked','came') THEN a.price ELSE 0 END) AS total,
      COALESCE(SUM(CASE WHEN a.status IN ('booked','came') THEN
        (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.appointment_id = a.id) ELSE 0 END), 0) AS paid
    FROM appointments a
    ${q ? 'WHERE a.client_name LIKE @q OR a.phone LIKE @q' : ''}
    GROUP BY ${CLIENT_KEY}
    ORDER BY last_date DESC LIMIT 500`).all(q ? { q } : {});
  res.json(rows.map((r) => ({ ...r, remaining: Math.max(0, r.total - r.paid) })));
});

api.get('/clients/history', (req, res) => {
  const phone = normPhone(req.query.phone);
  const name = str(req.query.name, 80);
  if (!phone && !name) throw bad('مطلوب رقم أو اسم');
  const rows = phone
    ? db.prepare(`${APPT_SELECT} WHERE a.phone = ? ORDER BY a.date DESC, a.time DESC`).all(phone)
    : db.prepare(`${APPT_SELECT} WHERE a.phone = '' AND a.client_name = ? ORDER BY a.date DESC, a.time DESC`).all(name);
  res.json(rows.map(withBalance));
});

// --- stats for a day + overall outstanding ---
api.get('/stats', (req, res) => {
  const date = req.query.date;
  if (!isDate(date)) throw bad('تاريخ غير صالح');
  const day = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(status = 'booked') AS booked, SUM(status = 'came') AS came,
      SUM(status = 'no_show') AS no_show, SUM(status = 'cancelled') AS cancelled,
      SUM(walk_in) AS walk_in
    FROM appointments WHERE date = ?`).get(date);
  const collected = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p
    JOIN appointments a ON a.id = p.appointment_id WHERE a.date = ?`).get(date).v;
  const outstanding = db.prepare(`
    SELECT COALESCE(SUM(MAX(a.price - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.appointment_id = a.id), 0), 0)), 0) AS v
    FROM appointments a WHERE a.status IN ('booked','came')`).get().v;
  const num = (v) => v || 0;
  res.json({
    total: num(day.total), booked: num(day.booked), came: num(day.came),
    no_show: num(day.no_show), cancelled: num(day.cancelled), walk_in: num(day.walk_in),
    collected, outstanding,
  });
});

// --- backup download ---
api.get('/backup', async (req, res) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const tmp = path.join(BACKUP_DIR, `download-${crypto.randomBytes(6).toString('hex')}.tmp`);
  await db.backup(tmp);
  res.download(tmp, `salon-${new Date().toISOString().slice(0, 10)}.db`, () => fs.rmSync(tmp, { force: true }));
});

// --- notes ---
api.get('/notes', (req, res) => {
  res.json(db.prepare('SELECT * FROM notes ORDER BY done, pinned DESC, id DESC LIMIT 500').all()
    .map((n) => ({ ...n, pinned: !!n.pinned, done: !!n.done })));
});

api.post('/notes', (req, res) => {
  const text = str(req.body.text, 2000);
  if (!text) throw bad('اكتب نص الملاحظة');
  const info = db.prepare('INSERT INTO notes (text) VALUES (?)').run(text);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

api.patch('/notes/:id', (req, res) => {
  const id = idParam(req);
  if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw new HttpError(404, 'الملاحظة غير موجودة');
  if (req.body.text !== undefined) {
    const text = str(req.body.text, 2000);
    if (!text) throw bad('اكتب نص الملاحظة');
    db.prepare('UPDATE notes SET text = ? WHERE id = ?').run(text, id);
  }
  if (req.body.pinned !== undefined) db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(req.body.pinned ? 1 : 0, id);
  if (req.body.done !== undefined) db.prepare('UPDATE notes SET done = ? WHERE id = ?').run(req.body.done ? 1 : 0, id);
  res.json({ ok: true });
});

api.delete('/notes/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ?').run(idParam(req));
  res.json({ ok: true });
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));

// the tablet keeps the page open for days: always revalidate code, cache the drawings for a day
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders(res, file) {
    res.set('Cache-Control', /\.(svg|png)$/.test(file) ? 'public, max-age=86400' : 'no-cache');
  },
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'طلب غير صالح' });
  console.error(err);
  res.status(500).json({ error: 'خطأ في الخادم' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`${SALON_NAME} يعمل على http://localhost:${PORT}`));
  const backup = () => makeBackup().catch((err) => console.error('backup failed:', err));
  backup();
  setInterval(backup, 6 * 3600e3).unref();
}

module.exports = app;
