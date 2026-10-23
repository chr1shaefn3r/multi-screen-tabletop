// Drawing of the chess board and pieces. Everything is drawn in world millimetres;
// the caller has already applied the screen's view transform.

const GLYPH_FONT = '"Segoe UI Symbol","Apple Symbols","Noto Sans Symbols 2","Noto Sans Symbols2","DejaVu Sans",serif';
const TEXT_ONLY = '︎'; // stops phones from drawing ♟ as a coloured emoji

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

export function drawPiece(ctx, p) {
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
