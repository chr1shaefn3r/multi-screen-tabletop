// The game master's page: opens a session, accepts devices, and shows the control panel.
import { post, sleep, accept, transport } from './net.js';
import { HostCore } from './core.js';
import { Screen } from './screen.js';
import { LayoutEditor } from './layout.js';
import { GAMES } from './games.js';
import { log, logError, logIceServers, showDetails } from './diag.js';
import { $, h, getDeviceId, deviceInfo, keepAwake, toggleFullscreen, setupHud, updateToolbar } from './ui.js';

const SESSION_KEY = 'tiletop-host-session';
const LOBBY_IDLE_MS = 10 * 60 * 1000; // stop polling the server when nobody joined for this long

export async function startHost(secret) {
  const api = (action, body = {}) => post('/api/host', { action, ...body }, secret);

  // Resume the session after a reload, otherwise open a new one.
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {}
  let code = null, iceServers;
  if (saved?.code) {
    try {
      ({ iceServers } = await api('resume', { code: saved.code }));
      code = saved.code;
    } catch (e) {
      if (e.status !== 404) throw e;
      saved = null;
    }
  }
  if (!code) ({ code, iceServers } = await api('create'));
  log(`Game session ${code} is open. This device is the game master.`);
  logIceServers(iceServers);

  const core = new HostCore();
  if (saved?.core) core.restore(saved.core);
  let persistTimer;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, core: core.serialize() }));
      } catch {}
    }, 400);
  };

  $('#home').hidden = true;
  const canvas = $('#table');
  canvas.hidden = false;

  // The game master's own screen is a device too, connected through a local "transport".
  const hostId = getDeviceId();
  const screen = new Screen(canvas, (m) => queueMicrotask(() => core.handle(hostId, structuredClone(m))));
  const local = { send: (m) => queueMicrotask(() => screen.receive(structuredClone(m))), close() {} };
  const editor = new LayoutEditor(core);
  screen.editor = editor;
  const setMode = (m) => core.setMode(m);
  const host = { editor, setMode };
  screen.onMode = (m) => {
    updateToolbar(screen, host);
    if (m === 'play' && core.state.board.type === 'none' && !Object.keys(core.state.pieces).length) openPanel();
    renderPanel();
  };
  editor.onSelect = () => updateToolbar(screen, host);

  // --- lobby: poll the server for devices that want to join
  let lobbyOpen = true, lastJoin = Date.now(), polling = false, ended = false;

  async function pollLoop() {
    if (polling) return;
    polling = true;
    let delay = 1000;
    while (lobbyOpen && !ended) {
      if (Date.now() - lastJoin > LOBBY_IDLE_MS) {
        await setLobby(false).catch(() => {});
        break;
      }
      try {
        const { offers } = await api('poll', { code });
        if (offers.length) {
          log(`${offers.length} device(s) want to join`);
          lastJoin = Date.now();
          delay = 1000;
          offers.forEach(handleOffer);
        } else {
          delay = Math.min(delay * 1.25, 4000);
        }
      } catch (e) {
        logError('Checking the server for joining devices failed: ' + e.message);
        if (e.status === 404) {
          alert('This game session has expired. Start a new one.');
          return endSession(false);
        }
        delay = 5000;
      }
      await sleep(delay);
    }
    polling = false;
  }

  async function setLobby(open) {
    await api('lobby', { code, open });
    lobbyOpen = open;
    log(open ? 'Lobby opened: devices can join' : 'Lobby closed: no new devices can join');
    lastJoin = Date.now();
    renderPanel();
    if (open) pollLoop();
  }

  let joinCount = 0;
  async function handleOffer({ peerId, offer }) {
    let pc, r;
    const label = `join #${++joinCount}`;
    try {
      log(`[${label}] a device sent a connection offer (request id ${peerId})`);
      r = await accept(offer, iceServers, label);
      pc = r.pc;
      await api('answer', { code, peerId, answer: r.answer });
      log(`[${label}] answer sent to the server, the device picks it up and then both try to connect…`);
      const dc = await Promise.race([
        r.channel,
        sleep(30000).then(() => Promise.reject(new Error('the device did not connect within 30s'))),
      ]);
      log(`[${label}] data channel open ✓`);
      const t = transport(dc, pc);
      let deviceId = null;
      dc.addEventListener('message', (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (deviceId) return core.handle(deviceId, m);
        if (m?.t === 'hello' && typeof m.deviceId === 'string' && m.deviceId !== hostId) {
          deviceId = core.connect(m, t);
          const d = core.devices.get(deviceId);
          log(`[${label}] ✓ screen ${d.num} (${d.name}) joined`);
        }
      });
      const gone = () => {
        if (deviceId && core.devices.get(deviceId)?.transport === t) log(`[${label}] screen ${core.devices.get(deviceId).num} disconnected`);
        if (deviceId) core.disconnect(deviceId, t);
        t.close();
      };
      dc.addEventListener('close', gone);
      pc.addEventListener('connectionstatechange', () => ['failed', 'closed'].includes(pc.connectionState) && gone());
    } catch (e) {
      logError(`[${label}] joining failed: ${e.message}`);
      await r?.watch.diagnose();
      pc?.close();
    }
  }

  async function endSession(ask = true) {
    if (ask && !confirm('End this game for everyone?')) return;
    ended = true;
    for (const d of core.devices.values()) if (!d.isHost) d.transport?.close();
    await api('end', { code }).catch(() => {});
    sessionStorage.removeItem(SESSION_KEY);
    location.href = '/';
  }

  // --- control panel
  const panel = $('#panel');
  const joinUrl = `${location.origin}/#${code}`;
  const openPanel = () => {
    panel.hidden = false;
    renderPanel();
  };
  const section = (title, ...kids) => h('section', {}, h('h3', {}, title), ...kids);
  const action = (label, fn, cls = '') => h('button', { class: cls, onclick: fn }, label);

  async function loadImage(file) {
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    try {
      img.src = url;
      await img.decode();
      const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      core.setImage(c.toDataURL('image/jpeg', 0.85), c.width, c.height);
      if (core.mode !== 'play') setMode('play');
      panel.hidden = true;
    } catch {
      alert('Could not read this image.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const startGame = (id) => {
    core.newGame(id);
    if (core.mode !== 'play') setMode('play');
    panel.hidden = true;
  };

  panel.replaceChildren(
    h('header', {}, h('strong', {}, 'Game master'), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => (panel.hidden = true) }, '✕')),
    section(
      'Join code',
      h('div', { class: 'join' }, h('div', { class: 'code' }, code), h('img', { id: 'qr', alt: 'QR code to join' })),
      h('p', { class: 'muted' }, 'Others open ', h('a', { href: joinUrl, target: '_blank', rel: 'noopener' }, location.host), ' and type the code, or scan the QR code.'),
      h('div', { class: 'row' }, h('span', { id: 'lobbyState' }), h('button', { id: 'lobbyBtn', onclick: () => setLobby(!lobbyOpen).catch((e) => alert(e.message)) })),
    ),
    section('Screens', h('ul', { id: 'devList', class: 'devices' })),
    section(
      'Steps',
      h('div', { class: 'seg', id: 'modeSeg' }, ...[['layout', '1 · Layout'], ['align', '2 · Align'], ['play', '3 · Play']].map(([m, l]) => h('button', { 'data-mode': m, onclick: () => setMode(m) }, l))),
      h('p', { class: 'muted' }, 'Layout: place the screens roughly. Align: drag each screen until the lines continue across the gaps. Play: pick a game.'),
    ),
    section(
      'New game',
      h(
        'div',
        { class: 'grid' },
        ...GAMES.map(([id, label]) => action(label, () => startGame(id))),
        h('label', { class: 'button' }, 'Image map…', h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => loadImage(e.target.files[0]) })),
      ),
    ),
    section(
      'Add to the table',
      h('div', { class: 'grid' }, action('+ d6', () => core.addPiece('d6')), action('+ d20', () => core.addPiece('d20')), action('+ Token', () => core.addPiece('token')), action('Remove dice & tokens', () => core.clearExtras())),
    ),
    section('Session', h('div', { class: 'grid' }, action('Connection details', showDetails), action('Fullscreen', toggleFullscreen), action('End session', () => endSession(), 'danger'))),
  );

  // QR code (library is vendored, loaded only on the game master's page)
  const s = document.createElement('script');
  s.src = '/vendor/qrcode.js';
  s.onload = () => {
    const qr = window.qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    $('#qr').src = qr.createDataURL(4, 2);
  };
  document.head.append(s);

  let panelQueued = false;
  function renderPanel() {
    if (panelQueued) return;
    panelQueued = true;
    requestAnimationFrame(() => {
      panelQueued = false;
      $('#lobbyState').textContent = lobbyOpen ? '🟢 Lobby open – devices can join' : '🔴 Lobby closed';
      $('#lobbyBtn').textContent = lobbyOpen ? 'Close lobby' : 'Open lobby';
      for (const b of $('#modeSeg').children) b.classList.toggle('active', b.dataset.mode === core.mode);
      const list = [...core.devices.values()].sort((a, b) => a.num - b.num);
      $('#devList').replaceChildren(
        ...list.map((d) => {
          const dot = h('span', { class: 'dot' });
          dot.style.background = d.connected ? d.color : '#666';
          return h(
            'li',
            {},
            dot,
            h('b', {}, String(d.num)),
            h('span', {}, `${d.name}${d.isHost ? ' (this device)' : ''}`),
            h('span', { class: 'muted' }, d.connected ? '' : 'offline'),
            !d.isHost && !d.connected && h('button', { class: 'icon', 'aria-label': 'Remove', onclick: () => core.remove(d.id) }, '✕'),
          );
        }),
      );
    });
  }

  core.on(() => {
    screen.dirty = true;
    persist();
    renderPanel();
  });
  core.connect({ deviceId: hostId, ...deviceInfo() }, local, true);

  setupHud(() => (panel.hidden ? openPanel() : (panel.hidden = true)), showDetails);
  keepAwake();
  openPanel();
  pollLoop();
}
