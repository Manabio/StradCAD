// structural/wallBeamAxisFollow.js（followWallBeamAxes）の単体テスト。
// 壁再生成をFinishModeStateから独立させる計画のステップ2: 下地帯の中心が動いたとき、
// 壁由来の梁芯CL（discipline:fuse）を撤去せず追従させる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { findBeamAnchorCL, wallBeamAxisExcludeKey } from './wallBeamAxes.js';
import { followWallBeamAxes } from './wallBeamAxisFollow.js';

function makeGraph(planeId = 'p1', elevation = 0) {
  const plane = new Plane(planeId, elevation, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

function addFuseCL(graph, value) {
  return graph.addCenterLine(CenterLineType.HORIZONTAL, value, { labeled: false, discipline: Discipline.FUSE });
}

test('followWallBeamAxes: fuse梁芯の値がtoに変わり、CL idは不変', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  const { moved } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, [{ clId: beamCL.id, isVertical: false, from: 2045, to: 2060 }]);
  assert.equal(beamCL.value, 2060);
});

test('followWallBeamAxes: アンカー柱の解決先（findBeamAnchorCL）が新座標に一致し、旧座標にはもう見つからない', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  const anchor = findBeamAnchorCL(graph, CenterLineType.HORIZONTAL, 2060);
  assert.equal(anchor?.id, beamCL.id, 'CL id不変のまま新座標でアンカー解決できる');
  assert.equal(findBeamAnchorCL(graph, CenterLineType.HORIZONTAL, 2045), null, '旧座標にはもう存在しない');
});

test('【重複ガード】followWallBeamAxes: toに既に別の壁由来梁芯があればスキップし、書き換えない', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  addFuseCL(graph, 2060); // 新座標に既に別の梁芯
  const { moved, skipped } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'duplicate');
  assert.equal(beamCL.value, 2045, '重複時は書き換えない');
});

test('【QA S1・重複ガード】followWallBeamAxes: toに通り芯（labeled）があればスキップし、梁芯値は不変・to位置のCLは通り芯1本のまま', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  const gridCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2060, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯
  const { moved, skipped } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'duplicate');
  assert.equal(beamCL.value, 2045, '梁芯の値は書き換わらない（通り芯を動かさない）');
  const clsAt2060 = graph.centerLines.filter(cl => Math.abs(cl.value - 2060) < 1);
  assert.deepEqual(clsAt2060.map(cl => cl.id), [gridCL.id], 'to位置には元の通り芯1本だけが残る（梁芯が並ばない）');
});

test('【旧データ限定・種別ベースへ統一】followWallBeamAxes: toに{labeled:true, discipline:ARCH}（種別center。通り芯でも梁芯でもない旧データ）があっても重複ガードに引っかからず追従する——移行前はcl.labeledで一致しskipped:\'duplicate\'にしていた', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2060, { labeled: true, discipline: Discipline.ARCH }); // 種別center・旧データ
  const { moved, skipped } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(skipped, [],
    '種別ベース（tier:primary=[struct,beam]）は中心線を重複ガードの対象にしないため追従する（移行前はcl.labeledで一致しskipped:duplicateにしていた）');
  assert.equal(moved.length, 1);
  assert.equal(beamCL.value, 2060);
});

test('followWallBeamAxes: excludedWallBeamAxesの旧キーが新キーへ張り替わる', () => {
  const graph = makeGraph();
  addFuseCL(graph, 2045);
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, 2045));
  followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2045)), false);
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2060)), true);
});

test('followWallBeamAxes: 旧キーが無ければ新キーも追加しない（除外指定の無い梁芯は無指定のまま追従する）', () => {
  const graph = makeGraph();
  addFuseCL(graph, 2045);
  followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.equal(graph.excludedWallBeamAxes.size, 0);
});

test('【失敗系・孤児は撤去しない裁定】followWallBeamAxes: fromに壁由来梁芯が無ければ何もしない（moved/skippedとも空）', () => {
  const graph = makeGraph();
  const { moved, skipped, undoFns, redoFns } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(skipped, []);
  assert.deepEqual(undoFns, []);
  assert.deepEqual(redoFns, []);
});

test('followWallBeamAxes: undoで値と除外キーが戻り、redoで再度反映される', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, 2045));

  const { undoFns, redoFns } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.equal(beamCL.value, 2060);
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2060)), true);

  undoFns.forEach(fn => fn());
  assert.equal(beamCL.value, 2045, 'undoで値が旧座標へ戻る');
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2045)), true, 'undoで除外キーも旧座標へ戻る');
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2060)), false);

  redoFns.forEach(fn => fn());
  assert.equal(beamCL.value, 2060, 'redoで値が新座標へ戻る');
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2060)), true);
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2045)), false);
});

test('followWallBeamAxes: 複数moveのうち一部が重複ガードでスキップされても、他は正常に追従する', () => {
  const graph = makeGraph();
  const beamA = addFuseCL(graph, 2045);
  const beamB = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  addFuseCL(graph, 2060); // beamAの移動先(2060)に既に別の梁芯がある→beamAはスキップ

  const { moved, skipped } = followWallBeamAxes(graph, [
    { axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 },
    { axisCLId: 'ax2', isVertical: true, from: 3000, to: 3100 },
  ]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].from, 2045);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].clId, beamB.id);
  assert.equal(beamA.value, 2045, 'スキップされた方は書き換わらない');
  assert.equal(beamB.value, 3100, 'スキップされなかった方は追従する');
});
