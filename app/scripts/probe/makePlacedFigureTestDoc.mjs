// 姿図の配置（PlacedFigure。部分詳細図 S10 P3）を平面（見下げ）・天伏（見上げ）で目視確認するためのテスト用 .stq を作る probe。
// 入力（既定 D:/tatsuya/Download/moku4.stq）を読み、1 階に配置 2 件を足し、同梱の詳細図 3 図を載せて書き出す（他の階・構造・平面表は元のバイト列のまま）。
//   配置: 衛生 1（便所の中・回転 90・鏡像なし）／空調 1（売場の中・回転 270・鏡像あり）。座標は非ゼロ・非対称の点。
//   同梱の詳細図: df-pf-sanitary（平面の姿図 sanitary。L 字・局所の頂点 (200,100) が配置原点・PLACEMENT_ORIGIN の基準だけ）／
//     df-pf-hvac（平面の姿図 hvac。矩形 600×400・views.ceiling で df-pf-hvac-ceiling を引く）／
//     df-pf-hvac-ceiling（平面の姿図 hvac。矩形＋縦横の中線＝線数 3。見上げ用）／
//     df-pf-sanitary-front（立面の姿図 sanitary。400×800 矩形＋中線＝線数 2。衛生の views.front）／
//     df-pf-sanitary-right（同 300×800 矩形＋線 2 本＝線数 3。衛生の views.right〔表示名は左側面図〕。views.left〔表示名は右側面図〕の図は無く、right の鏡像で代用される）。
//   キーと表示名: キーは器具自身の左右（right＝器具の右手側から見た図）、表示名は製図の呼び方（正面図に向かって左から見た図が左側面図）で、left／right の表示名は入れ替わる
//   （right＝左側面図・left＝右側面図。error.js DETAIL_PLACEMENT_VIEW_LABEL_TEXT）。以下「right の図」はキー right（表示名は左側面図）の図のこと。
//   展開（S10 P5）: 読み戻し後、1 階の便所の帯の 4 面について appendPlacedFigures の出力（線数・x の範囲）を assert して出力する。
//   立面（S10 P6）: 屋外の空調（室外機。建物の南外壁の外 500 mm・回転 0＝正面が南向き）を 1 台足し、df-pf-hvac の views に front（線数 2）・
//     right（線数 3。表示名は左側面図）を同梱する（df-pf-hvac-front／df-pf-hvac-right。left〔表示名は右側面図〕の図は無く right の鏡像で代用）。読み戻し後、東・南・西・北の 4 面について
//     buildFacadePlacedFigures の出力（線数・図の X の範囲・手計算の u0）を assert して出力する。
// 往復を先に確かめる: 書いた直後に読み戻し、1 階 placedFigures 3 件・見下げは 3 件とも線あり・見上げは空調 2 件だけで ceiling 図の線数、を assert する。
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
import { buildRoomFaces } from '../../src/elevation/elevationFaces.js';
import { appendPlacedFigures } from '../../src/elevation/elevationPlacedFigures.js';
import { buildFacadeInputs, exteriorPlacedFiguresOf } from '../../src/facade/facadeInputs.js';
import { facadeViews, facadeFloorProfiles } from '../../src/facade/facadeGeometry.js';
import { buildFacadePlacedFigures } from '../../src/facade/facadePlacedFigures.js';
import { facadeRoofRegionsResolver } from '../../src/modes/FacadeModeState.js';
import { buildCellToRoom } from '../../src/finish/edgeClassify.js';
import { worldToCell } from '../../src/finish/gridCells.js';
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
const KEY_SANITARY_FRONT = 'df-pf-sanitary-front';
const KEY_SANITARY_RIGHT = 'df-pf-sanitary-right';
const KEY_HVAC_FRONT = 'df-pf-hvac-front';
const KEY_HVAC_RIGHT = 'df-pf-hvac-right';
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
], { [DETAIL_VIEWS_FIELD]: { [DetailPlacementView.FRONT]: KEY_SANITARY_FRONT, [DetailPlacementView.RIGHT]: KEY_SANITARY_RIGHT } });
// (1b) 衛生の正面図（立面の姿図 sanitary）: 幅 400×高 800 の矩形＋縦の中線＝線数 2。配置原点＝矩形の左下の頂点 3（s 0..400・t −800..0）。
// (1c) 衛生の right の図（表示名は左側面図）: 幅 300×高 800 の矩形＋縦線 2 本＝線数 3。配置原点は同じく左下。left の図（表示名は右側面図）は無い（right の鏡像で代用される）。
const elevBase = (key, label, strokes, anchors, subject = DetailSubject.SANITARY) => ({ ...base(key, label, subject, strokes, anchors), view: DetailView.ELEVATION });
const bottomLeft = strokeId => [
  { datumId: 'ds0', strokeId, vertexIndex: 3 },
  { datumId: 'dt0', strokeId, vertexIndex: 3 },
];
const rectOf = (w, h) => ({ id: 'a', closed: true, line: LINE, moves: [move(PenDir.RIGHT, fixedLen(w)), move(PenDir.DOWN, fixedLen(h)), move(PenDir.LEFT, fixedLen(w))] });
const vLine = (id, h = 800) => ({ id, closed: false, line: LINE, moves: [move(PenDir.DOWN, fixedLen(h))] });
const vLineAnchors = (id, sMm, h = 800) => [
  { datumId: 'ds0', strokeId: id, vertexIndex: 0, offsetMm: sMm }, { datumId: 'dt0', strokeId: id, vertexIndex: 0, offsetMm: -h },
];
const sanitaryFront = elevBase(KEY_SANITARY_FRONT, '衛生 正面 矩形＋中線（配置確認用）', [rectOf(400, 800), vLine('b')],
  [...bottomLeft('a'), ...vLineAnchors('b', 200)]);
