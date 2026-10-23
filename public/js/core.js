// Runs on the game master's device and owns the truth: which screens exist,
// where they lie on the table, and the game state. Every device (including the
// game master's own screen) talks to it through a "transport" with send()/close().
import { bounds, corners, sanitizeView } from './geom.js';
import { setupGame, extraPiece } from './games.js';

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5c0', '#f032e6', '#7a9a01', '#9a6324', '#469990'];
const IMG_CHUNK = 16000;

export class HostCore {
  constructor() {
    this.devices = new Map();
    this.nextNum = 1;
    this.mode = 'layout';
    this.state = { board: { type: 'none' }, pieces: {} };
    this.image = null; // { id, data } – the current map image, sent to devices in chunks
    this.z = 1;
    this.lastTap = new Map();
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  connected() {
    return [...this.devices.values()].filter((d) => d.connected);
  }

  // Bounding box of the given screens in world mm.
  union(list = this.connected()) {
    const pts = list.filter((d) => d.view && d.w).flatMap((d) => corners(d.view, d.w, d.h));
    return bounds(pts.length ? pts : [[0, 0], [100, 100]]);
  }

  center() {
    const u = this.union();
    return [u.cx, u.cy];
  }

  // A device said hello. Returns its id.
  connect(hello, transport, isHost = false) {
    const id = String(hello.deviceId).slice(0, 64);
    let d = this.devices.get(id);
    if (!d) {
      const num = this.nextNum++;
      d = { id, num, color: COLORS[(num - 1) % COLORS.length], view: null };
      this.devices.set(id, d);
    }
    if (d.transport && d.transport !== transport) d.transport.close?.();
    Object.assign(d, { transport, connected: true, isHost, name: String(hello.name || 'Device').slice(0, 40) });
    this.setSize(d, hello.w, hello.h);
    if (!d.view) d.view = this.placeNew(d, hello.scale);
    transport.send({
      t: 'welcome',
      you: { id, num: d.num, color: d.color, name: d.name, isHost },
      view: d.view,
      mode: this.mode,
      center: this.center(),
      state: this.state,
    });
    if (this.image && this.state.board.imageId === this.image.id) this.sendImage(d);
    this.emit();
    return id;
  }

  // New screens are placed to the right of the existing ones.
  placeNew(d, scale) {
    const s = Number.isFinite(+scale) && scale > 1 && scale < 20 ? +scale : 6.3;
    const others = [...this.devices.values()].filter((o) => o !== d && o.view && o.w);
    if (!others.length) return { ox: 0, oy: 0, rot: 0, scale: s };
    const u = this.union(others);
    return { ox: u.r, oy: u.t, rot: 0, scale: s };
  }

  setSize(d, w, h) {
    w = +w;
    h = +h;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 50 && h > 50 && w < 10000 && h < 10000) {
      d.w = w;
      d.h = h;
    }
  }

  disconnect(id, transport) {
    const d = this.devices.get(id);
    if (!d || (transport && d.transport !== transport)) return;
    d.connected = false;
    d.transport = null;
    for (const p of Object.values(this.state.pieces)) {
      if (p.heldBy === id) {
        p.heldBy = null;
        this.broadcast({ t: 'piece', p });
      }
    }
    this.emit();
  }

  remove(id) {
    const d = this.devices.get(id);
    if (!d || d.isHost) return;
    d.transport?.close?.();
    this.devices.delete(id);
    this.emit();
  }

  send(d, msg) {
    d.transport?.send(msg);
  }

  broadcast(msg, exceptId) {
    for (const d of this.devices.values()) if (d.connected && d.id !== exceptId) d.transport.send(msg);
  }

