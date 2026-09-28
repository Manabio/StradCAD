// openingBeamAxes.js（床開口由来の梁芯自動生成。規則O）の単体テスト。
// フィクスチャはwallBeamAxes.test.js（実core.js流儀）・slabOpening.test.js（開口セル構成）を踏襲する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomFeature, StairType, StructuralMaterialType } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import {
  openingBeamSourcesFor, openingBeamSourcesDiagnostics, autoFillOpeningBeamAxes, reconcileOpeningBeamAxes,
  mapOpeningSourceMoves,
} from './openingBeamAxes.js';
import { autoFillWallBeamAxes, wallBeamSourcesFor } from './wallBeamAxes.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { autoFillStructuralGrid } from './structuralAutoFill.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { RC_WALL_BACKING_CODES } from '../finish/materials/backingClass.js';

function makeGraph(planeId = 'p1') {
  return new PlanGraph(new Plane(planeId, 0, `${planeId}階`, 1, 1));
}

const GRID = { labeled: true, discipline: Discipline.STRUCT };
const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 通り芯 X:0,8000 / Y:0,6000 と、その内側に非グリッドの意匠中心線 X:2000,5000 / Y:1000,yBottom
// を持つグラフを返す。中央セル x:[2000,5000] y:[1000,yBottom] をVOID開口にする
// （既定 yBottom=3000: width=3000>height=2000 → 通しは水平辺）。
function makeRectOpeningGraph(yBottom = 3000) {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, yBottom, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(graph);
  const centerKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === yBottom).key;
  graph.addRoom(new Set([centerKey])).setFeature(RoomFeature.VOID);
  return { graph, x0, xa, xb, x1, y0, ya, yb, y1 };
}

test('openingBeamSourcesFor: 主構造の選択子がslabOpenings以外（木造）なら空配列', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = '木造（在来）';
  assert.deepEqual(openingBeamSourcesFor(graph, {}), []);
});

test('openingBeamSourcesFor→autoFillOpeningBeamAxes: 矩形の吹抜け（壁なし）は長辺方向2本が通し・短辺2本が通し梁芯のidを参照し、由来はopening', () => {
  const { graph, x0, x1 } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  assert.equal(sources.length, 4);
  assert.ok(sources.every(s => s.source === 'void'));

  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.equal(created.length, 4, '壁が無いので通し2本＋短辺2本の計4本');
  assert.ok(created.every(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING));
  assert.ok(created.every(cl => cl.discipline === Discipline.FUSE && cl.labeled === false));

  const throughTop = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000);
  const throughBottom = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  assert.ok(throughTop && throughBottom, '通し（長辺方向=水平辺）2本');
  assert.equal(throughTop.extentLoRef?.clId, x0.id, '通しのextentは直交通り芯で挟む');
  assert.equal(throughTop.extentHiRef?.clId, x1.id);
  assert.equal(throughBottom.extentLoRef?.clId, x0.id);
  assert.equal(throughBottom.extentHiRef?.clId, x1.id);

  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const shortRight = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000);
  assert.ok(shortLeft && shortRight, '短辺2本');
  assert.equal(shortLeft.value, 2000, '壁が無いのでcoordはCL位置そのまま（offset 0）');
  assert.equal(shortRight.value, 5000);
  assert.equal(shortLeft.extentLoRef?.clId, throughTop.id, '短辺のextentは通し梁芯のidを参照する');
  assert.equal(shortLeft.extentHiRef?.clId, throughBottom.id);
  assert.equal(shortRight.extentLoRef?.clId, throughTop.id);
  assert.equal(shortRight.extentHiRef?.clId, throughBottom.id);
});

test('openingBeamSourcesFor: 外接矩形が正方形（同長）のときは水平辺（X方向）が通しになる', () => {
  // width=5000-2000=3000, height=4000-1000=3000（同長）
  const { graph } = makeRectOpeningGraph(4000);
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const throughSources = sources.filter(s => s.through);
  assert.equal(throughSources.length, 2);
  assert.ok(throughSources.every(s => !s.isVertical), '同長はX方向（水平辺）が通し');
});

test('openingBeamSourcesFor→autoFillOpeningBeamAxes: 下地オーナー壁がある辺はcoord=下地帯の外面+outwardSign×(梁幅/2)へ逃げる（RC造・梁幅300・偏芯なし）', () => {
  const { graph, xa, ya, yb } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  // 左辺(x=2000)のCL(xa)上に下地オーナー壁（backingDepth=120→半幅60、backingOffset省略=0＝偏芯なし）
  // を1本張る。下地帯の外面（絶対座標）=2000-60=1940（backingOffset=0なのでwallBackingCenterCoordは
  // axisCL位置=2000と一致）。RC造の既定梁断面RC-300x300→梁幅300→半幅150。clearance既定0。
  // 左辺のoutwardSignは-1（開口はx>2000側）→coord=1940-150=1790（偏芯が無いため旧式と同値）。
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, wallFinish: 12.5 });

  const sources = openingBeamSourcesFor(graph, {});
  const leftSrc = sources.find(s => s.isVertical && s.through === false);
  assert.equal(leftSrc.coord, 1790);
  assert.equal(leftSrc.beamWidthUnresolved, false);

  const created = autoFillOpeningBeamAxes(graph, sources);
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && Math.abs(cl.value - 1790) < 1);
  assert.ok(shortLeft, '壁を逃げた位置(1790)に梁芯が生成される');
  assert.equal(shortLeft.beamAxisOrigin, BeamAxisOrigin.OPENING);
});

// ---- Major-1是正（QAレビュー・T4）: 逃げ量は下地帯の外面基準（偏芯backingOffsetを吸収） ----
test('【Major-1是正・T4】openingBeamSourcesFor: 下地オーナー壁が偏芯（backingOffset）していても下地帯の外面基準でcoordが変わる', () => {
  const { graph, xa, ya, yb } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  // backingOffset=45（下地帯中心をCLから+45だけ偏芯）。backingDepth=120→半幅60。
  // 下地帯の外面（絶対座標）= wallBackingCenterCoord(=axisCL値2000+backingOffset45=2045) - 半幅60
  //   = 1985（outwardSign=-1側の面）。梁幅300→半幅150。clearance既定0。
  // coord = 1985 + (-1)*150 = 1835（旧式=辺座標基準だと1790のままで偏芯45が反映されず不一致になる）。
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, backingOffset: 45, wallFinish: 12.5 });

  const sources = openingBeamSourcesFor(graph, {});
  const leftSrc = sources.find(s => s.isVertical && s.through === false);
  assert.equal(leftSrc.coord, 1835, '偏芯+45ぶんだけ旧値(1790)からずれる（下地帯の外面基準）');
});

test('【Major-1是正・T4・失敗系】openingBeamSourcesFor: 辺の区間に重なる下地オーナー壁が2つあれば外側へ最も出ている面を採る', () => {
  const { graph, xa, ya, yb } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  // 同じCL(xa)・区間[1000,3000]に、偏芯の異なる2枚の下地オーナー壁を重ねて張る
  // （実際には同一区間に2枚重なることは通常無いが、境界条件として指示書§5失敗系が明示する構成）。
  // 壁A: backingOffset=0→外面(outwardSign=-1側)=2000-60=1940。
  // 壁B: backingOffset=+100→外面=2000+100-60=2040。
  // outwardSign=-1（開口はx>2000側）にとって「外側」はより小さい座標（-1方向）——1940の方が
  // 2040より外側（開口から遠い）ため、壁Aの面(1940)が採用される。
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, backingOffset: 0, wallFinish: 12.5 });
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, backingOffset: 100, wallFinish: 12.5 });

  const sources = openingBeamSourcesFor(graph, {});
  const leftSrc = sources.find(s => s.isVertical && s.through === false);
  // coord = 1940(外側の面) + (-1)*150(梁幅300/2) = 1790。
  assert.equal(leftSrc.coord, 1790, '2枚のうち外側へ最も出ている面(1940)を基準にする');
});

