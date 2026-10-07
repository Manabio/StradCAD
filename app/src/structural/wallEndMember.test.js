// wallEndMember.js（腰壁・垂れ壁の自由端に立つ端部材の導出）の単体テスト。
// woodAutoFill.test.js と同じく実 core.js（Plane/PlanGraph/Wall）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, StairType, CenterLineType, Discipline, edgeKey } from '../core.js';
import { kneeDropEndMembers, stairPartitionEndMembers, allEndMembers } from './wallEndMember.js';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { PARTITION_BACKING_MM } from '../finish/stair/stairPartition.js';
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

// ---- 折返し階段の隔て壁の端部材（stairPartitionEndMembers / allEndMembers）----
// フィクスチャは finish/stair/stairPartitionWalls.test.js の makeStair/EQUAL_UP と同じ構成
// （軸 x=1000・区間 y1000〜4000）を generateStairPartitionWalls の本番生成で作る。
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

function makePartitionGraph(structure = TRADITIONAL_WOOD_STRUCTURE, rects = EQUAL_UP) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v);
  const H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up' });
  const [owner, thin] = generateStairPartitionWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE });
  graph.structureOverride = structure;
  return { graph, owner, thin };
}

test('stairPartitionEndMembers: 隔て壁のオーナー壁の両端（区間の内側 lo+45 / hi−45・幅90・mode=partition）に出る。薄壁には出ない', () => {
  const { graph, owner, thin } = makePartitionGraph();
  assert.equal(owner.backingDepth, PARTITION_BACKING_MM);
  const members = stairPartitionEndMembers(graph, PROJECT);
  assert.equal(members.size, 1);
  assert.deepEqual(members.get(owner.id), [
    { along: 1045, widthMm: 90, mode: 'partition', heightMm: null },
    { along: 3955, widthMm: 90, mode: 'partition', heightMm: null },
  ]);
  assert.equal(members.has(thin.id), false);
});

test('【失敗系】stairPartitionEndMembers: 180mm未満の区間・非在来・隔て壁でない壁（通常の下地壁）は空', () => {
  const short = makePartitionGraph(TRADITIONAL_WOOD_STRUCTURE, [[0, 0, 2000, 1000], [0, 1000, 1000, 1150], [1000, 1000, 2000, 1150]]);
  assert.equal(short.owner.backingDepth, PARTITION_BACKING_MM, '対照: 短い区間でもオーナー壁は生成される');
  assert.equal(stairPartitionEndMembers(short.graph, PROJECT).size, 0, '180mm未満は2本が重なるので出さない');

  const steel = makePartitionGraph('S造');
  assert.equal(stairPartitionEndMembers(steel.graph, PROJECT).size, 0, '非在来は空');

  const g = makeWoodGraph();
  const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  addBackingWall(g, { axisValue: 0, clStart: x0, clEnd: x1, isVertical: false });
  assert.equal(stairPartitionEndMembers(g, PROJECT).size, 0, '階段が無ければ空');
});

test('【失敗系】stairPartitionEndMembers: 隔て壁の線上にない下地深さ90の部屋壁には出ない（形だけ同じ壁を拾わない）', () => {
  const { graph, owner } = makePartitionGraph();
  const mkCL = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const axis = mkCL(CenterLineType.VERTICAL, 5000);
  const y0 = mkCL(CenterLineType.HORIZONTAL, 0), y3 = mkCL(CenterLineType.HORIZONTAL, 3000);
  const other = graph.addWall(axis, 57.5, true, y0, 0, y3, 0,
    { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: PARTITION_BACKING_MM, finishSide: 1 });
  assert.equal(other.backingDepth, PARTITION_BACKING_MM, '対照: 隔て壁と同じ形（線だけ違う）');
  const members = stairPartitionEndMembers(graph, PROJECT);
  assert.equal(members.size, 1);
  assert.equal(members.has(owner.id), true);
  assert.equal(members.has(other.id), false);
});

test('allEndMembers: 腰壁の自由端の端部材と隔て壁の端部材が壁idごとに両方入る・隔て壁は自由端（構造柱の点源）に現れない', () => {
  const { graph, owner } = makePartitionGraph();
  const a0 = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const a1 = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: true, discipline: Discipline.STRUCT });
  const hw = addBackingWall(graph, { axisValue: 9000, clStart: a0, clEnd: a1, isVertical: false });
  graph.setKneeDropWall(edgeKey(hw.axisCL.id, a0.id, a1.id), { knee: { topHeight: 900 } });
  const all = allEndMembers(graph, PROJECT);
  assert.equal(all.size, 2);
  assert.deepEqual(all.get(owner.id).map(e => e.mode), ['partition', 'partition']);
  assert.deepEqual(all.get(hw.id).map(e => e.mode), ['knee', 'knee']);
  // 隔て壁の端は selfWallSegments（構造の壁ソース）に入らないので自由端にならず、柱とも二重にならない
  const freeAlongOwnerAxis = wallRunFreeEnds(selfWallSegments(graph)).filter(fe => fe.x === 1000 || fe.y === 1000);
  assert.equal(freeAlongOwnerAxis.length, 0);
});
