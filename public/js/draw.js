// Drawing of the chess board and pieces. Everything is drawn in world millimetres;
// the caller has already applied the screen's view transform.
// Pieces are SVG images (public/pieces), so they look the same in every browser. Each is
// rendered once per needed pixel size into a small bitmap, which then maps 1:1 to screen pixels.

const GLYPH_FONT = '"Segoe UI Symbol","Apple Symbols","Noto Sans Symbols 2","Noto Sans Symbols2","DejaVu Sans",serif';
const TEXT_ONLY = '\uFE0E'; // stops phones from drawing ♟ as a coloured emoji
const CODES = { '♚': 'K', '♛': 'Q', '♜': 'R', '♝': 'B', '♞': 'N', '♟': 'P' };
const BOX = 2 / 0.92; // image box edge per piece radius: a piece image fills one square

const images = {};
const bitmaps = new Map();

// Starts loading the piece images; `onLoad` runs when one has arrived (to redraw).
export function loadPieces(onLoad) {
  for (const color of 'wb') {
    for (const code of 'KQRBNP') {
      if (images[color + code]) continue;
      const img = new Image();
      img.onload = onLoad;
      img.src = `/pieces/${color}${code}.svg`;
      images[color + code] = img;
    }
  }
}

function bitmap(key, px) {
  px = Math.max(8, Math.min(1024, Math.round(px)));
  let c = bitmaps.get(key + px);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(images[key], 0, 0, px, px);
    bitmaps.set(key + px, c);
    if (bitmaps.size > 120) bitmaps.delete(bitmaps.keys().next().value);
  }
  return c;
}

export function drawBoard(ctx, b, px) {
  if (!b || b.type !== 'chess') return;
  const m = b.cell * 0.35;
  ctx.fillStyle = '#4e342e';
  ctx.fillRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#b58863' : '#f0d9b5';
      // +px overlaps neighbours slightly so no hairline gaps show
      ctx.fillRect(b.x + c * b.cell, b.y + r * b.cell, b.cell + px, b.cell + px);
    }
  }
}

// `pxPerMm`: device pixels per millimetre on this screen, to pick the bitmap size.
export function drawPiece(ctx, p, pxPerMm) {
  const s = p.size;
  const white = p.color === 'w';
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.heldBy) {
    ctx.scale(1.1, 1.1);
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
  } else {
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
  }
  if (p.selected) {
    // highlight: this piece moves to the next square touched, on any screen
    ctx.beginPath();
    ctx.arc(0, 0, s * 1.12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 213, 79, .55)';
    ctx.fill();
    ctx.lineWidth = s * 0.12;
    ctx.strokeStyle = '#ffb300';
    ctx.stroke();
  }
  const key = p.color + CODES[p.glyph];
  const img = images[key];
  if (img?.complete && img.naturalWidth) {
    const box = s * BOX;
    ctx.drawImage(bitmap(key, box * pxPerMm), -box / 2, -box / 2, box, box);
    ctx.restore();
    return;
  }
  // until the images have loaded: the font's chess symbols
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${s * 2}px ${GLYPH_FONT}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = s * 0.14;
  ctx.strokeStyle = white ? '#1a1a1a' : '#f2f2f2';
  ctx.strokeText(p.glyph + TEXT_ONLY, 0, s * 0.1);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = white ? '#fafafa' : '#141414';
  ctx.fillText(p.glyph + TEXT_ONLY, 0, s * 0.1);
  ctx.restore();
}

// Topmost piece under world point (x, y). `minR` makes small pieces easier to grab.
export function hitTest(pieces, x, y, minR = 5) {
  const list = Object.values(pieces).sort((a, b) => b.z - a.z);
  return list.find((p) => Math.hypot(x - p.x, y - p.y) <= Math.max(p.size * 1.15, minR));
}

// --- Mensch ärgere Dich nicht

const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function roundedRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h); // older browsers
}

