// 部分詳細図ヘルパーの DXF 読込み（S7a）を目視するためのサンプル DXF を作る。
//   矩形（LINE 4 本・70×45）／長円（LWPOLYLINE の bulge の円弧・40×20）／面取りのある五角形（ブロック CHAMFER の INSERT 1 段）
//   ヘッダ $INSUNITS=4（mm）。レイヤ名「枠」は UTF-8。
// 使い方: node scripts/probe/makeDxfSample.mjs [--out <出力先 .dxf>]
//   既定の出力先は環境変数 STRAD_DXF_SAMPLE_OUT、無ければカレントの detail-sample.dxf。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : (process.env.STRAD_DXF_SAMPLE_OUT ?? 'detail-sample.dxf'));

const text = pairs => `${pairs.map(([c, v]) => `${c}\n${v}`).join('\n')}\n`;
const section = (name, body) => [[0, 'SECTION'], [2, name], ...body, [0, 'ENDSEC']];
const line = (x1, y1, x2, y2, layer = '枠') => [[0, 'LINE'], [8, layer], [10, x1], [20, y1], [11, x2], [21, y2]];
const lwpolyline = (verts, closed, layer = '枠') => [
  [0, 'LWPOLYLINE'], [8, layer], [90, verts.length], [70, closed ? 1 : 0],
  ...verts.flatMap(([x, y, bulge]) => [[10, x], [20, y], ...(bulge ? [[42, bulge]] : [])]),
];

const rect = [line(0, 0, 70, 0), line(70, 0, 70, 45), line(70, 45, 0, 45), line(0, 45, 0, 0)];
// 長円: 直線 2 本と半円 2 つ（bulge=1＝反時計回りの半円）
const slot = lwpolyline([[110, 0, 0], [150, 0, 1], [150, 20, 0], [110, 20, 1]], true);
const chamfer = [
  line(0, 0, 40, 0), line(40, 0, 40, 25), line(40, 25, 25, 40), line(25, 40, 0, 40), line(0, 40, 0, 0),
];
const insert = [[0, 'INSERT'], [8, '枠'], [2, 'CHAMFER'], [10, 200], [20, 0], [41, 1], [42, 1], [50, 0]];

const doc = [
  ...section('HEADER', [[9, '$INSUNITS'], [70, 4]]),
  ...section('BLOCKS', [[0, 'BLOCK'], [8, '0'], [2, 'CHAMFER'], [70, 0], [10, 0], [20, 0], ...chamfer.flat(), [0, 'ENDBLK']]),
  ...section('ENTITIES', [...rect.flat(), ...slot, ...insert]),
  [0, 'EOF'],
];

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text(doc), 'utf8');
console.log(`wrote ${out}`);
