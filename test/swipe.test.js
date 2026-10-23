import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostCore } from '../public/js/core.js';
import { toWorld, toScreen } from '../public/js/geom.js';

const W = 390, H = 844;

function table(trueViews) {
  const core = new HostCore();
  const inbox = {};
  trueViews.forEach((v, i) => {
    const id = 'd' + i;
    inbox[id] = [];
    core.connect({ deviceId: id, name: id, w: W, h: H, scale: 6.3 }, { send: (m) => inbox[id].push(structuredClone(m)), close() {} }, i === 0);
  });
  core.devices.get('d0').view = { ...trueViews[0] }; // the reference screen defines the world
  return { core, inbox };
}

// Finger moving in a straight world line at `speed` mm/ms; each screen records what it sees.
// `clockError[i]` ms are added to screen i's timestamps (imperfect clock sync).
function swipe(core, trueViews, from, to, { speed = 0.4, clockError = [] } = {}) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const strokes = trueViews.map(() => []);
  for (let t = 0; t <= len / speed; t += 8) {
    const w = [from[0] + ((to[0] - from[0]) * t * speed) / len, from[1] + ((to[1] - from[1]) * t * speed) / len];
    trueViews.forEach((v, i) => {
      const [x, y] = toScreen(v, ...w);
      if (x >= 0 && y >= 0 && x <= W && y <= H) strokes[i].push([x, y, 1000 + t + (clockError[i] || 0)]);
    });
  }
  strokes.forEach((pts, i) => pts.length >= 3 && core.handle('d' + i, { t: 'stroke', pts }));
}

// Largest distance between where the core thinks a screen's corners are and where they really are.
function cornerError(core, id, trueView) {
  const v = core.devices.get(id).view;
  return Math.max(...[[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => {
    const a = toWorld(v, x, y), b = toWorld(trueView, x, y);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }));
}

test('two swipes line up a different, slightly tilted phone', () => {
  const A = { ox: 0, oy: 0, rot: 0, scale: 6.3 };
  const B = { ox: 70, oy: 5, rot: 0.02, scale: 5.8 }; // 8 mm bezel gap, 5 mm lower, other pixel density
  const { core, inbox } = table([A, B]);
  assert.ok(cornerError(core, 'd1', B) > 10, 'starts out wrong');
  // screen 2's clock is 3 ms off after syncing (the same for both swipes)
  swipe(core, [A, B], [30, 30], [110, 32], { clockError: [0, 3] });
  assert.match(inbox.d1.filter((m) => m.t === 'status').at(-1).text, /Lined up with screen 1/);
  swipe(core, [A, B], [30, 120], [110, 118], { clockError: [0, 3] });
  const v = core.devices.get('d1').view;
  assert.ok(cornerError(core, 'd1', B) < 1.5, `corner error ${cornerError(core, 'd1', B).toFixed(2)} mm`);
  assert.ok(Math.abs(v.scale - 5.8) / 5.8 < 0.02, `scale ${v.scale}`);
});

test('one swipe finds a screen that is turned by 90°', () => {
  const A = { ox: 0, oy: 0, rot: 0, scale: 6.3 };
  const B = { ox: 62 + 6 + 134, oy: 10, rot: Math.PI / 2, scale: 6.3 }; // lying sideways to the right
  const { core } = table([A, B]);
  swipe(core, [A, B], [30, 60], [120, 60]);
  const v = core.devices.get('d1').view;
  assert.ok(Math.abs(v.rot - Math.PI / 2) < 0.01, `rot ${v.rot}`);
  assert.ok(cornerError(core, 'd1', B) < 2, `corner error ${cornerError(core, 'd1', B).toFixed(2)} mm`);
});

test('one long swipe lines up a whole row', () => {
  const A = { ox: 0, oy: 0, rot: 0, scale: 6.3 };
  const B = { ox: 69, oy: 3, rot: 0, scale: 6.3 };
  const C = { ox: 138, oy: -4, rot: 0, scale: 6.3 };
  const { core } = table([A, B, C]);
  swipe(core, [A, B, C], [20, 70], [190, 72]);
  assert.ok(cornerError(core, 'd1', B) < 2);
  assert.ok(cornerError(core, 'd2', C) < 2);
  assert.equal(core.aligner.parent.get('d2'), 'd1', 'C was lined up with B');
});

test('swipes between two screens that are not lined up yet are refused', () => {
  const A = { ox: 0, oy: 0, rot: 0, scale: 6.3 };
  const B = { ox: 69, oy: 0, rot: 0, scale: 6.3 };
  const C = { ox: 138, oy: 0, rot: 0, scale: 6.3 };
  const { core, inbox } = table([A, B, C]);
  swipe(core, [A, B, C].map((v, i) => (i === 0 ? { ...v, ox: -1000 } : v)), [100, 70], [190, 70]); // only B and C see it
  assert.ok(inbox.d1.some((m) => /Neither screen is lined up/.test(m.toast || '')));
  assert.equal(core.aligner.parent.size, 0);
});

test('a screen moved by hand gives up its swipe data', () => {
  const A = { ox: 0, oy: 0, rot: 0, scale: 6.3 };
  const B = { ox: 70, oy: 5, rot: 0, scale: 6.3 };
  const { core } = table([A, B]);
  swipe(core, [A, B], [30, 30], [110, 32]);
  core.handle('d1', { t: 'view', view: { ox: 75, oy: 5, rot: 0, scale: 6.3 } });
  assert.equal(core.aligner.parent.has('d1'), false);
  assert.match(core.aligner.status('d1'), /by hand/);
});
