// 柱貫通（変更B）: 下階編集経路（recomputeStructuralComposition の belowGraph 分岐。structuralOrchestration.js の
// autoFillColumnsForStructure(belowGraph, …)）の結果テスト。配線テスト（roofColumnThrough.test.js）だけでは、フィルタの
// 渡し忘れを「結果」で検出できないため。peek は本番同型（serializeGraph したバイト列から restoreGraph で復元した別インスタンス）。
// 通り芯は project.structGraph に置く（各階の graph に直に置くと、復元したコピーのフットプリントが空になりゲートが null に
// 落ちて空振りする）。モジュールスコープのキャッシュを持つ floorSwapManager を差し替えるため専用ファイルに置く。
// 判定は真偽値の assert（Column と undefined を assert.equal で比べると、失敗時の差分表示で RangeError になる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature } from '../core.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { recomputeStructuralComposition } from './structuralOrchestration.js';
import { autoFillColumns } from './structuralAutoFill.js';
import { footprintCellKeys } from './wallGate.js';

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const S = 4000;
const ROOF = [[0, 0], [1, 0], [0, 1], [1, 1]];
const ROOF_ONLY = [[0, 0], [4000, 0], [0, 4000], [4000, 4000]];

function layout(graph, roofCells, through, xs, ys) {
  const key = ([i, j]) => `${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`;
  const roofSet = new Set(roofCells.map(c => c.join(',')));
  const all = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) all.push([i, j]);
  graph.addRoom(new Set(all.filter(c => !roofSet.has(c.join(','))).map(key)), '居間');
  const room = graph.addRoom(new Set(roofCells.map(key)), '屋根');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.ROOF);
  room.setRoofSpec(createLeanToRoofSpec());
  if (through) room.roofSpec.setField('columnThrough', true);
  return room;
}

// 1階（編集される下階）も2階（主題階）も同じ配置: 屋根の 2×2 ブロック＋屋内。1階の屋根の部屋の columnThrough だけ through で変える。
function build(through, carry) {
  const project = new Project('p', 't');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  project.activePlaneId = 'p2';
  project.structuralInfo.mainStructure = 'S造';
  const xs = [0, 1, 2, 3].map(i => project.structGraph.addCenterLine(CenterLineType.VERTICAL, i * S, STRUCT));
  const ys = [0, 1, 2, 3].map(j => project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, j * S, STRUCT));
  const roof1 = layout(g1, ROOF, through, xs, ys);
  layout(g2, ROOF, false, xs, ys);
  if (carry) autoFillColumns(g1, project, null); // 屋根にする前に立っていた柱の持ち越し（全交点）
  return { project, g1, g2, roof1 };
}

async function run({ project, g1, g2 }) {
  const origPeek = floorSwapManager.peek;
  const origFlush = floorSwapManager.flushEditablePeek;
  floorSwapManager.peek = async (plane) => {
    const live = project.graphMap.get(plane.id);
    if (!live) return null;
    const copy = new PlanGraph(plane);
    copy._structGraph = project.structGraph;
    restoreGraph(copy, serializeGraph(live)); // 本番同型: 保存→復元した別インスタンス
    return copy;
  };
  floorSwapManager.flushEditablePeek = async () => {};
  try {
    await recomputeStructuralComposition({ graphForCategory: () => g1 }, g2, project, { mutate: () => {} });
  } finally {
    floorSwapManager.peek = origPeek;
    floorSwapManager.flushEditablePeek = origFlush;
  }
}

const hasColAt = (g, x, y) => g.columns.some(c => c.verticalCL.value === x && c.horizontalCL.value === y);

function assertPremises(d) {
  assert.ok(d.roof1.roofSpec, '前提: 1階に屋根の部屋がある');
  assert.ok(d.g1.rooms.some(r => r.feature === RoomFeature.ROOF), '前提: 屋根の部屋');
  assert.ok(footprintCellKeys(d.g1).size > 0, '前提: 1階のフットプリントが空でない（空だとゲートが null に落ちて空振りする）');
}

test('【下階経路】オン: 柱0本から始めて、下階（1階）の屋根セルにしか接しない4交点にも柱が立つ', async () => {
  const d = build(true, false);
  assertPremises(d);
  assert.equal(d.g1.columns.length, 0, '前提: 柱0本');
  await run(d);
  assert.ok(d.g1.columns.length > 0, '前提: 下階経路で柱が作られた');
  assert.ok(hasColAt(d.g1, 8000, 0) && hasColAt(d.g1, 12000, 12000), '前提: 屋内に触れる交点には立つ');
  for (const [x, y] of ROOF_ONLY) assert.ok(hasColAt(d.g1, x, y), `(${x},${y}) に柱が立つ`);
  assert.equal(d.g1.columns.length, 16);
});

test('【下階経路】オフ: 全交点に持ち越しの柱がある状態から、屋根セルにしか接しない4交点の柱が撤去される', async () => {
  const d = build(false, true);
  assertPremises(d);
  assert.equal(d.g1.columns.length, 16, '前提: 全交点に持ち越しの柱');
  await run(d);
  for (const [x, y] of ROOF_ONLY) assert.equal(hasColAt(d.g1, x, y), false, `(${x},${y}) は撤去`);
  assert.ok(hasColAt(d.g1, 8000, 0), '屋内に触れる交点の柱は残る');
  assert.equal(d.g1.columns.length, 12);
});
