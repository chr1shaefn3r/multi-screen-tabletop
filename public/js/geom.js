// Geometry for the shared "world" (the virtual table). World units are millimetres.
//
// Every screen has a view {ox, oy, rot, scale}:
//   (ox, oy) world point shown at the screen's top-left corner
//   rot      direction (radians) of the screen's x-axis in the world
//   scale    CSS pixels per millimetre on that device

export const QUARTER = Math.PI / 2;

export function rotV(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

export function toWorld(v, sx, sy) {
  const [x, y] = rotV(sx / v.scale, sy / v.scale, v.rot);
  return [v.ox + x, v.oy + y];
}

export function toScreen(v, wx, wy) {
  const [x, y] = rotV(wx - v.ox, wy - v.oy, -v.rot);
  return [x * v.scale, y * v.scale];
}

// The four corners of a w×h screen in world coordinates.
export function corners(v, w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => toWorld(v, x, y));
}

export function bounds(points) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const [x, y] of points) {
    l = Math.min(l, x); t = Math.min(t, y);
    r = Math.max(r, x); b = Math.max(b, y);
  }
  return { l, t, r, b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}

// Moves a view so that screen point (sx, sy) shows world point (wx, wy).
export function pin(v, sx, sy, wx, wy) {
  const [x, y] = rotV(sx / v.scale, sy / v.scale, v.rot);
  return { ...v, ox: wx - x, oy: wy - y };
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function sanitizeView(v) {
  if (!v || typeof v !== 'object') return null;
  const out = { ox: +v.ox, oy: +v.oy, rot: +v.rot, scale: +v.scale };
  if (!Object.values(out).every(Number.isFinite) || out.scale < 0.5 || out.scale > 50) return null;
  return out;
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
