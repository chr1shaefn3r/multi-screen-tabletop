import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as madn from '../public/js/games/mensch-aerger-dich-nicht.js';

const { WAITING: W } = madn;
// A game with given positions; the current player is about to roll.
function game(pieces, turn = Object.keys(pieces)[0], tries) {
  const g = madn.newGame(Object.keys(pieces));
  Object.assign(g.pieces, structuredClone(pieces));
  g.turn = turn;
  g.tries = tries ?? 1;
  return g;
}
const legal = (g) => madn.legalMoves(g).map((m) => m.i);

test('a new game: everyone waits on B and gets 3 tries to roll a 6', () => {
  const g = madn.newGame(['red', 'yellow', 'blue']);
  assert.deepEqual(g.players, ['yellow', 'red', 'blue'], 'clockwise order');
  assert.equal(g.turn, 'yellow');
  assert.equal(g.tries, 3);
  let s = madn.roll(g, 3);
  assert.equal(s.turn, 'yellow');
  assert.equal(s.tries, 2);
  s = madn.roll(madn.roll(s, 5), 1);
  assert.equal(s.turn, 'red', 'after 3 misses the next player rolls');
  assert.equal(s.tries, 3);
});

test('a 6 must bring a piece out, then the player rolls again', () => {
  let g = madn.roll(madn.newGame(['yellow', 'red']), 6);
  assert.deepEqual(legal(g), [0, 1, 2, 3], 'any waiting piece can come out');
  g = madn.move(g, 2);
  assert.equal(g.pieces.yellow[2], 0, 'on the start field');
  assert.equal(g.turn, 'yellow');
  assert.equal(g.phase, 'roll');
  assert.equal(g.tries, 1);
});

test('bringing out is mandatory even if another piece could move', () => {
  const g = madn.roll(game({ yellow: [12, W, W, W], red: [W, W, W, W] }), 6);
  assert.deepEqual(legal(g), [1, 2, 3]);
});

test('the start field must be cleared while pieces are waiting', () => {
  const g = madn.roll(game({ yellow: [0, 15, W, W], red: [W, W, W, W] }), 4);
  assert.deepEqual(legal(g), [0]);
  // a 6 with the start field blocked by an own piece: the piece on A has to move on
  const g6 = madn.roll(game({ yellow: [0, 15, W, W], red: [W, W, W, W] }), 6);
  assert.deepEqual(legal(g6), [0]);
  // nobody waiting: free choice
  const free = madn.roll(game({ yellow: [0, 15, 41, 42], red: [W, W, W, W] }), 4);
  assert.deepEqual(legal(free), [0, 1]);
});

test('if the piece on the start field is blocked, others may move', () => {
  const g = madn.roll(game({ yellow: [0, 3, W, W], red: [W, W, W, W] }), 3);
  assert.deepEqual(legal(g), [1]);
});

test('landing on an opponent captures it; landing on an own piece is not allowed', () => {
  // red's progress 5 is field 25; yellow's progress 25 is field 25 too
  let g = madn.roll(game({ yellow: [22, 20, 41, 42], red: [5, W, W, W] }), 3);
  assert.deepEqual(madn.legalMoves(g).find((m) => m.i === 0).capture, { color: 'red', i: 0 });
  g = madn.move(g, 0);
  assert.equal(g.pieces.red[0], W, 'captured piece is back on B');
  assert.match(g.events[0], /captured Red/);
  assert.equal(g.turn, 'red');

  const own = madn.roll(game({ yellow: [10, 12, 41, 42], red: [W, W, W, W] }), 2);
  assert.deepEqual(legal(own), [1], 'piece 0 would land on piece 1');
});

test('pieces may jump over others on the track', () => {
  const g = madn.roll(game({ yellow: [10, 11, 41, 42], red: [W, W, W, W] }), 3);
  assert.ok(legal(g).includes(0));
});

test('bringing out onto an opponent on the own start field captures it', () => {
  // yellow's start is field 0 = red's progress 20
  const g = madn.move(madn.roll(game({ yellow: [W, W, W, W], red: [20, W, W, W] }, 'yellow', 3), 6), 0);
  assert.equal(g.pieces.red[0], W);
  assert.equal(g.pieces.yellow[0], 0);
});

