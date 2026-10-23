// Drawing of boards and pieces. Everything is drawn in world millimetres;
// the caller has already applied the screen's view transform.

const GLYPH_FONT = '"Segoe UI Symbol","Apple Symbols","Noto Sans Symbols 2","Noto Sans Symbols2","DejaVu Sans",serif';
const TEXT_ONLY = '︎'; // stops phones from drawing ♟ as a coloured emoji
const ROLL_MS = 700;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function circle(ctx, r) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
}

export function drawBoard(ctx, b, images, px) {
  if (!b || b.type === 'none') return;
  ctx.save();
  if (b.type === 'chess' || b.type === 'checkers') {
    const m = b.cell * 0.35;
    ctx.fillStyle = '#4e342e';
    ctx.fillRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
    const [light, dark] = b.type === 'chess' ? ['#f0d9b5', '#b58863'] : ['#ead6ab', '#3d6b4a'];
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        ctx.fillStyle = (r + c) % 2 ? dark : light;
        // +px overlaps neighbours slightly so no hairline gaps show
        ctx.fillRect(b.x + c * b.cell, b.y + r * b.cell, b.cell + px, b.cell + px);
      }
    }
  } else if (b.type === 'grid') {
    ctx.fillStyle = '#e9dfc7';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = 'rgba(70,50,30,.45)';
    ctx.lineWidth = Math.max(0.3, px);
    ctx.beginPath();
    for (let c = 0; c <= b.cols; c++) {
      ctx.moveTo(b.x + c * b.cell, b.y);
      ctx.lineTo(b.x + c * b.cell, b.y + b.h);
    }
    for (let r = 0; r <= b.rows; r++) {
      ctx.moveTo(b.x, b.y + r * b.cell);
      ctx.lineTo(b.x + b.w, b.y + r * b.cell);
    }
    ctx.stroke();
  } else if (b.type === 'image') {
    const img = images.get(b.imageId);
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, b.x, b.y, b.w, b.h);
    } else {
      ctx.fillStyle = '#2a2a2a';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = '#aaa';
      ctx.font = '8px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Loading map…', b.x + b.w / 2, b.y + b.h / 2);
    }
  }
  ctx.restore();
}

const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

export function drawPiece(ctx, p, now, rollStart) {
  const s = p.size;
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

  if (p.kind === 'glyph') {
    const white = p.color === 'w';
    ctx.font = `${s * 2}px ${GLYPH_FONT}`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = s * 0.14;
    ctx.strokeStyle = white ? '#1a1a1a' : '#f2f2f2';
    ctx.strokeText(p.glyph + TEXT_ONLY, 0, s * 0.1);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = white ? '#fafafa' : '#141414';
    ctx.fillText(p.glyph + TEXT_ONLY, 0, s * 0.1);
  } else if (p.kind === 'disc') {
    circle(ctx, s);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = s * 0.1;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    circle(ctx, s * 0.68);
    ctx.stroke();
    if (p.king) {
      ctx.fillStyle = '#ffd54f';
      ctx.font = `${s * 1.1}px ${GLYPH_FONT}`;
      ctx.fillText('♛' + TEXT_ONLY, 0, s * 0.08);
    }
  } else if (p.kind === 'token') {
    circle(ctx, s);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = s * 0.14;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${s * 1.05}px system-ui, sans-serif`;
    ctx.fillText(p.label, 0, s * 0.06);
  } else if (p.kind === 'die') {
    let value = p.value;
    if (rollStart !== undefined && now - rollStart < ROLL_MS) {
      value = 1 + Math.floor(Math.random() * p.sides);
      ctx.rotate((Math.random() - 0.5) * 0.8);
    }
    if (p.sides === 6) {
      roundRect(ctx, -s, -s, 2 * s, 2 * s, s * 0.3);
      ctx.fillStyle = '#fafafa';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = s * 0.05;
      ctx.strokeStyle = '#888';
      ctx.stroke();
      ctx.fillStyle = '#111';
      for (const [x, y] of PIPS[value] || []) {
        ctx.beginPath();
        ctx.arc(x * s * 0.5, y * s * 0.5, s * 0.17, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        ctx.lineTo(Math.cos(a) * s * 1.1, Math.sin(a) * s * 1.1);
      }
      ctx.closePath();
      ctx.fillStyle = '#5e35b1';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = s * 0.06;
      ctx.strokeStyle = '#d1c4e9';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${s * 0.95}px system-ui, sans-serif`;
      ctx.fillText(String(value), 0, s * 0.05);
    }
  }
  ctx.restore();
}

// Topmost piece under world point (x, y). `minR` makes small pieces easier to grab.
export function hitTest(pieces, x, y, minR = 5) {
  const list = Object.values(pieces).sort((a, b) => b.z - a.z);
  return list.find((p) => {
    const r = Math.max(p.size * 1.15, minR);
    return p.kind === 'die' ? Math.abs(x - p.x) <= r && Math.abs(y - p.y) <= r : Math.hypot(x - p.x, y - p.y) <= r;
  });
}
