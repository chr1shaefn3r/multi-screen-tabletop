// Networking. Vercel can't hold WebSocket connections, so devices talk to the game
// master directly over WebRTC data channels. The Vercel API only passes the one-time
// connection "offer" and "answer" between them (signalling).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function post(path, body, secret) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = 'Bearer ' + secret;
  let r;
  try {
    r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Network error. Are you online?'), { status: 0 });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}

// Wait until all ICE candidates are in the description, so one offer/answer
// round trip is enough (no trickle ICE through the server).
function gathered(pc, ms = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function opened(dc, ms) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    const t = setTimeout(() => reject(new Error('Could not connect to the game master. Are both devices on the same Wi-Fi?')), ms);
    dc.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const desc = (d) => ({ type: d.type, sdp: d.sdp });

export function transport(dc, pc) {
  return {
    send(msg) {
      if (dc.readyState !== 'open') return;
      try {
        dc.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('send failed', e);
      }
    },
    close() {
      try {
        dc.close();
        pc.close();
      } catch {}
    },
  };
}

// Player side: connect to the game master of session `code`.
export async function join(code, status) {
  const { iceServers } = await post('/api/join', { action: 'check', code });
  const pc = new RTCPeerConnection({ iceServers });
  try {
    const dc = pc.createDataChannel('table', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const { peerId } = await post('/api/join', { action: 'offer', code, offer: desc(pc.localDescription) });
    status('Waiting for the game master…');
    const deadline = Date.now() + 45000;
    let answer = null;
    while (!answer) {
      if (Date.now() > deadline) throw new Error('The game master did not answer. Is their screen still on?');
      await sleep(1000);
      ({ answer } = await post('/api/join', { action: 'answer', code, peerId }));
    }
    status('Connecting…');
    await pc.setRemoteDescription(answer);
    await opened(dc, 15000);
    return { pc, dc };
  } catch (e) {
    pc.close();
    throw e;
  }
}

// Game master side: answer one device's offer.
export async function accept(offer, iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  const channel = new Promise((resolve) => (pc.ondatachannel = (e) => resolve(e.channel)));
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { pc, answer: desc(pc.localDescription), channel };
}
