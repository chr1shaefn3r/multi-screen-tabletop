// Player endpoint: a device with a valid game code posts its WebRTC offer here
// and polls for the game master's answer. Rate limited per IP.
import { randomBytes } from 'node:crypto';
import { getStore } from '../lib/store.js';
import { handler, HttpError, clientIp, iceServers, rateLimit, validCode, validDesc, validPeer } from '../lib/http.js';

const MAX_PENDING = 16; // offers waiting for the game master per session

export default handler(async (req, body) => {
  const store = getStore();
  const ip = clientIp(req);
  const { action, code } = body;
  if (!validCode(code)) throw new HttpError(400, 'That code does not look right (6 letters and digits).');

  if (action === 'answer') {
    // Several phones on the same Wi-Fi share one IP, so this limit is generous.
    await rateLimit(store, `p:${ip}`, 300, 60);
    if (!validPeer(body.peerId)) throw new HttpError(400, 'Invalid request.');
    const key = `a:${code}:${body.peerId}`;
    const raw = await store.cmd('GET', key);
    if (!raw) return { answer: null };
    await store.cmd('DEL', key);
    return { answer: JSON.parse(raw) };
  }

  await rateLimit(store, `j:${ip}`, 40, 60);
  const raw = await store.cmd('GET', `s:${code}`);
  if (!raw) throw new HttpError(404, 'No game with this code. Check the code with your game master.');
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    session = {};
  }
  if (!session.open) throw new HttpError(403, 'The game master has closed the lobby.');

  if (action === 'check') return { iceServers: iceServers() };

  if (action === 'offer') {
    if (!validDesc(body.offer, 'offer')) throw new HttpError(400, 'Invalid offer.');
    const oKey = `o:${code}`;
    if ((await store.cmd('LLEN', oKey)) >= MAX_PENDING) {
      throw new HttpError(429, 'Too many devices are joining right now. Try again in a moment.');
    }
    const peerId = randomBytes(9).toString('base64url');
    await store.pipeline([
      ['RPUSH', oKey, JSON.stringify({ peerId, offer: { type: 'offer', sdp: body.offer.sdp } })],
      ['EXPIRE', oKey, '120'],
    ]);
    return { peerId };
  }

  throw new HttpError(400, 'Unknown action.');
});
