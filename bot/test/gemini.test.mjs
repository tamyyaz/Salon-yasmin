import test from 'node:test';
import assert from 'node:assert/strict';
import { createGemini } from '../lib/gemini.js';

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }), text: async () => '' });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => `{"error":{"code":${status}}}` });
const args = { system: 's', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [] };
const make = (responses, extra = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ model: url.match(/models\/([^:]+):/)[1], key: init.headers['x-goog-api-key'], url }); return responses.shift(); };
  return { calls, g: createGemini({ apiKey: 'KEY', fetchImpl, retryDelayMs: 1, ...extra }) };
};

test('returns the model content untouched and sends the key in a header only', async () => {
  const { g, calls } = make([ok('أهلين')]);
  assert.equal((await g.generate(args)).parts[0].text, 'أهلين');
  assert.equal(calls[0].key, 'KEY');
  assert.ok(!calls[0].url.includes('KEY'));
});

test('a brief 503 is retried on the same model', async () => {
  const { g, calls } = make([fail(503), ok('تمام')]);
  assert.equal((await g.generate(args)).parts[0].text, 'تمام');
  assert.deepEqual(calls.map((c) => c.model), ['gemini-flash-lite-latest', 'gemini-flash-lite-latest']);
});

test('a lasting overload falls back to the lighter model', async () => {
  const { g, calls } = make([fail(503), fail(503), ok('من الاحتياطي')]);
  assert.equal((await g.generate(args)).parts[0].text, 'من الاحتياطي');
  assert.equal(calls.at(-1).model, 'gemini-flash-latest');
});

test('rate limits (429) are treated like overload', async () => {
  const { g } = make([fail(429), ok('بعد الانتظار')]);
  assert.equal((await g.generate(args)).parts[0].text, 'بعد الانتظار');
});

test('everything down: throws the last error; a bad request is not retried', async () => {
  const down = make(Array.from({ length: 4 }, () => fail(503)));
  await assert.rejects(down.g.generate(args), /Gemini 503 \(gemini-flash-latest\)/);
  assert.equal(down.calls.length, 4);
  const bad = make([fail(400), ok('never')]);
  await assert.rejects(bad.g.generate(args), /Gemini 400/);
  assert.equal(bad.calls.length, 1);
});

test('empty answers and a missing key are errors', async () => {
  await assert.rejects(make([{ ok: true, status: 200, json: async () => ({ candidates: [] }) }]).g.generate(args), /no content/);
  assert.throws(() => createGemini({ apiKey: '' }), /GEMINI_API_KEY/);
  const { g, calls } = make([ok('x')], { fallbackModels: [] });
  await g.generate(args);
  assert.equal(calls.length, 1);
});

test('a model that just failed is skipped for a few minutes (no waiting on it for every message)', async () => {
  let clock = 1000;
  const { g, calls } = make([fail(503), fail(503), ok('lite 1'), ok('lite 2')], { now: () => clock, coolDownMs: 60000 });
  await g.generate(args);
  await g.generate(args);
  assert.deepEqual(calls.map((c) => c.model), ['gemini-flash-lite-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-flash-latest']);
  clock += 61000;
  const again = make([ok('main is back')], { now: () => clock });
  assert.equal((await again.g.generate(args)).parts[0].text, 'main is back');
});

test('check(): reports each model, including a rejected key, without throwing', async () => {
  const bad = make([{ ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid"}}' }, { ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid"}}' }]);
  const r = await bad.g.check();
  assert.deepEqual(r.map((x) => [x.model, x.ok, x.status]), [['gemini-flash-lite-latest', false, 400], ['gemini-flash-latest', false, 400]]);
  assert.match(r[0].message, /API key not valid/);
  const mixed = make([fail(503), ok('x')]);
  assert.deepEqual((await mixed.g.check()).map((x) => x.ok), [false, true]);
});
