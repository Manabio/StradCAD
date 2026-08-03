import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { collectWallBeamSources, autoFillWallBeamAxes, isTraditionalWoodStructure } from './wallBeamAxes.js';
import { RC_WALL_BACKING_CODES } from '../finish/materials/backingClass.js';
import { MATERIALS } from '../finish/materials/materialData.js';
import { materialThickness } from '../finish/edgeComposition.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

// memberTestFixtures.js のダックタイピングでは effectiveValue・gridXs/gridYs・backingRange連携の
// 実挙動を再現できないため、本ファイルは実 core.js（Plane/PlanGraph/Wall）を使う
// （structural/beamAxisMove.js 等、既存の実core.js流儀テストと同じ方針）。

function makeGraph(planeId = 'p1', elevation = 0) {
  const plane = new Plane(planeId, elevation, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 縦グリッド X1=0,X2=4000,X3=8000 / 横グリッド Y1=0,Y2=4000 を持つグラフを返す。
function makeGridGraph(planeId, elevation) {
  const graph = makeGraph(planeId, elevation);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  return { graph, x1, x2, x3, y1, y2 };
}

// 下地オーナー壁を1本追加する（axisCLは意匠中心線=discipline:archの想定。backingOffset=0固定なので
// 下地帯中心=axisCLの位置になる）。isVertical=falseの壁＝水平方向に走る壁（axisCLはHORIZONTAL）。
function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical, backingDepth = 120, isExteriorWall = false, backingOffset = 0 }) {
  // 壁のaxisCLは壁自身の走る向きと同じ種別（isVertical=falseの壁＝水平に走る＝HORIZONTAL軸）。
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL,
    axisValue, { labeled: false, discipline: Discipline.ARCH },
  );
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, {
    isExteriorWall, backingOffset, backingDepth, wallFinish: 12.5,
  });
}

test('isTraditionalWoodStructure: 在来のみtrue、2×4・その他はfalse', () => {
  assert.equal(isTraditionalWoodStructure('木造（在来）'), true);
  assert.equal(isTraditionalWoodStructure('木造（2"×4"）'), false);
  assert.equal(isTraditionalWoodStructure('RC造(ラーメン)'), false);
  assert.equal(isTraditionalWoodStructure('S造'), false);
});

// ---- autoFillWallBeamAxes（同期・純生成）----
test('autoFillWallBeamAxes: wallSourcesから梁芯CLを生成し、extentは壁区間を含む最小の通り芯ペアへスナップする', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const wallSources = [{ isVertical: false, coord: 2000, lo: 0, hi: 8000 }];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 1);
  const cl = created[0];
  assert.equal(cl.centerLineType, CenterLineType.HORIZONTAL);
  assert.equal(cl.value, 2000);
  assert.equal(cl.labeled, false);
  assert.equal(cl.discipline, Discipline.FUSE);
  assert.equal(cl.refId, null, 'refIdは持たせない（絶対座標）');
  assert.equal(cl.extentLoRef?.clId, x1.id);
  assert.equal(cl.extentHiRef?.clId, x3.id);
});

test('autoFillWallBeamAxes: 壁区間が通り芯の内側で終わる場合は最小の外側の通り芯へスナップする（部分区間）', () => {
  const { graph, x1, x2 } = makeGridGraph('p1', 0);
  // 壁はX=1000〜3000（X1〜X2の内側）→ extentはX1・X2（壁を含む最小のペア）へスナップされるはず
  const wallSources = [{ isVertical: false, coord: 2000, lo: 1000, hi: 3000 }];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 1);
  assert.equal(created[0].extentLoRef?.clId, x1.id);
  assert.equal(created[0].extentHiRef?.clId, x2.id);
});

test('autoFillWallBeamAxes: 通り芯が片側に無ければその側は静的extentへフォールバックする', () => {
  const graph = makeGraph('p1', 0);
  const wallSources = [{ isVertical: true, coord: 2000, lo: 500, hi: 3500 }];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 1);
  assert.equal(created[0].extentLoRef, null);
  assert.equal(created[0].extentHiRef, null);
  assert.equal(created[0].extentLo, 500);
  assert.equal(created[0].extentHi, 3500);
});

