// FinishModeState の階段削除まわり（件B ステップ3・4）: deleteStair の undo エントリ・stairDeleteBlockReason・
// isStairRemovalIntent・「部屋カードの削除」を階段の関門へ回しても自階の結果が従来の deleteRoom と食い違わないこと。
// 前提は実際の経路（applyNaming で階段を指定→syncUpperFloors で上の階へ展開）で作る（stairRemovalTestFixtures.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { RoomFeature, RoomKind } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { serializeGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { ERR_STAIR_DELETE_CONTINUATION, ERR_ROOM_DELETE_HAS_STAIR_CHILD } from '../error.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../finish/equipment/equipmentTestFixtures.js';
import { syncUpperFloors } from '../finish/stair/stairFloorSync.js';
import { setupProject, addPerFloorV, placeStair } from '../finish/stair/stairRemovalTestFixtures.js';

const RIGHT_HALF = [[750, 500]];

// 3階建ての1階に階段を指定して上の階へ展開済み（2階は階段の分身、3階は階段吹抜け）。
// g2 は保存バイト列を復号した2階（本番の peek 同型）。
async function twoFloors() {
  const { project, graphs } = setupProject(3);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const placed = placeStair(project, g1);
  const store = new Map(graphs.slice(1).map(g => [g.plane.id, serializeGraph(g)]));
  await syncUpperFloors(project, g1, { peekFn: makeStorePeek(project, store), saveFloorFn: makeStoreSave(store, []) });
  const g2 = decodeFloor(project, project.planeMap.get('p2'), store.get('p2'));
  return { project, g1, g2, ...placed };
}

// 直下階の読込み結果（_loadLowerStairs が peek して持つ値）を、IDB を使わずに注入する。
function injectLower(state, lowerGraph) {
  state._lowerGraph = lowerGraph;
  runInAction(() => { state.lowerStairs = lowerGraph.stairs.map(s => ({ stair: s, cellBounds: [] })); });
}

// ---- deleteStair の undo エントリ ----

test('deleteStair: lastStairUndoEntry を残し、undo で階段とペア部屋が戻り、redo で再び消える', async () => {
  const { project, g1, stair, room } = await twoFloors();
  const state = new FinishModeState(g1, project);
  assert.equal(state.lastStairUndoEntry, null, 'コンストラクタでは null');

  state.deleteStair(stair.id);
  assert.notEqual(state.lastStairUndoEntry, null, '差分があれば undo エントリが入る');
  assert.equal(g1.stairs.length, 0);
  assert.equal(g1.roomMap.get(room.id)?.feature, RoomFeature.UNDEFINED, '屋内のペア部屋は未定義化');

  undoManager.undo();
  assert.equal(g1.stairs.length, 1, 'undo で階段が戻る');
  assert.equal(g1.roomMap.get(room.id)?.feature, RoomFeature.STAIR, 'undo でペア部屋も階段属性へ戻る');
  undoManager.redo();
  assert.equal(g1.stairs.length, 0, 'redo で再び消える');
});

test('【失敗系】deleteStair: 存在しない id は差分なし＝lastStairUndoEntry が null（undo スタックを積まない）', async () => {
  const { project, g1 } = await twoFloors();
  const state = new FinishModeState(g1, project);
  const before = undoManager._undoStack.length;
  state.deleteStair('no-such-stair');
  assert.equal(state.lastStairUndoEntry, null);
  assert.equal(undoManager._undoStack.length, before);
});

// ---- stairDeleteBlockReason ----

test('stairDeleteBlockReason: 直下階に同 footprint の階段がある階段は理由の文言、その階で新設した別位置の階段は null', async () => {
  const { project, g1, g2 } = await twoFloors();
  assert.equal(g2.stairs.length, 1, '前提: 2階に分身がある');
  const own = placeStair(project, g2, { pts: RIGHT_HALF }); // 2階で新設（直下階に同 footprint なし）
  const state = new FinishModeState(g2, project);
  injectLower(state, g1);

  const continuation = g2.stairs.find(s => s.id !== own.stair.id);
  assert.equal(state.stairDeleteBlockReason(continuation.id), ERR_STAIR_DELETE_CONTINUATION, '下の階から続く階段は拒否');
  assert.equal(state.stairDeleteBlockReason(own.stair.id), null, '2階で新設した階段は削除できる');
  assert.equal(state.stairDeleteBlockReason('no-such-stair'), null, '存在しない id は null');
});

