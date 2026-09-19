// wallEndMember.js（腰壁・垂れ壁の自由端に立つ端部材の導出）の単体テスト。
// woodAutoFill.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '../core.js';
import { kneeDropEndMembers } from './wallEndMember.js';
import { selfWallFreeEnds } from './wallFreeEnds.js';
import { wallRunFreeEnds } from './woodFraming.js';
import { selfWallSegments } from './wallBeamAxes.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';

// woodAutoFill.test.js の addBackingWall と同じ。
function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical, bandOffset = null }) {
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axisValue, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, bandOffset });
}

function makeWoodGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  return graph;
}

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };

test('kneeDropEndMembers: 腰壁の辺の自由端に端部材（along=設計上の端・widthMm=階の柱寸120・mode=knee・heightMm=topHeight）が出る', () => {
  const graph = makeWoodGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1000, isVertical: true }); // 縦壁 x=0（下端(0,0)は指定なしの自由端）
  const hWall = addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false }); // 横壁 y=1000（右端(1000,1000)が腰壁）
  graph.setKneeDropWall(edgeKey(hWall.axisCL.id, x0.id, x1000.id), { knee: { topHeight: 900 } });

  const members = kneeDropEndMembers(graph, PROJECT);
  assert.equal(members.size, 1, '腰壁の辺を持つ壁1本だけがエントリを持つ');
  assert.deepEqual(members.get(hWall.id), [{ along: 1000, widthMm: 120, mode: 'knee', heightMm: 900 }]);
});

test('kneeDropEndMembers: 垂れ壁の辺の自由端にmode=dropの端部材が出る（heightMm=bottomHeight）', () => {
  const graph = makeWoodGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // 縦壁 x=0（y:0..1000）の上端(0,1000)は横壁との交点（T字）のため自由端ではない——自由端は
  // 下端(0,0)。垂れ壁指定は壁の全スパン[0,1000]を覆うため、この自由端も垂れ壁の辺として拾われる。
  const vWall = addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1000, isVertical: true });
  addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false });
  graph.setKneeDropWall(edgeKey(vWall.axisCL.id, y0.id, y1000.id), { drop: { bottomHeight: 1200 } });

  const members = kneeDropEndMembers(graph, PROJECT);
  assert.deepEqual(members.get(vWall.id), [{ along: 0, widthMm: 120, mode: 'drop', heightMm: 1200 }]);
});

test('【失敗系】kneeDropEndMembers: 腰壁・垂れ壁指定の無い自由端には出ない・非在来は空Map', () => {
  const graph = makeWoodGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1000, isVertical: true });
  addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false });
  assert.equal(kneeDropEndMembers(graph, PROJECT).size, 0, '腰壁・垂れ壁の指定が無ければ端部材は出ない');

  // 非在来（S造）は同じ壁配置・同じ指定があっても空Map。
  const steel = new PlanGraph(new Plane('p2', 0, '1階', 1, 1));
  steel.structureOverride = 'S造';
  const sx0 = steel.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const sx1000 = steel.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const sy0 = steel.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const sy1000 = steel.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const sHWall = addBackingWall(steel, { axisValue: 1000, clStart: sx0, clEnd: sx1000, isVertical: false });
  steel.setKneeDropWall(edgeKey(sHWall.axisCL.id, sx0.id, sx1000.id), { knee: { topHeight: 900 } });
  addBackingWall(steel, { axisValue: 0, clStart: sy0, clEnd: sy1000, isVertical: true });
  assert.equal(kneeDropEndMembers(steel, PROJECT).size, 0, '非在来（framingを持たない主構造）は空Map');

  // 壁が1本も無い階も空Map（woodAutoFill.jsのF-1と同じ割り切り）。
  const empty = makeWoodGraph();
  assert.equal(kneeDropEndMembers(empty, PROJECT).size, 0);
});

