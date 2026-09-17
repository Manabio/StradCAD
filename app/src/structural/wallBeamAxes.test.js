import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import {
  collectWallBeamSources, autoFillWallBeamAxes, isTraditionalWoodStructure,
  wallBackingCenters, mapBackingCenterMoves, findWallBeamAxisCL, wallBeamAxisExcludeKey, peekBelowGraph,
  selfWallSegments,
} from './wallBeamAxes.js';
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
// bandOffset（柱寸法シフト量の内訳。core/wall.js Wall.bandOffset）は既定null＝本来の偏芯
// （2a壁・CL偏芯等）を模す。外周辺由来の室生成壁（isExteriorWall:falseでもbandShiftを持つ壁）を
// 模すときは bandOffset を明示すること。
function addBackingWall(graph, {
  axisValue, clStart, clEnd, isVertical, backingDepth = 120, isExteriorWall = false, backingOffset = 0, bandOffset = null,
}) {
  // 壁のaxisCLは壁自身の走る向きと同じ種別（isVertical=falseの壁＝水平に走る＝HORIZONTAL軸）。
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL,
    axisValue, { labeled: false, discipline: Discipline.ARCH },
  );
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, {
    isExteriorWall, backingOffset, backingDepth, bandOffset, wallFinish: 12.5,
  });
}

// addBackingWall と異なり axisCL を呼び出し側から受け取る（「同じCL上で壁が再生成された」
// 前後2状態を作るのに使う。壁idは再生成のたびに変わるが axisCL は不変という前提を再現する）。
function addBackingWallOnCL(graph, axisCL, {
  clStart, clEnd, isVertical, axisOffset = 0, backingOffset = 0, backingDepth = 120, isExteriorWall = false, finishSide = null, bandOffset = null,
}) {
  return graph.addWall(axisCL, axisOffset, isVertical, clStart, 0, clEnd, 0, {
    isExteriorWall, backingOffset, backingDepth, finishSide, bandOffset, wallFinish: 12.5,
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

test('collectWallBeamSources: 第3引数に既peek済みのgraph（またはnull）を渡すと自前peekしない（structuralRecompute.jsのpeek共有）', async () => {
  const { graph: selfGraph } = makeGridGraph('p2', 3000);
  const { graph: belowGraph, x1: belowX1, x3: belowX3 } = makeGridGraph('p1', 0);
  addBackingWall(belowGraph, { axisValue: 1800, clStart: belowX1, clEnd: belowX3, isVertical: false });
  selfGraph.structureOverride = '木造（在来）';
  const project = { planes: [belowGraph.plane, selfGraph.plane], structuralInfo: { mainStructure: '未定' } };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('belowGraphを明示した場合は自前peekしてはいけない'); };
  try {
    // 既にpeek済みのgraphを渡す＝呼び出し側の結果をそのまま使う。
    const sources = await collectWallBeamSources(selfGraph, project, belowGraph);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].coord, 1800);
    // nullを明示＝「下階なし」。selfAndBelowでも下階分は足されない。
    const noBelow = await collectWallBeamSources(selfGraph, project, null);
    assert.equal(noBelow.length, 0);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('peekBelowGraph: belowPlaneOf＋floorSwapManager.peekの合成。1つ下の実体階が無ければnull（自前peekしない）', async () => {
  const { graph: selfGraph } = makeGridGraph('p2', 3000);
  const { graph: belowGraph } = makeGridGraph('p1', 0);
  const project = { planes: [belowGraph.plane, selfGraph.plane] };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === belowGraph.plane.id ? belowGraph : null);
  try {
    assert.equal(await peekBelowGraph(selfGraph, project), belowGraph);
    assert.equal(await peekBelowGraph(belowGraph, project), null, '最下階は下に実体階が無い');
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

// QA指摘2026-09-14: 主構造がどこにも設定されていない（undefined）graph でも例外を投げない。
// 旧実装は structure.startsWith('RC造') で TypeError になっていた（structureRules.js 経由で
// UNSPECIFIED_RULES＝生成源なしへ落ちる。ステップ1移設で唯一挙動が変わった点）。
test('【失敗系】collectWallBeamSources: 主構造が未設定（undefined）でも例外を投げず空配列を返す', async () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  addBackingWall(graph, { axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: undefined } };
  const sources = await collectWallBeamSources(graph, project);
  assert.deepEqual(sources, []);
});

// ================================================================
// 壁由来梁芯の追従（ステップ2）: wallBackingCenters / mapBackingCenterMoves / findWallBeamAxisCL
// ================================================================

test('wallBackingCenters: 下地オーナー壁（backingRange!=null）だけを拾い、仕上げのみの薄壁（backingDepth:0）は拾わない', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, axisOffset: 50, backingOffset: 50, backingDepth: 120,
  });
  // 仕上げのみの薄壁（backingDepth:0）は対象外——resolveBackingOwnership が生成する「−側」の薄壁相当。
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, axisOffset: -12.5, backingOffset: 0, backingDepth: 0,
  });

  const centers = wallBackingCenters(graph);
  assert.equal(centers.length, 1, '薄壁は拾わない');
  assert.equal(centers[0].axisCLId, axisCL.id);
  assert.equal(centers[0].isVertical, false);
  assert.equal(centers[0].side, 1, 'side = Math.sign(axisOffset)');
  assert.equal(centers[0].coord, 2000 + 50, '中心座標 = axisCL値 + backingOffset');
  assert.equal(centers[0].lo, 0);
  assert.equal(centers[0].hi, 8000);
});

