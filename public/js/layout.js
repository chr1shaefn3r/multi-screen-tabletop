// Step 1 on the game master's screen: a bird's-eye view of all screens.
// Drag rectangles so they match how the devices lie on the table; edges snap together.
import { corners, bounds, pointInPoly, rotV, toWorld, QUARTER } from './geom.js';

export class LayoutEditor {
  constructor(core) {
    this.core = core;
    this.sel = null;
    this.drag = null;
    this.cam = null;
    this.dirty = false;
    this.onSelect = null;
  }

  tiles() {
    return [...this.core.devices.values()].filter((d) => d.view && d.w && d.h);
  }

  // Fit all tiles on screen. Frozen while dragging so things don't jump around.
  camera(w, h) {
    if (this.drag && this.cam) return this.cam;
    const pts = this.tiles().flatMap((d) => corners(d.view, d.w, d.h));
    const u = bounds(pts.length ? pts : [[0, 0], [100, 100]]);
    const top = 130, bottom = 84, side = 20;
    const k = Math.min((w - 2 * side) / u.w, (h - top - bottom) / u.h) * 0.8;
    this.cam = { k, ox: u.cx - w / 2 / k, oy: u.cy - (top + (h - top - bottom) / 2) / k };
    return this.cam;
  }

  ws([x, y]) {
    const c = this.cam;
    return [(x - c.ox) * c.k, (y - c.oy) * c.k];
  }

  draw(ctx, w, h) {
    this.dirty = false;
    this.camera(w, h);
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('Step 1 · Arrange the screens', w / 2, 72);
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = '#aab';
    ctx.fillText('Drag the rectangles to match the table. Tap one, then rotate it below.', w / 2, 94, w - 24);
    ctx.fillText('Each device shows its number and an arrow pointing to its top edge.', w / 2, 112, w - 24);

    for (const d of this.tiles()) {
      const pts = corners(d.view, d.w, d.h).map((p) => this.ws(p));
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = d.connected ? d.color + 'cc' : '#55555599';
      ctx.fill();
      ctx.setLineDash(d.connected ? [] : [6, 4]);
      ctx.lineWidth = d.id === this.sel ? 4 : 1.5;
      ctx.strokeStyle = d.id === this.sel ? '#fff' : 'rgba(255,255,255,.6)';
      ctx.stroke();
      ctx.setLineDash([]);

      const [cx, cy] = this.ws(toWorld(d.view, d.w / 2, d.h / 2));
      const size = Math.min(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), Math.hypot(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]));
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.max(14, size * 0.42)}px system-ui, sans-serif`;
      ctx.fillText(String(d.num), cx, cy);
      ctx.font = `${Math.max(10, Math.min(13, size * 0.12))}px system-ui, sans-serif`;
      ctx.fillText(d.isHost ? 'this device' : d.connected ? d.name : 'offline', cx, cy + size * 0.32, size * 0.95);

      // arrow towards the device's top edge
      const [ux, uy] = rotV(0, -1, d.view.rot);
      const [tx, ty] = this.ws(toWorld(d.view, d.w / 2, d.h * 0.06));
      const a = Math.max(6, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(tx + ux * a, ty + uy * a);
      ctx.lineTo(tx - ux * a * 0.4 - uy * a, ty - uy * a * 0.4 + ux * a);
      ctx.lineTo(tx - ux * a * 0.4 + uy * a, ty - uy * a * 0.4 - ux * a);
      ctx.closePath();
      ctx.fill();
    }
  }

  pointer(e) {
    if (!this.cam) return;
    const x = e.clientX, y = e.clientY;
    if (e.type === 'pointerdown') {
      if (this.drag) return;
      const hit = this.tiles()
        .reverse()
        .find((d) => pointInPoly(x, y, corners(d.view, d.w, d.h).map((p) => this.ws(p))));
      this.sel = hit ? hit.id : null;
      this.onSelect?.(hit);
      if (hit) {
        try {
          e.target.setPointerCapture(e.pointerId);
        } catch {}
        this.drag = { pid: e.pointerId, id: hit.id, sx: x, sy: y, view: { ...hit.view } };
      }
    } else if (this.drag && e.pointerId === this.drag.pid) {
      const d = this.core.devices.get(this.drag.id);
      if (d && (e.type === 'pointermove' || Math.hypot(x - this.drag.sx, y - this.drag.sy) > 2)) {
        const k = this.cam.k;
        const v = { ...this.drag.view, ox: this.drag.view.ox + (x - this.drag.sx) / k, oy: this.drag.view.oy + (y - this.drag.sy) / k };
        const [sx, sy] = this.snap(d, v, 14 / k);
        this.core.setView(d.id, { ...v, ox: v.ox + sx, oy: v.oy + sy });
      }
      if (e.type === 'pointerup' || e.type === 'pointercancel') this.drag = null;
    }
    this.dirty = true;
  }

  // How far to nudge view v so its edges line up with a neighbour's edges.
  snap(d, v, thr) {
    const a = bounds(corners(v, d.w, d.h));
    let bx = null, by = null;
    const better = (cur, cand) => Math.abs(cand) < thr && (cur === null || Math.abs(cand) < Math.abs(cur));
    for (const o of this.tiles()) {
      if (o === d) continue;
      const b = bounds(corners(o.view, o.w, o.h));
      for (const dx of [b.r - a.l, b.l - a.r, b.l - a.l, b.r - a.r]) if (better(bx, dx)) bx = dx;
      for (const dy of [b.b - a.t, b.t - a.b, b.t - a.t, b.b - a.b]) if (better(by, dy)) by = dy;
    }
    return [bx || 0, by || 0];
  }

  // Rotate the selected screen by 90° around its centre.
  rotate(dir) {
    const d = this.core.devices.get(this.sel);
    if (!d) return;
    const [cx, cy] = toWorld(d.view, d.w / 2, d.h / 2);
    const rot = Math.round((d.view.rot + dir * QUARTER) / QUARTER) * QUARTER;
    const [x, y] = rotV(d.w / 2 / d.view.scale, d.h / 2 / d.view.scale, rot);
    const v = { ...d.view, rot, ox: cx - x, oy: cy - y };
    // turning around the centre can push it into a neighbour: snap edges back together
    const [sx, sy] = this.snap(d, v, Math.max(d.w, d.h) / d.view.scale / 2);
    this.core.setView(d.id, { ...v, ox: v.ox + sx, oy: v.oy + sy });
  }

  // Put all connected screens in one row, in join order.
  arrange() {
    let x = 0;
    const list = this.tiles().filter((d) => d.connected).sort((a, b) => a.num - b.num);
    for (const d of list) {
      this.core.setView(d.id, { ...d.view, rot: 0, ox: x, oy: 0 });
      x += d.w / d.view.scale;
    }
  }
}
