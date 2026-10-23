// Connection log: records every step of setting up WebRTC connections so that
// "it doesn't connect" can be understood. Shown via the "Connection details" button.
import { h } from './ui.js';

const start = Date.now();
const entries = [];
let render = null;

export function log(msg, level = 'info') {
  entries.push({ t: Date.now(), msg, level });
  if (entries.length > 2000) entries.splice(0, entries.length - 2000);
  (level === 'error' ? console.warn : console.log)('[tiletop] ' + msg);
  render?.();
}

export const logError = (msg) => log(msg, 'error');

const KINDS = {
  host: 'address in the local network',
  srflx: 'public internet address, learned from the STUN server',
  prflx: 'address discovered during the checks',
  relay: 'TURN relay server',
};

// "a=candidate:1 1 udp 2122260223 abc.local 54321 typ host ..." -> { type, protocol, address, port }
function parseCandidate(line) {
  const f = line.replace(/^a=/, '').replace(/^candidate:/, '').trim().split(/\s+/);
  if (f.length < 8) return null;
  return { protocol: f[2].toLowerCase(), address: f[4], port: f[5], type: f[7] };
}

function describe(c) {
  const mdns = c.address?.endsWith('.local') ? ' (real IP hidden behind an mDNS name)' : '';
  return `${c.type} ${c.protocol} ${c.address}:${c.port}: ${KINDS[c.type] || 'unknown kind'}${mdns}`;
}

const short = (c) => (c ? `${c.candidateType} ${c.protocol} ${c.address || c.ip || '(hidden)'}:${c.port}` : '?');

// Logs the network addresses ("ICE candidates") contained in an offer or answer.
export function logCandidates(label, sdp) {
  const list = sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')).map(parseCandidate).filter(Boolean);
  if (!list.length) logError(`${label}: contains no network addresses at all, so no connection is possible`);
  else log(`${label}: ${list.length} network address(es)`);
  for (const c of list) log('    • ' + describe(c));
  return list;
}

export function logIceServers(list) {
  if (!list?.length) return log('ICE servers: none configured (only local addresses can be used)');
  const names = list.map((s) => [].concat(s.urls).join(', ') + (s.username ? ' (with login)' : ''));
  log('ICE servers: ' + names.join('; '));
  if (!names.some((n) => /^turns?:/.test(n))) log('    No TURN server configured: devices must be able to reach each other directly.');
}

// Logs the state changes of a peer connection, every connection check between the two
// devices, and a diagnosis if it fails.
export function watchPeer(pc, label) {
  const p = label ? `[${label}] ` : '';
  const pairs = new Map();
  let lastStats = null;
  let stopped = false;
  const started = Date.now();

  async function poll() {
    const stats = await pc.getStats().catch(() => null);
    if (!stats) return;
    lastStats = stats;
    const cands = {};
    stats.forEach((r) => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
    });
    stats.forEach((r) => {
      if (r.type !== 'candidate-pair' || pairs.get(r.id) === r.state) return;
      pairs.set(r.id, r.state);
      const extra = r.nominated ? ', nominated' : '';
      log(`${p}check ${short(cands[r.localCandidateId])} → ${short(cands[r.remoteCandidateId])}: ${r.state}${extra}`, r.state === 'failed' ? 'error' : 'info');
    });
    return cands;
  }

  const timer = setInterval(() => {
    if (stopped || Date.now() - started > 120000) return clearInterval(timer);
    poll();
  }, 700);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };

  pc.addEventListener('signalingstatechange', () => log(`${p}signalling: ${pc.signalingState}`));
  pc.addEventListener('icegatheringstatechange', () => log(`${p}collecting own network addresses: ${pc.iceGatheringState}`));
  pc.addEventListener('iceconnectionstatechange', () => log(`${p}ICE: ${pc.iceConnectionState}`, ['failed', 'disconnected'].includes(pc.iceConnectionState) ? 'error' : 'info'));
  pc.addEventListener('icecandidateerror', (e) => {
    const msg = `${p}ICE server problem: ${e.url || ''} error ${e.errorCode} ${e.errorText || ''} (from ${e.address || e.hostCandidate || '?'})`;
    // 701 = server not reachable from one of the device's network interfaces: common and often harmless
    if (e.errorCode === 701) log(msg + ', often harmless if other addresses work');
    else logError(msg);
  });
  pc.addEventListener('connectionstatechange', async () => {
    const s = pc.connectionState;
    log(`${p}connection: ${s}`, ['failed', 'disconnected'].includes(s) ? 'error' : 'info');
    if (s === 'connected') {
      await poll();
      stop();
      let pair = null;
      lastStats?.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = lastStats.get(r.selectedCandidatePairId);
      });
      lastStats?.forEach((r) => {
        if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
      });
      if (pair) log(`${p}✓ connected via ${short(lastStats.get(pair.localCandidateId))} → ${short(lastStats.get(pair.remoteCandidateId))}`);
    } else if (s === 'failed') {
      await diagnoseNow();
    } else if (s === 'closed') {
      stop();
    }
  });

  let diagnosed = false;
  async function diagnoseNow() {
    if (diagnosed) return;
    diagnosed = true;
    const cands = (await poll()) || {};
    stop();
    diagnose(p, Object.values(cands));
  }
  // `diagnose` is also called when giving up on a connection that never reached "failed".
  return { stop, diagnose: diagnoseNow };
}