const sanitaryRight = elevBase(KEY_SANITARY_RIGHT, '衛生 左側面 矩形＋線2本（配置確認用。キー right）', [rectOf(300, 800), vLine('b'), vLine('c')],
  [...bottomLeft('a'), ...vLineAnchors('b', 100), ...vLineAnchors('c', 200)]);
// (2) 空調（平面）: 矩形 600×400（頂点 0 から右 600・下 400・左 600 で閉）。配置原点＝頂点 1（右上の角）。views.ceiling で見上げ図を引く。
const rectMoves = [move(PenDir.RIGHT, fixedLen(600)), move(PenDir.DOWN, fixedLen(400)), move(PenDir.LEFT, fixedLen(600))];
const rectStroke = { id: 'a', closed: true, line: LINE, moves: rectMoves };
const rectAnchors = [
  { datumId: 'ds0', strokeId: 'a', vertexIndex: 1 },
  { datumId: 'dt0', strokeId: 'a', vertexIndex: 1 },
];
const hvac = base(KEY_HVAC, '空調 矩形（配置確認用）', DetailSubject.HVAC, [rectStroke], rectAnchors,
  { [DETAIL_VIEWS_FIELD]: {
    [DetailPlacementView.CEILING]: KEY_HVAC_CEILING, [DetailPlacementView.FRONT]: KEY_HVAC_FRONT, [DetailPlacementView.RIGHT]: KEY_HVAC_RIGHT,
  } });
// (2b) 空調の正面図（立面）: 幅 600×高 500 の矩形＋縦の中線＝線数 2。(2c) right の図（表示名は左側面図）: 幅 400×高 500 の矩形＋縦線 2 本＝線数 3。配置原点は左下。
const hvacFront = elevBase(KEY_HVAC_FRONT, '空調 正面 矩形＋中線（配置確認用）', [rectOf(600, 500), vLine('b', 500)],
  [...bottomLeft('a'), ...vLineAnchors('b', 300, 500)], DetailSubject.HVAC);
