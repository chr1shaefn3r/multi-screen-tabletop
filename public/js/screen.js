// One physical screen: draws its slice of the shared table and handles touch.
// Used by every device, including the game master's.
import { toWorld, corners, bounds, pin, dist, mid, clamp } from './geom.js';
import { drawBoard, drawPiece, hitTest } from './draw.js';

const CARD = [85.6, 53.98]; // ISO/IEC 7810 ID-1 (bank card) in mm

export class Screen {
  constructor(canvas, send) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.send = send;
    this.me = null;
    this.view = { ox: 0, oy: 0, rot: 0, scale: 6.3 };
    this.mode = 'wait';
    this.center = [0, 0];
    this.state = { board: { type: 'none' }, pieces: {} };
    this.drags = new Map(); // pointerId -> piece drag
    this.pending = new Map(); // piece id -> [x, y] waiting to be sent
    this.pts = new Map(); // pointerId -> [x, y] for align gestures
    this.g0 = null;
    this.freeRotate = false;
    this.allowResize = false; // two-finger resizing in the align step, off unless switched on
    this.cardMode = false;
    this.editor = null; // layout editor, only on the game master's device
    this.dirty = true;
    this.onMode = null;
    this.lastViewSend = 0;
    window.__screen = this; // handy for debugging from the browser console

    this.resize();
    addEventListener('resize', () => this.resize());
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(t, (e) => this.pointer(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.dirty = true;
    clearTimeout(this.sizeTimer);
    this.sizeTimer = setTimeout(() => this.me && this.send({ t: 'size', w: this.w, h: this.h }), 250);
  }

  setMode(mode) {
    this.mode = mode;
    this.drags.clear();
    this.pending.clear();
    this.pts.clear();
    this.g0 = null;
    this.cardMode = false;
    this.onMode?.(mode);
  }

  receive(m) {
    switch (m.t) {
      case 'welcome':
        this.me = m.you;
        this.view = m.view;
        this.center = m.center;
        this.state = m.state;
        this.setMode(m.mode);
        break;
      case 'view':
        if (!this.pts.size) this.view = m.view;
        break;
      case 'mode':
        this.center = m.center;
        this.setMode(m.mode);
        break;
      case 'state':
        this.state = m.state;
        this.drags.clear();
        this.pending.clear();
        break;
      case 'piece': {
        const p = m.p;
        const old = this.state.pieces[p.id];
        const mine = [...this.drags.values()].find((d) => d.id === p.id);
        if (mine) {
          if (p.heldBy && p.heldBy !== this.me?.id) {
            this.drags.delete(mine.pointerId); // someone else got it first
            this.pending.delete(p.id);
          } else if (old) {
            p.x = old.x; // keep following our finger
            p.y = old.y;
          }
        }
        this.state.pieces[p.id] = p;
        break;
      }
    }
    this.dirty = true;
  }

  frame() {
    for (const [id, [x, y]] of this.pending) this.send({ t: 'drag', id, x, y });
    this.pending.clear();
    if (this.editor?.dirty) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    const { ctx, w, h, view: v } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.mode === 'layout' && this.editor) return this.editor.draw(ctx, w, h);
    if (this.mode === 'layout' || this.mode === 'wait' || !this.me) return this.drawIdentity(ctx, w, h);

    const align = this.mode === 'align';
    ctx.fillStyle = align ? '#0b1020' : '#1b3a2b';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.scale(v.scale, v.scale);
    ctx.rotate(-v.rot);
    ctx.translate(-v.ox, -v.oy);
    const px = 1 / v.scale; // one CSS pixel in mm
    if (align) {
      this.drawPattern(ctx, px);
    } else {
      drawBoard(ctx, this.state.board, px);
      const list = Object.values(this.state.pieces).sort((a, b) => a.z - b.z);
      for (const p of list) drawPiece(ctx, p);
    }
    ctx.restore();
    if (align) this.drawAlignHud(ctx, w, h);
  }

