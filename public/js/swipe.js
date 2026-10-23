// Automatic alignment by swiping: the player draws one quick straight line from one screen
// across the gap onto the next. Both screens record the finger's path with timestamps on
// the game master's clock. Where the line leaves one screen and enters the other, and in
// which direction, tells where the screens lie relative to each other:
//   - 1 swipe across a gap: position and which way the screen is turned
//   - 2+ swipes, some distance apart: also exact size (scale) and small tilts
// Runs on the game master's device; works in screen pixels and world millimetres.
import { toWorld, rotV, QUARTER } from './geom.js';

export const EDGE_PX = 50; // a stroke must start or end this close to a screen edge
export const MIN_SPEED = 0.15; // px per ms (150 px/s): slower is not a swipe
const FIT_MS = 120; // use this much of the stroke next to the edge to fit the finger's motion
const GAP_MS = [-40, 700]; // time from leaving one screen to entering the next (small negative = clock error)
const MAX_CORR = 4; // swipes remembered per pair of screens
const MIN_SPREAD_PX = 60; // swipes this far apart are needed to measure the size
const MAX_TILT = (10 * Math.PI) / 180; // larger differences from a quarter turn are taken as noise

const angle = ([x, y]) => Math.atan2(y, x);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const mean = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
const circMean = (angles) => Math.atan2(angles.reduce((s, a) => s + Math.sin(a), 0), angles.reduce((s, a) => s + Math.cos(a), 0));

// Straight line at constant speed through stroke points [x, y, t]: position(t) = p + v·(t − tm)
export function fitTrack(pts) {
  const n = pts.length;
  const tm = pts.reduce((s, p) => s + p[2], 0) / n;
  let stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
  for (const [x, y, t] of pts) {
    const dt = t - tm;
    stt += dt * dt;
    sx += x;
    sy += y;
    stx += dt * x;
    sty += dt * y;
  }
  const v = stt > 0 ? [stx / stt, sty / stt] : [0, 0];
  const p = [sx / n, sy / n];
  return { v, at: (t) => [p[0] + v[0] * (t - tm), p[1] + v[1] * (t - tm)] };
}

// The finger's motion where a stroke starts or ends.
export function crossing(pts, which) {
  const t = which === 'end' ? pts.at(-1)[2] : pts[0][2];
  let part = pts.filter((p) => Math.abs(p[2] - t) <= FIT_MS);
  if (part.length < 3) part = which === 'end' ? pts.slice(-3) : pts.slice(0, 3);
  const f = fitTrack(part);
  return { t, v: f.v, at: f.at, pos: f.at(t) };
}

// Best rotation/scale mapping screen points S onto world points W (2D Procrustes).
// Returns rot and k (mm per px); with `rot` given, only the scale is fitted.
export function similarity(S, W, rot) {
  const sm = mean(S), wm = mean(W);
  let a = 0, b = 0, ss = 0;
  S.forEach((s, i) => {
    const sx = s[0] - sm[0], sy = s[1] - sm[1], wx = W[i][0] - wm[0], wy = W[i][1] - wm[1];
    a += sx * wx + sy * wy;
    b += sx * wy - sy * wx;
    ss += sx * sx + sy * sy;
  });
  rot ??= Math.atan2(b, a);
  return { rot, k: (a * Math.cos(rot) + b * Math.sin(rot)) / ss, sm, wm };
}

const nearEdge = (d, [x, y]) => x < EDGE_PX || y < EDGE_PX || x > d.w - EDGE_PX || y > d.h - EDGE_PX;

export class SwipeAligner {
  constructor(core) {
    this.core = core;
    this.strokes = [];
    this.parent = new Map(); // screen id -> the screen it was lined up with
    this.corr = new Map(); // screen id -> swipes with its parent
    this.manual = new Set(); // screens placed by hand (can serve as reference)
    this.alignedAt = new Map();
    this.seq = 0;
  }

  anchor() {
    return [...this.core.devices.values()].find((d) => d.isHost);
  }

  isFixed(id) {
    return id === this.anchor()?.id || this.parent.has(id) || this.manual.has(id);
  }

