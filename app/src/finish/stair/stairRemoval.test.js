// finish/stair/stairRemoval.js（階段削除の単階本体と、上の階への連動の計画）の単体テスト。
// 前提は実際の経路で作る（applyNaming で階段を指定→syncUpperFloors で上の階へ展開。peek・保存は本番同型の
// 保存バイト列。上の階は復号したグラフに対して検証する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature, RoomKind } from '@core';
import { serializeGraph } from '../../graphSnapshot.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../equipment/equipmentTestFixtures.js';
import { roomBounds } from '../gridCells.js';
import { FinishModeState } from '../../modes/FinishModeState.js';
import { findUnderStairSplitCLs, ensureUnderStairSplit } from './stairUnderSplit.js';
import { syncUpperFloors } from './stairFloorSync.js';
import {
  removeStairOnFloor, findSameFootprintStair, isContinuationStair,
  planStairRemovalCascade, applyStairRemovalToFloor,
} from './stairRemoval.js';
import { setupProject, addPerFloorV, placeStair, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';

// n 階建て・全階 x=500 の per-floor 中心線・1階に階段を指定→上の階へ展開。
// 戻り値の floors は [1階(生きたグラフ), 2階(復号), 3階(復号)...]。
async function expanded(n, opts) {
  const { project, graphs } = setupProject(n);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const { stair, room } = placeStair(project, g1, opts);
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store) });
  const floors = project.planes.map((p, i) => (i === 0 ? { plane: p, graph: g1 } : { plane: p, graph: decodeFloor(project, p, store.get(p.id)) }));
  return { project, floors, stair, room, structGraph: project.structGraph };
}
const cascade = ({ project, floors, stair }) => planStairRemovalCascade({
  structGraph: project.structGraph, activeGraph: floors[0].graph, stair, uppers: floors.slice(1),
});

// ---- removeStairOnFloor ----

test('removeStairOnFloor: 屋内階段はペアRoomを未定義化（外形を保つ）して階段を消す', async () => {
  const { floors, stair, room } = await expanded(1);
  const g = floors[0].graph;
  // 直進階段は階段下の分割CLも戻るため、セルキーは粗くなりうる——外形（包絡）で保たれることを見る
  const boundsBefore = roomBounds(room.cells, g);
  const r = removeStairOnFloor(g, stair);
  assert.equal(r.roomId, room.id);
  assert.equal(g.stairs.length, 0);
  const kept = g.roomMap.get(room.id);
  assert.ok(kept, 'ペアRoomは残る');
  assert.equal(kept.feature, RoomFeature.UNDEFINED);
  assert.ok(kept.cells.size > 0);
  assert.deepEqual(roomBounds(kept.cells, g), boundsBefore, '外形は保たれる');
});

test('removeStairOnFloor: 屋外階段はペアRoomを削除し、連動する外部仕上げ行も消える', async () => {
  const { floors, stair, room } = await expanded(1, { kind: RoomKind.EXTERIOR });
  const g = floors[0].graph;
  assert.equal(room.kind, RoomKind.EXTERIOR, '前提: 屋外');
  if (!g.exteriorRows.some(r => r.roomId === room.id)) g.addExteriorRow('exteriorRows', '階段', room.id);
  assert.ok(g.exteriorRows.some(r => r.roomId === room.id), '前提: 外部仕上げ行がある');
  removeStairOnFloor(g, stair);
  assert.equal(g.roomMap.has(room.id), false, '屋外のペアRoomは削除される');
  assert.equal(g.exteriorRows.some(r => r.roomId === room.id), false, '外部仕上げ行も消える');
  assert.equal(g.stairs.length, 0);
});