test('wallBackingCenters: axisOffsetが負（反対側の下地オーナー壁）はside:-1になる', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, axisOffset: -50, backingOffset: -50, backingDepth: 120,
  });
  const centers = wallBackingCenters(graph);
  assert.equal(centers.length, 1);
  assert.equal(centers[0].side, -1);
  assert.equal(centers[0].coord, 2000 - 50);
});

test('【QA S3】wallBackingCenters: axisOffset:0でもfinishSide:-1が明示された仕上げ面合わせ壁はside:-1になる（Math.sign(axisOffset)は0に潰れる）', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, axisOffset: 0, backingOffset: -57.5, backingDepth: 90, finishSide: -1,
  });
  const centers = wallBackingCenters(graph);
  assert.equal(centers.length, 1);
  assert.equal(centers[0].side, -1, 'faceDirOr(0)はfinishSideを優先するためaxisOffset:0でも0に潰れない');
  assert.equal(centers[0].coord, 2000 - 57.5);
});

// ---- 柱寸法が基準（120）より細い階の外壁下地帯シフト（bandShift。structural/structureRules.js
// woodBaseColumnWidthMm 参照。finish/wallGeneration.js generateExteriorWalls/
// generateRoomWallsFromOutline）は「見た目の」帯移動であり、梁芯CL・壁交点柱のアンカー（通り芯位置
// 基準）まで動かしてはいけない（ステップ1・QA F1）。判定は wall.bandOffset（専用フィールド。
// core/wall.js Wall.bandOffset）で行う——isExteriorWallでは判定しない（外周辺に接する室生成壁
// も同じ扱いにする必要があるため）。----
test('selfWallSegments: 外壁がbandOffset!=0（柱寸法シフト）を持っていてもcoordは軸CL値のまま', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  // 柱寸105・bandShift=7.5相当（backingOffset=bandOffset=-7.5・backingDepth=105=wallBase）。
  addBackingWall(graph, {
    axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false,
    isExteriorWall: true, backingOffset: -7.5, bandOffset: -7.5, backingDepth: 105,
  });
  const segs = selfWallSegments(graph);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].coord, 2000, 'coordは軸CL値のまま（bandOffsetの見た目の移動を相殺する）');
  assert.equal(segs[0].bandOffset, -7.5, 'bandOffsetにシフト量がそのまま入る（ステップ2で柱が使う）');
});

