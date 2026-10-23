// Game master endpoint. Every call needs the HOST_SECRET as a Bearer token,
// so only the owner of the deployment can open tables.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { getStore } from '../lib/store.js';
import { handler, HttpError, clientIp, iceServers, validCode, validDesc, validPeer, SESSION_TTL } from '../lib/http.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_FAILS = 10; // wrong passwords per IP per hour

const sha = (s) => createHash('sha256').update(String(s)).digest();
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const notFound = () => new HttpError(404, 'This game session has expired.');

export default handler(async (req, body) => {
  const secret = process.env.HOST_SECRET;
  if (!secret || secret.length < 8) {
    throw new HttpError(500, 'HOST_SECRET is not set on the server (use at least 8 characters).');
  }
  const store = getStore();

  const failKey = `authfail:${clientIp(req)}`;
  if (Number((await store.cmd('GET', failKey)) || 0) >= MAX_FAILS) {
    throw new HttpError(429, 'Too many wrong passwords. Try again in an hour.');
  }
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(sha(given), sha(secret))) {
    await store.pipeline([
      ['INCR', failKey],
      ['EXPIRE', failKey, '3600'],
    ]);
    throw new HttpError(401, 'Wrong host password.');
  }

  const { action, code } = body;
  if (action === 'create') {
    for (let i = 0; i < 5; i++) {
      const c = newCode();
      const session = JSON.stringify({ open: true, t: Date.now() });
      if (await store.cmd('SET', `s:${c}`, session, 'EX', SESSION_TTL, 'NX')) {
        return { code: c, iceServers: iceServers() };
      }
    }
    throw new HttpError(500, 'Could not create a game code, please try again.');
  }

  if (!validCode(code)) throw new HttpError(400, 'Invalid code.');
  const sKey = `s:${code}`;
  const oKey = `o:${code}`;

  switch (action) {
    // Re-attach to an existing session (after a page reload) or open/close the lobby.
    case 'resume':
    case 'lobby': {
      const open = action === 'resume' ? true : !!body.open;
      const ok = await store.cmd('SET', sKey, JSON.stringify({ open, t: Date.now() }), 'EX', SESSION_TTL, 'XX');
      if (!ok) throw notFound();
      return { open, iceServers: iceServers() };
    }
    // Fetch (and remove) the connection offers of devices that want to join.
    case 'poll': {
      const [list, , alive] = await store.tx([
        ['LRANGE', oKey, '0', '-1'],
        ['DEL', oKey],
        ['EXPIRE', sKey, String(SESSION_TTL)],
      ]);
      if (!alive) throw notFound();
      const offers = (list || [])
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return { offers };
    }
    // Hand the answer for one joining device back to it.
    case 'answer': {
      if (!validPeer(body.peerId) || !validDesc(body.answer, 'answer')) throw new HttpError(400, 'Invalid answer.');
      const answer = JSON.stringify({ type: 'answer', sdp: body.answer.sdp });
      await store.cmd('SET', `a:${code}:${body.peerId}`, answer, 'EX', '300');
      return { ok: true };
    }
    case 'end':
      await store.cmd('DEL', sKey, oKey);
      return { ok: true };
    default:
      throw new HttpError(400, 'Unknown action.');
  }
});