test('removeStairOnFloor: 直進階段の階段下の分割CLが指定ごと戻る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const arch = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, arch);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, arch);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, arch);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, arch);
  const stair = graph.addStair({ type: StairType.STRAIGHT, cells: new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), upDirection: 'up' });
  ensureUnderStairSplit(stair, graph, null);
  assert.equal(findUnderStairSplitCLs(stair, graph).length, 1, '前提: 分割CLがある');
  const clCount = graph.centerLines.length;
  removeStairOnFloor(graph, stair);
  assert.equal(graph.centerLines.length, clCount - 1, '分割CLが取り除かれる');
  assert.equal(graph.stairs.length, 0);
});

test('【失敗系】removeStairOnFloor: ペアRoomを持たない階段（旧データ）でも例外なく階段だけ消える', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const stair = graph.addStair({ type: StairType.STRAIGHT, cells: new Set(), upDirection: 'up' });
  assert.deepEqual(removeStairOnFloor(graph, stair), { roomId: null });
  assert.equal(graph.stairs.length, 0);
});

test('FinishModeState.deleteStair: removeStairOnFloor への委譲後も、選択のクリアと未定義化はモード側が行う', async () => {
  const { project, floors, stair, room } = await expanded(1);
  const g = floors[0].graph;
  const state = new FinishModeState(g, project);
  state.selectedStairId = stair.id;
  state.selectedRoomId = room.id;
  state.namingRoomId = room.id;
  state.deleteStair(stair.id);
  assert.equal(g.stairs.length, 0);
  assert.equal(g.roomMap.get(room.id)?.feature, RoomFeature.UNDEFINED);
  assert.equal(state.selectedStairId, null);
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.namingRoomId, null);
});

// ---- findSameFootprintStair / isContinuationStair ----

test('isContinuationStair: 直下階に同 footprint の階段がある（上の階の自動設置分）→真、設置階の階段→偽（直下なし）', async () => {
  const ctx = await expanded(3);
  const [f1, f2, f3] = ctx.floors;
  const s2 = f2.graph.stairs[0];
  assert.ok(s2, '前提: 2階に階段が展開されている');
  assert.equal(isContinuationStair(s2, f2.graph, f1.graph, ctx.structGraph), true);
  assert.equal(findSameFootprintStair(s2, f2.graph, ctx.structGraph, f1.graph)?.id, ctx.stair.id, '下→上向きの逆（上→下）でも写せる');
  assert.equal(findSameFootprintStair(ctx.stair, f1.graph, ctx.structGraph, f2.graph)?.id, s2.id, '下→上');
  assert.equal(isContinuationStair(ctx.stair, f1.graph, null, ctx.structGraph), false, '直下階なし');
  assert.equal(f3.graph.stairs.length, 0, '前提: 最上階は階段でなく吹抜け');
});

test('isContinuationStair: 直下階の階段と一部だけ重なる footprint は偽', async () => {
  const ctx = await expanded(2);
  const [f1, f2] = ctx.floors;
  // 2階（最上階）には階段が無い。2階に置く階段は x=[0,1000]（1階の階段 x=[0,500] を含み、一致はしない）
  const wide = f2.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(f2.graph, LEFT_HALF[0]), keyAt(f2.graph, [750, 500])]), upDirection: 'up' });
  assert.equal(isContinuationStair(wide, f2.graph, f1.graph, ctx.structGraph), false);
});

test('【失敗系】isContinuationStair: 直下階へ写せない（直下階に対応する中心線が無い）→偽', async () => {
  const ctx = await expanded(3);
  const [, f2] = ctx.floors;
  const s2 = f2.graph.stairs[0];
  assert.ok(s2, '前提: 2階に階段がある（上の階の自動設置分）');
  const empty = decodeFloor(ctx.project, ctx.floors[0].plane, undefined); // per-floor 中心線も階段も無い1階
  assert.equal(isContinuationStair(s2, f2.graph, empty, ctx.structGraph), false);
});

// ---- planStairRemovalCascade ----