test('【QA F1回帰】selfWallSegments: 外周辺由来の室生成壁（isExteriorWall=false・bandOffset!=0）もcoordは軸CL値のまま', () => {
  // ownership解決で外周辺に接する室生成壁が非covered区間で下地オーナー（backingDepth=W）に
  // なるケース（QA実測: moku2.stqで再現）。isExteriorWall=falseだがbandOffsetを持つ。
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  addBackingWall(graph, {
    axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false,
    isExteriorWall: false, backingOffset: -7.5, bandOffset: -7.5, backingDepth: 105,
  });
  const segs = selfWallSegments(graph);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].coord, 2000, 'isExteriorWall=falseでもbandOffsetがあれば相殺される（通り芯脇に梁芯・柱が湧かない）');
  assert.equal(segs[0].bandOffset, -7.5);
});

test('selfWallSegments: bandOffset=null（本来の偏芯。2a壁・CL偏芯等）のbackingOffsetは従来どおりcoordに反映される', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  addBackingWall(graph, {
    axisValue: 2000, clStart: x1, clEnd: x3, isVertical: false,
    isExteriorWall: false, backingOffset: -7.5, bandOffset: null, backingDepth: 105,
  });
  const segs = selfWallSegments(graph);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].coord, 2000 - 7.5, 'bandOffset無しの偏芯（2a壁等）は従来どおりbackingOffsetがcoordに反映される');
  assert.equal(segs[0].bandOffset, 0);
});

test('wallBackingCenters: 外壁がbandOffset!=0（柱寸法シフト）を持っていてもcoordは軸CL値のまま', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, isExteriorWall: true,
    axisOffset: -72.5, backingOffset: -7.5, bandOffset: -7.5, backingDepth: 105,
  });
  const centers = wallBackingCenters(graph);
  assert.equal(centers.length, 1);
  assert.equal(centers[0].coord, 2000, '外壁のbandOffsetを相殺してaxisCL値のままになる');
});

test('【QA F1回帰】wallBackingCenters: 外周辺由来の室生成壁（isExteriorWall=false・bandOffset!=0）もcoordは軸CL値のまま', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, isExteriorWall: false,
    axisOffset: -57.5, backingOffset: -7.5, bandOffset: -7.5, backingDepth: 105,
  });
  const centers = wallBackingCenters(graph);
  assert.equal(centers.length, 1);
  assert.equal(centers[0].coord, 2000, 'isExteriorWall=falseでもbandOffsetがあれば相殺される');
});

test('mapBackingCenterMoves: 同じ(axisCLId,isVertical,side)でスパンが重なる旧↔新を対応づけ、動いた分だけ返す', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, axisOffset: 45, backingOffset: 45, backingDepth: 90,
  });
  const before = wallBackingCenters(graph);
  assert.equal(before.length, 1);
  assert.equal(before[0].coord, 2045);

  // 「壁が再生成されて厚みが変わった」を模す（同じaxisCL・壁idは変わらないが実運用では
  // 別オブジェクトになる。ここではフィールド直接書換えで下地帯中心の移動だけを再現する）。
  wall.backingOffset = 60;
  wall.backingDepth = 120;
  const after = wallBackingCenters(graph);
  assert.equal(after.length, 1);
  assert.equal(after[0].coord, 2060);

  const moves = mapBackingCenterMoves(before, after);
  assert.deepEqual(moves, [{ axisCLId: axisCL.id, isVertical: false, from: 2045, to: 2060 }]);
});

test('mapBackingCenterMoves: 中心座標が変わらなければ移動として返さない', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  addBackingWallOnCL(graph, axisCL, {
    clStart: x1, clEnd: x3, isVertical: false, axisOffset: 45, backingOffset: 45, backingDepth: 90,
  });
  const before = wallBackingCenters(graph);
  const after = wallBackingCenters(graph); // 同一状態から2回取得
  assert.deepEqual(mapBackingCenterMoves(before, after), []);
});

