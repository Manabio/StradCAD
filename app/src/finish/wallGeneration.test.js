// applyBackingOwnership（core.jsリファクタ: 仕上げ面が向く側導出のWall.faceDir集約）の回帰テスト。
// setOwnerFields=true 経路の finishSide 書き換えは Wall.faceDir（finishSide優先／axisOffsetの
// naiveな符号はfallback）を経由するが、dirの向きを取り違えても270件全緑で通過してしまう穴が
// あった（QA指摘）。この穴を塞ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph, Plane, CenterLineType, Discipline } from '@core';
import { applyBackingOwnership } from './wallGeneration.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addWall(graph, axisOffset, props) {
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, axisOffset, false, clStart, 0, clEnd, 0, props);
}

test('applyBackingOwnership: setOwnerFields=trueでも確定済みのfinishSideを書き換えない（axisOffsetのnaiveな符号と食い違うCL偏芯壁）', () => {
  const graph = makeGraph();
  // axisOffset=-75(負) だが finishSide=1 明示 → naiveなsign(axisOffset)=-1 とは食い違う。
  const owner = addWall(graph, -75, { wallFinish: 12.5, finishSide: 1 });

  applyBackingOwnership(graph, [owner], [], { setOwnerFields: true });

  assert.equal(owner.finishSide, 1, '既に確定済みのfinishSideはnaiveなsign(axisOffset)=-1へ書き換わらないはず');
});

// ---- 【失敗系】wallFinish===null（生成時確定値の無い手動壁）はsetOwnerFieldsの対象外 ----
test('【失敗系】applyBackingOwnership: wallFinish===null（手動壁）は早期continueされfinishSide/backingDepthが不変のまま', () => {
  const graph = makeGraph();
  const manualWall = addWall(graph, -75, { wallFinish: null, finishSide: null, backingDepth: 999 });

  applyBackingOwnership(graph, [manualWall], [], { setOwnerFields: true });

  assert.equal(manualWall.finishSide, null, '手動壁はcontinueされfinishSideが書き換わらないはず');
  assert.equal(manualWall.backingDepth, 999, '手動壁はcontinueされbackingDepthも書き換わらないはず');
});