test('stairDeleteBlockReason: 直下階が未読込み（_lowerGraph が null）なら、同 footprint があっても null（関門側が拒否する）', async () => {
  const { project, g1, g2 } = await twoFloors();
  const state = new FinishModeState(g2, project);
  injectLower(state, g1);
  assert.equal(state.stairDeleteBlockReason(g2.stairs[0].id), ERR_STAIR_DELETE_CONTINUATION, '前提: 読込み済みなら拒否');

  state._lowerGraph = null;
  assert.equal(state.stairDeleteBlockReason(g2.stairs[0].id), null);

  const empty = new FinishModeState(g2, project); // lowerStairs も空（1階を読み込む前）
  assert.equal(empty.stairDeleteBlockReason(g2.stairs[0].id), null);
});

test('stairDeleteBlockReason: 設置階（1階。直下階なし）の階段は null', async () => {
  const { project, g1, stair } = await twoFloors();
  const state = new FinishModeState(g1, project);
  assert.equal(state.stairDeleteBlockReason(stair.id), null);
});

// ---- isStairRemovalIntent ----

test('isStairRemovalIntent: 階段→部屋／階段→吹抜けは真、階段のまま名前だけ変更・階段でない部屋・Stair 実体のない階段属性・存在しない部屋は偽', async () => {
  const { project, g1, room } = await twoFloors();
  const state = new FinishModeState(g1, project);
  const k = RoomKind.INTERIOR;
  assert.equal(state.isStairRemovalIntent(room.id, { name: '', kind: k, feature: null }), true, '階段→部屋');
  assert.equal(state.isStairRemovalIntent(room.id, { name: '', kind: k, feature: RoomFeature.VOID }), true, '階段→吹抜け');
  assert.equal(state.isStairRemovalIntent(room.id, { name: '階段A', kind: k, feature: RoomFeature.STAIR }), false, '階段のまま名前だけ変更');
  assert.equal(state.isStairRemovalIntent(room.id, { name: '', kind: RoomKind.EXTERIOR, feature: RoomFeature.STAIR }), false, '階段のまま区分だけ変更');

  const plain = g1.addRoom(new Set(), '居間');
  assert.equal(state.isStairRemovalIntent(plain.id, { name: '', kind: k, feature: null }), false, '階段でない部屋');
  const orphan = g1.addRoom(new Set(), '旧');
  orphan.setFeature(RoomFeature.STAIR);
  assert.equal(state.isStairRemovalIntent(orphan.id, { name: '', kind: k, feature: null }), false, 'Stair 実体のない階段属性は従来どおり同期の applyNaming');
  assert.equal(state.isStairRemovalIntent('no-such-room', { name: '', kind: k, feature: null }), false, '存在しない部屋');
});

test('isStairRemovalIntent は applyNaming が連動 Stair を削除する条件と一致する（真のとき applyNaming で階段が消える）', async () => {
  const { project, g1, stair, room } = await twoFloors();
  const state = new FinishModeState(g1, project);
  const payload = { name: '', kind: RoomKind.INTERIOR, feature: null };
  assert.equal(state.isStairRemovalIntent(room.id, payload), true);
  state.applyNaming(room.id, payload, 3000);
  assert.equal(g1.stairMap.has(stair.id), false);
  assert.equal(state.isStairRemovalIntent(room.id, payload), false, '階段でなくなった後は偽');
});

// ---- 階段タブの経路（deleteStair）の固定: 子も親もない階段のペア部屋では deleteRoom と同じ結果 ----
// 部屋カードの削除は deleteRoom 本体を関門の commitActive に使う（App.jsx deleteStairRoomCascade）ため、
// 子を持つ・子である階段のペア部屋では deleteStair と結果が異なる（下の「部屋カードの削除」のテスト）。

