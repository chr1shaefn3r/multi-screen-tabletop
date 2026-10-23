// Networking. Devices talk to the game master directly over WebRTC data channels.
// The Vercel API only passes the one-time connection "offer" and "answer" between
// them (signalling).

import { log, logError, logCandidates, logIceServers, watchPeer } from './diag.js';

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
    const t = setTimeout(() => {
      log(`Still collecting network addresses after ${ms / 1000}s, continuing with what we have`);
      done();
    }, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function opened(dc, pc, ms, watch) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') return resolve();
    const fail = async (why) => {
      clearTimeout(t);
      logError(`${why} (connection state: ${pc.connectionState}, ICE: ${pc.iceConnectionState})`);
      await watch?.diagnose();
      reject(new Error(why + ' Tap "Connection details" to see why.'));
    };
    const t = setTimeout(() => fail(`No connection after ${ms / 1000}s.`), ms);
    pc.addEventListener('connectionstatechange', () => pc.connectionState === 'failed' && fail('The devices could not reach each other.'));
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
  log(`Joining game ${code}: checking the code with the server`);
  const { iceServers } = await post('/api/join', { action: 'check', code });
  log('Code is valid, lobby is open');
  logIceServers(iceServers);
  const pc = new RTCPeerConnection({ iceServers });
  const watch = watchPeer(pc, 'to game master');
  try {
    const dc = pc.createDataChannel('table', { ordered: true });
    dc.addEventListener('open', () => log('Data channel open ✓'));
    dc.addEventListener('close', () => log('Data channel closed'));
    await pc.setLocalDescription(await pc.createOffer());
    status('Collecting network addresses…');
    await gathered(pc);
    logCandidates('Our offer', pc.localDescription.sdp);
    const { peerId } = await post('/api/join', { action: 'offer', code, offer: desc(pc.localDescription) });
    log(`Offer sent to the server (request id ${peerId}). Waiting for the game master's device to pick it up and answer…`);
    status('Waiting for the game master…');
    const begin = Date.now();
    let answer = null, nextNote = 10000;
    while (!answer) {
      const waited = Date.now() - begin;
      if (waited > 45000) {
        logError('No answer within 45s. The game master\'s page must be open, awake and with the lobby open.');
        throw new Error('The game master did not answer. Is their screen still on?');
      }
      if (waited > nextNote) {
        log(`Still no answer after ${Math.round(waited / 1000)}s`);
        nextNote += 10000;
      }
      await sleep(1000);
      ({ answer } = await post('/api/join', { action: 'answer', code, peerId }));
    }
    log(`Answer received after ${((Date.now() - begin) / 1000).toFixed(1)}s`);
    logCandidates('Game master\'s answer', answer.sdp);
    status('Connecting directly to the game master…');
    log('Trying all address combinations (ICE checks)…');
    await pc.setRemoteDescription(answer);
    await opened(dc, pc, 30000, watch);
    return { pc, dc };
  } catch (e) {
    pc.close();
    throw e;
  }
}

// Game master side: answer one device's offer.
export async function accept(offer, iceServers, label) {
  logCandidates(`[${label}] offer`, offer.sdp);
  const pc = new RTCPeerConnection({ iceServers });
  const watch = watchPeer(pc, label);
  const channel = new Promise((resolve) => (pc.ondatachannel = (e) => resolve(e.channel)));
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  logCandidates(`[${label}] our answer`, pc.localDescription.sdp);
  return { pc, answer: desc(pc.localDescription), channel, watch };
}
