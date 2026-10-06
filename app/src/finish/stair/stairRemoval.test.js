// finish/stair/stairRemoval.js（階段削除の単階本体と、直上1階への連動の計画）の単体テスト。
// 前提は実際の経路で作る（applyNaming で階段を指定→syncUpperFloors で直上階へ階段吹抜けを展開。peek・保存は
// 本番同型の保存バイト列。上の階は復号したグラフに対して検証する）。
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
  removeStairOnFloor, planStairRemovalCascade, applyStairRemovalToFloor,
} from './stairRemoval.js';
import { setupProject, addPerFloorV, placeStair, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';

// n 階建て・全階 x=500 の per-floor 中心線・1階に階段を指定→直上階へ展開（2階に階段吹抜け）。
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
const voidRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);

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

// ---- planStairRemovalCascade（直上1階の同 footprint の階段吹抜けだけを拾う） ----

test('planStairRemovalCascade: 3階建て→直上の2階の階段吹抜けだけを拾う（3階は対象外）', async () => {
  const ctx = await expanded(3);
  const t = cascade(ctx);
  assert.equal(t.length, 1);
  assert.equal(t[0].plane.id, 'p2');
  assert.equal(t[0].voidRooms.length, 1);
  assert.equal(t[0].voidRooms[0].feature, RoomFeature.STAIR_VOID);
  assert.equal(t[0].stair, undefined, '階段は計画に含めない（直上階の階段は消さない）');
});

test('planStairRemovalCascade: 3階に同 footprint の階段吹抜けがあっても拾わない（N+2 以上は触らない）', async () => {
  const ctx = await expanded(3);
  const top = ctx.floors[2].graph;
  const stray = top.addRoom(new Set([keyAt(top, LEFT_HALF[0])]));
  stray.setFeature(RoomFeature.STAIR_VOID);
  assert.deepEqual(cascade(ctx).map(x => x.plane.id), ['p2']);
});

test('planStairRemovalCascade: 直上階にユーザー指定の階段（同 footprint）があっても消さない。吹抜けが無ければ空', async () => {
  const ctx = await expanded(3);
  const g2 = ctx.floors[1].graph;
  for (const r of voidRooms(g2)) g2.removeRoom(r.id);
  g2.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(g2, LEFT_HALF[0])]), upDirection: 'up' });
  assert.deepEqual(cascade(ctx), []);
});

test('planStairRemovalCascade: 同 footprint の階段吹抜けが複数あれば全部拾う（原子セルへ展開して比較）', async () => {
  const ctx = await expanded(2);
  const g2 = ctx.floors[1].graph;
  const first = voidRooms(g2)[0];
  const dup = g2.addRoom(new Set(first.cells));
  dup.setFeature(RoomFeature.STAIR_VOID);
  const t = cascade(ctx);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].voidRooms.map(r => r.id).sort(), [first.id, dup.id].sort());
});

test('planStairRemovalCascade: 屋外階段（吹抜けを置かない）→空', async () => {
  const ctx = await expanded(3, { kind: RoomKind.EXTERIOR });
  assert.deepEqual(cascade(ctx), []);
});

test('【失敗系】planStairRemovalCascade: 上の階が無い・上の階へ写せない→空', async () => {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const { stair } = placeStair(project, graphs[0]); // 展開（syncUpperFloors）をしない
  const base = { structGraph: project.structGraph, activeGraph: graphs[0], stair };
  assert.deepEqual(planStairRemovalCascade({ ...base, uppers: [{ plane: graphs[1].plane, graph: graphs[1] }] }), [], '同 footprint が無い');
  assert.deepEqual(planStairRemovalCascade({ ...base, uppers: [] }), [], '上の階が無い');
  const empty = decodeFloor(project, graphs[1].plane, undefined); // per-floor 中心線が無い2階（写せない）
  assert.deepEqual(planStairRemovalCascade({ ...base, uppers: [{ plane: graphs[1].plane, graph: empty }] }), []);
});

// ---- applyStairRemovalToFloor ----

test('applyStairRemovalToFloor: 同 footprint の階段吹抜けを全部未定義化する。対象が空なら何もしない', async () => {
  const ctx = await expanded(2);
  const g2 = ctx.floors[1].graph;
  const dup = g2.addRoom(new Set(voidRooms(g2)[0].cells));
  dup.setFeature(RoomFeature.STAIR_VOID);
  const t = cascade(ctx);
  assert.equal(applyStairRemovalToFloor(g2, t[0]), true);
  assert.equal(voidRooms(g2).length, 0);
  assert.equal(g2.rooms.filter(r => r.feature === RoomFeature.UNDEFINED).length, 2);
  assert.equal(applyStairRemovalToFloor(g2, { voidRooms: [] }), false, '対象が空なら何もしない');
});
