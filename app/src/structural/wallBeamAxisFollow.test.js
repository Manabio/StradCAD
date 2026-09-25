// structural/wallBeamAxisFollow.js（followWallBeamAxes）の単体テスト。
// 壁再生成をFinishModeStateから独立させる計画のステップ2: 下地帯の中心が動いたとき、
// 壁由来の梁芯CL（discipline:fuse）を撤去せず追従させる。
// 追従先に既存の梁芯・通り芯がある場合の重複ガードは、案B（ユーザー裁定・2026-09-26）で
// 「保護されなければ旧梁芯を吸収して撤去する」に変わった（旧: 常にskipして旧を残す）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
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

// ---- 案B（ユーザー裁定・2026-09-26）: 追従先に既存の梁芯・通り芯があるとき、保護されない旧梁芯は
// 吸収して撤去する（相手はそのまま残す。乗っていたauto柱・梁も道連れ）----

test('【案B】followWallBeamAxes: toに既に別の壁由来梁芯があり旧が保護されなければ、旧を吸収して撤去する（乗っていたauto柱も道連れ）。undoで同idで戻る', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  const beamCLId = beamCL.id;
  const anchorBeam = addFuseCL(graph, 2060); // 新座標に既に別の梁芯（相手）
  const column = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH }), beamCL); // dimensionStatus省略→既定'auto'
  const columnId = column.id;

  const { moved, skipped, absorbed, undoFns, redoFns } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(skipped, []);
  assert.equal(absorbed.length, 1);
  assert.equal(absorbed[0].clId, beamCLId);
  assert.equal(graph.shapeMap.has(beamCLId), false, '旧梁芯は撤去されるはず');
  assert.equal(graph.columnMap.has(columnId), false, '旧梁芯に乗っていたauto柱も道連れで消えるはず');
  assert.equal(graph.shapeMap.has(anchorBeam.id), true, '相手（既存の梁芯）はそのまま残る');

  undoFns.forEach(fn => fn());
  assert.equal(graph.shapeMap.get(beamCLId)?.id, beamCLId, 'undoで同じidの旧梁芯が戻るはず');
  // 道連れで消えたauto柱自体はここでは個別復元しない（次の構造同期が作り直す原則。設計コメント参照）。

  redoFns.forEach(fn => fn());
  assert.equal(graph.shapeMap.has(beamCLId), false, 'redoで再び撤去されるはず');
});

test('【案B】followWallBeamAxes: toに通り芯があり旧が保護されなければ、旧を吸収して撤去する。undoで同idで戻る（相手の通り芯はそのまま残る）', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  const beamCLId = beamCL.id;
  const gridCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2060, { labeled: true, discipline: Discipline.STRUCT }); // 通り芯（相手）

  const { moved, skipped, absorbed, undoFns } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(skipped, []);
  assert.equal(absorbed.length, 1);
  assert.equal(graph.shapeMap.has(beamCLId), false, '旧梁芯は撤去されるはず');
  const clsAt2060 = graph.centerLines.filter(cl => Math.abs(cl.value - 2060) < 1);
  assert.deepEqual(clsAt2060.map(cl => cl.id), [gridCL.id], 'to位置には通り芯1本だけが残る（旧梁芯は消え、相手の通り芯は動かさない）');

  undoFns.forEach(fn => fn());
  assert.equal(graph.shapeMap.get(beamCLId)?.id, beamCLId, 'undoで同じidの旧梁芯が戻るはず');
});

test('【案B・保護】followWallBeamAxes: 旧にlocked部材（dimensionStatus!==auto）が乗ればskipして残る', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  const beamCLId = beamCL.id;
  addFuseCL(graph, 2060); // 相手
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, beamCL, { dimensionStatus: 'locked' }); // 手動固定

  const { moved, skipped, absorbed } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(absorbed, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'duplicate');
  assert.equal(graph.shapeMap.has(beamCLId), true, 'lockedの柱が乗る旧梁芯は撤去しない（ユーザー確定値の保護）');
  assert.equal(beamCL.value, 2045, '保護されたので値も書き換わらない');
});

