// Chess setup and rules for where pieces go. Everything is in world millimetres;
// `U` is the bounding box of all screens on the table.

let seq = 0;
export const uid = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

const BACK_ROW = '♜♞♝♛♚♝♞♜';
const VALUE = { '♛': 0, '♜': 1, '♝': 2, '♞': 3, '♟': 4, '♚': 5 }; // order of captured pieces
const FRAME = 0.35; // board frame, in cells
const SLOT = 0.58; // spacing of captured pieces, in cells (15 fit along the board)
const RESERVE = FRAME + 0.1 + SLOT; // room kept above and below the board for captured pieces

const pieceSize = (b) => b.cell * 0.46;

export function setupChess(U) {
  // the board plus a row of captured pieces above and below must fit on the screens
  const size = Math.min(U.w * 0.96, (U.h * 0.98) / (1 + (2 * RESERVE) / 8));
  const cell = size / 8;
  const board = { type: 'chess', x: U.cx - size / 2, y: U.cy - size / 2, w: size, h: size, cols: 8, rows: 8, cell };
  const pieces = {};
  for (let c = 0; c < 8; c++) {
    for (const [r, color, glyph] of [[0, 'b', BACK_ROW[c]], [1, 'b', '♟'], [6, 'w', '♟'], [7, 'w', BACK_ROW[c]]]) {
      const [x, y] = cellCenter(board, c, r);
      const id = uid();
      pieces[id] = { id, kind: 'glyph', glyph, color, x, y, z: 0, heldBy: null, captured: false, size: pieceSize(board) };
    }
  }
  return { board, pieces };
}

export const cellCenter = (b, c, r) => [b.x + (c + 0.5) * b.cell, b.y + (r + 0.5) * b.cell];

// Board square under world point (x, y), or null when it's off the board.
export function cellAt(b, x, y) {
  const c = Math.floor((x - b.x) / b.cell), r = Math.floor((y - b.y) / b.cell);
  return c >= 0 && r >= 0 && c < b.cols && r < b.rows ? [c, r] : null;
}

// Applies a drop of piece `p` at its current position and returns the pieces that changed:
// - on a square with an opposing piece: that piece is captured (moved beside the board)
// - on a square with an own piece: the move is undone (back to `from`)
// - off the board: the piece counts as captured
// - a captured piece dropped on the board is back in play
// `fits(x, y, r)` tells whether a circle lies fully on one screen (used to keep captured
// pieces off the gaps between screens).
export function dropPiece(state, p, from, fits) {
  const b = state.board;
  const changed = new Set([p]);
  const cell = cellAt(b, p.x, p.y);
  if (!cell) {
    if (!p.captured) capture(p);
  } else {
    const [x, y] = cellCenter(b, ...cell);
    const other = Object.values(state.pieces).find((q) => q !== p && !q.captured && Math.hypot(q.x - x, q.y - y) < b.cell / 4);
    if (other && other.color === p.color) {
      Object.assign(p, from); // can't take your own piece
    } else {
      Object.assign(p, { x, y, captured: false, size: pieceSize(b) });
      if (other) {
        capture(other);
        changed.add(other);
      }
    }
  }
  for (const q of layoutCaptured(state, fits)) changed.add(q);
  return [...changed];
}

let captureCount = 0;
function capture(p) {
  p.captured = true;
  p.capturedAt = ++captureCount;
}

// Lines up captured pieces beside the board, most valuable first: black above, starting
// from black's left (the right end), white below, starting from white's left (the left end).
// Slots that would put a piece across a gap between two screens are skipped.
// Returns the captured pieces (all may have moved).
export function layoutCaptured(state, fits = () => true) {
  const b = state.board;
  const slot = b.cell * SLOT;
  const r = slot * 0.5;
  const moved = [];
  for (const color of ['b', 'w']) {
    const list = Object.values(state.pieces)
      .filter((p) => p.captured && p.color === color)
      .sort((a, c) => VALUE[a.glyph] - VALUE[c.glyph] || a.capturedAt - c.capturedAt);
    const gap = (FRAME + 0.1) * b.cell + slot / 2;
    const y = color === 'b' ? b.y - gap : b.y + b.h + gap;
    const dir = color === 'b' ? -1 : 1;
    const start = color === 'b' ? b.x + b.w - r : b.x + r;
    const inRow = (x) => x >= b.x - FRAME * b.cell && x <= b.x + b.w + FRAME * b.cell;
    let x = start;
    for (const p of list) {
      let tryX = x;
      while (inRow(tryX) && !fits(tryX, y, r)) tryX += dir * slot * 0.25;
      if (inRow(tryX)) x = tryX; // otherwise: no gap-free spot left, just keep going
      Object.assign(p, { x, y, size: r });
      moved.push(p);
      x += dir * slot;
    }
  }
  return moved;
}
