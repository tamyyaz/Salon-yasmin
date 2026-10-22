import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDate, isTime, parseAppointment, ValidationError, dueOf, withBalance, filterAppointments, groupClients,
  clientHistory, dayStats, sortNotes, addDays, ymd,
} from '../src/logic.js';

const appt = (o = {}) => ({ id: Math.random().toString(36).slice(2), client_name: 'ليلى', phone: '0791234567', date: '2026-03-01', time: '10:00',
  service: '', price: 100, status: 'booked', walk_in: false, note: '', payments: [], ...o });
const pay = (amount) => ({ id: Math.random().toString(36).slice(2), amount, paid_at: '2026-03-01T10:00:00.000Z' });

test('dates and times are validated strictly', () => {
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('2026-13-01'));
  assert.ok(!isDate('26-1-1'));
  assert.ok(isTime('00:00') && isTime('23:59'));
  assert.ok(!isTime('24:00') && !isTime('9:30') && !isTime('10:60'));
});

test('appointment parsing normalises and rejects bad input', () => {
  const ok = parseAppointment({ client_name: '  ليلى ', phone: '0791 234-567', date: '2026-03-01', time: '14:30', price: '120.5', service: 'صبغة', note: 'x' });
  assert.equal(ok.client_name, 'ليلى');
  assert.equal(ok.phone, '0791234567');
  assert.equal(ok.price, 120.5);
  const base = { client_name: 'x', date: '2026-03-01', time: '10:00', price: 0 };
  for (const patch of [{ client_name: ' ' }, { date: '2026-02-30' }, { time: '25:00' }, { price: -5 }, { price: 'abc' }, { status: 'hacked' }]) {
    assert.throws(() => parseAppointment({ ...base, ...patch }), ValidationError, JSON.stringify(patch));
  }
  assert.deepEqual(parseAppointment({ status: 'came' }, { partial: true }), { status: 'came' });
});

test('balances: payments reduce what is owed; no-show/cancelled owe nothing', () => {
  const a = appt({ price: 100, payments: [pay(30), pay(20)] });
  assert.equal(withBalance(a).paid, 50);
  assert.equal(dueOf(a), 50);
  assert.equal(dueOf({ ...a, payments: [pay(150)] }), 0);          // overpaid never goes negative
  assert.equal(dueOf({ ...a, status: 'no_show' }), 0);
  assert.equal(dueOf({ ...a, status: 'cancelled' }), 0);
  assert.equal(dueOf(appt({ price: 0.1 + 0.2, payments: [pay(0.3)] })), 0); // float noise
});

test('filtering and ordering', () => {
  const list = [appt({ date: '2026-03-02', time: '09:00', client_name: 'رنا', phone: '0777' }), appt({ date: '2026-03-01', time: '15:00' }), appt({ date: '2026-03-01', time: '10:00', status: 'came' })];
  assert.deepEqual(filterAppointments(list, { date: '2026-03-01' }).map((a) => a.time), ['10:00', '15:00']);
  assert.equal(filterAppointments(list, { from: '2026-03-02' }).length, 1);
  assert.equal(filterAppointments(list, { to: '2026-03-01', status: 'came' }).length, 1);
  assert.equal(filterAppointments(list, { q: 'رنا' }).length, 1);
  assert.equal(filterAppointments(list, { q: '0791' }).length, 2);
});

test('clients group by phone, walk-ins without a phone by name', () => {
  const list = [
    appt({ date: '2026-03-01', price: 100, payments: [pay(30)], status: 'came' }),
    appt({ date: '2026-03-05', price: 50, status: 'no_show' }),
    appt({ client_name: 'زبون مفاجئ', phone: '', walk_in: true, price: 40, payments: [pay(10)], status: 'came' }),
  ];
  const clients = groupClients(list);
  assert.equal(clients.length, 2);
  const layla = clients.find((c) => c.phone === '0791234567');
  assert.equal(layla.visits, 2);
  assert.equal(layla.came, 1);
  assert.equal(layla.no_show, 1);
  assert.equal(layla.remaining, 70);                                  // the no-show's 50 is not owed
  assert.equal(layla.last_date, '2026-03-05');
  assert.equal(clients.find((c) => !c.phone).remaining, 30);
  assert.equal(groupClients(list, 'مفاجئ').length, 1);
  assert.equal(clientHistory(list, { phone: '0791234567' }).length, 2);
  assert.equal(clientHistory(list, { phone: '', name: 'زبون مفاجئ' }).length, 1);
});

test('day stats include collected cash and all-time outstanding', () => {
  const list = [
    appt({ date: '2026-03-01', status: 'came', price: 100, payments: [pay(60)] }),
    appt({ date: '2026-03-01', status: 'no_show' }),
    appt({ date: '2026-03-01', walk_in: true, status: 'came', price: 20, payments: [pay(20)] }),
    appt({ date: '2026-01-10', status: 'came', price: 80 }),         // old debt still counts
  ];
  const s = dayStats(list, '2026-03-01');
  assert.deepEqual([s.total, s.came, s.no_show, s.walk_in, s.collected, s.outstanding], [3, 2, 1, 1, 80, 120]);
});

test('pending (customer-requested) appointments are counted but never owed', () => {
  const list = [appt({ date: '2026-03-01', status: 'pending', price: 100 }), appt({ date: '2026-03-01', status: 'booked', price: 50 })];
  assert.equal(dueOf(list[0]), 0);
  const s = dayStats(list, '2026-03-01');
  assert.deepEqual([s.total, s.pending, s.booked, s.outstanding], [2, 1, 1, 50]);
  assert.equal(parseAppointment({ status: 'pending' }, { partial: true }).status, 'pending');
});

test('notes: open before done, pinned first, newest first', () => {
  const n = (id, o) => ({ id, text: id, pinned: false, done: false, created_at: `2026-01-0${id}`, ...o });
  const sorted = sortNotes([n('1', { done: true }), n('2'), n('3', { pinned: true }), n('4')]);
  assert.deepEqual(sorted.map((x) => x.id), ['3', '4', '2', '1']);
});

test('date helpers', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
});
