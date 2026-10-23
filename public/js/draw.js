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
