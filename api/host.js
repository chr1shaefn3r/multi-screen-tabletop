// Game master endpoint. Every call needs the HOST_SECRET as a Bearer token,
// so only the owner of the deployment can open tables.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { getStore } from '../lib/store.js';
import { handler, HttpError, clientIp, describeSdp, iceServers, validCode, validDesc, validPeer, SESSION_TTL } from '../lib/http.js';

const MAX_FAILS = 10; // wrong passwords per IP per hour

const sha = (s) => createHash('sha256').update(String(s)).digest();
// 8 digits: typed on the phone's number pad; 100 million codes, guessing is rate limited
const newCode = () => String(randomInt(100_000_000)).padStart(8, '0');
// ICE server list for the log, without logins.
const describeIce = () => iceServers().map((s) => [].concat(s.urls).join(',') + (s.username ? ' (with login)' : '')).join('; ') || 'none';
const notFound = () => new HttpError(404, 'This game session has expired.');

export default handler('host', async (req, body, ctx) => {
  const secret = process.env.HOST_SECRET;
  if (!secret || secret.length < 8) {
    throw new HttpError(500, 'HOST_SECRET is not set on the server (use at least 8 characters).');
  }
  const store = getStore();

  const failKey = `authfail:${clientIp(req)}`;
  const fails = Number((await store.cmd('GET', failKey)) || 0);
  if (fails >= MAX_FAILS) {
    throw new HttpError(429, 'Too many wrong passwords. Try again in an hour.');
  }
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(sha(given), sha(secret))) {
    await store.pipeline([
      ['INCR', failKey],
      ['EXPIRE', failKey, '3600'],
    ]);
    ctx.note(`wrong password attempt ${fails + 1} of ${MAX_FAILS} before a 1 hour lockout`);
    throw new HttpError(401, 'Wrong host password.');
  }

  const { action, code } = body;
  if (action === 'create') {
    for (let i = 0; i < 5; i++) {
      const c = newCode();
      const session = JSON.stringify({ open: true, t: Date.now() });
      if (await store.cmd('SET', `s:${c}`, session, 'EX', SESSION_TTL, 'NX')) {
        ctx.code = c;
        ctx.note(`new game opened, ICE servers: ${describeIce()}`);
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
      ctx.note(action === 'resume' ? 'game master reloaded the page and resumed the game' : open ? 'lobby opened' : 'lobby closed');
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
      if (!offers.length) ctx.quiet = true; // routine poll, only logged with LOG_LEVEL=debug
      for (const o of offers) {
        ctx.note(`handed offer peer=${o.peerId} to the game master (it waited ${((Date.now() - (o.t || Date.now())) / 1000).toFixed(1)}s)`);
        delete o.t;
      }
      if (!offers.length) ctx.note('no devices waiting');
      return { offers };
    }
    // Hand the answer for one joining device back to it.
    case 'answer': {
      if (!validPeer(body.peerId) || !validDesc(body.answer, 'answer')) throw new HttpError(400, 'Invalid answer.');
      const answer = JSON.stringify({ type: 'answer', sdp: body.answer.sdp, t: Date.now() });
      await store.cmd('SET', `a:${code}:${body.peerId}`, answer, 'EX', '300');
      ctx.note(`stored answer for peer=${body.peerId}, answer has ${describeSdp(body.answer.sdp)}`);
      return { ok: true };
    }
    case 'end':
      await store.cmd('DEL', sKey, oKey);
      ctx.note('game ended by the game master');
      return { ok: true };
    default:
      throw new HttpError(400, 'Unknown action.');
  }
});
