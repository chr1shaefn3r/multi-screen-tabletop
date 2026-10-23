// Runs on the game master's device and owns the truth: which screens exist,
// where they lie on the table, and the game state. Every device (including the
// game master's own screen) talks to it through a "transport" with send()/close().
import { bounds, corners, pointInPoly, sanitizeView } from './geom.js';
import { setupChess, dropPiece } from './games.js';
import { SwipeAligner } from './swipe.js';

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa5c0', '#f032e6', '#7a9a01', '#9a6324', '#469990'];

export class HostCore {
  constructor() {
    this.devices = new Map();
    this.nextNum = 1;
    this.mode = 'align';
    this.state = { board: { type: 'none' }, pieces: {} };
    this.z = 1;
    this.grabbedFrom = new Map(); // piece id -> where it was picked up, to undo invalid moves
    this.listeners = new Set();
    this.aligner = new SwipeAligner(this);
    this.log = () => {}; // set by the game master's page to write into the connection log
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

  // Is the circle (x, y, r) fully visible on one of the connected screens?
  onOneScreen(x, y, r) {
    const pts = [[x - r, y], [x + r, y], [x, y - r], [x, y + r]];
    return this.connected().some((d) => d.view && d.w && pts.every(([px, py]) => pointInPoly(px, py, corners(d.view, d.w, d.h))));
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
    const welcome = {
      t: 'welcome',
      you: { id, num: d.num, color: d.color, name: d.name, isHost },
      view: d.view,
      mode: this.mode,
      center: this.center(),
      state: this.state,
    };
    transport.send(welcome);
    transport.send({ t: 'status', text: this.aligner.status(id) });
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
    for (const [child, par] of this.aligner.parent) if (par === id || child === id) this.aligner.movedByHand(child);
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
        // the device was dragged by hand in the align step
        const v = sanitizeView(m.view);
        if (v) {
          d.view = v;
          this.aligner.movedByHand(id);
          this.emit();
        }
        break;
      }
      case 'ping': // clock sync: the device compares its clock with ours
        this.send(d, { t: 'pong', c: m.c, h: performance.now() });
        break;
      case 'stroke': {
        if (this.mode !== 'align' || !Array.isArray(m.pts) || m.pts.length > 300) break;
        const pts = m.pts.filter((q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite));
        this.deliver(this.aligner.add(id, pts));
        break;
      }
      case 'grab':
        if (!p || this.mode !== 'play') break;
        if (!p.heldBy || p.heldBy === id || !this.devices.get(p.heldBy)?.connected) {
          if (p.heldBy !== id) this.grabbedFrom.set(p.id, { x: p.x, y: p.y, captured: p.captured, size: p.size });
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
        if (m.t === 'drag') {
          Object.assign(p, { x, y });
          this.broadcast({ t: 'piece', p }, id);
          break;
        }
        const from = this.grabbedFrom.get(p.id) || { x: p.x, y: p.y, captured: p.captured, size: p.size };
        this.grabbedFrom.delete(p.id);
        Object.assign(p, { x, y, heldBy: null });
        for (const q of dropPiece(this.state, p, from, (cx, cy, r) => this.onOneScreen(cx, cy, r))) this.broadcast({ t: 'piece', p: q });
        this.emit();
        break;
      }
    }
  }

  setMode(mode) {
    this.mode = mode;
    for (const p of Object.values(this.state.pieces)) p.heldBy = null;
    this.broadcast({ t: 'mode', mode, center: this.center() });
    this.emit();
  }

  // A screen was placed by hand (layout editor).
  setView(id, view) {
    this.aligner.movedByHand(id);
    this.applyView(id, view);
  }

  applyView(id, view) {
    const d = this.devices.get(id);
    if (!d) return;
    d.view = view;
    this.send(d, { t: 'view', view });
    this.emit();
  }

  // Status texts and short notices for screens: [{ to: [ids], text, toast, status }]
  deliver(msgs) {
    for (const m of msgs || []) {
      if (!m) continue;
      for (const id of m.to) {
        const d = this.devices.get(id);
        if (d) this.send(d, { t: 'status', text: m.status || !m.toast ? this.aligner.status(id) : undefined, toast: m.toast ? m.text : undefined });
      }
    }
  }

  // A fresh chess game, centred on the screens that are connected right now.
  newGame() {
    this.state = setupChess(this.union());
    this.z = 1;
    this.grabbedFrom.clear();
    this.broadcast({ t: 'state', state: this.state });
    this.emit();
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
    this.mode = s.mode || 'align';
    if (['chess', 'none'].includes(s.state?.board?.type)) this.state = s.state;
    for (const d of s.devices) this.devices.set(d.id, { ...d, connected: false, transport: null });
    this.z = Math.max(1, ...Object.values(this.state.pieces).map((p) => p.z || 0));
  }
}
