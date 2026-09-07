// 展開図のプリミティブ（dumpElevFigure.mjs の出力）を SVG へ描き出す（目視確認用）。
// 実機の Konva レンダラの完全な再現ではなく、線・寸法・文字の位置関係を人が見て
// 「旧図と何が違うか」を指させるようにするためのもの。
// 使い方: node scripts/probe/renderElevSvg.mjs <elevfig-*.json> <部屋名> <出力.svg>
import fs from 'node:fs';

const [inFile, roomName, outFile] = process.argv.slice(2);
if (!inFile || !roomName || !outFile) {
  console.error('用法: renderElevSvg.mjs <elevfig-*.json> <部屋名> <出力.svg>');
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const row = rows.find(r => String(r.name) === roomName);
if (!row?.prims) { console.error(`部屋 ${roomName} が見つかりません`); process.exit(1); }

const W = { thin: 0.6, medium: 1.2, thick: 2.2 };
const parts = [];
const xs = [], ys = [];
const note = (x, y) => { if (Number.isFinite(x)) xs.push(x); if (Number.isFinite(y)) ys.push(y); };
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

for (const p of row.prims) {
  const w = W[p.weight] ?? 0.8;
  if (p.type === 'line') {
    note(p.x1, p.y1); note(p.x2, p.y2);
    // 1FL（y=0）は赤で強調する——今回の調査対象。
    const red = Math.abs(p.y1) < 0.01 && Math.abs(p.y2) < 0.01;
    parts.push(`<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${red ? '#d00' : '#111'}" stroke-width="${w}"/>`);
  } else if (p.type === 'polyline') {
    for (const [x, y] of p.points) note(x, y);
    parts.push(`<polyline points="${p.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="#111" stroke-width="${w}"/>`);
  } else if (p.type === 'rect') {
    note(p.x, p.y); note(p.x + p.w, p.y + p.h);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="none" stroke="#111" stroke-width="0.8"/>`);
  } else if (p.type === 'circle') {
    note(p.cx, p.cy);
    parts.push(`<circle cx="${p.cx}" cy="${p.cy}" r="60" fill="#fff" stroke="#111" stroke-width="0.8"/>`);
  } else if (p.type === 'text') {
    note(p.x, p.y);
    parts.push(`<text x="${p.x}" y="${p.y}" font-size="90" text-anchor="middle" dominant-baseline="middle" fill="#111">${esc(p.text)}</text>`);
  } else if (p.type === 'dim') {
    // 寸法線: 向き(dir)に沿って from..to を at の位置へ引き、中央にラベルを置く。
    const [x1, y1, x2, y2] = p.dir === 'h' ? [p.from, p.at, p.to, p.at] : [p.at, p.from, p.at, p.to];
    note(x1, y1); note(x2, y2);
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#06c" stroke-width="0.5"/>`);
    parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 40}" font-size="70" text-anchor="middle" fill="#06c">${esc(p.label)}</text>`);
  } else if (p.type === 'miterTriangle') {
    note(p.x, p.y);
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="40" fill="#111"/>`);
  }
}

const pad = 400;
const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" width="${Math.round((x1 - x0) / 10)}" height="${Math.round((y1 - y0) / 10)}">
<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#f5f5f0"/>
<line x1="${x0}" y1="0" x2="${x1}" y2="0" stroke="#d00" stroke-width="0.4" stroke-dasharray="40 30"/>
<text x="${x0 + 100}" y="-60" font-size="90" fill="#d00">y=0 (1FL)</text>
${parts.join('\n')}
</svg>`;
fs.writeFileSync(outFile, svg);
console.log(`${outFile}: ${row.prims.length} プリミティブ / 部屋「${row.name}」(${row.kind})`);