test('不変条件: 自由端全体＝構造柱の点源(selfWallFreeEnds) ∪ 端部材(kneeDropEndMembers)、かつ交わらない', () => {
  const graph = makeWoodGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const x2000 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // 縦壁 x=0（下端(0,0)は指定なし＝構造柱側）。横壁 y=1000, x:0..1000（右端(1000,1000)は腰壁＝端部材側）。
  // さらに横壁 y=1000, x:1200..2000（左端(1200,1000)は手前のrunとの隙間200mm＞WALL_JUNCTION_TOL_MM(150)
  // のため別run＝指定なしの自由端＝構造柱側。右端(2000,1000)も指定なし＝構造柱側）。
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1000, isVertical: true });
  const hWall = addBackingWall(graph, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false });
  graph.setKneeDropWall(edgeKey(hWall.axisCL.id, x0.id, x1000.id), { knee: { topHeight: 900 } });
  const x1200 = graph.addCenterLine(CenterLineType.VERTICAL, 1200, { labeled: false, discipline: Discipline.ARCH });
  addBackingWall(graph, { axisValue: 1000, clStart: x1200, clEnd: x2000, isVertical: false });

  const segments = selfWallSegments(graph);
  const allFreeEnds = wallRunFreeEnds(segments);
  const columnEnds = selfWallFreeEnds(graph, segments);
  const memberEnds = [...kneeDropEndMembers(graph, PROJECT).values()].flat();

  const keyOf = (fe) => `${fe.isVertical}:${Math.round(fe.x)}:${Math.round(fe.y)}`;
  const allKeys = new Set(allFreeEnds.map(keyOf));
  const columnKeys = new Set(columnEnds.map(keyOf));
  // 端部材はalong座標しか持たないため、対応する壁のisVertical/coordから同じキー形式を組み立てる。
  const memberKeys = new Set();
  for (const [wallId, arr] of kneeDropEndMembers(graph, PROJECT)) {
    const wall = graph.walls.find(w => w.id === wallId);
    for (const m of arr) {
      const x = wall.isVertical ? wall.axisCL.effectiveValue : m.along;
      const y = wall.isVertical ? m.along : wall.axisCL.effectiveValue;
      memberKeys.add(`${wall.isVertical}:${Math.round(x)}:${Math.round(y)}`);
    }
  }
  assert.ok(allKeys.size >= 3, '前提: 少なくとも3つの自由端がある');
  // 排他: 交わらない
  for (const k of columnKeys) assert.equal(memberKeys.has(k), false, `構造柱側と端部材側が重複: ${k}`);
  // 網羅: 合わせて全自由端
  const union = new Set([...columnKeys, ...memberKeys]);
  assert.deepEqual([...union].sort(), [...allKeys].sort());
  assert.equal(memberEnds.length, 1, '腰壁指定は1辺だけなので端部材は1件');
});

// QA指摘2026-09-19（Minor-1）: 上の不変条件は「在来木造の呼び出し文脈」でのみ成立する。
// selfWallFreeEnds自体は主構造を見ずに腰壁・垂れ壁指定の自由端を除くため、非在来グラフへ直接呼べば
// kneeDropEndMembers（非在来は空）との間に漏れが生じる——woodAutoFill.js・wallDrawPlan.js が
// どちらも在来木造のときだけ両関数を呼ぶため実害は無いが、コードの挙動としては漏れることを固定する
// （13.stq 2階の自由端(-1500,-3500)相当の実データ形状。腰壁指定つきの非在来自由端）。
test('不変条件はS造など非在来では成立しない（selfWallFreeEndsが主構造を見ずに腰壁指定の自由端を除く一方、kneeDropEndMembersは非在来で空のため両方から漏れる。呼び出し元が在来限定のため実害なし）', () => {
  const steel = new PlanGraph(new Plane('p3', 0, '1階', 1, 1));
  steel.structureOverride = 'S造';
  const x0 = steel.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1000 = steel.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = steel.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1000 = steel.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(steel, { axisValue: 0, clStart: y0, clEnd: y1000, isVertical: true });
  const hWall = addBackingWall(steel, { axisValue: 1000, clStart: x0, clEnd: x1000, isVertical: false });
  steel.setKneeDropWall(edgeKey(hWall.axisCL.id, x0.id, x1000.id), { knee: { topHeight: 900 } });

  const segments = selfWallSegments(steel);
  const allFreeEnds = wallRunFreeEnds(segments);
  const columnEnds = selfWallFreeEnds(steel, segments); // 主構造を見ずに腰壁指定の自由端(1000,1000)を除く
  const memberEnds = [...kneeDropEndMembers(steel, PROJECT).values()].flat();

  assert.equal(memberEnds.length, 0, '非在来（rules.framing無し）はkneeDropEndMembersが常に空');
  assert.ok(allFreeEnds.length > columnEnds.length,
    'S造でも腰壁指定の自由端はselfWallFreeEndsから除かれる（主構造を見ないため）');
  // ↑除かれた自由端(1000,1000)はkneeDropEndMembersにも出ないため、両者を合わせても全自由端には
  // ならない——不変条件はこの非在来のケースでは成立しない（実害は無い。上記コメント参照）。
});