const hvacRight = elevBase(KEY_HVAC_RIGHT, '空調 左側面 矩形＋線2本（配置確認用。キー right）', [rectOf(400, 500), vLine('b', 500), vLine('c', 500)],
  [...bottomLeft('a'), ...vLineAnchors('b', 130, 500), ...vLineAnchors('c', 270, 500)], DetailSubject.HVAC);
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
const newFigures = [sanitary, sanitaryFront, sanitaryRight, hvac, hvacCeiling, hvacFront, hvacRight];
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
// 屋外の空調（S10 P6）: 建物の南外壁の外面から 500 mm 外・x は建物の外形の中央付近（非対称にするため +130）。回転 0＝正面が南向き。
const floorsAll = project.planes.map(p => ({ plane: p, graph: project.graphMap.get(p.id) ?? null }));
const rec0 = buildFacadeInputs(floorsAll, project).floors.find(f => f.planeId === plane.id);
const outer = rec0.segments.filter(s => s.loopType === 'outer');
const southFace = Math.max(...outer.filter(s => !s.isVertical && s.outwardSign === 1).map(s => s.value));
const xMid = Math.round((Math.min(...outer.map(s => (s.isVertical ? s.value : s.lo))) + Math.max(...outer.map(s => (s.isVertical ? s.value : s.hi)))) / 2) + 130;
const HVAC_OUT_AT = { x: xMid, y: southFace + 500 };
const roomAt = (g, x, y) => { const c = worldToCell(x, y, g); return c ? buildCellToRoom(g).get(c.key) ?? null : null; };
check(roomAt(graph, HVAC_OUT_AT.x, HVAC_OUT_AT.y) === null, `屋外の空調の配置点 (${HVAC_OUT_AT.x},${HVAC_OUT_AT.y}) がどの部屋のセルにも入らない（南外壁の外面 y=${southFace}）`);
graph.setPlacedFigures([
  new PlacedFigure({ id: 'pf-sanitary-1', figureKey: KEY_SANITARY, ...SANITARY_AT, rotationDeg: 90, mirror: false, zMm: 0, note: '衛生 回転90' }),
  new PlacedFigure({ id: 'pf-hvac-1', figureKey: KEY_HVAC, ...HVAC_AT, rotationDeg: 270, mirror: true, zMm: 2400, note: '空調 回転270 鏡像' }),
  new PlacedFigure({ id: 'pf-hvac-out', figureKey: KEY_HVAC, ...HVAC_OUT_AT, rotationDeg: 0, mirror: false, zMm: 300, note: '屋外空調 回転0' }),
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
check(G.placedFigures.length === 3, `読み戻した 1 階の placedFigures 3 件（${G.placedFigures.length}）`);
const sameRoundTrip = G.placedFigures.every((p, i) => JSON.stringify(p.toData()) === JSON.stringify(graph.placedFigures[i].toData()));
check(sameRoundTrip, '配置の全項目（id・図キー・座標・回転・鏡像・z・note）が往復で一致する');
for (const other of P.planes.filter(p => p.id !== plane.id)) {
  check(P.graphMap.get(other.id).placedFigures.length === 0, `${other.name} の placedFigures は 0 件のまま`);
}
const figs = D.catalogs?.catalogs?.[CatalogKind.DETAIL_FIGURE] ?? [];
check(newFigures.every(n => figs.some(f => f.key === n.key)), `同梱の詳細図に ${newFigures.length} 図が入っている（${figs.map(f => f.key).join(',')}）`);

clearOverlays();
setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
const down = placedFigureDrawPlan(G.placedFigures, detailFigureEntry, { direction: 'down' });
const up = placedFigureDrawPlan(G.placedFigures, detailFigureEntry, { direction: 'up' });
// 展開（S10 P5）: 1 階の便所の帯の各面について appendPlacedFigures の出力を取る。衛生は回転 90（正面＝西向き）。
//   手計算（R3）: 北壁 d=(0,−1)→left の図（表示名は右側面図。図が無い→right の鏡像 3 本）・東壁 d=(1,0)→正面 2 本・南壁 d=(0,1)→right の図（表示名は左側面図）3 本・西壁 d=(−1,0)→背面（図が無い→0 本）
const toiletRoom = G.rooms.find(r => r.name === '便所');
const faceRows = buildRoomFaces(toiletRoom, G).map(face => {
  const prims = [];
  appendPlacedFigures(prims, { face, room: toiletRoom, graph: G, figureOf: detailFigureEntry, floorDyAt: () => 0 });
  const xs = prims.flatMap(p => (p.type === 'polyline' ? p.points.map(q => q[0]) : [p.x1, p.x2]));
  return { letter: face.letter, d: face.isVertical ? [-face.inward, 0] : [0, -face.inward], run: face.run, n: prims.length, xMin: Math.min(...xs), xMax: Math.max(...xs), types: [...new Set(prims.map(p => p.type))] };
});
clearOverlays();
for (const r of faceRows) console.log(`便所の面 ${r.letter} d=${JSON.stringify(r.d)} run=${r.run} 線数=${r.n} x=${r.n ? `${r.xMin}..${r.xMax}` : '-'} 型=${r.types.join(',')}`);
const rowOf = letter => faceRows.find(r => r.letter === letter);
check(faceRows.length === 4, `便所の面が 4 面（${faceRows.length}）`);
check(rowOf('A')?.n === 3 && rowOf('B')?.n === 2 && rowOf('C')?.n === 3 && rowOf('D')?.n === 0,
  '便所: 北＝right の図の鏡像（left の代用）3 本・東＝正面 2 本・南＝right の図（左側面図）3 本・西＝0 本（R3 の手計算どおり）');
check(faceRows.every(r => r.n === 0 || r.xMin < r.run && r.xMax > 0), '出た図は面の [0, run] に掛かる');
check(faceRows.every(r => r.types.every(t => t === 'line' || t === 'polyline')), '足されるプリミティブの型は line／polyline だけ');
const countBy = plan => Object.fromEntries(['pf-sanitary-1', 'pf-hvac-1', 'pf-hvac-out'].map(id => [id, plan.lines.filter(l => l.figureId === id).length]));
console.log(`見下げ: lines=${down.lines.length} marks=${down.marks.length} boxes=${down.boxes.length}`, JSON.stringify(countBy(down)));
console.log(`見上げ: lines=${up.lines.length} marks=${up.marks.length} boxes=${up.boxes.length}`, JSON.stringify(countBy(up)));
console.log('見下げの外接:', JSON.stringify(down.boxes));
console.log('見上げの外接:', JSON.stringify(up.boxes));
check(down.marks.length === 0 && up.marks.length === 0, '解決できない配置（印）が無い');
check(countBy(down)['pf-sanitary-1'] > 0 && countBy(down)['pf-hvac-1'] > 0 && countBy(down)['pf-hvac-out'] > 0, '見下げは 3 件とも線がある');
check(countBy(down)['pf-hvac-1'] === 1 && countBy(down)['pf-hvac-out'] === 1, '見下げの空調は平面図（線数 1）');
check(countBy(up)['pf-sanitary-1'] === 0 && countBy(up)['pf-hvac-1'] === 3 && countBy(up)['pf-hvac-out'] === 3, '見上げは空調だけで、ceiling 図の線数（3）');
check(up.boxes.length === 2 && up.boxes.every(b => b.figureId.startsWith('pf-hvac')), '見上げの外接は空調の 2 件だけ');

// 立面（S10 P6）: 屋外の空調（回転 0・正面＝南向き）。読み戻した文書から屋外判定→4 面の出力。
//   手計算（R2・R3）: 南 n(0,1) d(0,−1)＝−f→正面（線数 2）・東 n(1,0) d(−1,0)→left の図（表示名は右側面図。無し→right の鏡像 3 本）・西 n(−1,0) d(1,0)→right の図（表示名は左側面図）3 本・北 d(0,1)＝f→背面（無し→0 本）
//   u0＝ny·x − nx·y: 南 x・東 −y・西 y・北 −x。
const floorsRead = P.planes.map(p => ({ plane: p, graph: P.graphMap.get(p.id) ?? null }));
const facadeInputs = buildFacadeInputs(floorsRead, P, { roofRegionsOf: facadeRoofRegionsResolver(P) });
const facadeRec = facadeInputs.floors.find(f => f.planeId === plane.id);
check(facadeRec.placedFigures.map(p => p.id).join() === 'pf-hvac-out', `1 階の屋外の配置は空調 1 件だけ（${facadeRec.placedFigures.map(p => p.id)}）。衛生・売場の空調は屋内で出ない`);
check(exteriorPlacedFiguresOf(G).length === 1, 'exteriorPlacedFiguresOf も 1 件');
const u0Of = (n, p) => n.y * p.x - n.x * p.y;
setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins }); // 展開の段で clearOverlays 済み。立面の既定 figureOf（detailFigureEntry）用に載せ直す
const facadeRows = facadeViews().map(view => {
  const profiles = facadeFloorProfiles(facadeInputs, view.normal);
  const uMin = Math.min(...profiles.flatMap(f => f.pieces.map(q => q.lo)));
  const prims = buildFacadePlacedFigures(facadeInputs, view, { uMin, profiles });
  const xs = prims.flatMap(p => (p.type === 'polyline' ? p.points.map(q => q[0]) : [p.x1, p.x2]));
  const ys = prims.flatMap(p => (p.type === 'polyline' ? p.points.map(q => q[1]) : [p.y1, p.y2]));
  return { direction: view.direction, n: view.normal, u0: u0Of(view.normal, HVAC_OUT_AT), uMin, count: prims.length, xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys), types: [...new Set(prims.map(p => p.type))] };
});
clearOverlays();
for (const r of facadeRows) {
  console.log(`立面 ${r.direction} n=${JSON.stringify(r.n)} u0=${r.u0} uMin=${r.uMin} 線数=${r.count} X=${r.count ? `${r.xMin}..${r.xMax}` : '-'} Y=${r.count ? `${r.yMin}..${r.yMax}` : '-'} 型=${r.types.join(',')}`);
}
const facadeRow = d => facadeRows.find(r => r.direction === d);
// 型: 正面＝矩形 polyline 1 本＋中線 line 1 本・right の図（左側面図）＝矩形 polyline 1 本＋線 2 本 → 線数は polyline と line を合わせて 2／3
check(facadeRow('south').count === 2 && facadeRow('east').count === 3 && facadeRow('west').count === 3 && facadeRow('north').count === 0,
  '立面: 南＝正面 2 本・東＝right の図の鏡像（left の代用）3 本・西＝right の図（左側面図）3 本・北＝0 本');