test('planStairRemovalCascade: 3階建て→2階の階段と3階の階段吹抜けを拾う（階段吹抜けは階段なしの最終段）', async () => {
  const ctx = await expanded(3);
  const t = cascade(ctx);
  assert.equal(t.length, 2);
  assert.equal(t[0].plane.id, 'p2');
  assert.equal(t[0].stair?.id, ctx.floors[1].graph.stairs[0].id);
  assert.equal(t[0].voidRoom, null);
  assert.equal(t[1].plane.id, 'p3');
  assert.equal(t[1].stair, null);
  assert.equal(t[1].voidRoom?.feature, RoomFeature.STAIR_VOID);
});

test('planStairRemovalCascade: 2階建て→最上階の階段吹抜けだけを拾う', async () => {
  const ctx = await expanded(2);
  const t = cascade(ctx);
  assert.equal(t.length, 1);
  assert.equal(t[0].stair, null);
  assert.equal(t[0].voidRoom?.feature, RoomFeature.STAIR_VOID);
});

test('planStairRemovalCascade: 途中の階で階段が欠けていれば、そこで打ち切る（その上の階は拾わない）', async () => {
  const ctx = await expanded(4);
  const f3 = ctx.floors[2].graph;
  f3.removeStair(f3.stairs[0].id); // 3階の階段が欠ける（4階の吹抜けはあるが連鎖が切れている）
  const t = cascade(ctx);
  assert.deepEqual(t.map(x => x.plane.id), ['p2']);
  assert.ok(ctx.floors[3].graph.rooms.some(r => r.feature === RoomFeature.STAIR_VOID), '前提: 4階に吹抜けは残っている');
});

test('planStairRemovalCascade: 最上階に残った同位置の階段も拾う', async () => {
  const ctx = await expanded(2);
  const top = ctx.floors[1].graph;
  for (const r of top.rooms.filter(x => x.feature === RoomFeature.STAIR_VOID)) top.removeRoom(r.id);
  const stray = top.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(top, LEFT_HALF[0])]), upDirection: 'up' });
  const t = cascade(ctx);
  assert.equal(t.length, 1);
  assert.equal(t[0].stair?.id, stray.id);
});

test('planStairRemovalCascade: 屋外階段の3階建て→2階の階段だけ（最上階に吹抜けは無い）', async () => {
  const ctx = await expanded(3, { kind: RoomKind.EXTERIOR });
  const t = cascade(ctx);
  assert.deepEqual(t.map(x => [x.plane.id, !!x.stair, !!x.voidRoom]), [['p2', true, false]]);
});

test('【失敗系】planStairRemovalCascade: 上の階に同 footprint が無ければ空', async () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const { stair } = placeStair(project, graphs[0]); // 展開（syncUpperFloors）をしない
  const t = planStairRemovalCascade({
    structGraph: project.structGraph, activeGraph: graphs[0], stair,
    uppers: [{ plane: graphs[1].plane, graph: graphs[1] }],
  });
  assert.deepEqual(t, []);
});

// ---- applyStairRemovalToFloor ----

test('applyStairRemovalToFloor: 中間階は階段を消してペアRoomを未定義化、最上階は階段吹抜けを未定義化', async () => {
  const ctx = await expanded(3);
  const t = cascade(ctx);
  const [, g2, g3] = ctx.floors.map(f => f.graph);
  const pairId = g2.stairs[0].roomId;
  assert.equal(applyStairRemovalToFloor(g2, t[0]), true);
  assert.equal(applyStairRemovalToFloor(g3, t[1]), true);
  assert.equal(g2.stairs.length, 0);
  assert.equal(g2.roomMap.get(pairId)?.feature, RoomFeature.UNDEFINED);
  assert.equal(g3.rooms.some(r => r.feature === RoomFeature.STAIR_VOID), false);
  assert.equal(g3.rooms.filter(r => r.feature === RoomFeature.UNDEFINED).length, 1);
  assert.equal(applyStairRemovalToFloor(g3, { stair: null, voidRoom: null }), false, '対象が空なら何もしない');
});
