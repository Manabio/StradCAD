// wallGate.js のテスト（A-1: フットプリント境界での分割。中点判定の粒度依存の解消）。
// 既存の spanInBuilding／intersectionInBuilding は主に structuralAutoFill.test.js・woodAutoFill.test.js
// が手作りのモックゲート経由で間接的にカバーしているため、本ファイルは実 core.js（Plane/PlanGraph/Room）
// を使い、buildSelfFootprintGate が組み立てる「本物のゲート」と footprintBreakCLs／spanPointInBuilding を
// 直接検証する（wallBeamAxes.test.js と同じ「実挙動を再現できないダックタイピングは使わない」方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { buildSelfFootprintGate, footprintBreakCLs } from './wallGate.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

// 2部屋（ともにINTERIOR）をY方向に積んだグラフ。X:0..2000固定、Y:-1000..1000(room A)・1000..4000(room B)。
// 境界Y=1000は「divider CLの候補ではあるが、両側とも建物内で帰属が変わらない」ケースを作るために置く
// （footprintBreakCLsが候補全部を返すのではなく実際に帰属が変わる境界だけを選別することの検証に使う）。
function makeTwoRoomGraph() {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${yMid.id}`]), 'A');
  graph.addRoom(new Set([`${x0.id}:${yMid.id}:${x1.id}:${y1.id}`]), 'B');
  return { graph, x0, x1, y0, yMid, y1 };
}

test('footprintBreakCLs: 建物外→建物内へ帰属が変わる境界のCLだけを返す（両側とも建物内の候補は含めない）', () => {
  const { graph, x0, y0 } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  assert.ok(gate, '前提: 部屋があるためゲートが構築される');
  // 軸 X=0（垂直）に沿って Y:-5000..2000 の区間。区間内の候補はY=-1000(外→内)・Y=1000(内→内)の2本
  // （Y=4000は区間の端hiより外なので候補に含まれない＝dividerCLsBetweenの開区間仕様）。
  const breaks = footprintBreakCLs(gate, graph, x0, true, -5000, 2000);
  assert.equal(breaks.length, 1, 'Y=1000（両側とも建物内）は帰属が変わらないため含めない');
  assert.equal(breaks[0], y0, 'Y=-1000（外→内の境界）だけを返す');
});

test('footprintBreakCLs: gate=nullは常に空配列', () => {
  const { graph, x0 } = makeTwoRoomGraph();
  // 【QA指摘2026-09-19】entityの配列を deepEqual(..., []) で比較すると、失敗時にnode:assertがCL実体
  // （graph・他CLへの参照を持つMobXグラフ）を丸ごと差分表示しようとしヒープを圧迫する——.lengthで比較する。
  assert.equal(footprintBreakCLs(null, graph, x0, true, -5000, 2000).length, 0);
});

test('【失敗系】footprintBreakCLs: 区間が完全に建物内（room A内部のみ）なら候補CLが無く空配列', () => {
  const { graph, x0 } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  assert.equal(footprintBreakCLs(gate, graph, x0, true, -1000, 1000).length, 0);
});

test('【失敗系】footprintBreakCLs: 区間が完全に建物外なら候補CLが無く空配列', () => {
  const { graph, x0 } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  assert.equal(footprintBreakCLs(gate, graph, x0, true, -9000, -6000).length, 0);
});

test('spanInBuilding は spanPointInBuilding（区間中点）へ委譲する（判定式の二重化なし）', () => {
  const { graph, x0, y0, yMid } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  const mid = (y0.value + yMid.value) / 2;
  assert.equal(gate.spanInBuilding(x0, true, y0, yMid), gate.spanPointInBuilding(x0, true, mid));
  assert.equal(gate.spanPointInBuilding(x0, true, mid), true, '前提: room A内部の中点は建物内');
});
