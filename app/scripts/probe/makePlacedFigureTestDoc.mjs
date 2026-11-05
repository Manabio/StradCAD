// 姿図の配置（PlacedFigure。部分詳細図 S10 P3）を平面（見下げ）・天伏（見上げ）で目視確認するためのテスト用 .stq を作る probe。
// 入力（既定 D:/tatsuya/Download/moku4.stq）を読み、1 階に配置 2 件を足し、同梱の詳細図 3 図を載せて書き出す（他の階・構造・平面表は元のバイト列のまま）。
//   配置: 衛生 1（便所の中・回転 90・鏡像なし）／空調 1（売場の中・回転 270・鏡像あり）。座標は非ゼロ・非対称の点。
//   同梱の詳細図: df-pf-sanitary（平面の姿図 sanitary。L 字・局所の頂点 (200,100) が配置原点・PLACEMENT_ORIGIN の基準だけ）／
//     df-pf-hvac（平面の姿図 hvac。矩形 600×400・views.ceiling で df-pf-hvac-ceiling を引く）／
//     df-pf-hvac-ceiling（平面の姿図 hvac。矩形＋縦横の中線＝線数 3。見上げ用）。
// 往復を先に確かめる: 書いた直後に読み戻し、1 階 placedFigures 2 件・見下げは 2 件とも線あり・見上げは空調だけで ceiling 図の線数、を assert する。
// 使い方: cd app && MSYS_NO_PATHCONV=1 node --import ./scripts/testSetup.mjs scripts/probe/makePlacedFigureTestDoc.mjs [--src D:/tatsuya/Download/moku4.stq] [--out D:/tatsuya/Download/placed-figure-test.stq]
// 既存ファイルは上書きしない（再生成は先に削除する）。.mjs は eslint の対象外。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PlacedFigure } from '../../src/core.js';
import { serializeGraph } from '../../src/graphSnapshot.js';
import { buildDocumentJson } from '../../src/storage/documentFile.js';
import { emptyBundle, withEntries } from '../../src/catalog/catalogBundle.js';
import { CatalogKind } from '../../src/catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../../src/catalog/catalogRegistry.js';
import { detailFigureEntry } from '../../src/openings/openingCatalog.js';
import detailBuiltins from '../../src/detail/detailBuiltins.js';
import { validateDetailFigure } from '../../src/detail/detailModel.js';
import { fixedLen, move } from '../../src/finish/roomDetailTestFixtures.js';
import { placedFigureDrawPlan } from '../../src/renderer/placedFigureDrawPlan.js';
import {
  PenDir, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DetailPlacementView, DETAIL_VIEWS_FIELD, DETAIL_FIGURE_VERSION,
} from '../../src/core/constants.js';
import { loadDocument } from './loadDoc.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const srcPath = argOf('--src', 'D:/tatsuya/Download/moku4.stq');
const outPath = argOf('--out', 'D:/tatsuya/Download/placed-figure-test.stq');
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }

let failed = false;
const check = (ok, msg) => { if (ok) console.log(`OK: ${msg}`); else { console.error(`NG: ${msg}`); failed = true; } };