function outcome(g, state) {
  return {
    stairs: g.stairs.length,
    rooms: g.rooms.map(r => ({ feature: r.feature, kind: r.kind, name: r.name })),
    exteriorRows: g.exteriorRows.length,
    selectedRoomId: state.selectedRoomId === null ? null : 'set',
    selectedStairId: state.selectedStairId === null ? null : 'set',
    namingRoomId: state.namingRoomId === null ? null : 'set',
  };
}

for (const kind of [RoomKind.INTERIOR, RoomKind.EXTERIOR]) {
  test(`階段タブの経路の固定: ${kind === RoomKind.INTERIOR ? '屋内' : '屋外'}階段のペア部屋（子も親もない）で deleteStair は deleteRoom と同じ結果`, async () => {
    const viaRoom = await twoFloors0(kind);
    const viaStair = await twoFloors0(kind);
    viaRoom.state.selectRoom(viaRoom.room.id);
    viaStair.state.selectRoom(viaStair.room.id);
    viaRoom.state.deleteRoom(viaRoom.room.id);
    viaStair.state.deleteStair(viaStair.stair.id);
    assert.deepEqual(outcome(viaStair.g1, viaStair.state), outcome(viaRoom.g1, viaRoom.state));
  });
}

// ---- roomDeleteBlockReason・deleteRoom（部分指定に階段を含む部屋の削除は拒否） ----

const roomsState = (g) => JSON.stringify(g.rooms.map(r => [r.id, r.feature, r.name, [...r.cells], [...r.referenceRoomIds]]));

/** 1階に階段（ペア部屋 R）を指定済みの状態を作り、通常の部屋を足す。 */
function stairFloor() {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const { stair, room } = placeStair(project, g1);
  const state = new FinishModeState(g1, project);
  const plain = (name, refs = []) => g1.addRoom(new Set(), name, undefined, new Set(refs));
  return { project, g1, stair, room, state, plain };
}

test('roomDeleteBlockReason: 子に階段のペア部屋がある親→文言', () => {
  const { room, state, plain } = stairFloor();
  const parent = plain('親');
  room.referenceRoomIds.add(parent.id);
  assert.equal(state.roomDeleteBlockReason(parent.id), ERR_ROOM_DELETE_HAS_STAIR_CHILD);
});

test('roomDeleteBlockReason: 孫（子の子）に階段のペア部屋がある→文言（_deleteRoomNoUndo のカスケードが孫まで届くのと同じ列挙）', () => {
  const { g1, room, state, plain } = stairFloor();
  const top = plain('祖');
  const mid = plain('子', [top.id]);
  room.referenceRoomIds.add(mid.id);
  assert.equal(state.roomDeleteBlockReason(top.id), ERR_ROOM_DELETE_HAS_STAIR_CHILD, '孫に階段');
  assert.equal(state.roomDeleteBlockReason(mid.id), ERR_ROOM_DELETE_HAS_STAIR_CHILD, '子に階段');
  assert.equal(state._cascadedRoomIds(top.id).length, 2, '子と孫の2件');
  assert.equal(g1.roomMap.has(top.id), true);
});

test('roomDeleteBlockReason: 子はいるが階段でない→null。削除対象そのものが階段のペア部屋（子に階段なし）→null。存在しない id→null', () => {
  const { room, state, plain } = stairFloor();
  const parent = plain('親');
  plain('子', [parent.id]);
  assert.equal(state.roomDeleteBlockReason(parent.id), null, '子は階段でない');
  assert.equal(state.roomDeleteBlockReason(room.id), null, '階段のペア部屋そのもの');
  assert.equal(state.roomDeleteBlockReason('no-such-room'), null);
});

test('roomDeleteBlockReason: 削除対象そのものが階段のペア部屋でも、その子にさらに階段のペア部屋があれば文言', () => {
  const { g1, project, room, state } = stairFloor();
  const second = placeStair(project, g1, { pts: [[750, 500]] }); // 右半分に2つ目の階段
  second.room.referenceRoomIds.add(room.id);
  assert.equal(state.roomDeleteBlockReason(room.id), ERR_ROOM_DELETE_HAS_STAIR_CHILD);
  assert.equal(state.roomDeleteBlockReason(second.room.id), null, '子側（階段のペア部屋そのもの）は拒否しない');
});