test('the goal needs the exact number and no jumping over own pieces inside it', () => {
  let g = madn.roll(game({ yellow: [38, 43, 20, 25], red: [W, W, W, W] }), 6);
  assert.deepEqual(legal(g), [2, 3], 'piece 0 would end up past the last goal field');
  g = madn.roll(game({ yellow: [38, 41, 20, 25], red: [W, W, W, W] }), 4);
  assert.ok(!legal(g).includes(0), 'piece 0 would jump over the own piece on goal field b');
  g = madn.roll(game({ yellow: [38, 41, 20, 25], red: [W, W, W, W] }), 2);
  assert.ok(legal(g).includes(0), 'goal field a is free');
  g = madn.roll(game({ yellow: [40, 42, 20, 25], red: [W, W, W, W] }), 3);
  assert.ok(!legal(g).includes(0), 'moving inside the goal may not jump either');
  assert.ok(madn.roll(game({ yellow: [40, 42, 20, 25], red: [W, W, W, W] }), 1).phase === 'move');
});

test('pieces stuck in the goal count as unable to move: 3 tries', () => {
  // red moves, then it's yellow's turn: yellow's pieces on goal fields c and d can't move at all
  let g = madn.move(madn.roll(game({ red: [5, W, W, W], yellow: [42, 43, W, W] }, 'red'), 2), 0);
  assert.deepEqual([g.turn, g.tries], ['yellow', 3]);
  // with a piece on goal field a and b free, a 1 would move it: just one try
  g = madn.move(madn.roll(game({ red: [5, W, W, W], yellow: [40, 43, W, W] }, 'red'), 2), 0);
  assert.deepEqual([g.turn, g.tries], ['yellow', 1]);
});

test('finishing, places and game over', () => {
  let g = madn.roll(game({ yellow: [41, 42, 43, 37], red: [W, W, W, W], blue: [W, W, W, W] }), 3);
  g = madn.move(g, 3);
  assert.deepEqual(g.winners, ['yellow']);
  assert.equal(g.turn, 'red', 'winners are skipped');
  g = madn.roll(game({ yellow: [40, 41, 42, 43], red: [41, 42, 43, 38], blue: [W, W, W, W] }, 'red'), 2);
  g.winners = ['yellow'];
  g = madn.move(g, 3);
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.winners, ['yellow', 'red', 'blue']);
  assert.equal(madn.roll(g, 6), null, 'nothing happens after the game is over');
});

test('the die is blank whenever a fresh roll is needed', () => {
  let g = madn.newGame(['yellow', 'red']);
  assert.equal(g.die, null);
  g = madn.roll(g, 6);
  assert.equal(g.die, 6, 'shown while choosing a move');
  g = madn.move(g, 0);
  assert.deepEqual([g.turn, g.die, g.lastRoll.value], ['yellow', null, 6], 'extra roll after a 6: blank again');
  assert.match(g.events.at(-1), /roll again/);
  g = madn.move(madn.roll(g, 2), 0);
  assert.deepEqual([g.turn, g.die], ['red', null], 'next player starts with a blank die');
  g = madn.roll(g, 4);
  assert.deepEqual([g.turn, g.die, g.lastRoll], ['red', null, { color: 'red', value: 4 }], 'a miss keeps the result in lastRoll');
});

test('illegal actions return null', () => {
  const g = madn.newGame(['yellow', 'red']);
  assert.equal(madn.move(g, 0), null, 'must roll first');
  const r = madn.roll(g, 6);
  assert.equal(madn.roll(r, 3), null, 'must move first');
  assert.equal(madn.roll(g, 7), null);
});

test('board layout: a closed loop of 40 neighbouring fields, goals and homes in place', () => {
  const T = madn.TRACK_CELLS;
  assert.equal(new Set(T.map(String)).size, 40);
  T.forEach((c, k) => {
    const n = T[(k + 1) % 40];
    assert.equal(Math.abs(c[0] - n[0]) + Math.abs(c[1] - n[1]), 1, `fields ${k} and ${k + 1} touch`);
  });
  for (const color of madn.COLORS) {
    const entry = madn.cellOf(color, 0, 39), a = madn.goalCells(color)[0];
    assert.equal(Math.abs(entry[0] - a[0]) + Math.abs(entry[1] - a[1]), 1, `${color} goal starts next to its last track field`);
    const home = madn.homeCells(color)[0], start = madn.startCell(color);
    assert.ok(Math.hypot(home[0] - start[0], home[1] - start[1]) < 5, `${color} home is near its start`);
    const all = [...T, ...madn.goalCells(color), ...madn.homeCells(color), ...madn.COLORS.flatMap((c) => [...madn.goalCells(c), ...madn.homeCells(c)])];
    const [sx, sy] = madn.dieSpot(color);
    assert.ok(all.every(([c, r]) => Math.hypot(c + 0.5 - sx, r + 0.5 - sy) >= 1), `${color}'s die does not cover a field`);
  }
});