test('autoFillWallBeamAxes: 同方向の既存通り芯（labeled）とCL_OVERLAP_TOL_MM以内なら生成しない', () => {
  const { graph } = makeGridGraph('p1', 0);
  // Y=4000（Y2）に既存の通り芯があるため、同座標の壁由来ソースは重複ガードでスキップされる
  const wallSources = [{ isVertical: false, coord: 4000, lo: 0, hi: 8000 }];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 0);
});

test('autoFillWallBeamAxes: 同方向の既存梁芯（fuse）とCL_OVERLAP_TOL_MM以内なら生成しない', () => {
  const { graph } = makeGridGraph('p1', 0);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE });
  const wallSources = [{ isVertical: false, coord: 2000, lo: 0, hi: 8000 }];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 0);
});

test('autoFillWallBeamAxes: 同方向の意匠中心線・補助線とは同座標でも生成する（重複ガードの対象外）', () => {
  const { graph } = makeGridGraph('p1', 0);
  // 壁は意匠中心線に沿って生成されるのが常態（部屋境界＝中心線）。中心線・補助線は障害物にしない
  // ——構造モードでは非表示化済みのため、その位置に梁芯が立つのが設計どおりの状態（実機検証で発覚）。
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH }); // 中心線
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' }); // 補助線
  const wallSources = [
    { isVertical: false, coord: 2000, lo: 0, hi: 8000 },
    { isVertical: false, coord: 3000, lo: 0, hi: 8000 },
  ];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 2);
});

test('autoFillWallBeamAxes: excludedWallBeamAxesにあるキーは生成しない（手動削除・移動元の尊重）', () => {
  const { graph } = makeGridGraph('p1', 0);
  graph.excludedWallBeamAxes.add('Y:2000');
  const wallSources = [{ isVertical: false, coord: 2000, lo: 0, hi: 8000 }];
  const created = autoFillWallBeamAxes(graph, wallSources);
  assert.equal(created.length, 0);
});

// ---- collectWallBeamSources（非同期・条件判定）----
test('collectWallBeamSources: 条件(a) RC造はRC下地の壁だけが対象になる', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = 'RC造(ラーメン)';
  graph.interiorWallBacking = RC_WALL_BACKING_CODES[0];
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  const sources = await collectWallBeamSources(graph, project);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].coord, 2000);
  assert.equal(sources[0].lo, 0);
  assert.equal(sources[0].hi, 8000);
});

test('collectWallBeamSources: 条件(a) RC造でも下地材がRC以外なら対象外', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = 'RC造(壁式)';
  // interiorWallBackingは既定値（LGS等）のまま＝RC_WALL_BACKING_CODESに属さない
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  const sources = await collectWallBeamSources(graph, project);
  assert.equal(sources.length, 0);
});

test('collectWallBeamSources: 条件(b) 木造（在来）は下地材の種別を問わず自階の下地オーナー壁が対象', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = '木造（在来）';
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  const sources = await collectWallBeamSources(graph, project);
  assert.equal(sources.length, 1);
});

test('collectWallBeamSources: 木造（2×4）は対象外（在来のみ。Open Q2）', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = '木造（2"×4"）';
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  const sources = await collectWallBeamSources(graph, project);
  assert.equal(sources.length, 0);
});

test('collectWallBeamSources: S造・未定は生成対象外', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = 'S造';
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  assert.equal((await collectWallBeamSources(graph, project)).length, 0);
});

test('collectWallBeamSources: backingDepth===0（仕上げのみの薄壁）は下地オーナーではないため対象外', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = '木造（在来）';
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false, backingDepth: 0 });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  assert.equal((await collectWallBeamSources(graph, project)).length, 0);
});