test('【案B・保護】followWallBeamAxes: 旧がrefIdを持てばskipして残る（手動追加の可能性がある線は吸収しない）', () => {
  const graph = makeGraph();
  const parent = graph.addCenterLine(CenterLineType.HORIZONTAL, 2045, { labeled: false, discipline: Discipline.ARCH });
  const beamCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2045, { labeled: false, discipline: Discipline.FUSE, refId: parent.id, refOffset: 0 });
  const beamCLId = beamCL.id;
  addFuseCL(graph, 2060); // 相手

  const { moved, skipped, absorbed } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(absorbed, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'duplicate');
  assert.equal(graph.shapeMap.has(beamCLId), true, 'refIdを持つ旧梁芯は撤去しない');
});

test('【旧データ限定・種別ベースへ統一】followWallBeamAxes: toに{labeled:true, discipline:ARCH}（種別center。通り芯でも梁芯でもない旧データ）があっても重複ガードに引っかからず追従する——移行前はcl.labeledで一致しskipped:\'duplicate\'にしていた', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2060, { labeled: true, discipline: Discipline.ARCH }); // 種別center・旧データ
  const { moved, skipped, absorbed } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(skipped, [],
    '種別ベース（tier:primary=[struct,beam]）は中心線を重複ガードの対象にしないため追従する（移行前はcl.labeledで一致しskipped:duplicateにしていた）');
  assert.deepEqual(absorbed, []);
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

test('【案B】followWallBeamAxes: 吸収（撤去）した場合はexcludedWallBeamAxesに一切触れない（既存の除外指定もそのまま残る）', () => {
  const graph = makeGraph();
  const beamCL = addFuseCL(graph, 2045);
  addFuseCL(graph, 2060); // 相手
  graph.excludedWallBeamAxes.add(wallBeamAxisExcludeKey(false, 2045)); // 呼び出し前から既にあった除外指定

  const { absorbed } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.equal(absorbed.length, 1);
  assert.equal(graph.shapeMap.has(beamCL.id), false);
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2045)), true, '触れないので既存の除外指定はそのまま残る');
  assert.equal(graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(false, 2060)), false, '新座標のキーは追加しない（相手のCLがある座標であり、旧CL自体はもう無い）');
});

test('【失敗系・孤児は撤去しない裁定】followWallBeamAxes: fromに壁由来梁芯が無ければ何もしない（moved/skippedとも空）', () => {
  const graph = makeGraph();
  const { moved, skipped, absorbed, undoFns, redoFns } = followWallBeamAxes(graph, [{ axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 }]);
  assert.deepEqual(moved, []);
  assert.deepEqual(skipped, []);
  assert.deepEqual(absorbed, []);
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

test('followWallBeamAxes: 複数moveのうち一部が吸収（案B）されても、他は正常に追従する', () => {
  const graph = makeGraph();
  const beamA = addFuseCL(graph, 2045);
  const beamAId = beamA.id;
  const beamB = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  addFuseCL(graph, 2060); // beamAの移動先(2060)に既に別の梁芯がある→beamAは保護されないため吸収される

  const { moved, skipped, absorbed } = followWallBeamAxes(graph, [
    { axisCLId: 'ax1', isVertical: false, from: 2045, to: 2060 },
    { axisCLId: 'ax2', isVertical: true, from: 3000, to: 3100 },
  ]);
  assert.deepEqual(skipped, []);
  assert.equal(absorbed.length, 1);
  assert.equal(absorbed[0].from, 2045);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].clId, beamB.id);
  assert.equal(graph.shapeMap.has(beamAId), false, '吸収された方は撤去される');
  assert.equal(beamB.value, 3100, '吸収されなかった方は追従する');
});