test('【失敗系】deleteRoom: 理由ありのときは何も変更しない（階段・部屋・undo スタックが不変。lastRoomUndoEntry は null）', () => {
  const { g1, stair, room, state, plain } = stairFloor();
  const parent = plain('親');
  room.referenceRoomIds.add(parent.id);
  const snap = roomsState(g1);
  const undoLen = undoManager._undoStack.length;
  state.deleteRoom(parent.id);
  assert.equal(g1.stairMap.has(stair.id), true, '階段が残る');
  assert.equal(g1.roomMap.has(parent.id), true, '親が残る');
  assert.equal(g1.roomMap.get(room.id).feature, RoomFeature.STAIR, '子（階段のペア部屋）が残る');
  assert.equal(roomsState(g1), snap, '部屋の状態が不変');
  assert.equal(undoManager._undoStack.length, undoLen, 'undo スタックを積まない');
  assert.equal(state.lastRoomUndoEntry, null);
});

// ---- 部屋カードの削除（deleteRoom 本体を commitActive に使う）: 自階の結果は従来の deleteRoom ----

test('deleteRoom: undo エントリを lastRoomUndoEntry に残し、undo で戻り、redo で再び消える。差分なし（存在しない id）は null', () => {
  const { g1, stair, room, state } = stairFloor();
  assert.equal(state.lastRoomUndoEntry, null, 'コンストラクタでは null');
  state.deleteRoom(room.id);
  assert.notEqual(state.lastRoomUndoEntry, null);
  assert.equal(g1.stairs.length, 0);
  undoManager.undo();
  assert.equal(g1.stairMap.has(stair.id), true, 'undo で階段が戻る');
  assert.equal(g1.roomMap.get(room.id).feature, RoomFeature.STAIR);
  undoManager.redo();
  assert.equal(g1.stairs.length, 0);

  const len = undoManager._undoStack.length;
  state.deleteRoom('no-such-room');
  assert.equal(state.lastRoomUndoEntry, null);
  assert.equal(undoManager._undoStack.length, len);
});

test('deleteRoom（部屋カードの削除）: (a) 階段のペア部屋が部分指定の子（階段でない）を持つ親→子も削除され、ペア部屋は未定義化（従来どおり）', () => {
  const { g1, stair, room, state, plain } = stairFloor();
  const child = plain('子', [room.id]);
  state.deleteRoom(room.id);
  assert.equal(g1.roomMap.has(child.id), false, '子も削除される（確認ダイアログの「部分指定N件も削除」と一致）');
  assert.equal(g1.stairMap.has(stair.id), false);
  assert.equal(g1.roomMap.get(room.id)?.feature, RoomFeature.UNDEFINED);
  // 階段タブの経路（deleteStair）は子を消さない＝カード削除を deleteStair へ回すと食い違う（回帰の検出用）
  const tab = stairFloor();
  const tabChild = tab.plain('子', [tab.room.id]);
  tab.state.deleteStair(tab.stair.id);
  assert.equal(tab.g1.roomMap.has(tabChild.id), true, '前提: deleteStair は子を残す');
});

test('deleteRoom（部屋カードの削除）: (b) 階段のペア部屋が部分指定の子→従来どおり removeRoom（親は残り、子は部屋ごと消える）', () => {
  const { g1, stair, room, state, plain } = stairFloor();
  const parent = plain('親');
  room.referenceRoomIds.add(parent.id);
  const before = g1.rooms.length;
  state.deleteRoom(room.id);
  assert.equal(g1.roomMap.has(room.id), false, '部分指定の子は removeRoom（未定義化しない）');
  assert.equal(g1.roomMap.has(parent.id), true);
  assert.equal(g1.rooms.length, before - 1);
  assert.equal(g1.stairMap.has(stair.id), false);
});

async function twoFloors0(kind) {
  const { project, graphs } = setupProject(2);
  addPerFloorV(graphs);
  const g1 = graphs[0];
  const { stair, room } = placeStair(project, g1, { kind });
  if (kind === RoomKind.EXTERIOR && !g1.exteriorRows.some(r => r.roomId === room.id)) g1.addExteriorRow('exteriorRows', '階段', room.id);
  return { g1, stair, room, state: new FinishModeState(g1, project) };
}