test('collectWallBeamSources: 条件(c) 木造（在来）は1つ下の実体階の下地オーナー壁も対象になる（下階peek）', async () => {
  const { graph: selfGraph } = makeGridGraph('p2', 3000); // 自階：壁なし
  const { graph: belowGraph, x1: belowX1, x3: belowX3 } = makeGridGraph('p1', 0);
  addBackingWall(belowGraph, { axisValue: 1800, clStart: belowX1, clEnd: belowX3, isVertical: false });
  selfGraph.structureOverride = '木造（在来）';

  const project = { planes: [belowGraph.plane, selfGraph.plane], structuralInfo: { mainStructure: '未定' } };

  // floorSwapManager.peek はIndexedDBに依存するため、テスト用に一時的に差し替える
  // （floorSwapManagerはシングルトンインスタンス。実IDBを使わずロジックだけ検証する）。
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === belowGraph.plane.id ? belowGraph : null);
  try {
    const sources = await collectWallBeamSources(selfGraph, project);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].coord, 1800);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('collectWallBeamSources: RC造は1つ下の実体階を対象にしない（自階のみ。要求どおり）', async () => {
  const { graph: selfGraph } = makeGridGraph('p2', 3000);
  const { graph: belowGraph, x1: belowX1, x3: belowX3 } = makeGridGraph('p1', 0);
  addBackingWall(belowGraph, { axisValue: 1800, clStart: belowX1, clEnd: belowX3, isVertical: false });
  selfGraph.structureOverride = 'RC造(ラーメン)';
  selfGraph.interiorWallBacking = RC_WALL_BACKING_CODES[0];

  const project = { planes: [belowGraph.plane, selfGraph.plane], structuralInfo: { mainStructure: '未定' } };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('RC造では下階peekを呼んではいけない'); };
  try {
    const sources = await collectWallBeamSources(selfGraph, project);
    assert.equal(sources.length, 0);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('collectWallBeamSources: 同一バッチ内で座標が重なる複数の壁は1本にまとめ、extentは和集合になる', async () => {
  const { graph, x1, x2, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = '木造（在来）';
  // 2本の壁が同じ座標(y=2000)に梁芯を要求するが、区間が異なる（X1-X2 と X2-X3）
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x2, isVertical: false });
  addBackingWall(graph, { axisValue: 2000, clStart: x2, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };

  const sources = await collectWallBeamSources(graph, project);
  assert.equal(sources.length, 1, '同座標の2本は1本にまとめられるはず');
  assert.equal(sources[0].lo, 0);
  assert.equal(sources[0].hi, 8000, 'extentは和集合（外接）になるはず');
});

// ---- QA blocker回帰: 材データ→materialThickness→backingDepth→backingRangeの結合テスト ----
// edgeComposition.js の実際のフローを模して、RC壁下地のmaterialThicknessをbackingDepthに使う
// （テストヘルパーの決め打ちbackingDepth:120ではなく実材データ経由の値で壁を作る）。
// 修正前（Math.max(x,y)一律）はRC壁下地がthickness0になりbackingRange===nullで条件(a)が0本になっていた。
test('collectWallBeamSources: RC壁下地のmaterialThicknessをbackingDepthに用いた壁はbackingRange!=nullになり条件(a)が1件返す', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  graph.structureOverride = 'RC造(ラーメン)';
  graph.interiorWallBacking = RC_WALL_BACKING_CODES[0];

  const rcBackingMat = MATERIALS.find(m => m.code === RC_WALL_BACKING_CODES[0]); // RC壁 t=150
  const backingDepth = materialThickness(rcBackingMat);
  assert.equal(backingDepth, 150, '前提: RC壁 t=150 のmaterialThicknessは150（0ではない）');

  const wall = addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false, backingDepth });
  assert.notEqual(wall.backingRange, null, 'backingDepthが実材厚で入っていればbackingRangeはnullにならない');

  const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定' } };
  const sources = await collectWallBeamSources(graph, project);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].coord, 2000);
});
