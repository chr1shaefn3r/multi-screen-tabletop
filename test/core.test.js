import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWorld, toScreen, pin, corners, bounds } from '../public/js/geom.js';
import { HostCore } from '../public/js/core.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('screen <-> world round trip with rotation', () => {
  const v = { ox: 12, oy: -40, rot: 0.7, scale: 6.2 };
  const [wx, wy] = toWorld(v, 120, 300);
  const [sx, sy] = toScreen(v, wx, wy);
  close(sx, 120);
  close(sy, 300);
});

test('pin keeps a world point under a screen point', () => {
  const v = pin({ ox: 0, oy: 0, rot: Math.PI / 2, scale: 5 }, 100, 50, 30, 40);
  const [wx, wy] = toWorld(v, 100, 50);
  close(wx, 30);
  close(wy, 40);
});

function fakeDevice(core, id, w = 390, h = 844) {
  const inbox = [];
  core.connect({ deviceId: id, name: id, w, h, scale: 6.3 }, { send: (m) => inbox.push(structuredClone(m)), close() {} });
  return inbox;
}

test('new screens are placed side by side', () => {
  const core = new HostCore();
  fakeDevice(core, 'a');
  fakeDevice(core, 'b');
  const [a, b] = ['a', 'b'].map((id) => bounds(corners(core.devices.get(id).view, 390, 844)));
  close(b.l, a.r);
  close(b.t, a.t);
});

test('dragging and dropping a piece snaps it and syncs other screens', () => {
  const core = new HostCore();
  const inA = fakeDevice(core, 'a');
  const inB = fakeDevice(core, 'b');
  core.setMode('play');
  core.newGame('chess');
  const b = core.state.board;
  const [id, p] = Object.entries(core.state.pieces).find(([, p]) => p.glyph === '♟' && p.color === 'w');
  core.handle('a', { t: 'grab', id });
  core.handle('b', { t: 'grab', id }); // b can't take it while a holds it
  assert.equal(p.heldBy, 'a');
  inB.length = 0;
  core.handle('a', { t: 'drag', id, x: p.x + 1, y: p.y - b.cell * 2.2 });
  assert.equal(inB.at(-1).t, 'piece', 'other screens see the drag');
  core.handle('a', { t: 'drop', id, x: p.x, y: p.y });
  assert.equal(p.heldBy, null);
  close(((p.y - b.y) / b.cell) % 1, 0.5); // snapped to a cell centre
  assert.equal(inA.at(-1).p.y, p.y);
});

test('tapping a die rolls it', () => {
  const core = new HostCore();
  fakeDevice(core, 'a');
  core.setMode('play');
  core.newGame('free');
  const die = Object.values(core.state.pieces).find((p) => p.kind === 'die');
  core.handle('a', { t: 'tap', id: die.id });
  assert.equal(die.rollSeq, 1);
  assert.ok(die.value >= 1 && die.value <= 6);
});

test('a reconnecting device keeps its place', () => {
  const core = new HostCore();
  fakeDevice(core, 'a');
  fakeDevice(core, 'b');
  core.setView('b', { ox: 500, oy: 7, rot: 0, scale: 6 });
  core.disconnect('b');
  const inbox = fakeDevice(core, 'b');
  assert.equal(inbox[0].t, 'welcome');
  assert.equal(inbox[0].view.ox, 500);
  assert.equal(inbox[0].you.num, 2);
});