// ---- 詳細図 ----
const KEY_SANITARY = 'df-pf-sanitary';
const KEY_HVAC = 'df-pf-hvac';
const KEY_HVAC_CEILING = 'df-pf-hvac-ceiling';
const LINE = { weightRole: 'medium', dashRole: DetailDash.SOLID };
const placementDatums = [
  { id: 'ds0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
  { id: 'dt0', role: DetailDatumRole.PLACEMENT_ORIGIN, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
];
const base = (key, label, subject, strokes, anchors, extra = {}) => ({
  key, version: DETAIL_FIGURE_VERSION, label, category: DetailCategory.FIGURE, view: DetailView.PLAN, subject,
  strokes, datums: placementDatums, anchors, provenance: null, note: null, ...extra,
});
// (1) 衛生: L 字。右 200・下 100・右 150・下 250・左 350（閉）。配置原点＝頂点 2（200,100）。
const sanitary = base(KEY_SANITARY, '衛生器具 L字（配置確認用）', DetailSubject.SANITARY, [
  { id: 'a', closed: true, line: LINE, moves: [
    move(PenDir.RIGHT, fixedLen(200)), move(PenDir.DOWN, fixedLen(100)), move(PenDir.RIGHT, fixedLen(150)),
    move(PenDir.DOWN, fixedLen(250)), move(PenDir.LEFT, fixedLen(350)),
  ] },
], [
  { datumId: 'ds0', strokeId: 'a', vertexIndex: 2 },
  { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
]);
// (2) 空調（平面）: 矩形 600×400（頂点 0 から右 600・下 400・左 600 で閉）。配置原点＝頂点 1（右上の角）。views.ceiling で見上げ図を引く。
const rectMoves = [move(PenDir.RIGHT, fixedLen(600)), move(PenDir.DOWN, fixedLen(400)), move(PenDir.LEFT, fixedLen(600))];
const rectStroke = { id: 'a', closed: true, line: LINE, moves: rectMoves };
const rectAnchors = [
  { datumId: 'ds0', strokeId: 'a', vertexIndex: 1 },
  { datumId: 'dt0', strokeId: 'a', vertexIndex: 1 },
];
const hvac = base(KEY_HVAC, '空調 矩形（配置確認用）', DetailSubject.HVAC, [rectStroke], rectAnchors,
  { [DETAIL_VIEWS_FIELD]: { [DetailPlacementView.CEILING]: KEY_HVAC_CEILING } });
// (3) 空調（見上げ）: 同じ矩形に縦・横の中線（線数 3）。中線の始点は Anchor.offsetMm で矩形の辺の中点に載せる。
const hvacCeiling = base(KEY_HVAC_CEILING, '空調 見上げ 矩形＋中線（配置確認用）', DetailSubject.HVAC, [
  rectStroke,
  { id: 'b', closed: false, line: { weightRole: 'thin', dashRole: DetailDash.DASHED }, moves: [move(PenDir.DOWN, fixedLen(400))] },
  { id: 'c', closed: false, line: { weightRole: 'thin', dashRole: DetailDash.DASHED }, moves: [move(PenDir.RIGHT, fixedLen(600))] },
], [
  ...rectAnchors,
  { datumId: 'ds0', strokeId: 'b', vertexIndex: 0, offsetMm: -300 }, { datumId: 'dt0', strokeId: 'b', vertexIndex: 0 },
  { datumId: 'ds0', strokeId: 'c', vertexIndex: 0, offsetMm: -600 }, { datumId: 'dt0', strokeId: 'c', vertexIndex: 0, offsetMm: 200 },
]);
const newFigures = [sanitary, hvac, hvacCeiling];
for (const f of newFigures) {
  const v = validateDetailFigure(f);
  check(v.ok, `${f.key} が validateDetailFigure を通る${v.ok ? '' : `: ${v.errors.map(e => e.message).join(' / ')}`}`);
}
if (failed) process.exit(1);

// ---- 入力を読んで 1 階に配置を足す ----
const { project, doc } = loadDocument(srcPath);
const plane = project.planes.find(p => p.name === '1階') ?? project.planes[0];
const graph = project.graphMap.get(plane.id);
check(graph.placedFigures.length === 0, `${plane.name} の placedFigures は空から始まる`);
// 便所 x 1820..2730・y −9100..−7280 の中、売場 x 0..9100・y −7280..0 の中（moku4 の 1 階。座標は読み込んだ部屋のセルから確認）
const roomBounds = name => {
  const r = graph.rooms.find(x => x.name === name);
  const xs = [], ys = [];
  for (const key of r.cells) {
    const [L, T, R, B] = key.split(':').map(id => graph.centerLines.find(c => c.id === id)?.effectiveValue);
    xs.push(L, R); ys.push(T, B);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};
const toilet = roomBounds('便所'), sales = roomBounds('売場');
const inside = (b, x, y) => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY;
const SANITARY_AT = { x: 2400, y: -8150 };
const HVAC_AT = { x: 4310, y: -3170 };
check(inside(toilet, SANITARY_AT.x, SANITARY_AT.y), `衛生の配置点 (${SANITARY_AT.x},${SANITARY_AT.y}) が便所の中`);
check(inside(sales, HVAC_AT.x, HVAC_AT.y), `空調の配置点 (${HVAC_AT.x},${HVAC_AT.y}) が売場の中`);
graph.setPlacedFigures([
  new PlacedFigure({ id: 'pf-sanitary-1', figureKey: KEY_SANITARY, ...SANITARY_AT, rotationDeg: 90, mirror: false, zMm: 0, note: '衛生 回転90' }),
  new PlacedFigure({ id: 'pf-hvac-1', figureKey: KEY_HVAC, ...HVAC_AT, rotationDeg: 270, mirror: true, zMm: 2400, note: '空調 回転270 鏡像' }),
]);

// ---- 保存（1 階以外の床・構造・平面表・敷地・情報は元のまま）----
const existing = doc.catalogs ?? emptyBundle();
const detailEntries = [...(existing.catalogs?.[CatalogKind.DETAIL_FIGURE] ?? []).filter(f => !newFigures.some(n => n.key === f.key)), ...newFigures];
const catalogs = withEntries(existing, CatalogKind.DETAIL_FIGURE, detailEntries);
const floors = doc.floors.map(f => (f.planeId === plane.id ? { planeId: f.planeId, bytes: serializeGraph(graph) } : f));
const json = buildDocumentJson({
  floors, struct: doc.struct, planes: doc.planes, site: doc.site, info: doc.info, bootPlaneId: doc.bootPlaneId ?? plane.id, catalogs,
});
fs.writeFileSync(outPath, json);
const buf = fs.readFileSync(outPath);
console.log('wrote', outPath, buf.length, 'bytes sha256', crypto.createHash('sha256').update(buf).digest('hex'));

// ---- 往復 ----
const { project: P, doc: D } = loadDocument(outPath);
const G = P.graphMap.get(plane.id);
check(G.placedFigures.length === 2, `読み戻した 1 階の placedFigures 2 件（${G.placedFigures.length}）`);
const sameRoundTrip = G.placedFigures.every((p, i) => JSON.stringify(p.toData()) === JSON.stringify(graph.placedFigures[i].toData()));
check(sameRoundTrip, '配置の全項目（id・図キー・座標・回転・鏡像・z・note）が往復で一致する');
for (const other of P.planes.filter(p => p.id !== plane.id)) {
  check(P.graphMap.get(other.id).placedFigures.length === 0, `${other.name} の placedFigures は 0 件のまま`);
}
const figs = D.catalogs?.catalogs?.[CatalogKind.DETAIL_FIGURE] ?? [];
check([KEY_SANITARY, KEY_HVAC, KEY_HVAC_CEILING].every(k => figs.some(f => f.key === k)), `同梱の詳細図に 3 図が入っている（${figs.map(f => f.key).join(',')}）`);

clearOverlays();
setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
const down = placedFigureDrawPlan(G.placedFigures, detailFigureEntry, { direction: 'down' });
const up = placedFigureDrawPlan(G.placedFigures, detailFigureEntry, { direction: 'up' });
clearOverlays();
const countBy = plan => Object.fromEntries(['pf-sanitary-1', 'pf-hvac-1'].map(id => [id, plan.lines.filter(l => l.figureId === id).length]));
console.log(`見下げ: lines=${down.lines.length} marks=${down.marks.length} boxes=${down.boxes.length}`, JSON.stringify(countBy(down)));
console.log(`見上げ: lines=${up.lines.length} marks=${up.marks.length} boxes=${up.boxes.length}`, JSON.stringify(countBy(up)));
console.log('見下げの外接:', JSON.stringify(down.boxes));
console.log('見上げの外接:', JSON.stringify(up.boxes));
check(down.marks.length === 0 && up.marks.length === 0, '解決できない配置（印）が無い');
check(countBy(down)['pf-sanitary-1'] > 0 && countBy(down)['pf-hvac-1'] > 0, '見下げは 2 件とも線がある');
check(countBy(down)['pf-hvac-1'] === 1, '見下げの空調は平面図（線数 1）');
check(countBy(up)['pf-sanitary-1'] === 0 && countBy(up)['pf-hvac-1'] === 3, '見上げは空調だけで、ceiling 図の線数（3）');
check(up.boxes.length === 1 && up.boxes[0].figureId === 'pf-hvac-1', '見上げの外接は空調の 1 件だけ');

if (failed) process.exit(1);
