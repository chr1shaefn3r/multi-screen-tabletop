// Shared helpers for the API endpoints.

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

// Wraps an endpoint: POST only, JSON in, JSON out, errors mapped to status codes.
export function handler(fn) {
  return async (req, res) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
      const body = await readJson(req);
      send(res, 200, await fn(req, body));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Server error, please try again.' });
    }
  };
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
