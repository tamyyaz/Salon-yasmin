'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SALON_PASSWORD = 'test-pass-123';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-test-'));

const app = require('../server.js');

let base;
let server;
let cookie = '';

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, body, { auth = true } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

test('api is locked without a session', async () => {
  for (const url of ['/api/appointments', '/api/clients', '/api/notes', '/api/stats?date=2026-01-01']) {
    assert.equal((await call('GET', url, null, { auth: false })).status, 401);
  }
});

test('wrong password is rejected, right password sets cookie', async () => {
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  const ok = await call('POST', '/api/login', { password: 'test-pass-123' });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  assert.equal((await call('GET', '/api/appointments')).status, 200);
});

test('forged session cookie is rejected', async () => {
  const res = await fetch(`${base}/api/appointments`, { headers: { Cookie: `salon_session=${Date.now() + 1e9}.forged` } });
  assert.equal(res.status, 401);
});

test('appointment lifecycle with payments and balance', async () => {
  const created = await call('POST', '/api/appointments', {
    client_name: 'ليلى', phone: '0791 234 567', date: '2026-03-01', time: '14:30', service: 'صبغة', price: 100, deposit: 30,
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.phone, '0791234567');
  assert.equal(created.body.paid, 30);
  assert.equal(created.body.remaining, 70);

  const pay = await call('POST', `/api/appointments/${id}/payments`, { amount: 20 });
  assert.equal(pay.body.remaining, 50);

  const came = await call('PATCH', `/api/appointments/${id}`, { status: 'came' });
  assert.equal(came.body.status, 'came');

  const clients = await call('GET', '/api/clients');
  const c = clients.body.find((x) => x.phone === '0791234567');
  assert.equal(c.remaining, 50);
  assert.equal(c.came, 1);

  const stats = await call('GET', '/api/stats?date=2026-03-01');
  assert.equal(stats.body.came, 1);
  assert.equal(stats.body.collected, 50);
  assert.equal(stats.body.outstanding, 50);

  const payments = await call('GET', `/api/appointments/${id}/payments`);
  const del = await call('DELETE', `/api/payments/${payments.body[0].id}`);
  assert.equal(del.body.remaining, 80);

  const noShow = await call('PATCH', `/api/appointments/${id}`, { status: 'no_show' });
  assert.equal(noShow.body.remaining, 0);
});

test('walk-in client without phone is grouped by name', async () => {
  const w = await call('POST', '/api/appointments', {
    client_name: 'زبون مفاجئ', date: '2026-03-02', time: '11:05', price: 40, status: 'came', walk_in: true, deposit: 40,
  });
  assert.equal(w.body.walk_in, true);
  assert.equal(w.body.remaining, 0);
  const stats = await call('GET', '/api/stats?date=2026-03-02');
  assert.equal(stats.body.walk_in, 1);
  const hist = await call('GET', `/api/clients/history?name=${encodeURIComponent('زبون مفاجئ')}`);
  assert.equal(hist.body.length, 1);
});

test('validation errors', async () => {
  const base1 = { client_name: 'x', date: '2026-03-01', time: '10:00', price: 0 };
  assert.equal((await call('POST', '/api/appointments', { ...base1, client_name: ' ' })).status, 400);
  assert.equal((await call('POST', '/api/appointments', { ...base1, date: '2026-13-45' })).status, 400);
  assert.equal((await call('POST', '/api/appointments', { ...base1, time: '25:00' })).status, 400);
  assert.equal((await call('POST', '/api/appointments', { ...base1, price: -5 })).status, 400);
  assert.equal((await call('POST', '/api/appointments', { ...base1, status: 'hacked' })).status, 400);
  assert.equal((await call('GET', '/api/appointments/9999')).status, 404);
  assert.equal((await call('POST', '/api/appointments/9999/payments', { amount: 5 })).status, 404);
});

test('notes: create, pin, complete, delete', async () => {
  const n = await call('POST', '/api/notes', { text: 'اطلب مواد صبغة' });
  assert.equal(n.status, 201);
  await call('PATCH', `/api/notes/${n.body.id}`, { pinned: true, done: true });
  const list = await call('GET', '/api/notes');
  assert.equal(list.body[0].pinned, true);
  assert.equal(list.body[0].done, true);
  await call('DELETE', `/api/notes/${n.body.id}`);
  assert.equal((await call('GET', '/api/notes')).body.length, 0);
});

test('backup download is a SQLite file and requires login', async () => {
  assert.equal((await call('GET', '/api/backup', null, { auth: false })).status, 401);
  const res = await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 15).toString();
  assert.equal(head, 'SQLite format 3');
});

test('healthz is public and config exposes slot settings', async () => {
  assert.equal((await call('GET', '/healthz', null, { auth: false })).body.ok, true);
  const cfg = await call('GET', '/api/config', null, { auth: false });
  assert.equal(cfg.body.openHour, 9);
  assert.equal(cfg.body.slotMinutes, 30);
});

test('login lockout after repeated failures', async () => {
  // earlier failures from this IP count too; a few more must trigger 429
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/login', { password: 'bad' });
  assert.equal(last.status, 429);
});