check(facadeRows.every(r => r.types.every(t => t === 'line' || t === 'polyline')), '立面: 足されるプリミティブの型は line／polyline だけ');
// 図の X の手計算: 南は正面 s 0..600（配置原点＝左下）→ X＝u0−uMin＋0..600。東は right の図の鏡像で s −400..0。西は s 0..400。
check(Math.abs(facadeRow('south').xMin - (facadeRow('south').u0 - facadeRow('south').uMin)) < 1e-6
  && Math.abs(facadeRow('south').xMax - (facadeRow('south').u0 - facadeRow('south').uMin + 600)) < 1e-6, '立面 南: X の範囲が u0−uMin＋(0..600)');
check(Math.abs(facadeRow('east').xMax - (facadeRow('east').u0 - facadeRow('east').uMin)) < 1e-6
  && Math.abs(facadeRow('east').xMin - (facadeRow('east').u0 - facadeRow('east').uMin - 400)) < 1e-6, '立面 東: X の範囲が u0−uMin＋(−400..0)（right の図の鏡像）');
check(Math.abs(facadeRow('west').xMin - (facadeRow('west').u0 - facadeRow('west').uMin)) < 1e-6
  && Math.abs(facadeRow('west').xMax - (facadeRow('west').u0 - facadeRow('west').uMin + 400)) < 1e-6, '立面 西: X の範囲が u0−uMin＋(0..400)');

if (failed) process.exit(1);