test('【Major-1是正・T4・失敗系・逆順】openingBeamSourcesFor: 同じ2枚の壁を逆順（壁B→壁A）で張っても外側の面(1790)になる（走査順に依存しない）', () => {
  const { graph, xa, ya, yb } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  // 上のテストと同じ壁A・壁Bだが追加順を逆にする（backingOffset=100のB→backingOffset=0のAの順）。
  // 「最初に見つけた壁を採る」実装だと逆順でB(2040)が勝ってしまう——outwardSign方向の比較で
  // 決めていることを確認する。
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, backingOffset: 100, wallFinish: 12.5 });
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, backingOffset: 0, wallFinish: 12.5 });

  const sources = openingBeamSourcesFor(graph, {});
  const leftSrc = sources.find(s => s.isVertical && s.through === false);
  assert.equal(leftSrc.coord, 1790, '追加順を逆にしても外側の面(1940→coord1790)が採用される');
});

test('openingBeamSourcesFor→autoFillOpeningBeamAxes: 通り芯上の辺は生成されず、短辺のextentが通り芯を参照する', () => {
  // 上辺(y=1000)を通り芯Y=1000そのものに合わせる（yaをGRID・labeledにする）。
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const yGrid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, GRID); // 通り芯化
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(graph);
  const centerKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 4000).key;
  graph.addRoom(new Set([centerKey])).setFeature(RoomFeature.VOID);
  graph.structureOverride = 'RC造(ラーメン)';

  const sources = openingBeamSourcesFor(graph, {});
  const throughOnGrid = sources.find(s => s.through && s.onGrid);
  assert.ok(throughOnGrid, '上辺(y=1000)はonGrid=true');
  assert.equal(throughOnGrid.coord, 1000);

  const created = autoFillOpeningBeamAxes(graph, sources);
  // onGridの辺は新規生成しない: through 2本のうち1本(y=4000)＋短辺2本の計3本。
  assert.equal(created.length, 3);
  assert.ok(!created.some(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000),
    '通り芯上の辺(y=1000)には梁芯を新規生成しない');

  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  assert.equal(shortLeft.extentLoRef?.clId, yGrid.id, '短辺のextentは既存の通り芯を参照する');
  void x0; void xa; void xb; void x1; void y0; void yb; void y1;
});

// ---- I-9是正（QAレビュー）: RC造でRC下地壁のある辺は開口梁芯を作らず、壁芯の梁芯を再利用する ----
test('【I-9是正】openingBeamSourcesFor→autoFillOpeningBeamAxes: RC造でRC下地壁のある辺（通し辺）は生成せず、短辺のextentはその壁芯の梁芯を参照する', () => {
  const { graph, ya } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  graph.interiorWallBacking = RC_WALL_BACKING_CODES[0];
  // 上辺(y=1000)のCL(ya)上にRC下地の下地オーナー壁を張り、autoFillStructuralGridと同じ順序
  // （autoFillWallBeamAxes→autoFillOpeningBeamAxes）で壁由来梁芯を先に生成する。
  const wallAxisX0 = graph.addCenterLine(CenterLineType.VERTICAL, -2000, GRID); // ya全長を覆うclStart/clEnd
  const wallAxisX1 = graph.addCenterLine(CenterLineType.VERTICAL, 9000, GRID);
  graph.addWall(ya, 0, false, wallAxisX0, 0, wallAxisX1, 0, { backingDepth: 120, wallFinish: 12.5 });
  const project = {};
  const wallSources = wallBeamSourcesFor(graph, project, null);
  assert.ok(wallSources.some(s => !s.isVertical && Math.abs(s.coord - 1000) < 1), '前提: RC下地壁が壁由来梁芯の源になっている');
  const wallAxes = autoFillWallBeamAxes(graph, wallSources);
  const wallAxisCL = wallAxes.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && Math.abs(cl.value - 1000) < 1);
  assert.ok(wallAxisCL, '前提: 壁由来の梁芯(壁芯)が先に生成されている');

  const sources = openingBeamSourcesFor(graph, project);
  const topSrc = sources.find(s => !s.isVertical && s.through === true && Math.abs(s.coord - 1000) < 1);
  assert.equal(topSrc.rcBacked, true, 'RC下地壁のある通し辺はrcBacked:trueになる');

  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.ok(!created.some(cl => cl.centerLineType === CenterLineType.HORIZONTAL && Math.abs(cl.value - 1000) < 1),
    '上辺(y=1000)からは新規の梁芯を作らない（壁芯の梁芯を再利用）');
  assert.equal(wallAxisCL.beamAxisOrigin, BeamAxisOrigin.WALL, '壁芯の梁芯の由来はwallのまま（開口由来で上書きしない）');

  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  assert.ok(shortLeft, '短辺(左辺x=2000)は通常どおり生成される');
  assert.equal(shortLeft.extentLoRef?.clId, wallAxisCL.id, '短辺のextentは壁芯の梁芯を参照する');
});

test('【I-9是正・対照】openingBeamSourcesFor: RC造でも下地材がRC以外（既定コード）の壁がある辺は従来どおり外面逃げで生成される', () => {
  const { graph, ya } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  // interiorWallBackingは既定値のまま（RC_WALL_BACKING_CODESに属さない＝鋼・軽鉄下地相当）。
  const wallAxisX0 = graph.addCenterLine(CenterLineType.VERTICAL, -2000, GRID);
  const wallAxisX1 = graph.addCenterLine(CenterLineType.VERTICAL, 9000, GRID);
  graph.addWall(ya, 0, false, wallAxisX0, 0, wallAxisX1, 0, { backingDepth: 120, wallFinish: 12.5 });
  const project = {};

  const sources = openingBeamSourcesFor(graph, project);
  const topSrc = sources.find(s => !s.isVertical && s.through === true);
  assert.equal(topSrc.rcBacked, false, 'RC下地でない壁はrcBacked:falseのまま');
  assert.notEqual(topSrc.coord, 1000, '外面逃げのoffsetが効いて辺座標そのものからは動く（従来どおり）');
});

// ---- Minor-6是正（QAレビュー・T5）: 梁断面が解決できない場合の診断 ----
test('【Minor-6是正・T5】openingBeamSourcesFor/Diagnostics: 梁断面を解決できない場合は幅0で生成しbeamWidthUnresolvedを診断に出す', () => {
  const { graph, xa, ya, yb } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  graph.addWall(xa, 0, true, ya, 0, yb, 0, { backingDepth: 120, wallFinish: 12.5 }); // 左辺(短辺)に下地オーナー壁
  // DI引数rulesで defaultSections.beam に未知の断面キーを注入する（rulesForを改変しない）。
  const badRules = {
    openingBeamAxes: 'slabOpenings', openingBeamClearanceMm: 0,
    wallBeamAxes: null, // I-9のRC判定は本テストの主眼ではないため素通りさせる
    defaultSections: { beam: 'UNKNOWN-SECTION-KEY' },
  };

  const sources = openingBeamSourcesFor(graph, {}, { rules: badRules });
  const leftSrc = sources.find(s => s.isVertical && s.through === false);
  assert.equal(leftSrc.beamWidthUnresolved, true, '断面が解決できない場合はbeamWidthUnresolved:true');
  assert.equal(leftSrc.coord, 1940, '梁幅0扱い（clearance=0）で下地帯の外面(1940)そのものに生成される');

  const diag = openingBeamSourcesDiagnostics(graph, {}, { rules: badRules });
  assert.equal(diag.beamWidthUnresolvedCount, 1);

  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.ok(created.some(cl => Math.abs(cl.value - 1940) < 1), '幅0でも例外にならず生成される');
});

test('openingBeamSourcesFor→autoFillOpeningBeamAxes: 除外集合にあるキーは生成しない', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  graph.excludedWallBeamAxes.add('Y:1000');
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.ok(!created.some(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000),
    '除外キーY:1000は生成しない');
});

