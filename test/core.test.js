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

const findPiece = (core, glyph, color, col, row) => {
  const b = core.state.board;
  return Object.values(core.state.pieces).find(
    (p) => p.glyph === glyph && p.color === color && !p.captured && Math.floor((p.x - b.x) / b.cell) === col && Math.floor((p.y - b.y) / b.cell) === row,
  );
};
const move = (core, dev, p, col, row) => {
  const b = core.state.board;
  core.handle(dev, { t: 'grab', id: p.id });
  core.handle(dev, { t: 'drop', id: p.id, x: b.x + (col + 0.3) * b.cell, y: b.y + (row + 0.6) * b.cell });
};

function chessTable() {
  const core = new HostCore();
  const inA = fakeDevice(core, 'a');
  const inB = fakeDevice(core, 'b');
  core.setMode('play');
  core.newGame();
  return { core, inA, inB };
}

test('chess board is centred on the screens and leaves room for captured pieces', () => {
  const { core } = chessTable();
  const u = core.union(), b = core.state.board;
  close(b.x + b.w / 2, u.cx);
  close(b.y + b.h / 2, u.cy);
  assert.ok(b.y - b.cell > u.t && b.y + b.h + b.cell < u.b, 'rows for captured pieces fit on the screens');
  assert.equal(Object.keys(core.state.pieces).length, 32);
});

test('dragging and dropping a piece snaps it and syncs other screens', () => {
  const { core, inA, inB } = chessTable();
  const b = core.state.board;
  const p = findPiece(core, '♟', 'w', 4, 6);
  core.handle('a', { t: 'grab', id: p.id });
  core.handle('b', { t: 'grab', id: p.id }); // b can't take it while a holds it
  assert.equal(p.heldBy, 'a');
  inB.length = 0;
  core.handle('a', { t: 'drag', id: p.id, x: p.x + 1, y: p.y - b.cell * 2.2 });
  assert.equal(inB.at(-1).t, 'piece', 'other screens see the drag');
  core.handle('a', { t: 'drop', id: p.id, x: p.x, y: p.y });
  assert.equal(p.heldBy, null);
  close(p.y, b.y + 4.5 * b.cell); // snapped to the centre of e4
  assert.equal(inA.at(-1).p.y, p.y);
});

test('dropping on an opposing piece captures it', () => {
  const { core, inB } = chessTable();
  const b = core.state.board;
  const white = findPiece(core, '♟', 'w', 4, 6);
  const black = findPiece(core, '♟', 'b', 3, 1);
  move(core, 'a', white, 4, 4);
  move(core, 'b', black, 3, 3);
  inB.length = 0;
  move(core, 'a', white, 3, 3); // exd5
  assert.equal(black.captured, true);
  assert.ok(black.y < b.y, 'captured black piece goes above the board');
  assert.ok(black.size < white.size, 'captured pieces are drawn smaller');
  assert.ok(inB.some((m) => m.t === 'piece' && m.p.id === black.id && m.p.captured), 'other screens are told');
  close(white.x, b.x + 3.5 * b.cell);

  const queen = findPiece(core, '♛', 'b', 3, 0);
  move(core, 'b', queen, 3, 3); // Qxd5
  assert.equal(white.captured, true);
  assert.ok(white.y > b.y + b.h, 'captured white piece goes below the board');
});

test('captured pieces line up sorted by value', () => {
  const { core } = chessTable();
  const b = core.state.board;
  const pawn = findPiece(core, '♟', 'b', 0, 1);
  const rook = findPiece(core, '♜', 'b', 0, 0);
  move(core, 'b', pawn, 0, -2); // off the board = removed
  move(core, 'b', rook, 9, 3);
  assert.ok(pawn.captured && rook.captured);
  close(pawn.y, rook.y);
  assert.ok(rook.x > pawn.x, "black's row starts at black's left (the right end): rook first, then pawn");

  // capture more white pieces than fit on one screen: none may sit across the gap between the screens
  for (const [c, r] of [[0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [0, 7], [1, 7]]) {
    move(core, 'a', findPiece(core, r === 6 ? '♟' : c === 0 ? '♜' : '♞', 'w', c, r), c, 10);
  }
  const captured = Object.values(core.state.pieces).filter((p) => p.captured && p.color === 'w');
  assert.equal(captured.length, 10);
  for (const p of captured) assert.ok(core.onOneScreen(p.x, p.y, p.size), `captured ${p.glyph} at x=${p.x.toFixed(1)} is not split across screens`);
  assert.ok(captured.every((p) => p.y > b.y + b.h));
});

test('own pieces cannot be captured, captured pieces can come back', () => {
  const { core } = chessTable();
  const b = core.state.board;
  const knight = findPiece(core, '♞', 'w', 1, 7);
  const [x, y] = [knight.x, knight.y];
  move(core, 'a', knight, 1, 6); // onto own pawn
  assert.deepEqual([knight.x, knight.y, knight.captured], [x, y, false], 'move undone');

  const pawn = findPiece(core, '♟', 'w', 1, 6);
  move(core, 'a', pawn, 1, 9);
  assert.equal(pawn.captured, true);
  move(core, 'a', pawn, 2, 4);
  assert.equal(pawn.captured, false);
  close(pawn.size, b.cell * 0.46);
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