  // A screen was moved by hand: its swipe data no longer applies.
  movedByHand(id) {
    this.parent.delete(id);
    this.corr.delete(id);
    this.manual.add(id);
    this.alignedAt.set(id, ++this.seq);
  }

  status(id) {
    const devs = this.core.devices;
    if (id === this.anchor()?.id) return 'Reference screen: swipe from here onto the screens next to it';
    if (this.parent.has(id)) {
      const n = this.corr.get(id)?.length || 0;
      const sized = n >= 2 ? '' : ' · swipe again near the other end to match the size too';
      return `Lined up with screen ${devs.get(this.parent.get(id))?.num} ✓ (${n} swipe${n === 1 ? '' : 's'})${sized}`;
    }
    if (this.manual.has(id)) return 'Placed by hand';
    return 'Not lined up yet: swipe onto this screen from one that is';
  }

  // A finished stroke from a screen. Returns messages: [{ to: [ids], text, toast }], and logs.
  add(id, pts) {
    const d = this.core.devices.get(id);
    if (!d?.w || pts.length < 3) return [];
    const s = { id, pts, t0: pts[0][2], t1: pts.at(-1)[2], start: nearEdge(d, pts[0]), end: nearEdge(d, pts.at(-1)) };
    this.strokes = this.strokes.filter((o) => Math.abs(s.t1 - o.t1) < 3000);
    const out = [];
    const inGap = (dt) => dt >= GAP_MS[0] && dt <= GAP_MS[1];
    for (const o of this.strokes) {
      if (o.id === id) continue;
      if (o.end && s.start && !o.endUsed && !s.startUsed && inGap(s.t0 - o.t1)) out.push(...this.link(o, s));
      else if (s.end && o.start && !s.endUsed && !o.startUsed && inGap(o.t0 - s.t1)) out.push(...this.link(s, o));
    }
    this.strokes.push(s);
    // tell the user if a swipe that touched an edge found no partner
    if (s.start || s.end) {
      const timer = setTimeout(() => {
        if (!s.startUsed && !s.endUsed) {
          const text = 'That swipe did not reach a neighbouring screen. Swipe in one go, straight across the gap.';
          this.core.log(`Swipe on screen ${d.num} was not matched with a neighbouring screen`);
          this.core.deliver([{ to: [id], text, toast: true }]);
        }
      }, GAP_MS[1] + 500);
      timer?.unref?.();
    }
    return out;
  }

  // `exit` left its screen, `entry` started on the neighbouring one.
  link(exit, entry) {
    const devs = this.core.devices;
    const X = devs.get(exit.id), Y = devs.get(entry.id);
    if (!X?.view || !Y?.view) return [];
    exit.endUsed = entry.startUsed = true;
    const fx = this.isFixed(X.id), fy = this.isFixed(Y.id);
    const anchorId = this.anchor()?.id;
    let tgt;
    if (fx && !fy) tgt = Y;
    else if (fy && !fx) tgt = X;
    else if (!fx && !fy) {
      const text = `Neither screen is lined up yet. Start with a swipe from screen ${this.anchor()?.num} onto its neighbour.`;
      return [{ to: [X.id, Y.id], text, toast: true }];
    } else if (this.parent.get(Y.id) === X.id || X.id === anchorId) tgt = Y;
    else if (this.parent.get(X.id) === Y.id || Y.id === anchorId) tgt = X;
    else tgt = (this.alignedAt.get(X.id) || 0) > (this.alignedAt.get(Y.id) || 0) ? X : Y;
    const ref = tgt === X ? Y : X;
    if (this.isAncestor(tgt.id, ref.id)) return []; // would create a loop

    const refCross = crossing(ref === X ? exit.pts : entry.pts, ref === X ? 'end' : 'start');
    const tgtCross = crossing(tgt === X ? exit.pts : entry.pts, tgt === X ? 'end' : 'start');
    if (Math.hypot(...refCross.v) < MIN_SPEED || Math.hypot(...tgtCross.v) < MIN_SPEED) {
      return [{ to: [X.id, Y.id], text: 'Swipe a bit faster, in one straight move.', toast: true }];
    }
    if (this.parent.get(tgt.id) !== ref.id) {
      this.parent.set(tgt.id, ref.id);
      this.corr.set(tgt.id, []);
      this.manual.delete(tgt.id);
    }
    const list = this.corr.get(tgt.id);
    // the point on the finger's path where it entered (or left) the target screen, as seen
    // from the reference screen by continuing its motion across the gap
    list.push({ refPt: refCross.at(tgtCross.t), tgtPt: tgtCross.pos, refV: refCross.v, tgtV: tgtCross.v });
    if (list.length > MAX_CORR) list.shift();
    this.alignedAt.set(tgt.id, ++this.seq);

    const out = [this.solve(tgt.id)];
    // screens lined up with the target follow it
    const queue = [tgt.id];
    while (queue.length) {
      const p = queue.shift();
      for (const [child, par] of this.parent) {
        if (par === p) {
          this.solve(child, true);
          queue.push(child);
        }
      }
    }
    out.push({ to: [ref.id], text: `Screen ${tgt.num} lined up ✓`, toast: true });
    return out;
  }

