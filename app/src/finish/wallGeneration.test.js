// applyBackingOwnership（core.jsリファクタ: 仕上げ面が向く側導出のWall.faceDir集約）の回帰テスト。
// setOwnerFields=true 経路の finishSide 書き換えは Wall.faceDir（finishSide優先／axisOffsetの
// naiveな符号はfallback）を経由するが、dirの向きを取り違えても270件全緑で通過してしまう穴が
// あった（QA指摘）。この穴を塞ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph, Plane, CenterLineType, Discipline } from '@core';
import { applyBackingOwnership, computeExternalEdgeParams } from './wallGeneration.js';

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


// ---- 同値・別延長のCLがある場合の外周エッジ端点id（問題修正2026-08その9） ----
// externalSubIntervals は「自部屋のセルには現れない区切りCL」も分割候補に足すが、その追加が
// セルキー由来のid（実際にセルを画しているCL＝権威）を value をキーに上書きしていた。値が同じで
// 延長だけ違うCLが2本あると、隅が「その位置には届いていない方」のidを指し、buildRoomFacesの
// チェーン探索（隅をCLのidで辿る）が繋がらなくなる（実機2階の室22で展開図が「Aのみ」になった）。
// 再現には「同値CLの位置を跨ぐセル」（＝そのCLが届かず割れないセル）が要る。
test('computeExternalEdgeParams: 同値で延長の違うCLが2本あっても、端点idは辺の位置に届いている方になる', () => {
  const graph = makeGraph();
  const ARCH = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   3000, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, ARCH);
  // y=2000 に延長の違う2本。左列(x:0..3000)に届くのは yNear、yFar は無関係な右方だけに届く。
  const yNear = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { ...ARCH, extentLo: 0,    extentHi: 3000 });
  const yFar  = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { ...ARCH, extentLo: 5000, extentHi: 7000 });

  // 左列は下半分だけ・右列はy=2000で割れない1枚（＝yNearが届かないため跨ぐ）。
  const room = graph.addRoom(new Set([
    `${x0.id}:${yNear.id}:${x1.id}:${y1.id}`,
    `${x1.id}:${y0.id}:${x2.id}:${y1.id}`,
  ]), 'R');

  const params = computeExternalEdgeParams(room, 1, graph);
  assert.ok(params.some(p => p.isVertical && p.axisCLId === x1.id),
    '前提: 右列の左辺（x=3000）に外周エッジが出る');
  assert.equal(params.filter(p => p.startCLId === yFar.id || p.endCLId === yFar.id).length, 0,
    `端点idに「この辺に届いていない同値CL」が混ざらないはず（実際:${JSON.stringify(params)}）`);
  assert.ok(params.some(p => p.isVertical && p.axisCLId === x1.id &&
    (p.startCLId === yNear.id || p.endCLId === yNear.id)),
    '右列の左辺の分割点はセルを画している側のCL(yNear)を指すはず');
});
