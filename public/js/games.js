// Game setups. A game is a board plus pieces, all in world millimetres.
// `U` is the bounding box of all screens on the table.

export const GAMES = [
  ['chess', 'Chess'],
  ['checkers', 'Checkers'],
  ['battlemap', 'Battle map (1″ grid)'],
  ['free', 'Free table'],
];

const TOKEN_COLORS = ['#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#e53935', '#6d4c41'];
let seq = 0;
export const uid = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

function squareBoard(type, U, n) {
  const size = Math.min(U.w, U.h) * 0.92;
  const cell = size / n;
  return { type, x: U.cx - size / 2, y: U.cy - size / 2, w: size, h: size, cols: n, rows: n, cell, snap: true };
}

const cellCenter = (b, c, r) => [b.x + (c + 0.5) * b.cell, b.y + (r + 0.5) * b.cell];

export function die(x, y, sides = 6) {
  return { id: uid(), kind: 'die', x, y, z: 0, heldBy: null, sides, value: sides, rollSeq: 0, size: sides === 6 ? 8 : 10 };
}

export function token(x, y, color, label, size = 10) {
  return { id: uid(), kind: 'token', x, y, z: 0, heldBy: null, color, label: String(label), size };
}

export function setupGame(type, U, opts = {}) {
  const pieces = {};
  const add = (p) => {
    p.id ??= uid();
    p.z ??= 0;
    p.heldBy = null;
    pieces[p.id] = p;
  };
  let board = { type: 'none' };

  if (type === 'chess') {
    board = squareBoard('chess', U, 8);
    const back = '♜♞♝♛♚♝♞♜';
    for (let c = 0; c < 8; c++) {
      for (const [r, color, glyph] of [[0, 'b', back[c]], [1, 'b', '♟'], [6, 'w', '♟'], [7, 'w', back[c]]]) {
        const [x, y] = cellCenter(board, c, r);
        add({ kind: 'glyph', glyph, color, x, y, size: board.cell * 0.46 });
      }
    }
  } else if (type === 'checkers') {
    board = squareBoard('checkers', U, 8);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 0 || (r > 2 && r < 5)) continue;
        const [x, y] = cellCenter(board, c, r);
        add({ kind: 'disc', color: r < 3 ? '#222222' : '#c62828', king: false, x, y, size: board.cell * 0.4 });
      }
    }
  } else if (type === 'battlemap') {
    const cell = 25.4; // one inch, the classic miniature grid
    const cols = Math.max(4, Math.floor((U.w * 0.98) / cell));
    const rows = Math.max(4, Math.floor((U.h * 0.98) / cell));
    board = { type: 'grid', x: U.cx - (cols * cell) / 2, y: U.cy - (rows * cell) / 2, w: cols * cell, h: rows * cell, cols, rows, cell, snap: true };
    'ABCD'.split('').forEach((label, i) => {
      const [x, y] = cellCenter(board, Math.min(i, cols - 1), rows - 1);
      add(token(x, y, TOKEN_COLORS[i], label, cell * 0.42));
    });
    for (let i = 0; i < 3; i++) {
      const [x, y] = cellCenter(board, Math.max(0, cols - 1 - i), 0);
      add(token(x, y, '#c62828', i + 1, cell * 0.42));
    }
    add(die(U.cx, U.cy, 20));
  } else if (type === 'free') {
    add(die(U.cx - 14, U.cy));
    add(die(U.cx + 14, U.cy));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      add(token(U.cx + Math.cos(a) * 45, U.cy + Math.sin(a) * 45, TOKEN_COLORS[i], i + 1));
    }
  } else if (type === 'image') {
    const aspect = opts.aspect > 0 ? opts.aspect : 1;
    const w = Math.min(U.w * 0.98, U.h * 0.98 * aspect);
    const h = w / aspect;
    board = { type: 'image', imageId: opts.imageId, x: U.cx - w / 2, y: U.cy - h / 2, w, h, snap: false };
  }
  return { board, pieces };
}

export function extraPiece(kind, U, count) {
  const jitter = () => (Math.random() - 0.5) * Math.min(U.w, U.h) * 0.25;
  const x = U.cx + jitter(), y = U.cy + jitter();
  if (kind === 'd6') return die(x, y, 6);
  if (kind === 'd20') return die(x, y, 20);
  return token(x, y, TOKEN_COLORS[count % TOKEN_COLORS.length], count + 1);
}