  isAncestor(a, b) {
    for (let p = this.parent.get(b); p; p = this.parent.get(p)) if (p === a) return true;
    return false;
  }

  // Computes a screen's view from its swipes with its parent and applies it.
  solve(id, quiet = false) {
    const devs = this.core.devices;
    const t = devs.get(id), ref = devs.get(this.parent.get(id));
    const list = this.corr.get(id);
    if (!t || !ref || !list?.length) return null;
    const W = list.map((c) => toWorld(ref.view, ...c.refPt));
    const S = list.map((c) => c.tgtPt);

    // which way the screen is turned, from the swipe directions on both screens
    const dirRot = circMean(list.map((c) => angle(rotV(c.refV[0], c.refV[1], ref.view.rot)) - angle(c.tgtV)));
    const quarter = Math.round(dirRot / QUARTER) * QUARTER;
    let rot = Math.abs(wrap(t.view.rot - quarter)) < MAX_TILT ? t.view.rot : quarter;
    let scale = t.view.scale;
    let sized = false;
    const spread = Math.max(...S.map((a) => Math.max(...S.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])))));
    if (list.length >= 2 && spread >= MIN_SPREAD_PX) {
      const free = similarity(S, W);
      rot = Math.abs(wrap(free.rot - quarter)) < MAX_TILT ? free.rot : quarter;
      const s = 1 / similarity(S, W, rot).k;
      if (s / t.view.scale > 0.6 && s / t.view.scale < 1.7) {
        scale = s;
        sized = true;
      }
    }
    const sm = mean(S), wm = mean(W);
    const [x, y] = rotV(sm[0] / scale, sm[1] / scale, rot);
    const view = { ox: wm[0] - x, oy: wm[1] - y, rot, scale };
    const moved = Math.hypot(...[0, 1].map((i) => toWorld(view, t.w / 2, t.h / 2)[i] - toWorld(t.view, t.w / 2, t.h / 2)[i]));
    const fit = S.reduce((sum, s, i) => sum + Math.hypot(toWorld(view, ...s)[0] - W[i][0], toWorld(view, ...s)[1] - W[i][1]), 0) / S.length;
    const old = t.view;
    this.core.applyView(id, view);
    const deg = (a) => ((a * 180) / Math.PI).toFixed(1);
    this.core.log(
      `Swipe: screen ${t.num} ${quiet ? 'follows' : 'lined up with'} screen ${ref.num} from ${list.length} swipe(s): moved ${moved.toFixed(1)} mm, ` +
        `turned ${deg(wrap(old.rot))}° → ${deg(wrap(rot))}°, size ${old.scale.toFixed(2)} → ${scale.toFixed(2)} px/mm${sized ? '' : ' (unchanged)'}` +
        (list.length > 1 ? `, swipes agree within ${fit.toFixed(1)} mm` : ''),
    );
    return { to: [id], text: this.status(id), toast: true, status: true };
  }
}