test('openingBeamSourcesFor→autoFillOpeningBeamAxes: 既存梁芯／通り芯が同座標なら再利用し、由来未設定(null)なら書き戻す', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const existing = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  assert.equal(existing.beamAxisOrigin, null, '前提');
  const before = graph.centerLines.length;

  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.equal(created.length, 3, '既存梁芯(y=1000)は新規作成せず再利用される（通し1本＋短辺2本のみ新規）');
  assert.equal(graph.centerLines.length, before + 3);
  assert.equal(existing.beamAxisOrigin, BeamAxisOrigin.OPENING, '再利用時に由来を書き戻す');
  // ---- T7: 短辺のextentは再利用した既存梁芯自身のidを参照する ----
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  assert.equal(shortLeft.extentLoRef?.clId, existing.id, '短辺のextentは再利用した既存梁芯のidを参照する');
});

// ---- T7: 既に由来'wall'の梁芯を再利用する場合は由来を上書きしない ----
test('【T7】openingBeamSourcesFor→autoFillOpeningBeamAxes: 既に由来wallの梁芯と同座標なら再利用し、由来はwallのまま不変・短辺はそのidを参照する', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const existing = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.WALL,
  });
  const before = graph.centerLines.length;

  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.equal(created.length, 3, '既存梁芯(y=1000)は新規作成せず再利用される（通し1本＋短辺2本のみ新規）');
  assert.equal(graph.centerLines.length, before + 3);
  assert.equal(existing.beamAxisOrigin, BeamAxisOrigin.WALL, '既に由来wallの梁芯は開口由来で上書きしない（fillBeamAxisOriginIfUnknownの規約）');

  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  assert.equal(shortLeft.extentLoRef?.clId, existing.id, '短辺のextentは（由来を書き換えていない）既存梁芯のidを参照する');
});

test('【失敗系】openingBeamSourcesFor: 非矩形（L字）は空配列を返し、診断はnonRectangular', () => {
  // makeLShapeGrid相当: 上段1セル(x:0-2000,y:0-1000) + 下段左セル(x:0-1000,y:1000-2000) のL字開口。
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...ARCH, extentLo: 1000, extentHi: 2000 });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, ARCH);
  const cells = getAllCells(graph);
  const topKey = cells.find(c => c.y1 === 0 && c.y2 === 1000 && c.x1 === 0 && c.x2 === 2000).key;
  const blKey = cells.find(c => c.y1 === 1000 && c.y2 === 2000 && c.x1 === 0 && c.x2 === 1000).key;
  graph.addRoom(new Set([topKey, blKey])).setFeature(RoomFeature.VOID);
  graph.structureOverride = 'RC造(ラーメン)';

  assert.deepEqual(openingBeamSourcesFor(graph, {}), []);
  const diag = openingBeamSourcesDiagnostics(graph, {});
  assert.equal(diag.skipped, 'nonRectangular');
  assert.equal(diag.edgeCount, 6);
  assert.equal(diag.componentCount, 1, 'L字は端点を共有する1つの連結成分');
  assert.equal(diag.rectangularCount, 0);
  assert.equal(diag.nonRectangularCount, 1);
  void x0; void xm; void x1; void y0; void y1000; void y1;
});

// ---- Minor-3是正（2026-09-28QAレビュー・T3）: 連結成分はセルの4近傍。角だけで接する2開口も別成分 ----
test('【Minor-3是正・T3】openingBeamSourcesFor: 対角に角だけで接する2つの矩形開口はrectangularCount:2で両方から源が出る', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, GRID);
  // 左上セル(x:[0,1000],y:[0,1000])と右下セル(x:[1000,2000],y:[1000,2000])——角(1000,1000)だけで接する。
  const topLeft = `${x0.id}:${y0.id}:${xm.id}:${ym.id}`;
  const bottomRight = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([topLeft])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([bottomRight])).setFeature(RoomFeature.VOID);
  graph.structureOverride = 'RC造(ラーメン)';

  const diag = openingBeamSourcesDiagnostics(graph, {});
  assert.equal(diag.componentCount, 2, '角だけで接する2つの矩形は別々の連結成分（端点共有では1つになってしまう不良の是正）');
  assert.equal(diag.rectangularCount, 2);
  assert.equal(diag.skipped, null);

  const sources = openingBeamSourcesFor(graph, {});
  assert.equal(sources.length, 8, '矩形2つ×(通し2+短辺2)＝8件の源');
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.ok(created.length > 0, '両方の矩形から梁芯が生成される（同座標の重複は既存の重複ガードで1本に集約されうる）');
});

// ---- Q3是正（2026-09-28QAレビュー）: 「矩形のみ」は開口1つずつの意味。連結成分ごとに判定する ----
test('【QA是正・2026-09-28】openingBeamSourcesFor: 互いに独立した矩形の吹抜けが2つあれば両方から梁芯が生成される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const xc = graph.addCenterLine(CenterLineType.VERTICAL, 8000, ARCH);
  const xd = graph.addCenterLine(CenterLineType.VERTICAL, 11000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 14000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(graph);
  const roomAKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 3000).key;
  const roomBKey = cells.find(c => c.x1 === 8000 && c.x2 === 11000 && c.y1 === 1000 && c.y2 === 3000).key;
  graph.addRoom(new Set([roomAKey])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([roomBKey])).setFeature(RoomFeature.VOID);
  graph.structureOverride = 'RC造(ラーメン)';

  const diag = openingBeamSourcesDiagnostics(graph, {});
  assert.equal(diag.componentCount, 2, '離れた2つの矩形は別々の連結成分');
  assert.equal(diag.rectangularCount, 2);
  assert.equal(diag.skipped, null);

  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  const roomAAxis = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const roomBAxis = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 8000);
  assert.ok(roomAAxis, 'room A（x=2000-5000）からも梁芯が生成される');
  assert.ok(roomBAxis, 'room B（x=8000-11000）からも梁芯が生成される');
  void x0; void xa; void xb; void xc; void xd; void x1; void y0; void ya; void yb; void y1;
});

test('【QA是正・2026-09-28】openingBeamSourcesFor: 矩形1つ＋L字1つが同じ階にあれば矩形だけ生成し、L字は診断に残る', () => {
  const graph = makeGraph();
  // 矩形（room A）: x[2000,5000] y[1000,3000]（makeRectOpeningGraphと同じ構成）。
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells1 = getAllCells(graph);
  const roomAKey = cells1.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 3000).key;
  graph.addRoom(new Set([roomAKey])).setFeature(RoomFeature.VOID);

  // L字（room B）: 離れた位置(x:20000-22000, y:20000-22000)に独立したL字開口を追加する。
  const lx0 = graph.addCenterLine(CenterLineType.VERTICAL, 20000, ARCH);
  const lxm = graph.addCenterLine(CenterLineType.VERTICAL, 21000, { ...ARCH, extentLo: 21000, extentHi: 22000 });
  const lx1 = graph.addCenterLine(CenterLineType.VERTICAL, 22000, ARCH);
  const ly0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 20000, ARCH);
  const lym = graph.addCenterLine(CenterLineType.HORIZONTAL, 21000, ARCH);
  const ly1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 22000, ARCH);
  const cells2 = getAllCells(graph);
  const topKey = cells2.find(c => c.y1 === 20000 && c.y2 === 21000 && c.x1 === 20000 && c.x2 === 22000).key;
  const blKey = cells2.find(c => c.y1 === 21000 && c.y2 === 22000 && c.x1 === 20000 && c.x2 === 21000).key;
  graph.addRoom(new Set([topKey, blKey])).setFeature(RoomFeature.VOID);
  graph.structureOverride = 'RC造(ラーメン)';

  const diag = openingBeamSourcesDiagnostics(graph, {});
  assert.equal(diag.componentCount, 2);
  assert.equal(diag.rectangularCount, 1);
  assert.equal(diag.nonRectangularCount, 1);
  assert.equal(diag.skipped, null, '矩形の成分が1つでもあればskippedはnull（一部生成される）');

  const sources = openingBeamSourcesFor(graph, {});
  assert.ok(sources.every(s => s.coord < 10000), 'L字側(x/y>=20000)からは源が出ない（矩形のroom Aのみ）');
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.ok(created.some(cl => cl.value === 2000), '矩形（room A）からは梁芯が生成される');
  assert.ok(!created.some(cl => cl.value >= 20000), 'L字（room B）からは梁芯が生成されない');
  void x0; void xa; void xb; void x1; void y0; void ya; void yb; void y1; void lx0; void lxm; void lx1; void ly0; void lym; void ly1;
});