test('【失敗系】mapBackingCenterMoves: スパンが重ならない旧↔新は対応づけない（無関係な同軸壁と誤対応しない）', () => {
  const { graph, x2, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // 旧側スパンは [0,1500]（間に隙間を空ける）。新側は同じCL・side だが [4000,8000] で重ならない。
  const before = [{ axisCLId: axisCL.id, isVertical: false, side: 1, coord: 2045, lo: 0, hi: 1500 }];
  addBackingWallOnCL(graph, axisCL, { clStart: x2, clEnd: x3, isVertical: false, axisOffset: 60, backingOffset: 60, backingDepth: 120 });
  const after = wallBackingCenters(graph);
  assert.deepEqual(mapBackingCenterMoves(before, after), []);
});

test('【失敗系】mapBackingCenterMoves: sideが違う旧↔新は対応づけない', () => {
  const { graph, x1, x3 } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const before = [{ axisCLId: axisCL.id, isVertical: false, side: 1, coord: 2045, lo: 0, hi: 8000 }];
  addBackingWallOnCL(graph, axisCL, { clStart: x1, clEnd: x3, isVertical: false, axisOffset: -60, backingOffset: -60, backingDepth: 120 });
  const after = wallBackingCenters(graph);
  assert.deepEqual(mapBackingCenterMoves(before, after), []);
});

test('【失敗系・孤児は撤去しない裁定】mapBackingCenterMoves: 旧にあって新に対応が無い壁は無視する（moveを返さない）', () => {
  const { graph } = makeGridGraph('p1', 0);
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const before = [{ axisCLId: axisCL.id, isVertical: false, side: 1, coord: 2045, lo: 0, hi: 8000 }];
  const after = []; // 新側に壁が無い（部屋ごと消えた等）
  assert.deepEqual(mapBackingCenterMoves(before, after), []);
});

// ---- QA S2: 貪欲findIndex（配列順依存・端点共有を重なり扱い）の是正 ----
test('【QA S2】mapBackingCenterMoves: after配列の並び順に依存せず、重なり長最大のものへ正しく対応づける（部屋境界で2本に割れた同軸同sideの壁）', () => {
  const before = [
    { axisCLId: 'ax', isVertical: false, side: 1, coord: 100, lo: 0, hi: 3000 },
    { axisCLId: 'ax', isVertical: false, side: 1, coord: 200, lo: 3000, hi: 6000 },
  ];
  // after の順序を意図的に before と逆にする（配列順に依存する早期一致だと取り違える）。
  const after = [
    { axisCLId: 'ax', isVertical: false, side: 1, coord: 250, lo: 3000, hi: 6000 },
    { axisCLId: 'ax', isVertical: false, side: 1, coord: 150, lo: 0, hi: 3000 },
  ];
  assert.deepEqual(mapBackingCenterMoves(before, after), [
    { axisCLId: 'ax', isVertical: false, from: 100, to: 150 },
    { axisCLId: 'ax', isVertical: false, from: 200, to: 250 },
  ]);
});

test('【QA S2失敗系】mapBackingCenterMoves: 端点共有のみ（重なり長0）は対応づけない', () => {
  const before = [{ axisCLId: 'ax', isVertical: false, side: 1, coord: 100, lo: 0, hi: 3000 }];
  const after = [{ axisCLId: 'ax', isVertical: false, side: 1, coord: 900, lo: 3000, hi: 6000 }];
  assert.deepEqual(mapBackingCenterMoves(before, after), []);
});

test('【QA S2】mapBackingCenterMoves: 1旧→2新（分割）でもmoveは最大1件（重なりが大きい方だけ対応づく）', () => {
  const before = [{ axisCLId: 'ax', isVertical: false, side: 1, coord: 100, lo: 0, hi: 6000 }];
  const after = [
    { axisCLId: 'ax', isVertical: false, side: 1, coord: 150, lo: 0, hi: 1000 },   // 重なり1000
    { axisCLId: 'ax', isVertical: false, side: 1, coord: 250, lo: 500, hi: 6000 }, // 重なり5500（最大）
  ];
  const moves = mapBackingCenterMoves(before, after);
  assert.equal(moves.length, 1, '1旧エントリにつきmoveは最大1件');
  assert.equal(moves[0].to, 250, '重なりが最大の新側と対応づく');
});

test('【QA T2】mapBackingCenterMoves: 重なり長が同点の候補はloがb.loに近い方へ対応づく（afterの順を入れ替えても同じ結果）', () => {
  const before = [{ axisCLId: 'ax', isVertical: false, side: 1, coord: 100, lo: 0, hi: 3000 }];
  // A: lo=0（b.loと一致）hi=2000 → 重なり = min(3000,2000)-max(0,0) = 2000
  // B: lo=1000            hi=3000 → 重なり = min(3000,3000)-max(0,1000) = 2000（同点）
  const a = { axisCLId: 'ax', isVertical: false, side: 1, coord: 150, lo: 0, hi: 2000 };
  const b = { axisCLId: 'ax', isVertical: false, side: 1, coord: 350, lo: 1000, hi: 3000 };

  const movesAB = mapBackingCenterMoves(before, [a, b]);
  assert.equal(movesAB.length, 1);
  assert.equal(movesAB[0].to, 150, 'loがb.loに一致するAへ対応づく');

  const movesBA = mapBackingCenterMoves(before, [b, a]); // after の順を入れ替える
  assert.equal(movesBA.length, 1);
  assert.equal(movesBA[0].to, 150, '走査順を変えても結果は変わらない');
});

test('findWallBeamAxisCL: 許容差内(CL_OVERLAP_TOL_MM)の壁由来梁芯（fuse）を返す', () => {
  const graph = makeGraph('p1', 0);
  const beamCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2045, { labeled: false, discipline: Discipline.FUSE });
  const found = findWallBeamAxisCL(graph, false, 2045);
  assert.equal(found, beamCL);
});

