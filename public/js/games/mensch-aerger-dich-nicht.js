// Mensch ärgere Dich nicht: the complete game rules, as pure functions on a plain game object
// (no drawing, no networking). Every function returns a new game object or null for an illegal action.
//
// Rules (as agreed):
//  1. 2–4 players (yellow, green, red, blue, clockwise), 4 pieces each, all start on their B fields.
//  2. One die. A 6 brings a piece from B onto the own start field A; if pieces are waiting on B and
//     A is not blocked by an own piece, bringing one out is mandatory. A 6 always gives another roll.
//  3. While pieces are waiting on B, a piece on the own start field A must move off it if it can.
//  4. With no piece that could move (all on B, or the rest stuck in the goal): up to 3 tries to roll a 6.
//  5. A piece moves exactly the number rolled. Jumping over pieces is allowed; landing on an own piece
//     is not. Landing on an opponent captures it: it goes back to its B fields.
//  6. After a full lap a piece enters its 4 goal fields. It needs the exact number and may not jump over
//     own pieces inside the goal.
//  7. No legal move: the turn passes. Whoever has all 4 pieces in the goal finishes; the others play on
//     for the next places until one player is left.
//  Not used (variants): having to capture, starting with a piece on A, jumping inside the goal.
//
// A piece's position is its progress: -1 = waiting on B, 0…39 = on the track (fields from its own
// start field A), 40…43 = goal fields a…d.

export const COLORS = ['yellow', 'green', 'red', 'blue']; // clockwise; start fields 0, 10, 20, 30
export const COLOR_HEX = { yellow: '#f2c200', green: '#2e9e44', red: '#d62828', blue: '#1f6fd1' };
export const NAMES = { yellow: 'Yellow', green: 'Green', red: 'Red', blue: 'Blue' };
const TRACK = 40;
const LAST = 43; // last goal field
export const WAITING = -1;

const startOf = (color) => COLORS.indexOf(color) * 10;
// Absolute track field (0…39) of a piece of `color` with progress p (0…39).
export const trackField = (color, p) => (startOf(color) + p) % TRACK;

export function newGame(players) {
  const ps = COLORS.filter((c) => players.includes(c));
  if (ps.length < 2) throw new Error('Mensch ärgere Dich nicht needs at least 2 players');
  const g = {
    players: ps,
    pieces: Object.fromEntries(ps.map((c) => [c, [WAITING, WAITING, WAITING, WAITING]])),
    turn: ps[0],
    phase: 'roll', // 'roll' | 'move' | 'over'
    die: null,
    rollSeq: 0,
    moveSeq: 0,
    lastMove: null,
    tries: 0,
    winners: [],
    events: [],
  };
  g.tries = triesFor(g, g.turn);
  g.events = [`${NAMES[g.turn]} starts: tap the die next to your corner.`];
  return g;
}

function occupant(g, field) {
  for (const c of g.players) {
    const i = g.pieces[c].findIndex((p) => p >= 0 && p < TRACK && trackField(c, p) === field);
    if (i >= 0) return { color: c, i };
  }
  return null;
}

// Where piece i of `color` would go with roll v: { to, capture } or null if it can't move.
export function target(g, color, i, v) {
  const own = g.pieces[color];
  const p = own[i];
  if (p === WAITING) {
    if (v !== 6) return null;
    const occ = occupant(g, startOf(color));
    return occ?.color === color ? null : { to: 0, capture: occ };
  }
  const to = p + v;
  if (to > LAST) return null; // exact number needed
  if (to < TRACK) {
    const occ = occupant(g, trackField(color, to));
    return occ?.color === color ? null : { to, capture: occ };
  }
  // into or within the goal: no own piece on the way inside the goal, nor on the target
  for (let q = Math.max(TRACK, p + 1); q <= to; q++) if (own.includes(q)) return null;
  return { to, capture: null };
}

// The moves the current player may make with the rolled die: [{ i, to, capture }].
export function legalMoves(g) {
  if (g.phase !== 'move') return [];
  const c = g.turn, v = g.die, own = g.pieces[c];
  const all = own.map((_, i) => ({ i, ...target(g, c, i, v) })).filter((m) => m.to !== undefined);
  const waiting = own.includes(WAITING);
  if (v === 6 && waiting) {
    const out = all.filter((m) => own[m.i] === WAITING);
    if (out.length) return out; // bringing a piece out is mandatory
  }
  if (waiting) {
    const fromStart = all.filter((m) => own[m.i] === 0);
    if (fromStart.length) return fromStart; // the start field must be cleared
  }
  return all;
}

// 3 tries when only a 6 could help (no piece can move with 1–5), otherwise 1.
function triesFor(g, color) {
  for (let v = 1; v <= 5; v++) for (let i = 0; i < 4; i++) if (target(g, color, i, v)) return 1;
  return 3;
}