// slabOpening.test.js makeSwitchbackBeyondFixture相当（returnKeyレーンが矩形の破れ先セル）。
// 同じフットプリントの階段を2つのグラフ（自階F・下階F-1）に独立に作る——上階自動設置
// （stairFloorSync.js syncUpperFloors）のコピーはaddStairで新規idを発番するため、
// 実フィクスチャでもidを共有せず、世界座標のフットプリントだけを一致させる。
function makeSwitchbackStairGraph(xOffset = 0) {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0 + xOffset, GRID);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000 + xOffset, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000 + xOffset, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, GRID);
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const stairCells = new Set([landingKey, outboundKey, returnKey]);
  const roomCells  = new Set([landingKey, outboundKey]); // L字。returnKeyは部屋自身に含めない＝破れ先。
  const room = graph.addRoom(roomCells, '階段');
  graph.addStair({
    type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  return graph;
}

test('【QA是正・2026-09-28】openingBeamSourcesFor: belowGraphが無ければ（設置階自身）破れ先は源にならない', () => {
  const graph = makeSwitchbackStairGraph();
  graph.structureOverride = 'S造';
  const sources = openingBeamSourcesFor(graph, {}, { riserOf: () => 200 });
  assert.deepEqual(sources, [], '設置階自身の破れ先は自階スラブの開口ではない（.claude/stair-model.md:38前半）');
});

test('【QA是正・2026-09-28】openingBeamSourcesFor: belowGraphに同じフットプリントの階段（到達元）があれば破れ先が源になる', () => {
  const belowGraph = makeSwitchbackStairGraph(); // F-1（到達元）
  const graph = makeSwitchbackStairGraph();      // F（自階。上階自動設置のコピー相当・同じフットプリント）
  graph.structureOverride = 'S造';
  const sources = openingBeamSourcesFor(graph, {}, { riserOf: () => 200, belowGraph });
  assert.ok(sources.length > 0, '破れ先(returnKey)は矩形1セルなので規則Oの対象になる');
  assert.ok(sources.every(s => s.source === 'stairBeyond'));
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.ok(created.length > 0);
  assert.ok(created.every(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING));
});

// ---- Major-2是正（QAレビュー・T1）----
test('【Major-2是正・T1・失敗系】openingBeamSourcesFor: 下階の階段が別位置（x+1000）なら破れ先は源にならない', () => {
  const belowGraph = makeSwitchbackStairGraph(1000); // フットプリントがx方向に1000ずれた「別の階段」
  const graph = makeSwitchbackStairGraph();
  graph.structureOverride = 'S造';
  const sources = openingBeamSourcesFor(graph, {}, { riserOf: () => 200, belowGraph });
  assert.deepEqual(sources, [], '下階の階段はフットプリントが違うため到達元とみなさない');
});

test('【失敗系・QA是正2026-09-28】openingBeamSourcesFor: belowGraphの階段のフットプリントが一致しなければ破れ先は源にならない', () => {
  const belowGraph = makeGraph(); // 階段の無い下階（フットプリント不一致＝到達元なし）
  const graph = makeSwitchbackStairGraph();
  graph.structureOverride = 'S造';
  const sources = openingBeamSourcesFor(graph, {}, { riserOf: () => 200, belowGraph });
  assert.deepEqual(sources, []);
});

// ---- Major-2是正（QAレビュー・T2）: 配線テスト（structuralRecompute.js経由でbelowGraphが実配線される） ----
test('【Major-2是正・T2】recomputeStructuralForGraph: 上階（同フットプリントの階段）は下階の到達元階段から由来openingの梁芯を生成する（belowGraph実配線）', async () => {
  const project = new Project('proj-major2-t2', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = 'S造';
  g2.structureOverride = 'S造';

  // 同じフットプリントの階段（switchback。returnKeyレーンが矩形の破れ先セル）をg1・g2の両方へ
  // 設置する——g2は「上階自動設置のコピー」を模す（syncUpperFloors自体はstairFloorSync.test.jsで
  // 別途検証済みのため、ここではフットプリント一致という結果だけを直接再現する）。
  function addSwitchbackStair(g) {
    const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
    const xm = g.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const x1 = g.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
    const y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
    const ym = g.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
    const y1 = g.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
    const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
    const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
    const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
    const stairCells = new Set([landingKey, outboundKey, returnKey]);
    const roomCells  = new Set([landingKey, outboundKey]); // L字。returnKeyは破れ先。
    const room = g.addRoom(roomCells, '階段');
    g.addStair({
      type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
      sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
    });
  }
  addSwitchbackStair(g1);
  addSwitchbackStair(g2);

  // precomputedBelowGraph(g1)を渡してg2を直接再計算する（structuralRecompute.jsのbelowGraph配線を
  // 通す）。buildStructuralWallGateは別経路でfloorSwapManager.peekを呼ぶため、実IndexedDBの代わりに
  // project.graphMapをそのまま返す簡易peekへ差し替える（wallBeamAxes.test.js・structAnchorProbe.mjs
  // と同じ方式）。
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    await recomputeStructuralForGraph(g2, project, 'S造', g1);
  } finally {
    floorSwapManager.peek = originalPeek;
  }

  const openingCL = g2.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING);
  assert.ok(openingCL, '上階(g2)に由来openingの梁芯が生成される（下階g1の到達元階段から）');
});


// ---- Minor-QA追加・T8: VOID単独（階段0本）は規則Oのための下階peekを起こさない ----
test('【Minor-QA追加・T8】recomputeStructuralForGraph: 2階にVOID1部屋だけ（階段0本）なら規則Oのための下階peekは発生せず、由来openingの梁芯は生成される', async () => {
  const project = new Project('proj-t8', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = 'S造';
  g2.structureOverride = 'S造';

  // 2階にVOID1部屋（矩形。makeRectOpeningGraphと同じ構成）を置く。階段は0本。
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = g2.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = g2.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = g2.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(g2);
  const centerKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 3000).key;
  g2.addRoom(new Set([centerKey])).setFeature(RoomFeature.VOID);

  let peekCount = 0;
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => { peekCount++; return project.graphMap.get(plane.id) ?? null; };
  try {
    // precomputedBelowGraphを渡さない（undefined）——belowGraph解決はstructuralRecompute.js自身の
    // 分岐（needsBelowForOpenings。Minor-4是正）に委ねる。
    await recomputeStructuralForGraph(g2, project, 'S造');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  // 実測値2（regime Oに起因するpeekは0）: buildStructuralWallGateの足元連続性チェック
  // （wallGate.js footprintProbe。基準階=g2にVOIDの部屋があるため直下のg1までpeekする。
  // 部屋が無い階なら早期returnで発生しない）1回 + resolveLowestGraph（最下階g1の柱芯オフセット
  // 解決用。部屋・階段の有無に関わらず常に1回）1回＝計2回。どちらもopeningBeamAxes.jsの
  // stairFilterFor/needsBelowForOpeningsとは無関係——g2.stairs.length===0のため
  // needsBelowForOpeningsはfalseのままbelowGraph=nullで解決され、追加peekは発生しない。
  assert.equal(peekCount, 2, '階段0本のVOID開口では規則Oに起因する下階peekは発生しない（他2件のみ）');

  const openingCL = g2.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING);
  assert.ok(openingCL, 'VOID開口からは下階peek無し（belowGraph=null）でも由来openingの梁芯が生成される');
  void x0; void xa; void xb; void x1; void y0; void ya; void yb; void y1;
});

// ---- reconcileOpeningBeamAxes（ステップ6・開口由来梁芯の再計算照合） ----