  // Shown while the game master arranges the layout: who am I, and where is my top edge.
  drawIdentity(ctx, w, h) {
    const me = this.me;
    ctx.fillStyle = me ? me.color : '#0b1020';
    ctx.fillRect(0, 0, w, h);
    if (!me) return;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.min(w, h) * 0.5}px system-ui, sans-serif`;
    ctx.fillText(String(me.num), w / 2, h / 2);
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('▲ top edge ▲', w / 2, 60);
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText(`Screen ${me.num} · ${me.name}`, w / 2, h - 80, w - 24);
    ctx.fillText('Lay this device on the table.', w / 2, h - 56, w - 24);
    ctx.fillText('The game master arranges the screens.', w / 2, h - 34, w - 24);
  }

  // Calibration pattern in world space: lines must continue straight across screen gaps.
  drawPattern(ctx, px) {
    const vb = bounds(corners(this.view, this.w, this.h));
    const [cx, cy] = this.center;
    const step = 10;
    const k0x = Math.floor((vb.l - cx) / step), k1x = Math.ceil((vb.r - cx) / step);
    const k0y = Math.floor((vb.t - cy) / step), k1y = Math.ceil((vb.b - cy) / step);
    if (k1x - k0x < 600 && k1y - k0y < 600) {
      for (const major of [false, true]) {
        ctx.beginPath();
        for (let k = k0x; k <= k1x; k++) {
          if ((k % 5 === 0) !== major) continue;
          ctx.moveTo(cx + k * step, vb.t);
          ctx.lineTo(cx + k * step, vb.b);
        }
        for (let k = k0y; k <= k1y; k++) {
          if ((k % 5 === 0) !== major) continue;
          ctx.moveTo(vb.l, cy + k * step);
          ctx.lineTo(vb.r, cy + k * step);
        }
        ctx.lineWidth = major ? 2 * px : px;
        ctx.strokeStyle = major ? 'rgba(110,190,255,.6)' : 'rgba(255,255,255,.13)';
        ctx.stroke();
      }
    }
    // circles and diagonals through the table centre
    const far = Math.max(...corners(this.view, this.w, this.h).map((p) => dist(p, [cx, cy])));
    ctx.beginPath();
    for (let r = 30; r < Math.min(far + 30, 3000); r += 30) {
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    ctx.lineWidth = 2.5 * px;
    ctx.strokeStyle = 'rgba(255,120,190,.75)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - far, cy - far);
    ctx.lineTo(cx + far, cy + far);
    ctx.moveTo(cx - far, cy + far);
    ctx.lineTo(cx + far, cy - far);
    ctx.strokeStyle = 'rgba(120,255,160,.8)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - far, cy);
    ctx.lineTo(cx + far, cy);
    ctx.moveTo(cx, cy - far);
    ctx.lineTo(cx, cy + far);
    ctx.lineWidth = 4 * px;
    ctx.strokeStyle = 'rgba(255,215,64,.9)';
    ctx.stroke();
  }

  drawAlignHud(ctx, w, h) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.cardMode) {
      const cw = CARD[0] * this.view.scale, ch = CARD[1] * this.view.scale;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, w, h);
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(w / 2 - cw / 2, h / 2 - ch / 2, cw, ch);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText('Put a bank card on the outline', w / 2, h / 2 - ch / 2 - 40, w - 24);
      ctx.fillText('and pinch until the size matches.', w / 2, h / 2 - ch / 2 - 20, w - 24);
      return;
    }
    const me = this.me;
    ctx.beginPath();
    ctx.arc(w / 2, 34, 20, 0, Math.PI * 2);
    ctx.fillStyle = me.color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(String(me.num), w / 2, 35);
    // physical size this screen is assumed to have: should match the real screen
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(`this screen: ${Math.round(w / this.view.scale)} × ${Math.round(h / this.view.scale)} mm`, w / 2, 70, w - 24);
    if (!this.pts.size) {
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(0, h / 2 - 30, w, 60);
      ctx.fillStyle = '#fff';
      ctx.fillText('Drag so the lines continue straight', w / 2, h / 2 - 10, w - 24);
      ctx.fillText(this.allowResize ? 'into the neighbouring screens. Pinch to resize.' : 'into the neighbouring screens.', w / 2, h / 2 + 10, w - 24);
    }
  }

  capture(e) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
  }

  pointer(e) {
    if (this.mode === 'layout' && this.editor) {
      this.editor.pointer(e);
      this.dirty = true;
    } else if (this.mode === 'align') this.alignPointer(e);
    else if (this.mode === 'play') this.playPointer(e);
  }

  // --- Step 2: align. Pan with one finger, pinch with two (like a map).
  alignPointer(e) {
    const id = e.pointerId;
    if (e.type === 'pointerdown') {
      this.capture(e);
      this.pts.set(id, [e.clientX, e.clientY]);
      this.anchor();
    } else if (!this.pts.has(id)) {
      return;
    } else if (e.type === 'pointermove') {
      this.pts.set(id, [e.clientX, e.clientY]);
      this.applyGesture();
    } else {
      this.pts.delete(id);
      this.anchor();
      this.sendView(true);
    }
    this.dirty = true;
  }

  anchor() {
    this.g0 = {
      view: { ...this.view },
      pts: [...this.pts].slice(0, 2).map(([id, s]) => ({ id, s, w: toWorld(this.view, s[0], s[1]) })),
    };
  }

  applyGesture() {
    const g = this.g0;
    if (!g?.pts.length) return;
    const cur = g.pts.map((a) => this.pts.get(a.id));
    if (cur.some((c) => !c)) return;
    let v = { ...g.view };
    if (this.cardMode) {
      // only change the size, keep the screen centre fixed
      if (g.pts.length < 2) return;
      const d0 = dist(g.pts[0].s, g.pts[1].s);
      if (d0 < 10) return;
      const c = toWorld(g.view, this.w / 2, this.h / 2);
      v.scale = clamp((g.view.scale * dist(cur[0], cur[1])) / d0, 1, 30);
      v = pin(v, this.w / 2, this.h / 2, c[0], c[1]);
    } else if (g.pts.length === 1) {
      v = pin(v, cur[0][0], cur[0][1], g.pts[0].w[0], g.pts[0].w[1]);
    } else {
      const [a, b] = g.pts, [sa, sb] = cur;
      const dw = dist(a.w, b.w), ds = dist(sa, sb);
      if (dw < 1e-6 || ds < 10) return;
      if (this.allowResize) v.scale = clamp(ds / dw, 1, 30);
      if (this.freeRotate) v.rot = Math.atan2(b.w[1] - a.w[1], b.w[0] - a.w[0]) - Math.atan2(sb[1] - sa[1], sb[0] - sa[0]);
      const wm = mid(a.w, b.w), sm = mid(sa, sb);
      v = pin(v, sm[0], sm[1], wm[0], wm[1]);
    }
    this.view = v;
    this.sendView(false);
  }

  sendView(final) {
    const now = performance.now();
    clearTimeout(this.viewTimer);
    if (final || now - this.lastViewSend > 100) {
      this.lastViewSend = now;
      this.send({ t: 'view', view: this.view });
    } else {
      this.viewTimer = setTimeout(() => this.sendView(true), 100);
    }
  }

  // --- Step 3: play. Drag pieces; dropping is checked by the game master (captures etc.).
  playPointer(e) {
    const id = e.pointerId;
    if (e.type === 'pointerdown') {
      const [wx, wy] = toWorld(this.view, e.clientX, e.clientY);
      const p = hitTest(this.state.pieces, wx, wy, 28 / this.view.scale);
      if (!p || [...this.drags.values()].some((d) => d.id === p.id)) return;
      if (p.heldBy && p.heldBy !== this.me.id) return;
      this.capture(e);
      this.drags.set(id, { pointerId: id, id: p.id, offX: p.x - wx, offY: p.y - wy, sx: e.clientX, sy: e.clientY, moved: false });
      p.z = Math.max(0, ...Object.values(this.state.pieces).map((q) => q.z || 0)) + 1;
      this.send({ t: 'grab', id: p.id });
    } else {
      const d = this.drags.get(id);
      if (!d) return;
      const p = this.state.pieces[d.id];
      if (!p) {
        this.drags.delete(id);
        return;
      }
      if (e.type === 'pointermove') {
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 8) d.moved = true;
        if (!d.moved) return;
        const [wx, wy] = toWorld(this.view, e.clientX, e.clientY);
        p.x = wx + d.offX;
        p.y = wy + d.offY;
        this.pending.set(p.id, [p.x, p.y]);
      } else {
        this.drags.delete(id);
        this.pending.delete(p.id);
        this.send({ t: 'drop', id: p.id, x: p.x, y: p.y });
      }
    }
    this.dirty = true;
  }
}