function diagnose(p, cands) {
  const local = cands.filter((c) => c.type === 'local-candidate');
  const remote = cands.filter((c) => c.type === 'remote-candidate');
  logError(`${p}Diagnosis: the two devices could not reach each other.`);
  if (!local.length) log(`${p}  • This device has no usable network address at all (Wi-Fi off, or the browser blocks WebRTC).`);
  if (!local.some((c) => c.candidateType === 'srflx')) {
    log(`${p}  • This device got no public address from the STUN server (no internet, or UDP blocked).`);
  }
  if (remote.length && remote.every((c) => c.candidateType === 'host')) {
    log(`${p}  • The other device only offered local network addresses.`);
  }
  if ([...local, ...remote].some((c) => String(c.address || '').endsWith('.local'))) {
    log(`${p}  • Addresses are hidden behind mDNS names (*.local). Some Wi-Fi networks block the multicast traffic needed to resolve them.`);
  }
  log(`${p}  • Common causes: the Wi-Fi isolates devices from each other (guest networks, "AP/client isolation"), a VPN, or one device on mobile data.`);
  log(`${p}  • Fix: turn off client isolation, use another Wi-Fi or a phone hotspot, or configure a TURN server (ICE_SERVERS, see README).`);
}

function text() {
  const head = [
    `Tiletop connection log, started ${new Date(start).toISOString()}`,
    `Device: ${navigator.userAgent}`,
    `Page: ${location.origin} (secure: ${isSecureContext}, online: ${navigator.onLine})`,
    '',
  ];
  const lines = entries.map((e) => `${('+' + ((e.t - start) / 1000).toFixed(1) + 's').padStart(8)} ${e.level === 'error' ? '⚠ ' : ''}${e.msg}`);
  return head.concat(lines).join('\n');
}

export function showDetails() {
  if (document.getElementById('details')) return;
  const pre = h('pre', { class: 'log' });
  const copyBtn = h('button', {}, 'Copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text());
      copyBtn.textContent = 'Copied ✓';
    } catch {
      getSelection().selectAllChildren(pre); // fallback: select it for manual copying
      copyBtn.textContent = 'Selected, copy manually';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy'), 2500);
  });
  const box = h(
    'div',
    { id: 'details', role: 'dialog', 'aria-label': 'Connection details' },
    h('header', {}, h('strong', {}, 'Connection details'), h('div', { class: 'row' }, copyBtn, h('button', { onclick: () => close() }, 'Close'))),
    h('p', { class: 'muted' }, 'Everything this device did while connecting. Updates live. Copy it to share it.'),
    pre,
  );
  const close = () => {
    render = null;
    box.remove();
  };
  render = () => {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = text();
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
  document.body.append(box);
  render();
  pre.scrollTop = pre.scrollHeight;
}