test('reconcileOpeningBeamAxes: 現況と一致すれば何も変わらない（冪等）', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  autoFillOpeningBeamAxes(graph, sources);
  const idsBefore = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING).map(cl => cl.id).sort();

  const { removed } = reconcileOpeningBeamAxes(graph, sources, []);

  assert.deepEqual(removed, [], '現況と一致する開口由来梁芯は撤去しない');
  const idsAfter = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING).map(cl => cl.id).sort();
  assert.deepEqual(idsAfter, idsBefore, 'idも変わらない');
});

test('reconcileOpeningBeamAxes: 吹抜けを通常部屋に戻す（開口が消える）と開口由来梁芯は全部撤去される（通し辺を短辺が参照していても両方消える）', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  assert.equal(created.length, 4);

  // 部屋をVOIDから戻す＝開口が無くなる（openingBeamSourcesForは[]を返す）。
  const { removed } = reconcileOpeningBeamAxes(graph, [], []);

  assert.equal(removed.length, 4, '通し辺2本・短辺2本の計4本が撤去される（相互参照があっても両方消える）');
  assert.equal(graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING).length, 0);
});

test('【失敗系】reconcileOpeningBeamAxes: 短辺に非autoの小梁が乗っていれば短辺は保護され、それを参照する通し辺も残る。無関係の短辺は撤去される', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const shortRight = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000);
  const throughTop = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000);
  const throughBottom = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  // 短辺(shortLeft)に手動固定（dimensionStatus!=='auto'）の小梁を乗せる。
  graph.addBeam(StructuralMaterialType.RC, 'RC-BEAM-TEST', shortLeft, true, throughTop, throughBottom,
    { role: 'secondary', dimensionStatus: 'fixed' });

  const { removed } = reconcileOpeningBeamAxes(graph, [], []);
  const removedIds = new Set(removed.map(cl => cl.id));

  assert.ok(!removedIds.has(shortLeft.id), '非autoの小梁が乗る短辺は保護され残る');
  assert.ok(removedIds.has(shortRight.id), '保護理由の無い短辺は撤去される');
  assert.ok(!removedIds.has(throughTop.id) && !removedIds.has(throughBottom.id),
    '生存する短辺(shortLeft)から参照される通し辺2本も、その参照によって保護され残る');
});

test('reconcileOpeningBeamAxes: 開口が消えた座標に壁ソースがあれば由来がWALLへ変わり撤去されない', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);

  const wallSources = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000 }];
  const { removed } = reconcileOpeningBeamAxes(graph, [], wallSources);

  assert.ok(!removed.some(cl => cl.id === shortLeft.id), '壁ソースに一致する梁芯は撤去されない');
  assert.equal(shortLeft.beamAxisOrigin, BeamAxisOrigin.WALL, '由来がWALLへ書き替わる');
});

test('reconcileOpeningBeamAxes: 由来がUSER（手動移動済み）の梁芯は照合の対象外', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  shortLeft.beamAxisOrigin = BeamAxisOrigin.USER; // 手動移動を模す（commitCLMoveOpの分岐と同じ切替）

  const { removed } = reconcileOpeningBeamAxes(graph, [], []);

  assert.ok(!removed.some(cl => cl.id === shortLeft.id), 'USER由来は開口が消えても対象外——撤去されない');
  assert.equal(shortLeft.beamAxisOrigin, BeamAxisOrigin.USER, '由来も変わらない');
});

test('【T1・M-2是正】reconcileOpeningBeamAxes: 短辺をgraph.setCLEccentricityだけで保護すると、固定点反復で通し辺2本とその短辺が残り、無関係の短辺は撤去される', () => {
  const { graph } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const shortRight = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000);
  const throughTop = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000);
  const throughBottom = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  // shortLeftをCL偏芯（clEccentricities）だけで保護する——小梁等の部材を一切乗せない。
  graph.setCLEccentricity(shortLeft.id, { side: 1, amount: 30 });

  // 開口を消す（全4本が座標非一致の孤児候補になる）。
  const { removed } = reconcileOpeningBeamAxes(graph, [], []);
  const removedIds = new Set(removed.map(cl => cl.id));

  assert.ok(!removedIds.has(shortLeft.id), 'clEccentricitiesで保護されたshortLeftは残る');
  assert.ok(!removedIds.has(throughTop.id) && !removedIds.has(throughBottom.id),
    '生き残ったshortLeftから参照される通し辺2本も、固定点反復でignoreRefsFromから外れ保護され残る');
  assert.ok(removedIds.has(shortRight.id), '保護理由の無いshortRightは撤去される');
});

// ---- M-1是正・QA指摘: reconcileは座標だけでなくextent（役割）も見る ----
// 「白紙から新規生成した結果と一致する」ことを、正規化（座標・extentの実効値・isVertical・由来。
// idは含めない）した記述の配列で比較する共通ヘルパ。
function normalizedOpeningAxes(graph) {
  return graph.centerLines
    .filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING || cl.beamAxisOrigin === BeamAxisOrigin.WALL)
    .map(cl => ({
      isVertical: cl.centerLineType === CenterLineType.VERTICAL,
      value: cl.value,
      extentLo: cl.extentLo, extentHi: cl.extentHi,
      origin: cl.beamAxisOrigin,
    }))
    .sort((a, b) => (Number(a.isVertical) - Number(b.isVertical)) || (a.value - b.value));
}

// graph.planeを最下階（index 0）扱いにしない最小のproject stub——isFoundationPlaneは
// project.planesでのindex一致だけを見るため、ダミーの1階分だけ前に挟めば基礎伏図分岐
// （footings・mat基礎等の余計な複雑さ）を踏まずに済む。foundationTypeはproject.structuralInfo.
// foundationTypeを直読みする箇所（autoFillStructuralGrid）があるため最小限で用意する。
function fakeNonFoundationProjectFor(graph) {
  return { planes: [{ id: '__below_dummy__' }, graph.plane], structuralInfo: { foundationType: 'independent' } };
}

// 【QA最終指摘・配線変異への感度是正】以前はreconcileOpeningBeamAxes→autoFillOpeningBeamAxes→
// retargetOpeningBeamAxisShortExtentsを自前で順に呼んでいたが、これは本番の呼び出し順
// （structuralAutoFill.js autoFillStructuralGrid）を複製しただけで、autoFillStructuralGrid内の
// 配線（2段目の呼び出しを外す等）が変わってもこのテストのヘルパ自体は追随せず赤にならない
// ——本番の配線そのもの（autoFillStructuralGrid）を直接呼ぶことで、配線変異にも感度を持たせる。
// 何か変わったかは、autoFillStructuralGridの返り値（changed判定と同じ構成要素）で判定する。
function applyOneOpeningReconcilePass(graph, project) {
  const sources = openingBeamSourcesFor(graph, project);
  const result = autoFillStructuralGrid(
    graph, project, graph.structureOverride, null, [], [], [], [], [], undefined, undefined, undefined, sources);
  return result.newColumns.length > 0 || result.removedColumns.length > 0
    || result.newFootings.length > 0 || result.removedFootings.length > 0
    || result.newBeams.length > 0 || result.removedBeams.length > 0
    || result.changedOpeningBeamAxes.length > 0;
}

