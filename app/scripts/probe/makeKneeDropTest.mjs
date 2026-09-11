// 腰壁・垂れ壁の「向こうに床/天井が見える」構成のテスト用 .stq を作るスクリプト
// （実データ13.stqに垂れ壁が無いため、ユーザー裁定2026-09-11で作成を承認）。
//
// 構成（1階のみ）:
//   部屋A(0..4000, 0..4000) / 部屋B(0..4000, 4000..8000, Aの南) / 部屋C(4000..7000, 0..4000, Aの東)
//   - A-B間の壁（Y2）の中央2000mm(X=1000..3000)に腰壁(topHeight=800)
//   - A-C間の壁（X2）の中央2000mm(Y=1000..3000)に垂れ壁(bottomHeight=1200)。
//     天井高さ3000mmのためceilingHeight-bottomHeight=1800>PLAN_CUT_HEIGHT(1500)で
//     resolveKneeDropOverlaysのdropオーバーレイ条件(notCutByPlane)も満たす。
//   - 部屋Bの南側外壁（Y3=8000、建物外周）に窓を1つ（「奥の壁の建具」確認用）。
//   - 通り芯(X1,X2,X3,Y1,Y2,Y3)を各部屋の角（＝壁芯）に配置。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeKneeDropTest.mjs [出力先.stq]
import fs from 'node:fs';
import {
  Project, CenterLineType, Discipline, OpeningCategory,
} from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { placeOpeningWithDefaults } from '../../src/openings/openingEdit.js';
import {
  kneeDropWallGeometry, effectiveCeilingHeight, validateKneeDropWall, resolveKneeDropOverlays,
} from '../../src/finish/kneeDropWall.js';
import { buildCellToRoom } from '../../src/finish/edgeClassify.js';
import { edgeKey } from '../../src/core.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/knee-drop-test.stq';

const project = new Project('knee-drop-test', '腰壁垂れ壁テスト');
const { plane, graph } = project.addPlane(0, '1階');

// ---- 通り芯（labeled struct CL。project.structGraph側へ追加） ----
const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const X1 = addAxis(CenterLineType.VERTICAL,   0);
const X2 = addAxis(CenterLineType.VERTICAL,   4000);
const X3 = addAxis(CenterLineType.VERTICAL,   7000);
const Y1 = addAxis(CenterLineType.HORIZONTAL, 0);
const Y2 = addAxis(CenterLineType.HORIZONTAL, 4000);
const Y3 = addAxis(CenterLineType.HORIZONTAL, 8000);

// ---- 腰壁・垂れ壁の区間カット点（非通り芯。階固有ARCH CL） ----
const addCL = (type, value) => graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
const Xa = addCL(CenterLineType.VERTICAL,   1000); // 腰壁区間の開始（X方向）
const Xb = addCL(CenterLineType.VERTICAL,   3000); // 腰壁区間の終了（X方向）
const Ya = addCL(CenterLineType.HORIZONTAL, 1000); // 垂れ壁区間の開始（Y方向）
const Yb = addCL(CenterLineType.HORIZONTAL, 3000); // 垂れ壁区間の終了（Y方向）

// ---- 部屋 ----
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
const roomA = graph.addRoom(new Set([cellKey(X1, Y1, X2, Y2)]), 'A');
const roomB = graph.addRoom(new Set([cellKey(X1, Y2, X2, Y3)]), 'B');
const roomC = graph.addRoom(new Set([cellKey(X2, Y1, X3, Y2)]), 'C');

// 垂れ壁側（A・C）の天井高さを明示（既定2400mmではnotCutByPlaneを満たせないため3000mmへ）。
roomA.setOverride('ceilingHeight', '3000');
roomC.setOverride('ceilingHeight', '3000');

// ---- 壁生成（本番の仕上げモード脱出境界と同じ経路。fmode={}=既定寸法） ----
await runFinishExitBoundary(graph, project, {}, {});

console.log('walls:', graph.walls.length, 'exterior:', graph.walls.filter(w => w.isExteriorWall).length);

// ---- 腰壁・垂れ壁レコード ----
const cellToRoom = buildCellToRoom(graph);

const kneeKey = edgeKey(Y2.id, Xa.id, Xb.id);
const kneeCeiling = effectiveCeilingHeight(graph, kneeKey, cellToRoom);
const kneeCheck = validateKneeDropWall(800, null, kneeCeiling);
console.log('knee span geometry:', kneeDropWallGeometry(graph, kneeKey, cellToRoom) ? 'resolved' : 'UNRESOLVED',
  'ceiling:', kneeCeiling, 'validate:', kneeCheck);
if (!kneeCheck.valid) throw new Error(`腰壁の検証に失敗: ${kneeCheck.error}`);
graph.setKneeDropWall(kneeKey, { knee: { topHeight: 800 }, drop: null });

const dropKey = edgeKey(X2.id, Ya.id, Yb.id);
const dropCeiling = effectiveCeilingHeight(graph, dropKey, cellToRoom);
const dropCheck = validateKneeDropWall(null, 1200, dropCeiling);
console.log('drop span geometry:', kneeDropWallGeometry(graph, dropKey, cellToRoom) ? 'resolved' : 'UNRESOLVED',
  'ceiling:', dropCeiling, 'validate:', dropCheck);
if (!dropCheck.valid) throw new Error(`垂れ壁の検証に失敗: ${dropCheck.error}`);
graph.setKneeDropWall(dropKey, { knee: null, drop: { bottomHeight: 1200 } });

const overlays = resolveKneeDropOverlays(graph);
console.log('resolveKneeDropOverlays size:', overlays.size, [...overlays.entries()]);

// ---- 建具（窓）: 部屋Bの南側外壁（建物外周、Y3=8000）の中央付近へ ----
const southWallB = graph.walls.find(w =>
  w.isExteriorWall && !w.isVertical && Math.abs(w.axisCL.effectiveValue - 8000) < 1
  && Math.min(w.coord1, w.coord2) <= 2000 && Math.max(w.coord1, w.coord2) >= 2000);
console.log('southWallB found:', !!southWallB);
if (southWallB) {
  const { opening, error } = placeOpeningWithDefaults(graph, project, southWallB, { x: 2000, y: 8000 }, OpeningCategory.WINDOW);
  console.log('opening placed:', !!opening, 'error:', error);
} else {
  console.log('WARNING: 部屋Bの南側外壁が見つからず、建具なしで出力します');
}

// ---- シリアライズ ----
const floors = [{ planeId: plane.id, bytes: serializeGraph(graph) }];
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const planes = serializePlanes(project);
const json = buildDocumentJson({ floors, struct, planes, site: null, info: null, bootPlaneId: plane.id });

if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}
fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