export function roll(game, value) {
  if (game.phase !== 'roll' || !(value >= 1 && value <= 6)) return null;
  const g = structuredClone(game);
  const name = NAMES[g.turn];
  Object.assign(g, { die: value, rollSeq: g.rollSeq + 1, phase: 'move', events: [], lastMove: null });
  if (legalMoves(g).length) return g;
  g.phase = 'roll';
  if (value === 6) {
    g.tries = 1;
    g.events.push(`${name} can't move with the 6. Roll again.`);
    return g;
  }
  g.tries--;
  if (g.tries > 0) {
    g.events.push(`${name} needs a 6: ${g.tries} more ${g.tries === 1 ? 'try' : 'tries'}.`);
    return g;
  }
  g.events.push(`${name} can't move.`);
  return nextTurn(g);
}

export function move(game, i) {
  const m = legalMoves(game).find((x) => x.i === i);
  if (!m) return null;
  const g = structuredClone(game);
  const c = g.turn, name = NAMES[c];
  g.events = [];
  const from = g.pieces[c][i];
  if (m.capture) {
    g.pieces[m.capture.color][m.capture.i] = WAITING;
    g.events.push(`${name} captured ${NAMES[m.capture.color]}!`);
  }
  g.pieces[c][i] = m.to;
  g.moveSeq++;
  g.lastMove = { color: c, i, from, to: m.to, capture: m.capture };
  if (g.pieces[c].every((p) => p >= TRACK)) {
    g.winners.push(c);
    g.events.push(`${name} has all pieces home: place ${g.winners.length}!`);
    const left = g.players.filter((p) => !g.winners.includes(p));
    if (left.length <= 1) {
      g.winners.push(...left);
      g.phase = 'over';
      g.events.push('Game over.');
      return g;
    }
    return nextTurn(g);
  }
  if (g.die === 6) {
    g.phase = 'roll';
    g.tries = 1;
    return g;
  }
  return nextTurn(g);
}

function nextTurn(g) {
  const order = g.players;
  let k = order.indexOf(g.turn);
  do k = (k + 1) % order.length;
  while (g.winners.includes(order[k]));
  g.turn = order[k];
  g.phase = 'roll';
  g.tries = triesFor(g, g.turn);
  return g;
}

// --- Board layout: an 11×11 grid of [column, row] cells.

// The 40 track fields, clockwise, starting at yellow's start field.
export const TRACK_CELLS = [
  [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [4, 3], [4, 2], [4, 1], [4, 0], [5, 0],
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [10, 5],
  [10, 6], [9, 6], [8, 6], [7, 6], [6, 6], [6, 7], [6, 8], [6, 9], [6, 10], [5, 10],
  [4, 10], [4, 9], [4, 8], [4, 7], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 5],
];
const GOAL_CELLS = {
  yellow: [[1, 5], [2, 5], [3, 5], [4, 5]],
  green: [[5, 1], [5, 2], [5, 3], [5, 4]],
  red: [[9, 5], [8, 5], [7, 5], [6, 5]],
  blue: [[5, 9], [5, 8], [5, 7], [5, 6]],
};
const HOME_CELLS = {
  yellow: [[0, 0], [1, 0], [0, 1], [1, 1]],
  green: [[9, 0], [10, 0], [9, 1], [10, 1]],
  red: [[9, 9], [10, 9], [9, 10], [10, 10]],
  blue: [[0, 9], [1, 9], [0, 10], [1, 10]],
};
// Where the die lies while it's this colour's turn: the free space next to its B fields
// (in grid units, measured from the board's corner).
const DIE_SPOTS = { yellow: [3, 3], green: [8, 3], red: [8, 8], blue: [3, 8] };
export const dieSpot = (color) => DIE_SPOTS[color];
export const homeCells = (color) => HOME_CELLS[color];
export const goalCells = (color) => GOAL_CELLS[color];
export const startCell = (color) => TRACK_CELLS[startOf(color)];

// Grid cell of piece i of `color` at progress p.
export function cellOf(color, i, p) {
  if (p === WAITING) return HOME_CELLS[color][i];
  if (p >= TRACK) return GOAL_CELLS[color][p - TRACK];
  return TRACK_CELLS[trackField(color, p)];
}

// The cells a piece passes through moving from progress `from` to `to` (for animation).
export function pathCells(color, i, from, to) {
  if (to === WAITING) return [cellOf(color, i, from), cellOf(color, i, WAITING)];
  const cells = [cellOf(color, i, from)];
  for (let p = Math.max(0, from + 1); p <= to; p++) cells.push(cellOf(color, i, p));
  return cells;
}