test('【T4・M-1是正】reconcileOpeningBeamAxes: 開口が短辺方向へ広がると、旧通し辺は座標一致無しで孤児になり（短辺の参照が張り直し済みのため保護されない）、収束後は白紙生成と一致する', () => {
  const { graph, yb } = makeRectOpeningGraph(); // 初期: width=3000(x:2000-5000), height=2000(y:1000-3000)
  graph.structureOverride = 'RC造(ラーメン)';
  const project = fakeNonFoundationProjectFor(graph);
  const sourcesInitial = openingBeamSourcesFor(graph, project);
  const created = autoFillOpeningBeamAxes(graph, sourcesInitial);
  const shortLeft = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  const shortRight = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000);
  const throughTopId = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000).id;
  const throughBottomId = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000).id;
  const shortLeftId = shortLeft.id, shortRightId = shortRight.id;

  // 開口を短辺方向（高さ）へ広げる: yb(下辺)を3000→3900へ（height 2000→2900、widthの3000は超えない
  // ためthrough/shortの役割は入れ替わらない）。
  yb.value = 3900;

  const changed1 = applyOneOpeningReconcilePass(graph, project);
  assert.ok(changed1, '1回目の適用で変更が検出される');
  const changed2 = applyOneOpeningReconcilePass(graph, project);
  assert.equal(changed2, false, 'M-1\'是正: 1回の適用（reconcile→生成→短辺の張り直し2段目）だけで収束する（2回目は変更なし）');

  assert.equal(graph.shapeMap.get(throughTopId)?.id, throughTopId, '動いていない側の通し辺(y=1000)は座標一致のまま同idで残る');
  assert.equal(graph.shapeMap.has(throughBottomId), false, '動いた側の旧通し辺(旧y=3000)は座標一致が崩れ孤児として撤去される');
  assert.equal(graph.shapeMap.get(shortLeftId)?.id, shortLeftId, '短辺(shortLeft)は同idのまま残る（座標は変わらないため）');
  assert.equal(graph.shapeMap.get(shortRightId)?.id, shortRightId, '短辺(shortRight)も同idのまま残る');
  assert.equal(shortLeft.extentHi, 3900, '短辺のextentHiが新しい通し辺の座標(3900)を指すよう張り直っている');
  assert.equal(shortLeft.extentLo, 1000, '短辺のextentLoは変わらず通し辺(y=1000)を指す');

  // 白紙から同じ最終形状を生成した結果と、座標・extent・由来（idを除く）が一致する。
  const { graph: freshGraph } = makeRectOpeningGraph(3900);
  freshGraph.structureOverride = 'RC造(ラーメン)';
  const freshSources = openingBeamSourcesFor(freshGraph, project);
  autoFillOpeningBeamAxes(freshGraph, freshSources);

  assert.deepEqual(normalizedOpeningAxes(graph), normalizedOpeningAxes(freshGraph),
    '収束後の梁芯集合（座標・extent実効値・由来）が白紙から新規生成した結果と一致する');
});

test('【T5・M-1是正】reconcileOpeningBeamAxes: 中心線移動で通し/短辺の役割が入れ替わると、両方向のextentが張り直される', () => {
  // width=3000(x:2000-5000)・height=2000(y:1000-3000) → width<height=2000(x:2000-5000固定のまま
  // widthは動かせないため、xb側を大きく動かしてwidthを縮め、height(2000)より小さくすることで
  // through/shortの役割を反転させる（through: height>width→trueでverticalが通しになる）。
  const { graph, xb } = makeRectOpeningGraph(); // height=2000固定
  graph.structureOverride = 'RC造(ラーメン)';
  const project = fakeNonFoundationProjectFor(graph);
  const sourcesInitial = openingBeamSourcesFor(graph, project);
  const created = autoFillOpeningBeamAxes(graph, sourcesInitial);
  // 初期: width(3000)>height(2000) → 通しは水平辺(y=1000,3000)、短辺は垂直辺(x=2000,5000)。
  const throughTopId = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000).id;
  const throughBottomId = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000).id;
  const oldShortLeftId = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000).id;
  const oldShortRightId = created.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000).id;

  // xb(右辺)を5000→3500へ動かし、width=1500<height=2000にする——through/shortが反転する
  // （通しは垂直辺x=2000,3500、短辺は水平辺y=1000,3000になる）。
  xb.value = 3500;

  const changed1 = applyOneOpeningReconcilePass(graph, project);
  assert.ok(changed1, '1回目の適用で変更が検出される');
  const changed2 = applyOneOpeningReconcilePass(graph, project);
  assert.equal(changed2, false, 'M-1\'是正: 1回の適用だけで収束する（2回目は変更なし）');

  // 反転後は垂直辺(x=2000,3500)が通し・水平辺(y=1000,3000)が短辺になる。
  // 座標が変わらないx=2000の垂直辺(旧shortLeft)は「同一の梁芯CL」が役割だけ通しへ変わる
  // （座標一致のため孤児化せず、reconcileのextent照合だけが効く）。
  const flippedThroughLeft = graph.shapeMap.get(oldShortLeftId);
  assert.ok(flippedThroughLeft, '座標が変わらないCL(旧shortLeft, x=2000)は同idのまま残り、役割が短辺→通しへ変わる');
  const gridYs = graph.gridYs; // 通り芯Y: 0, 6000
  assert.equal(flippedThroughLeft.extentLo, 0, '通しへ変わった旧shortLeftのextentLoは直交通り芯(y=0)を参照する');
  assert.equal(flippedThroughLeft.extentHi, 6000, '同extentHiは直交通り芯(y=6000)を参照する');

  // 旧通し辺(水平辺y=1000,3000)は、座標は変わらないが役割が通し→短辺へ変わる——extentが
  // 直交通り芯参照から短辺方式（spanRefs＝新しい通し辺の座標）へ張り直る。
  const flippedShortTop = graph.shapeMap.get(throughTopId);
  assert.ok(flippedShortTop, '座標が変わらない旧通し辺(y=1000)も同idのまま残り、役割が通し→短辺へ変わる');
  assert.equal(flippedShortTop.extentLo, 2000, '短辺へ変わった旧通し辺(y=1000)のextentLoは新しい通しの座標(x=2000)を指す');
  assert.equal(flippedShortTop.extentHi, 3500, '同extentHiは新しい通しの座標(x=3500)を指す');
  void gridYs; void throughBottomId; void oldShortRightId;

  // 白紙から同じ最終形状を生成した結果と一致する。
  const { graph: freshGraph } = makeRectOpeningGraph();
  freshGraph.structureOverride = 'RC造(ラーメン)';
  const freshXb = freshGraph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000);
  freshXb.value = 3500;
  const freshSources = openingBeamSourcesFor(freshGraph, project);
  autoFillOpeningBeamAxes(freshGraph, freshSources);

  assert.deepEqual(normalizedOpeningAxes(graph), normalizedOpeningAxes(freshGraph),
    '役割が入れ替わった後の梁芯集合（座標・extent実効値・由来）が白紙から新規生成した結果と一致する');
});

// ---- mapOpeningSourceMoves ----

test('mapOpeningSourceMoves: 同一axisCLId・isVertical・outwardSignで区間の重なりが最大の辺を対応づけ、coordが変われば move を返す', () => {
  const before = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000, outwardSign: -1, axisCLId: 'cl-a' }];
  const after  = [{ isVertical: true, coord: 2100, lo: 1000, hi: 3000, outwardSign: -1, axisCLId: 'cl-a' }];
  assert.deepEqual(mapOpeningSourceMoves(before, after), [{ isVertical: true, from: 2000, to: 2100 }]);
});

test('【失敗系】mapOpeningSourceMoves: 対応する後継が無い（axisCLId不一致・区間の重なりも無い）辺は無視する', () => {
  const before = [{ isVertical: true, coord: 2000, lo: 1000, hi: 3000, outwardSign: -1, axisCLId: 'cl-a' }];
  const after  = [{ isVertical: true, coord: 2100, lo: 5000, hi: 7000, outwardSign: -1, axisCLId: 'cl-b' }]; // 区間が重ならない
  assert.deepEqual(mapOpeningSourceMoves(before, after), []);
});

test('mapOpeningSourceMoves: coordが変わらなければ move を返さない', () => {
  const before = [{ isVertical: false, coord: 1000, lo: 2000, hi: 5000, outwardSign: 1, axisCLId: 'cl-a' }];
  const after  = [{ isVertical: false, coord: 1000, lo: 2000, hi: 5000, outwardSign: 1, axisCLId: 'cl-a' }];
  assert.deepEqual(mapOpeningSourceMoves(before, after), []);
});