  // A message from a device.
  handle(id, m) {
    const d = this.devices.get(id);
    if (!d || !m || typeof m.t !== 'string') return;
    const p = typeof m.id === 'string' && Object.hasOwn(this.state.pieces, m.id) ? this.state.pieces[m.id] : null;
    switch (m.t) {
      case 'size':
        this.setSize(d, m.w, m.h);
        this.emit();
        break;
      case 'view': {
        const v = sanitizeView(m.view);
        if (v) {
          d.view = v;
          this.emit();
        }
        break;
      }
      case 'grab':
        if (!p || this.mode !== 'play') break;
        if (!p.heldBy || p.heldBy === id || !this.devices.get(p.heldBy)?.connected) {
          p.heldBy = id;
          p.z = ++this.z;
          this.broadcast({ t: 'piece', p });
        } else {
          this.send(d, { t: 'piece', p }); // someone else has it
        }
        break;
      case 'drag':
      case 'drop': {
        if (!p) break;
        if (p.heldBy !== id) {
          this.send(d, { t: 'piece', p });
          break;
        }
        const x = +m.x, y = +m.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) break;
        p.x = x;
        p.y = y;
        if (m.t === 'drop') {
          p.heldBy = null;
          this.snap(p);
          this.broadcast({ t: 'piece', p });
          this.emit();
        } else {
          this.broadcast({ t: 'piece', p }, id);
        }
        break;
      }
      case 'tap':
        if (p && this.mode === 'play') this.tap(p, id);
        break;
    }
  }

  tap(p, id) {
    if (p.heldBy === id) p.heldBy = null;
    if (p.kind === 'die') {
      p.value = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % p.sides);
      p.rollSeq = (p.rollSeq || 0) + 1;
    } else if (p.kind === 'disc') {
      // double tap crowns / uncrowns a checkers piece
      const now = Date.now();
      if (now - (this.lastTap.get(p.id) || 0) < 450) {
        p.king = !p.king;
        this.lastTap.delete(p.id);
      } else {
        this.lastTap.set(p.id, now);
      }
    }
    this.broadcast({ t: 'piece', p });
    this.emit();
  }

  snap(p) {
    const b = this.state.board;
    if (!b.snap || !b.cell || p.kind === 'die') return;
    const c = (p.x - b.x) / b.cell, r = (p.y - b.y) / b.cell;
    if (c < 0 || r < 0 || c >= b.cols || r >= b.rows) return; // dropped beside the board: leave it there
    p.x = b.x + (Math.floor(c) + 0.5) * b.cell;
    p.y = b.y + (Math.floor(r) + 0.5) * b.cell;
  }

  setMode(mode) {
    this.mode = mode;
    for (const p of Object.values(this.state.pieces)) p.heldBy = null;
    this.broadcast({ t: 'mode', mode, center: this.center() });
    this.emit();
  }

  setView(id, view) {
    const d = this.devices.get(id);
    if (!d) return;
    d.view = view;
    this.send(d, { t: 'view', view });
    this.emit();
  }

  newGame(type, opts) {
    this.state = setupGame(type, this.union(), opts);
    this.z = 1;
    this.broadcast({ t: 'state', state: this.state });
    this.emit();
  }

  addPiece(kind) {
    const count = Object.values(this.state.pieces).filter((p) => p.kind === 'token').length;
    const p = extraPiece(kind, this.union(), count);
    p.z = ++this.z;
    this.state.pieces[p.id] = p;
    this.broadcast({ t: 'piece', p });
    this.emit();
  }

  clearExtras() {
    for (const [id, p] of Object.entries(this.state.pieces)) {
      if (p.kind === 'die' || p.kind === 'token') {
        delete this.state.pieces[id];
        this.broadcast({ t: 'remove', id });
      }
    }
    this.emit();
  }

  setImage(data, w, h) {
    const id = 'img' + Date.now().toString(36);
    this.image = { id, data };
    for (const d of this.connected()) this.sendImage(d);
    this.newGame('image', { imageId: id, aspect: w / h });
  }

  sendImage(d) {
    const { id, data } = this.image;
    const n = Math.ceil(data.length / IMG_CHUNK);
    for (let i = 0; i < n; i++) this.send(d, { t: 'img', id, i, n, d: data.slice(i * IMG_CHUNK, (i + 1) * IMG_CHUNK) });
  }

  // Saved in sessionStorage so a reload of the game master's page keeps the table.
  serialize() {
    return {
      nextNum: this.nextNum,
      mode: this.mode,
      state: this.state,
      devices: [...this.devices.values()].map(({ id, num, color, name, view, w, h, isHost }) => ({ id, num, color, name, view, w, h, isHost })),
    };
  }

  restore(s) {
    if (!s || !Array.isArray(s.devices)) return;
    this.nextNum = s.nextNum || 1;
    this.mode = s.mode || 'layout';
    if (s.state?.board?.type !== 'image') this.state = s.state || this.state; // map images are not saved
    for (const d of s.devices) this.devices.set(d.id, { ...d, connected: false, transport: null });
    this.z = Math.max(1, ...Object.values(this.state.pieces).map((p) => p.z || 0));
  }
}
