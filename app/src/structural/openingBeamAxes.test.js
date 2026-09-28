// openingBeamAxes.js（床開口由来の梁芯自動生成。規則O）の単体テスト。
// フィクスチャはwallBeamAxes.test.js（実core.js流儀）・slabOpening.test.js（開口セル構成）を踏襲する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomFeature, StairType } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { openingBeamSourcesFor, openingBeamSourcesDiagnostics, autoFillOpeningBeamAxes } from './openingBeamAxes.js';
import { autoFillWallBeamAxes, wallBeamSourcesFor } from './wallBeamAxes.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
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