// ---- m-4是正・QA指摘: 移動先が既存CLの座標へ厳密一致すると、floorOpeningEdgesがその辺のaxisCLを
// 動的に差し替える（移動元CLの物理的な位置は同じでもaxisCLIdが変わる）ため、1段階目（axisCLId一致）で
// 対応が付かない場合に2段階目（isVertical・outwardSign・区間重なりのみ）でフォールバック対応する。 ----
test('【T2・M-3/m-4是正】mapOpeningSourceMoves: axisCLIdが変わっても、isVertical・outwardSign・区間重なりでフォールバック対応する', () => {
  const before = [{ isVertical: false, coord: 1000, lo: 2000, hi: 5000, outwardSign: -1, axisCLId: 'ya' }];
  const after  = [{ isVertical: false, coord: 0, lo: 2000, hi: 5000, outwardSign: -1, axisCLId: 'y0' }]; // 着地先の既存CLへaxisCLIdが差し替わる
  assert.deepEqual(mapOpeningSourceMoves(before, after), [{ isVertical: false, from: 1000, to: 0 }]);
});

test('【T2・M-3是正・失敗系】mapOpeningSourceMoves: 同じaxisCLIdでもoutwardSignが逆（両側の辺）なら別々に対応づけ、取り違えない', () => {
  // L字型の1本の中心線(axisCLId:'ax1')が、外側(+1)と内側(-1)の2辺の軸になっている構成。
  // 外側の辺は+30、内側の辺は-10だけ動く——outwardSignを見ずに重なりだけで対応づけると
  // 先勝ちで取り違える恐れがある。
  const before = [
    { isVertical: true, coord: 1000, lo: 0, hi: 4000, outwardSign: 1, axisCLId: 'ax1' },
    { isVertical: true, coord: 1000, lo: 0, hi: 4000, outwardSign: -1, axisCLId: 'ax1' },
  ];
  const after = [
    { isVertical: true, coord: 1030, lo: 0, hi: 4000, outwardSign: 1, axisCLId: 'ax1' },
    { isVertical: true, coord: 990, lo: 0, hi: 4000, outwardSign: -1, axisCLId: 'ax1' },
  ];
  const moves = mapOpeningSourceMoves(before, after);
  assert.equal(moves.length, 2);
  assert.ok(moves.some(m => m.from === 1000 && m.to === 1030), '外側(+1)の辺は+30だけ動く対応がある');
  assert.ok(moves.some(m => m.from === 1000 && m.to === 990), '内側(-1)の辺は-10だけ動く対応がある（取り違えない）');
});

test('【m-2是正・QA指定入力】mapOpeningSourceMoves: 同じaxisCLId・区間で複数辺のoutwardSignが入れ替わっても取り違えない', () => {
  // before[0](outwardSign+1,coord3000)とbefore[1](outwardSign-1,coord3200)。
  // after[0](outwardSign-1,coord3200)とafter[1](outwardSign+1,coord3100)——
  // after配列の並び順が「-1側が先」になっていても、outwardSignで絞り込むため
  // before[0](+1)はafter[1](+1,coord3100)にだけ対応し、before[1](-1)はafter[0]
  // (-1,coord3200。座標not変化)に対応してmoveを生まない。
  const before = [
    { isVertical: false, coord: 3000, lo: 0, hi: 4000, outwardSign: 1, axisCLId: 'ax1' },
    { isVertical: false, coord: 3200, lo: 0, hi: 4000, outwardSign: -1, axisCLId: 'ax1' },
  ];
  const after = [
    { isVertical: false, coord: 3200, lo: 0, hi: 4000, outwardSign: -1, axisCLId: 'ax1' },
    { isVertical: false, coord: 3100, lo: 0, hi: 4000, outwardSign: 1, axisCLId: 'ax1' },
  ];
  assert.deepEqual(mapOpeningSourceMoves(before, after), [{ isVertical: false, from: 3000, to: 3100 }]);
});

test('recomputeStructuralForGraph: captureSnapshots時、reconcileの撤去より前にbeforeスナップショットが採られる（undoで開口由来梁芯が復元する）', async () => {
  const project = new Project('proj-reconcile-undo', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'RC造(ラーメン)';
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(graph);
  const centerKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 3000).key;
  const room = graph.addRoom(new Set([centerKey]));
  room.setFeature(RoomFeature.VOID);

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  let after1;
  try {
    after1 = await recomputeStructuralForGraph(graph, project, 'RC造(ラーメン)', null, { captureSnapshots: true });
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  assert.ok(graph.centerLines.some(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING), '前提: 開口由来の梁芯が生成されている');

  // 部屋をVOIDから戻す（開口が消える）
  room.setFeature(null);

  let result2;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    result2 = await recomputeStructuralForGraph(graph, project, 'RC造(ラーメン)', null, { captureSnapshots: true });
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  assert.equal(graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING).length, 0,
    '開口が消えたので開口由来梁芯はreconcileで撤去される');
  assert.ok(result2.changed, '撤去はremovedBeamsに現れてchangedになる');
  assert.ok(result2.before, 'captureSnapshots:trueならbeforeが採られる（reconcileの撤去より前＝開口が残っている状態）');

  const { restoreGraph } = await import('../graphSnapshot.js');
  restoreGraph(graph, result2.before);
  assert.ok(graph.centerLines.some(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING),
    'undo（beforeへ復元）で開口由来梁芯が戻る＝beforeはreconcileの撤去より前に採られている');
  void x0; void xa; void xb; void x1; void y0; void ya; void yb; void y1; void after1;
});