test('findWallBeamAxisCL: 許容差外なら見つからない（null）', () => {
  const graph = makeGraph('p1', 0);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2045, { labeled: false, discipline: Discipline.FUSE });
  assert.equal(findWallBeamAxisCL(graph, false, 2100), null);
});

test('【findBeamAnchorCLとの違い】findWallBeamAxisCL: 通り芯（labeled）は対象外——通り芯を動かす事故を防ぐ', () => {
  const graph = makeGraph('p1', 0);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2045, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(findWallBeamAxisCL(graph, false, 2045), null,
    'findBeamAnchorCLは通り芯にも一致するが、findWallBeamAxisCLは意図的に一致させない');
});

test('wallBeamAxisExcludeKey: autoFillWallBeamAxesの除外キーと同じ書式（X|Y:座標丸め）を返す', () => {
  assert.equal(wallBeamAxisExcludeKey(true, 2045.6), 'X:2046');
  assert.equal(wallBeamAxisExcludeKey(false, 2045.4), 'Y:2045');
});

// ---- 【QA S4不変条件】transform/centerLineOps.js の除外キー操作は wallBeamAxisExcludeKey を経由する ----
// 除外キーの書式を直書き（inline literal）で複製していると、wallBeamAxisExcludeKey 側だけ
// 書式を変えたときに片方が取り残されてキーがすれ違う事故になる（QA S4）。
test('【QA S4不変条件】centerLineOps.js の excludedWallBeamAxes.add(/.delete( 行は wallBeamAxisExcludeKey( を経由する', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../transform/centerLineOps.js'), 'utf8');
  const lines = src.split(/\r?\n/);
  const offenders = [];
  lines.forEach((line, i) => {
    if (/excludedWallBeamAxes\.(add|delete)\(/.test(line) && !line.includes('wallBeamAxisExcludeKey(')) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [], `除外キーの直書きが残っている:\n${offenders.join('\n')}`);
  // 前提: 走査対象の行が実在すること（0件だとテストが何も検出できず無意味に緑になるのを防ぐ）。
  const targetLines = lines.filter(l => /excludedWallBeamAxes\.(add|delete)\(/.test(l));
  assert.ok(targetLines.length >= 3, `前提: excludedWallBeamAxes.add/delete が3箇所以上あるはず（実際:${targetLines.length}）`);
});
