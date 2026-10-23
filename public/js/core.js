// Runs on the game master's device and owns the truth: which screens exist,
// where they lie on the table, and the game state. Every device (including the
// game master's own screen) talks to it through a "transport" with send()/close().
import { bounds, corners, pointInPoly, sanitizeView, QUARTER } from './geom.js';
import { setupChess, dropPiece } from './games/chess.js';
import * as madn from './games/mensch-aerger-dich-nicht.js';
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
          v.rot = Math.round(v.rot / QUARTER) * QUARTER || 0; // screens are only ever turned in quarter turns
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
      // Moving pieces. A piece can be "selected" (one at a time, shown highlighted on all
      // screens): by tapping it, or by sliding it off a screen edge while dragging. The next
      // touch on a square of any screen then moves it there. This is how pieces cross screens.
      case 'grab':
        if (!p || this.mode !== 'play') break;
        if (!p.heldBy || p.heldBy === id || !this.devices.get(p.heldBy)?.connected) {
          if (!p.selected) {
            this.clearSelection();
            if (p.heldBy !== id) this.grabbedFrom.set(p.id, { x: p.x, y: p.y, captured: p.captured, size: p.size });
          }
          p.heldBy = id;
          p.z = ++this.z;
          this.broadcast({ t: 'piece', p });
        } else {
          this.send(d, { t: 'piece', p }); // someone else has it
        }
        break;
      case 'drag':
      case 'drop':
      case 'hold': {
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
        } else if (m.t === 'hold') {
          // the finger slid off the screen: the piece waits at the edge for the next screen
          Object.assign(p, { x, y, heldBy: null, selected: true });
          this.broadcast({ t: 'piece', p });
        } else {
          const from = this.grabbedFrom.get(p.id) || { x: p.x, y: p.y, captured: p.captured, size: p.size };
          this.grabbedFrom.delete(p.id);
          Object.assign(p, { x, y, heldBy: null, selected: false });
          for (const q of dropPiece(this.state, p, from, (cx, cy, r) => this.onOneScreen(cx, cy, r))) this.broadcast({ t: 'piece', p: q });
          this.emit();
        }
        break;
      }
      case 'tap': // a piece was tapped without moving it: select it, or unselect it
        if (!p || this.mode !== 'play') break;
        if (p.heldBy === id) p.heldBy = null;
        if (p.selected) {
          this.clearSelection();
        } else {
          this.clearSelection();
          this.grabbedFrom.set(p.id, { x: p.x, y: p.y, captured: p.captured, size: p.size });
          p.selected = true;
          this.broadcast({ t: 'piece', p });
        }
        break;
      case 'cancel': // touched beside the board while a piece was selected
        this.clearSelection();
        break;
      case 'madn': {
        // Mensch ärgere Dich nicht: any screen may roll the die or move a piece of the current colour;
        // the rules module decides what is allowed
        const g = this.state.madn;
        if (this.mode !== 'play' || !g) break;
        const die = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 6);
        const next = m.a === 'roll' ? madn.roll(g, die) : m.a === 'move' ? madn.move(g, Number(m.i)) : null;
        if (!next) {
          this.send(d, { t: 'madn', game: g }); // not allowed (e.g. someone was quicker): resync this screen
          break;
        }
        this.state.madn = next;
        this.broadcast({ t: 'madn', game: next });
        for (const e of next.events) this.log(`Mensch ärgere Dich nicht: ${e}`);
        this.emit();
        break;
      }
    }
  }

  // Unselects the selected piece; if it was waiting at a screen edge it goes back to where it came from.
  clearSelection() {
    for (const q of Object.values(this.state.pieces)) {
      if (!q.selected) continue;
      Object.assign(q, this.grabbedFrom.get(q.id) || {}, { selected: false, heldBy: null });
      this.grabbedFrom.delete(q.id);
      this.broadcast({ t: 'piece', p: q });
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.clearSelection();
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
  // A fresh game, centred on the screens that are connected right now.
  // type 'chess', or 'madn' (Mensch ärgere Dich nicht) with opts.players = colours taking part.
  newGame(type = 'chess', opts = {}) {
    const u = this.union();
    let tip;
    if (type === 'madn') {
      const size = Math.min(u.w, u.h) * 0.96;
      const board = { type: 'madn', x: u.cx - size / 2, y: u.cy - size / 2, size, cell: size / 11 };
      this.state = { board, pieces: {}, madn: madn.newGame(opts.players?.length >= 2 ? opts.players : madn.COLORS) };
      tip = this.state.madn.events.join(' ');
    } else {
      this.state = setupChess(u);
      tip = 'Tip: tap a piece, then tap where it should go: that works across screens. Or drag it off the edge and keep going on the next screen.';
    }
    this.z = 1;
    this.grabbedFrom.clear();
    this.broadcast({ t: 'state', state: this.state });
    this.broadcast({ t: 'status', toast: tip });
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
    if (['chess', 'madn', 'none'].includes(s.state?.board?.type)) this.state = s.state;
    for (const d of s.devices) this.devices.set(d.id, { ...d, connected: false, transport: null });
    this.z = Math.max(1, ...Object.values(this.state.pieces).map((p) => p.z || 0));
  }
}