// ---- M-1'是正・QA再指摘: 1回の再計算で収束する（開口拡大の翌回でchanged=trueが続かない） ----
// 【QA最終指摘】旧T7はVOID以外に部屋が無く、建物フットプリント（wallGate）がVOIDの外接矩形だけに
// 縮んで梁が1本も生成されなかった（「梁が0本」）——2階建て・VOIDの周囲に通常の部屋がある構成
// （QAのidem3と同型）にし、実際に生成される短辺小梁・大梁（通し辺の小梁）で検証する。
test('【T7・M-1\'是正】recomputeStructuralForGraph: 2階建て・RC造(ラーメン)・VOIDの周囲に部屋がある構成で、開口が短辺方向へ広がると1回の再計算で短辺小梁の区間・参照が新しい通し辺へ張り直り収束する（2回目はchanged:false）', async () => {
  const project = new Project('proj-t7', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = 'RC造(ラーメン)';
  g2.structureOverride = 'RC造(ラーメン)';

  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = g2.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = g2.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = g2.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = g2.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const yc = g2.addCenterLine(CenterLineType.HORIZONTAL, 3500, ARCH); // 追加セルの下辺
  const y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(g2);
  const voidKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 3000).key;
  const extraKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 3000 && c.y2 === 3500).key;
  const otherKeys = cells.filter(c => c.key !== voidKey && c.key !== extraKey).map(c => c.key);
  const voidRoom = g2.addRoom(new Set([voidKey]));
  voidRoom.setFeature(RoomFeature.VOID);
  // VOIDの周囲（拡張先のextraKeyを含む）を通常の部屋（INTERIOR）で埋める——建物フットプリント
  // （wallGate）が全グリッドを覆うようにし、梁が実際に生成される構成にする。
  const outerRoom = g2.addRoom(new Set([extraKey, ...otherKeys]));

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    await recomputeStructuralForGraph(g2, project, 'RC造(ラーメン)', g1);
    const shortLeftBefore = g2.centerLines.find(cl =>
      cl.beamAxisOrigin === BeamAxisOrigin.OPENING && cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
    assert.ok(shortLeftBefore, '前提: 初期状態で短辺(x=2000)の開口由来梁芯が生成されている');
    assert.equal(shortLeftBefore.extentHi, 3000, '前提: 初期状態のextentHiは元の通し辺(y=3000)を指す');
    const shortLeftId = shortLeftBefore.id;
    const primaryBeamIdsBefore = new Set(g2.beams.filter(b => b.role === 'primary').map(b => b.id));
    assert.ok(primaryBeamIdsBefore.size > 0, '前提: 部屋を周囲に置いたことで大梁(role:primary)が実際に生成されている');

    // VOIDをy:[3000,3500]のセルまで広げる（短辺方向＝高さ方向への拡大。extraKeyをouterRoomから
    // voidRoomへ移す）。
    outerRoom.cells.delete(extraKey);
    voidRoom.cells.add(extraKey);

    const result1 = await recomputeStructuralForGraph(g2, project, 'RC造(ラーメン)', g1, { captureSnapshots: true });
    assert.ok(result1.changed, '1回目の再計算で変更が検出される');
    const shortLeftAfter1 = g2.shapeMap.get(shortLeftId);
    assert.ok(shortLeftAfter1, '短辺(x=2000)は同idのまま残る（座標は変わらないため）');
    const newThroughBottom = g2.centerLines.find(cl =>
      cl.beamAxisOrigin === BeamAxisOrigin.OPENING && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3500);
    assert.ok(newThroughBottom, '新しい通し辺(y=3500)が生成されている');
    assert.equal(shortLeftAfter1.extentHiRef?.clId, newThroughBottom.id,
      '1回目の後、短辺のextentHiRef.clIdが新しい通し辺(H@3500)のidになっている（M-1\'是正・1パスで収束）');

    // 短辺小梁（shortLeft自身をaxisCLに持つrole:secondaryの梁）の区間が[1000,3500]になっており、
    // clEnd.idが新しい通し辺(H@3500)のidであることを確認する。
    const shortLeftBeam = g2.beams.find(b => b.axisCL.id === shortLeftId && b.role === 'secondary');
    assert.ok(shortLeftBeam, '短辺(shortLeft)に乗る小梁が生成されている');
    const shortLeftBeamLo = Math.min(shortLeftBeam.clStart.effectiveValue, shortLeftBeam.clEnd.effectiveValue);
    const shortLeftBeamHi = Math.max(shortLeftBeam.clStart.effectiveValue, shortLeftBeam.clEnd.effectiveValue);
    assert.equal(shortLeftBeamLo, 1000, '短辺小梁の区間の下端は1000のまま');
    assert.equal(shortLeftBeamHi, 3500, '短辺小梁の区間の上端は張り直り後の3500になる');
    const shortLeftBeamHiEnd = shortLeftBeam.clStart.effectiveValue > shortLeftBeam.clEnd.effectiveValue
      ? shortLeftBeam.clStart : shortLeftBeam.clEnd;
    assert.equal(shortLeftBeamHiEnd.id, newThroughBottom.id, '短辺小梁のclEnd.idが新しい通し辺(H@3500)のidになっている');

    // 大梁(role:primary)のidは変わらない（通し辺の張り直しはprimary梁に影響しない）。
    const primaryBeamIdsAfter1 = new Set(g2.beams.filter(b => b.role === 'primary').map(b => b.id));
    assert.deepEqual(primaryBeamIdsAfter1, primaryBeamIdsBefore, '大梁(role:primary)のidは1回目の再計算後も不変');

    const result2 = await recomputeStructuralForGraph(g2, project, 'RC造(ラーメン)', g1, { captureSnapshots: true });
    assert.equal(result2.changed, false, '2回目はchanged:falseになる（すでに収束している。利用者の操作なしに再計算が繰り返されない）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  void x0; void xa; void xb; void x1; void y0; void ya; void yb; void yc; void y1;
});

// ---- m-1・QA再指摘: 張り直しだけが起きた再計算でもchanged:trueになる（changedOpeningBeamAxes配線） ----
test('【T8・m-1是正】recomputeStructuralForGraph: 通し辺のextentの張り直しだけが起きた再計算でもchanged:trueになる（新規生成・撤去は無し）', async () => {
  const project = new Project('proj-t8-m1', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'RC造(ラーメン)';
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, GRID);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, GRID);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, ARCH);
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const cells = getAllCells(graph);
  const centerKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 1000 && c.y2 === 3000).key;
  graph.addRoom(new Set([centerKey])).setFeature(RoomFeature.VOID);

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  try {
    await recomputeStructuralForGraph(graph, project, 'RC造(ラーメン)');
    const throughTop = graph.centerLines.find(cl =>
      cl.beamAxisOrigin === BeamAxisOrigin.OPENING && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000);
    assert.equal(throughTop.extentHiRef?.clId, x1.id, '前提: 通し辺(y=1000)のextentHiRefは元の通り芯(x=8000)を指す');
    const throughTopId = throughTop.id;

    // 通り芯を追加してbracketExtentの範囲を締める（x=6500）——4辺の座標・本数は一切変わらない
    // （新規生成・撤去なし）が、通し辺のextentHiRefだけが張り直る（retargetのみが起きるケース）。
    const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 6500, GRID);

    const result = await recomputeStructuralForGraph(graph, project, 'RC造(ラーメン)', null, { captureSnapshots: true });
    const throughTopAfter = graph.shapeMap.get(throughTopId);
    assert.equal(throughTopAfter.extentHiRef?.clId, x2.id, '前提: 通し辺のextentHiRefが新しい通り芯(x=6500)へ張り直っている（retargetのみ）');
    assert.ok(result.changed, 'm-1是正: 張り直しだけが起きた再計算でもchanged:trueになる（changedOpeningBeamAxesがchangedに乗っている）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  void x0; void xa; void xb; void y0; void ya; void yb; void y1;
});

// ---- m-3是正・QA再指摘: 張り直した梁芯に乗るauto小梁の撤去（子スリーブを先に消す） ----
test('【T9・m-3是正】reconcileOpeningBeamAxes: 張り直した梁芯に乗るauto小梁（子スリーブ付き）は撤去され、非auto（dimensionStatus:fixed）は残る。excludedBeamSlotsは変わらない', () => {
  const { graph, x1 } = makeRectOpeningGraph();
  graph.structureOverride = 'RC造(ラーメン)';
  const sources = openingBeamSourcesFor(graph, {});
  const created = autoFillOpeningBeamAxes(graph, sources);
  const throughTop = created.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 1000);
  assert.equal(throughTop.extentHiRef?.clId, x1.id, '前提: 通し辺(y=1000)のextentHiRefは元の通り芯(x=8000)を指す');

  // throughTopに乗るauto小梁（子スリーブ付き）と非auto小梁を1本ずつ手で置く。
  const autoBeam = graph.addBeam(StructuralMaterialType.RC, 'RC-BEAM-TEST', throughTop, false,
    graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000),
    graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000),
    { role: 'secondary' }); // dimensionStatus省略→既定'auto'
  const sleeve = graph.addSleeve('beam', { hostBeamId: autoBeam.id, hostAxisCL: throughTop });
  const fixedBeam = graph.addBeam(StructuralMaterialType.RC, 'RC-BEAM-TEST', throughTop, false,
    graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000),
    graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000),
    { role: 'secondary', dimensionStatus: 'fixed' });
  const excludedBeamSlotsSizeBefore = graph.excludedBeamSlots.size;

  // 通り芯を追加してbracketExtentの範囲を締める（throughTopのextentHiRefが張り直る）。
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 6500, GRID);
  const sourcesAfter = openingBeamSourcesFor(graph, {});
  const { retargeted } = reconcileOpeningBeamAxes(graph, sourcesAfter, []);

  assert.ok(retargeted.some(cl => cl.id === throughTop.id), '前提: throughTopが張り直された');
  assert.equal(graph.beamMap.has(autoBeam.id), false, 'auto小梁は撤去される');
  assert.equal(graph.sleeveMap.has(sleeve.id), false, 'm-3(c)是正: auto小梁を撤去する前に子スリーブが先に消える');
  assert.equal(graph.beamMap.has(fixedBeam.id), true, '非auto（dimensionStatus:fixed）の小梁は残る');
  assert.equal(graph.excludedBeamSlots.size, excludedBeamSlotsSizeBefore,
    '撤去はexcludedBeamSlotsへ記録しない（graph.removeBeamは使わない。直接beamMap.deleteする規約）');
  void x2;
});
