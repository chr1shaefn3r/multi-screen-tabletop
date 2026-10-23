// Runs the API against a real Redis server through REDIS_URL (skipped if redis-server isn't installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;
const port = 20000 + Math.floor(Math.random() * 20000);
let server;

before(async () => {
  if (!hasRedis) return;
  server = spawn('redis-server', ['--port', String(port), '--requirepass', 'p@ss:word', '--save', '', '--appendonly', 'no']);
  await sleep(300);
  process.env.REDIS_URL = `redis://default:${encodeURIComponent('p@ss:word')}@127.0.0.1:${port}`;
  process.env.HOST_SECRET = 'test-secret-123';
  delete process.env.VERCEL;
});

after(() => server?.kill());

async function call(fn, body, auth) {
  const req = { method: 'POST', headers: { 'x-forwarded-for': '10.1.1.1', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body };
  let status = 200, out = '';
  await fn(req, { setHeader() {}, set statusCode(s) { status = s; }, end(s) { out = s; } });
  return { status, body: JSON.parse(out) };
}

test('join handshake through REDIS_URL', { skip: !hasRedis && 'redis-server not installed' }, async () => {
  const host = (await import('../api/host.js')).default;
  const join = (await import('../api/join.js')).default;
  const sdp = (type) => ({ type, sdp: 'v=0\r\n' });

  const created = await call(host, { action: 'create' }, 'test-secret-123');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const { code } = created.body;
  const { body: offered } = await call(join, { action: 'offer', code, offer: sdp('offer') });
  const { body: polled } = await call(host, { action: 'poll', code }, 'test-secret-123'); // MULTI/EXEC
  assert.equal(polled.offers[0].peerId, offered.peerId);
  await call(host, { action: 'answer', code, peerId: offered.peerId, answer: sdp('answer') }, 'test-secret-123');
  const got = await call(join, { action: 'answer', code, peerId: offered.peerId });
  assert.equal(got.body.answer.type, 'answer');
  assert.equal((await call(join, { action: 'check', code: '12345678' })).status, 404);

  // survives a dropped connection
  globalThis.__tiletopRedis.client.destroy();
  assert.equal((await call(join, { action: 'check', code })).status, 200);
});

test('wrong Redis password gives a clear error', { skip: !hasRedis && 'redis-server not installed' }, async () => {
  const { RedisStore } = await import('../lib/store.js');
  const bad = new RedisStore(`redis://default:wrong@127.0.0.1:${port}`);
  await assert.rejects(bad.cmd('GET', 'x'), /WRONGPASS|invalid/i);
});
