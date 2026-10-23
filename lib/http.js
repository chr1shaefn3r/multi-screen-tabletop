// Shared helpers for the API endpoints.
import { createHash } from 'node:crypto';

export const SESSION_TTL = 6 * 60 * 60; // seconds a game code stays valid without activity
const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw new HttpError(413, 'Request too large.');
  let body;
  try {
    body = req.body; // Vercel parses JSON bodies for us (and throws on invalid JSON)
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(String(body) || '{}');
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
  return body;
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

const DEBUG = process.env.LOG_LEVEL === 'debug';

// Short anonymous tag per client IP, so log lines from the same device can be matched
// without writing IP addresses into the logs.
const tag = (ip) => '#' + createHash('sha256').update(ip).digest('hex').slice(0, 4);

// Wraps an endpoint: POST only, JSON in, JSON out, errors mapped to status codes.
// Writes one log line per request, e.g.
//   [tiletop] join/offer code=K7RX2M from=#3fa2 → 200 in 41ms | peer=abc… offer has 2 addresses: host udp ×1 (mDNS), srflx udp ×1
// Endpoints add details with ctx.note(); ctx.quiet hides routine calls (empty polls) unless LOG_LEVEL=debug.
export function handler(name, fn) {
  return async (req, res) => {
    const t0 = Date.now();
    const ctx = { notes: [], quiet: false, code: null, note: (s) => ctx.notes.push(s) };
    let status = 200, action = '?';
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
      const body = await readJson(req);
      action = typeof body.action === 'string' ? body.action.slice(0, 20) : '?';
      if (validCode(body.code)) ctx.code = body.code;
      send(res, 200, await fn(req, body, ctx));
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        ctx.note(e.message);
        send(res, e.status, { error: e.message });
      } else {
        status = 500;
        ctx.note(`unexpected error: ${e.stack || e}`);
        send(res, 500, { error: 'Server error, please try again.' });
      }
    }
    if (ctx.quiet && status === 200 && !DEBUG) return;
    const line = `[tiletop] ${name}/${action}${ctx.code ? ' code=' + ctx.code : ''} from=${tag(clientIp(req))} → ${status} in ${Date.now() - t0}ms${ctx.notes.length ? ' | ' + ctx.notes.join(' | ') : ''}`;
    (status >= 500 ? console.error : status >= 400 ? console.warn : console.log)(line);
  };
}

// "3 addresses: host udp ×2 (mDNS), srflx udp ×1" – what kind of network addresses an offer/answer contains.
export function describeSdp(sdp) {
  const groups = new Map();
  for (const line of String(sdp).split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const f = line.slice(12).split(/\s+/);
    if (f.length < 8) continue;
    const key = `${f[7]} ${f[2].toLowerCase()}`;
    const g = groups.get(key) || { n: 0, mdns: false };
    g.n++;
    g.mdns ||= f[4].endsWith('.local');
    groups.set(key, g);
  }
  const total = [...groups.values()].reduce((a, g) => a + g.n, 0);
  if (!total) return 'NO network addresses (cannot connect)';
  return `${total} address(es): ` + [...groups].map(([k, g]) => `${k} ×${g.n}${g.mdns ? ' (mDNS)' : ''}`).join(', ');
}

export function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  const ip = (xf ? String(xf).split(',')[0] : req.headers['x-real-ip']) || req.socket?.remoteAddress || 'unknown';
  return String(ip).trim().slice(0, 64);
}

// Fixed-window rate limit per key.
export async function rateLimit(store, key, limit, windowSec) {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const [n] = await store.pipeline([
    ['INCR', k],
    ['EXPIRE', k, String(windowSec)],
  ]);
  if (n > limit) throw new HttpError(429, 'Too many requests. Please wait a minute.');
}

// STUN/TURN servers handed to the browsers. Override with the ICE_SERVERS env var (JSON array),
// e.g. to add a TURN server for networks where direct connections fail.
export function iceServers() {
  try {
    const v = JSON.parse(process.env.ICE_SERVERS || '');
    if (Array.isArray(v)) return v;
  } catch {}
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

export const validCode = (c) => typeof c === 'string' && /^[A-HJ-NP-Z2-9]{6}$/.test(c);
export const validPeer = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(p);
export const validDesc = (d, type) =>
  !!d && d.type === type && typeof d.sdp === 'string' && d.sdp.length < 20000 && d.sdp.startsWith('v=0');
