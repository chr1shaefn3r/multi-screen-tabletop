import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../lib/store.js';

process.env.HOST_SECRET = 'test-secret-123';
delete process.env.VERCEL;
const host = (await import('../api/host.js')).default;
const join = (await import('../api/join.js')).default;

const SDP = (type) => ({ type, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' });
let ipCounter = 0;
let ip;

beforeEach(() => {
  globalThis.__tiletopStore = new MemoryStore();
  ip = `10.0.0.${++ipCounter}`;
});

async function call(fn, body, { auth, method = 'POST', from = ip } = {}) {
  const req = { method, headers: { 'x-forwarded-for': from, ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body };
  let status = 200, out = '';
  const res = { setHeader() {}, set statusCode(s) { status = s; }, end(s) { out = s; } };
  await fn(req, res);
  return { status, body: JSON.parse(out) };
}
const asHost = (body) => call(host, body, { auth: 'test-secret-123' });

test('full join handshake', async () => {
  const { body: created } = await asHost({ action: 'create' });
  assert.match(created.code, /^\d{8}$/);
  const code = created.code;

  const check = await call(join, { action: 'check', code });
  assert.equal(check.status, 200);
  assert.ok(Array.isArray(check.body.iceServers));

  const { body: offered } = await call(join, { action: 'offer', code, offer: SDP('offer') });
  assert.ok(offered.peerId);

  const none = await call(join, { action: 'answer', code, peerId: offered.peerId });
  assert.equal(none.body.answer, null);

  const { body: polled } = await asHost({ action: 'poll', code });
  assert.equal(polled.offers.length, 1);
  assert.equal(polled.offers[0].peerId, offered.peerId);
  assert.equal((await asHost({ action: 'poll', code })).body.offers.length, 0, 'offers are consumed');

  await asHost({ action: 'answer', code, peerId: offered.peerId, answer: SDP('answer') });
  const got = await call(join, { action: 'answer', code, peerId: offered.peerId });
  assert.equal(got.body.answer.type, 'answer');
  assert.equal((await call(join, { action: 'answer', code, peerId: offered.peerId })).body.answer, null, 'answer is consumed');
});

test('only the game master can create sessions', async () => {
  assert.equal((await call(host, { action: 'create' })).status, 401);
  assert.equal((await call(host, { action: 'create' }, { auth: 'wrong' })).status, 401);
});

test('wrong passwords get locked out', async () => {
  for (let i = 0; i < 10; i++) await call(host, { action: 'create' }, { auth: 'nope' });
  const r = await call(host, { action: 'create' }, { auth: 'test-secret-123' });
  assert.equal(r.status, 429);
});

test('unknown codes and closed lobbies are refused', async () => {
  assert.equal((await call(join, { action: 'check', code: '12345678' })).status, 404);
  assert.equal((await call(join, { action: 'check', code: 'K7RX2M' })).status, 400);
  const { code } = (await asHost({ action: 'create' })).body;
  await asHost({ action: 'lobby', code, open: false });
  assert.equal((await call(join, { action: 'check', code })).status, 403);
  await asHost({ action: 'lobby', code, open: true });
  assert.equal((await call(join, { action: 'check', code })).status, 200);
});

test('ended sessions are gone', async () => {
  const { code } = (await asHost({ action: 'create' })).body;
  await asHost({ action: 'end', code });
  assert.equal((await asHost({ action: 'poll', code })).status, 404);
  assert.equal((await asHost({ action: 'resume', code })).status, 404);
});

test('join attempts are rate limited per IP', async () => {
  let last;
  for (let i = 0; i < 41; i++) last = await call(join, { action: 'check', code: '12345678' }, { from: '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('rejects bad input', async () => {
  const { code } = (await asHost({ action: 'create' })).body;
  assert.equal((await call(join, { action: 'offer', code, offer: { type: 'offer', sdp: 'x' } })).status, 400);
  assert.equal((await call(join, { action: 'offer', code, offer: { type: 'offer', sdp: 'v=0' + 'a'.repeat(30000) } })).status, 400);
  assert.equal((await call(join, { action: 'check', code }, { method: 'GET' })).status, 405);
  assert.equal((await asHost({ action: 'answer', code, peerId: '../../x', answer: SDP('answer') })).status, 400);
});

test('limits pending offers per session', async () => {
  const { code } = (await asHost({ action: 'create' })).body;
  let last;
  for (let i = 0; i < 17; i++) last = await call(join, { action: 'offer', code, offer: SDP('offer') }, { from: `1.1.1.${i}` });
  assert.equal(last.status, 429);
});