function disc(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

// `madn` is the rules module; `anim` = { move, start } for the last move, `rollStart` when the die was
// rolled. While `rollingColor` is set, that player's die is still rolling (the result isn't known yet).
export function drawMadn(ctx, b, g, madn, now, anim, rollStart, rollingColor) {
  const at = ([c, r]) => [b.x + (c + 0.5) * b.cell, b.y + (r + 0.5) * b.cell];
  const cell = b.cell;
  ctx.save();
  ctx.fillStyle = '#f5e6c4';
  ctx.strokeStyle = '#8d6e63';
  ctx.lineWidth = cell * 0.08;
  ctx.beginPath();
  roundedRect(ctx, b.x, b.y, b.size, b.size, cell * 0.4);
  ctx.fill();
  ctx.stroke();

  // whose turn: glow behind their B fields
  if (g.phase !== 'over') {
    const hc = madn.homeCells(g.turn).map(at);
    const cx = (hc[0][0] + hc[3][0]) / 2, cy = (hc[0][1] + hc[3][1]) / 2;
    disc(ctx, cx, cy, cell * 1.35);
    ctx.fillStyle = madn.COLOR_HEX[g.turn] + '55';
    ctx.fill();
  }

  // path line, then the fields
  ctx.beginPath();
  madn.TRACK_CELLS.map(at).forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.lineWidth = cell * 0.1;
  ctx.strokeStyle = '#8d6e63';
  ctx.stroke();
  const field = (cellXY, fill, stroke = '#5d4037') => {
    const [x, y] = at(cellXY);
    disc(ctx, x, y, cell * 0.4);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = cell * 0.06;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  };
  for (const c of madn.TRACK_CELLS) field(c, '#fffaf0');
  for (const color of madn.COLORS) {
    const hex = madn.COLOR_HEX[color];
    field(madn.startCell(color), hex);
    for (const c of madn.goalCells(color)) field(c, hex + '66', hex);
    for (const c of madn.homeCells(color)) field(c, hex + '66', hex);
  }

  // pieces (the one that just moved hops along its path; a captured piece leaves when it's hit)
  const STEP = 110;
  const legal = new Set(madn.legalMoves(g).map((m) => g.turn + m.i));
  const m = anim?.move;
  const t = m ? (now - anim.start) / STEP : Infinity;
  for (const color of g.players) {
    g.pieces[color].forEach((p, i) => {
      let xy = at(madn.cellOf(color, i, p));
      if (m && m.color === color && m.i === i) {
        const path = madn.pathCells(color, i, m.from, m.to).map(at);
        if (t < path.length - 1) {
          const k = Math.max(0, Math.floor(t)), f = Math.max(0, t - k);
          xy = [path[k][0] + (path[k + 1][0] - path[k][0]) * f, path[k][1] + (path[k + 1][1] - path[k][1]) * f];
        }
      } else if (m?.capture && m.capture.color === color && m.capture.i === i) {
        const steps = madn.pathCells(m.color, m.i, m.from, m.to).length - 1;
        if (t < steps) xy = at(madn.cellOf(m.color, m.i, m.to));
      }
      const [x, y] = xy;
      if (legal.has(color + i)) {
        disc(ctx, x, y, cell * 0.47);
        ctx.lineWidth = cell * 0.09;
        ctx.strokeStyle = '#ffb300';
        ctx.stroke();
      }
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.4)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 2;
      disc(ctx, x, y, cell * 0.32);
      ctx.fillStyle = madn.COLOR_HEX[color];
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = cell * 0.05;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke();
      disc(ctx, x - cell * 0.08, y - cell * 0.08, cell * 0.11);
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.fill();
    });
  }

  // The die lies next to the B fields of the player whose turn it is, framed in their colour.
  // Like a real die it keeps showing the player's last roll while they roll again (another try,
  // the extra roll after a 6); it is blank when the next player takes over. The previous
  // player's result stays visible at their corner for a moment, fading out.
  const spotXY = (color) => madn.dieSpot(color).map((v, k) => (k ? b.y : b.x) + v * cell);
  if (rollingColor) {
    drawDie(ctx, ...spotXY(rollingColor), cell * 0.55, null, madn.COLOR_HEX[rollingColor], { rolling: true });
    ctx.restore();
    return;
  }
  const since = rollStart === undefined ? Infinity : now - rollStart;
  const result = since < MADN_RESULT_MS ? g.lastRoll : null;
  const rolling = since < MADN_ROLL_MS;
  if (result && result.color !== g.turn) {
    drawDie(ctx, ...spotXY(result.color), cell * 0.55, rolling ? null : result.value, madn.COLOR_HEX[result.color], {
      rolling,
      alpha: rolling ? 1 : Math.max(0, 1 - (since - MADN_ROLL_MS) / (MADN_RESULT_MS - MADN_ROLL_MS)),
    });
  }
  const mine = result && result.color === g.turn;
  const value = g.phase === 'move' ? g.die : g.lastRoll?.color === g.turn ? g.lastRoll.value : null;
  drawDie(ctx, ...spotXY(g.turn), cell * 0.55, value, g.phase === 'over' ? '#888' : madn.COLOR_HEX[g.turn], {
    rolling: rolling && mine,
    glow: g.phase === 'roll' && !(rolling && mine),
  });
  ctx.restore();
}

// How long the die rolls, and how long a result stays visible at the previous player's corner (ms).
export const MADN_ROLL_MS = 600;
export const MADN_RESULT_MS = 1600;

function drawDie(ctx, x, y, s, value, color, { rolling = false, glow = false, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (rolling) {
    value = 1 + Math.floor(Math.random() * 6);
    ctx.rotate((Math.random() - 0.5) * 0.8);
  }
  if (glow) {
    // "tap me": a fresh roll is needed
    disc(ctx, 0, 0, s * 1.75);
    ctx.fillStyle = color + '66';
    ctx.fill();
  }
  ctx.beginPath();
  roundedRect(ctx, -s, -s, 2 * s, 2 * s, s * 0.3);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = s * 0.22;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = '#111';
  for (const [px, py] of PIPS[value] || []) {
    disc(ctx, px * s * 0.5, py * s * 0.5, s * 0.17);
    ctx.fill();
  }
  ctx.restore();
}

// How long the last move's animation runs (ms), so the screen keeps redrawing until it's done.
export const madnAnimMs = (madn, move) => (move ? (madn.pathCells(move.color, move.i, move.from, move.to).length - 1) * 110 + 50 : 0);
