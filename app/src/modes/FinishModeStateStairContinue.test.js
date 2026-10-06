// FinishModeState の「続きの階段」の指定（階段の上階展開ステップ4）: 中間階で、直下階の階段の吹抜け（STAIR_VOID）を
// 含めて部屋ドラッグし、階段として確定できる。吹抜けは確定（applyNaming）のときだけ吸収し、ドラッグ中・ダイアログ中は
// 候補部屋と吹抜けがセルを一時的に二重に持つのを許す（キャンセルでは吹抜けに触れない）。部分的な重なりと、階段以外での
// 確定は何も変更せず拒否する。前提は実際の経路（applyNaming で階段を指定→syncUpperFloors で直上階へ吹抜けを展開）で作り、
// 他階の検証はストアのバイト列を復号したグラフに対して行う（stairRemovalTestFixtures.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { RoomFeature, RoomKind } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { refreshCells } from '../finish/gridCells.js';
import { ERR_STAIR_VOID_NOT_STAIR, ERR_STAIR_VOID_PARTIAL } from '../error.js';
import { makeStorePeek, makeStoreSave, decodeFloor } from '../finish/equipment/equipmentTestFixtures.js';
import { syncUpperFloors, runStairRemoval } from '../finish/stair/stairFloorSync.js';
import { runFinishExitBoundary } from '../finish/finishBoundary.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { setupProject, addPerFloorV, placeStair, keyAt } from '../finish/stair/stairRemovalTestFixtures.js';

const LEFT = [250, 500];
const RIGHT = [750, 500];
const FAR = [1500, 500];
const STAIR_PAYLOAD = { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.STAIR };
const flush = () => new Promise(resolve => setTimeout(resolve, 0)); // 投げっぱなしの保存を待つ
const voidRooms = (g) => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID);

// 3階建て。1階に階段（pts）を指定→2階へ吹抜けを展開。2階（g2）をアクティブにした FinishModeState を返す。
// g2 は保存バイト列から復元した生きたグラフ、3階は store のバイト列（本番の peek 同型）。
async function setup({ stairPts, floors = 3 } = {}) {
  const { project, graphs } = setupProject(floors);
  addPerFloorV(graphs);
  const [g1, g2] = graphs;
  const placed = placeStair(project, g1, stairPts ? { pts: stairPts } : {});
  const store = new Map(graphs.map(g => [g.plane.id, serializeGraph(g)]));
  const peekFn = makeStorePeek(project, store);
  const saveFloorFn = makeStoreSave(store, []);
  await syncUpperFloors(project, g1, { peekFn, saveFloorFn });
  store.set('p1', serializeGraph(g1));
  restoreGraph(g2, store.get('p2'));
  runInAction(() => { project.activePlaneId = 'p2'; });
  const state = new FinishModeState(g2, project);
  // 見下げ判定（_loadLowerStairs の結果と同形。本物の peek は使わない）。1階の階段のセルの外接矩形
  const cellBounds = (stairPts ?? [LEFT]).map(([x]) => (x < 500 ? { x1: 0, y1: 0, x2: 500, y2: 1000 } : { x1: 500, y1: 0, x2: 1000, y2: 1000 }));
  state.lowerStairs = [{ stair: g1.stairs[0], cellBounds }];
  const sync = (undoEntry) => syncUpperFloors(project, g2, { undoEntry, peekFn, saveFloorFn });
  return { project, graphs, g1, g2, store, state, sync, lowerStair: placed.stair, peekFn, saveFloorFn };
}

/** pts を順になぞって離す（先頭で押下、残りは移動）。 */
function drag(state, pts, { tap = false } = {}) {
  state.startDrag(...pts[0]);
  for (const p of pts.slice(1)) state.updateDrag(...p);
  state.commitDrag({ tap });
}

const rejectionOf = (state, payload) => { state.applyNaming(state.namingRoomId, payload, 3000); return state.lastNamingRejection; };

// ---- 吹抜けの中からのドラッグ→階段で確定 ----

test('吹抜け＋空きセルをなぞって階段で確定: 吹抜けは吸収され、そのセルを持つのはペア部屋だけ。3階に吹抜け1件。選択順に吹抜けのセルが入る', async () => {
  const ctx = await setup();
  const { g2, state, project } = ctx;
  const voidBefore = voidRooms(g2);
  assert.equal(voidBefore.length, 1, '前提: 2階に吹抜け1件');
  const voidRaw = new Set(voidBefore[0].cells);

  drag(state, [LEFT, RIGHT]);
  assert.ok(state.namingRoomId, '候補が作られ、ダイアログが開く');
  assert.equal(state.namingIsNew, true);
  assert.equal(state.namingCellOrder[0], keyAt(g2, LEFT), '選択順の先頭は吹抜けのセル（歩行順の入力）');
  assert.equal(state.namingCellOrder.length, 2);
  assert.equal(voidRooms(g2).length, 1, 'ダイアログ中は吹抜けに触れない');

  const stair = state.applyNaming(state.namingRoomId, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.ok(stair, '階段が作られる');
  assert.equal(voidRooms(g2).length, 0, '吹抜けは吸収されて消える');
  // 階段の足元の分割CL（ensureUnderStairSplit）でグリッドが細かくなるため、吹抜けの生キーを確定後の格子へ展開し直して比べる
  for (const k of refreshCells(voidRaw, g2)) {
    const owners = g2.rooms.filter(r => refreshCells(r.cells, g2).has(k));
    assert.deepEqual(owners.map(r => r.id), [stair.roomId], '同じセルを持つ部屋はペア部屋だけ');
  }

  await ctx.sync(state.lastNamingUndoEntry);
  const g3 = decodeFloor(project, project.planeMap.get('p3'), ctx.store.get('p3'));
  assert.equal(voidRooms(g3).length, 1, '3階に続きの階段の吹抜けが1件');
});

test('吹抜けと同じ形（2セル）を吹抜けの中からなぞって階段で確定できる（訪れたセルが増える形）', async () => {
  const ctx = await setup({ stairPts: [LEFT, RIGHT] });
  const { g2, state, project } = ctx;
  assert.equal(voidRooms(g2).length, 1);
  assert.equal(refreshCells(voidRooms(g2)[0].cells, g2).size, 2, '前提: 吹抜けは2セル');

  drag(state, [LEFT, RIGHT]);
  assert.ok(state.namingRoomId, '同じ形でもタップ扱いにならず候補が作られる');
  const stair = state.applyNaming(state.namingRoomId, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.ok(stair);
  assert.equal(voidRooms(g2).length, 0);
});

test('【失敗系】吹抜けの一部だけと重なる範囲は ERR_STAIR_VOID_PARTIAL で拒否: graph のバイト列不変・候補と保留 undo を保持', async () => {
  const ctx = await setup({ stairPts: [LEFT, RIGHT] });
  const { g2, state, project } = ctx;
  drag(state, [FAR, RIGHT]); // 吹抜け（左・右）のうち右だけに触れる
  const roomId = state.namingRoomId;
  assert.ok(roomId, '前提: 候補が開いている');
  const bytes = serializeGraph(g2);

  const stair = state.applyNaming(roomId, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(stair, null);
  assert.equal(state.lastNamingRejection, ERR_STAIR_VOID_PARTIAL);
  assert.deepEqual(serializeGraph(g2), bytes, '何も変更しない');
  assert.equal(state.namingRoomId, roomId);
  assert.equal(state.namingIsNew, true);
  assert.notEqual(state._pendingDialogUndo, null);
  assert.equal(state.prepareStairNaming(roomId, STAIR_PAYLOAD).rejection, ERR_STAIR_VOID_PARTIAL, 'App の関門の前検査も同じ文言');
});

test('【失敗系】吹抜けを含む範囲を階段以外（なし・吹抜け・屋根・昇降機）で確定すると ERR_STAIR_VOID_NOT_STAIR で拒否。昇降機は prepareElevatorNaming の段で返る', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  drag(state, [LEFT, RIGHT]);
  const roomId = state.namingRoomId;
  const bytes = serializeGraph(g2);
  const k = RoomKind.INTERIOR;
  for (const [label, feature, kind] of [
    ['なし', null, k], ['吹抜け', RoomFeature.VOID, k], ['屋根', RoomFeature.ROOF, RoomKind.EXTERIOR],
  ]) {
    assert.equal(rejectionOf(state, { name: '', kind, feature }), ERR_STAIR_VOID_NOT_STAIR, label);
    assert.deepEqual(serializeGraph(g2), bytes, `${label}: 何も変更しない`);
    assert.equal(state.namingRoomId, roomId, `${label}: 候補を保持`);
  }
  const ev = { name: '', kind: k, feature: RoomFeature.ELEVATOR_EQUIPMENT };
  assert.equal(state.prepareElevatorNaming(roomId, ev).rejection, ERR_STAIR_VOID_NOT_STAIR, '昇降機（関門の前検査）');
  assert.equal(rejectionOf(state, ev), ERR_STAIR_VOID_NOT_STAIR, '昇降機（applyNaming）');
  assert.deepEqual(serializeGraph(g2), bytes);
  assert.equal(voidRooms(g2).length, 1, '吹抜けは残る');
});

test('キャンセル: 候補は消え、吹抜けは同じ id・同じセルで残る', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  const v = voidRooms(g2)[0];
  const cellsBefore = [...v.cells];
  drag(state, [LEFT, RIGHT]);
  state.cancelNaming(state.namingRoomId);
  assert.equal(state.namingRoomId, null);
  assert.equal(voidRooms(g2).length, 1);
  assert.equal(voidRooms(g2)[0].id, v.id);
  assert.deepEqual([...voidRooms(g2)[0].cells], cellsBefore);
  assert.equal(g2.rooms.some(r => r.feature !== RoomFeature.STAIR_VOID && r.feature !== RoomFeature.UNDEFINED), false, '候補部屋は残らない');
});

test('undo 1回で2階の吹抜け・3階の before まで戻り、redo でも戻る', async () => {
  const ctx = await setup();
  const { g2, state, project, store } = ctx;
  const v = voidRooms(g2)[0];
  const roomCount = g2.rooms.length;
  const p3Before = store.get('p3');

  drag(state, [LEFT, RIGHT]);
  state.applyNaming(state.namingRoomId, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  await ctx.sync(state.lastNamingUndoEntry);
  const p3After = store.get('p3');
  assert.notDeepEqual(p3After, p3Before, '前提: 3階は変わっている');
  const afterIds = g2.rooms.map(r => r.id);

  // 3階の before は peek 時の復号→再直列化の形（初期の生バイト列とは正規化の分だけ長さが違う）。復号し直して比べる
  const p3Of = (bytes) => decodeFloor(project, project.planeMap.get('p3'), bytes);
  const p3Shape = (bytes) => JSON.stringify(p3Of(bytes).rooms.map(r => [r.feature, [...r.cells]]));
  undoManager.undo();
  await flush();
  assert.equal(g2.stairs.length, 0);
  assert.equal(voidRooms(g2).length, 1, 'undo で吹抜けが戻る');
  assert.equal(voidRooms(g2)[0].id, v.id);
  assert.equal(g2.rooms.length, roomCount, '候補部屋は残らない');
  assert.equal(p3Shape(store.get('p3')), p3Shape(p3Before), '3階が before へ戻る（部屋の属性とセル）');
  assert.equal(voidRooms(p3Of(store.get('p3'))).length, 0, '3階の吹抜けが無い');

  undoManager.redo();
  await flush();
  assert.equal(g2.stairs.length, 1);
  assert.equal(voidRooms(g2).length, 0);
  assert.deepEqual(g2.rooms.map(r => r.id), afterIds, 'redo で階段確定後へ戻る');
  assert.deepEqual(store.get('p3'), p3After, '3階が after へ戻る');
});

// ---- タップ・判定1・除外 ----

test('吹抜けのタップ（commitDrag の tap）は従来どおり下階の階段の見下げ選択で、部屋は作られない', async () => {
  const ctx = await setup();
  const { g2, state, lowerStair } = ctx;
  const bytes = serializeGraph(g2);
  drag(state, [LEFT], { tap: true });
  assert.equal(state.selectedStairId, lowerStair.id);
  assert.equal(state.namingRoomId, null);
  assert.equal(state.dragState, null);
  assert.deepEqual(serializeGraph(g2), bytes, '部屋は作られない');
});

test('吹抜けの外（既存部屋）から始めて、既存部屋＋吹抜けをなぞると判定1の選択だけ: 既存部屋は吹抜けのセルを取り込まない', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  const existing = g2.addRoom(new Set([keyAt(g2, RIGHT)]), '居間');
  const cellsBefore = [...existing.cells];
  const bytes = serializeGraph(g2);

  drag(state, [RIGHT, LEFT]); // 既存部屋から始め、吹抜けのセルへ
  assert.equal(state.selectedRoomId, existing.id, '既存部屋を選択するだけ');
  assert.equal(state.namingRoomId, null, 'ダイアログは開かない');
  assert.deepEqual([...g2.roomMap.get(existing.id).cells], cellsBefore, '既存部屋のセルは増えない');
  assert.equal(voidRooms(g2).length, 1);
  assert.deepEqual(serializeGraph(g2), bytes);
});

test('屋根・昇降路のセルは従来どおりドラッグから除外され、吹抜けのセルは除外されない', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  const roof = g2.addRoom(new Set([keyAt(g2, RIGHT)]));
  roof.setFeature(RoomFeature.ROOF);
  const shaft = g2.addRoom(new Set([keyAt(g2, FAR)]));
  shaft.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const excluded = state._roomExcludedStairKeys();
  assert.equal(excluded.has(keyAt(g2, RIGHT)), true, '屋根は除外');
  assert.equal(excluded.has(keyAt(g2, FAR)), true, '昇降路は除外');
  assert.equal(excluded.has(keyAt(g2, LEFT)), false, '吹抜けは除外しない');
  // 吹抜けから始めて屋根・昇降路の上を通っても、訪れたセルに入らない
  state.startDrag(...LEFT);
  state.updateDrag(...RIGHT);
  state.updateDrag(...FAR);
  assert.deepEqual([...state.dragState.visitedCells.keys()], [keyAt(g2, LEFT)]);
});

// ---- 続きの階段の削除（6b との結合）----

test('続きの階段を削除すると、2階に直下階の階段の吹抜けが戻る', async () => {
  const ctx = await setup();
  const { g2, state, project, store, g1, peekFn, saveFloorFn } = ctx;
  drag(state, [LEFT, RIGHT]);
  const stair = state.applyNaming(state.namingRoomId, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  await ctx.sync(state.lastNamingUndoEntry);
  store.set('p1', serializeGraph(g1));
  store.set('p2', serializeGraph(g2));
  assert.equal(voidRooms(g2).length, 0, '前提: 吸収済み');

  const result = await runStairRemoval({
    project, activeGraph: g2, stairId: stair.id,
    commitActive: () => { state.deleteStair(stair.id); return state.lastStairUndoEntry; },
    isStillValid: () => true, onApplied: () => {}, peekFn, saveFloorFn,
  });
  assert.equal(result.status, 'removed');
  assert.equal(g2.stairs.length, 0);
  const voids = voidRooms(g2);
  assert.equal(voids.length, 1, '直下階の階段の吹抜けが戻る');
  assert.deepEqual([...refreshCells(voids[0].cells, g2)], [keyAt(g2, LEFT)]);
});

test('1階の階段を削除すると、2階の吹抜けは未定義化される（結合）', async () => {
  const ctx = await setup();
  const { project, g1, store, peekFn, saveFloorFn, lowerStair } = ctx;
  runInAction(() => { project.activePlaneId = 'p1'; });
  const state1 = new FinishModeState(g1, project);
  const result = await runStairRemoval({
    project, activeGraph: g1, stairId: lowerStair.id,
    commitActive: () => { state1.deleteStair(lowerStair.id); return state1.lastStairUndoEntry; },
    isStillValid: () => true, onApplied: () => {}, peekFn, saveFloorFn,
  });
  assert.equal(result.status, 'removed');
  const p2 = decodeFloor(project, project.planeMap.get('p2'), store.get('p2'));
  assert.equal(voidRooms(p2).length, 0, '2階の吹抜けは無くなる');
  assert.ok(p2.rooms.some(r => r.feature === RoomFeature.UNDEFINED), '未定義の部屋として外形が残る');
});

test('屋外の続きの階段（直下が屋内）も指定でき、3階には何も置かれない（屋外階段は上階展開の対象外）', async () => {
  const ctx = await setup();
  const { g2, state, project, store } = ctx;
  const p3Of = () => decodeFloor(project, project.planeMap.get('p3'), store.get('p3'));
  const roomsBefore = p3Of().rooms.length;
  drag(state, [LEFT, RIGHT]);
  const stair = state.applyNaming(state.namingRoomId, { name: '', kind: RoomKind.EXTERIOR, feature: RoomFeature.STAIR }, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.ok(stair);
  assert.equal(voidRooms(g2).length, 0, '吹抜けは吸収される');
  await ctx.sync(state.lastNamingUndoEntry);
  assert.equal(voidRooms(p3Of()).length, 0, '3階に吹抜けは置かれない');
  assert.equal(p3Of().rooms.length, roomsBefore, '3階の部屋は増えない');
});

// ---- ポインタの移動量で決めるタップ（吹抜けが1連結領域でも同じ形の指定ができる）----

test('1セル（1連結領域）の吹抜けと同じ形でも、tap でなければ続きの階段を指定できる', async () => {
  const ctx = await setup();
  const { g2, state, project } = ctx;
  assert.equal(refreshCells(voidRooms(g2)[0].cells, g2).size, 1, '前提: 吹抜けは1セル');
  drag(state, [LEFT]); // tap=false（ポインタが動いた）。訪れたセルは増えない
  assert.ok(state.namingRoomId, '候補が作られダイアログが開く');
  const stair = state.applyNaming(state.namingRoomId, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.ok(stair);
  assert.equal(voidRooms(g2).length, 0);
});

test('【失敗系】吹抜けのタップは、見下げ先（lowerStairs）が未読込みでも候補部屋を作らない', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  state.lowerStairs = [];
  const bytes = serializeGraph(g2);
  drag(state, [LEFT], { tap: true });
  assert.equal(state.namingRoomId, null);
  assert.equal(state.selectedStairId, null);
  assert.equal(state.dragState, null);
  assert.deepEqual(serializeGraph(g2), bytes);
});

test('最上階（上階なし）では吹抜けのセルからドラッグを始めない: 見下げ先があれば選択、無ければ何もしない', async () => {
  const ctx = await setup({ floors: 2 });
  const { g2, state, lowerStair } = ctx;
  assert.equal(voidRooms(g2).length, 1, '前提: 最上階の2階に吹抜け');
  const bytes = serializeGraph(g2);
  state.startDrag(...LEFT);
  assert.equal(state.dragState, null, 'ドラッグを始めない');
  assert.equal(state.selectedStairId, lowerStair.id, '従来どおり見下げ選択');
  state.lowerStairs = [];
  state.selectedStairId = null;
  drag(state, [LEFT, RIGHT]);
  assert.equal(state.dragState, null);
  assert.equal(state.namingRoomId, null, '行き止まりの候補は作られない');
  assert.deepEqual(serializeGraph(g2), bytes);
});

// ---- 判定2・dispose・新規候補でない部屋 ----

test('既存部屋の全体＋吹抜け＋空きセルをなぞる（判定2）: 既存部屋は空きセルまで広がるが、吹抜けのセルは取り込まない', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  const existing = g2.addRoom(new Set([keyAt(g2, RIGHT)]), '居間');
  const v = voidRooms(g2)[0];
  drag(state, [RIGHT, LEFT, FAR]);
  assert.equal(state.namingRoomId, existing.id, '統合先として既存部屋のダイアログが開く');
  const cells = refreshCells(g2.roomMap.get(existing.id).cells, g2);
  assert.deepEqual([...cells].sort(), [keyAt(g2, RIGHT), keyAt(g2, FAR)].sort(), '空きセルまで広がる');
  assert.equal(cells.has(keyAt(g2, LEFT)), false, '吹抜けのセルは取り込まない');
  assert.equal(voidRooms(g2).length, 1, '吹抜けは重複せず残る');
  assert.equal(voidRooms(g2)[0].id, v.id);
});

test('ダイアログを開いたまま dispose すると、吹抜けと同セルの候補部屋は残らず、吹抜けは同じ id で残る', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  const v = voidRooms(g2)[0];
  const roomCount = g2.rooms.length;
  drag(state, [LEFT, RIGHT]);
  assert.equal(g2.rooms.length, roomCount + 1, '前提: 候補が作られている');
  state.dispose();
  assert.equal(g2.rooms.length, roomCount, '候補部屋は残らない');
  assert.equal(voidRooms(g2).length, 1);
  assert.equal(voidRooms(g2)[0].id, v.id);
});

test('新規候補でない部屋（吹抜けと同セルで二重所有の旧状態）を階段にすると、吹抜けを吸収する。階段以外への変更は止めない', async () => {
  const ctx = await setup();
  const { g2, state, project } = ctx;
  const old = g2.addRoom(new Set([keyAt(g2, LEFT), keyAt(g2, RIGHT)]), '居間');
  assert.equal(state.namingIsNew, false);
  // 階段以外（なし）は旧データの可能性があり拒否しない
  state.applyNaming(old.id, { name: '居間', kind: RoomKind.INTERIOR, feature: null }, 3000);
  assert.equal(state.lastNamingRejection, null);
  assert.equal(voidRooms(g2).length, 1, '階段以外では吹抜けに触れない');
  const stair = state.applyNaming(old.id, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.ok(stair);
  assert.equal(voidRooms(g2).length, 0, '吹抜けを吸収する');
});

test('【失敗系】新規候補でない部屋でも、吹抜けの一部だけと重なるなら階段化は PARTIAL で拒否する', async () => {
  const ctx = await setup({ stairPts: [LEFT, RIGHT] });
  const { g2, state, project } = ctx;
  const old = g2.addRoom(new Set([keyAt(g2, RIGHT), keyAt(g2, FAR)]), '居間');
  const bytes = serializeGraph(g2);
  const stair = state.applyNaming(old.id, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(stair, null);
  assert.equal(state.lastNamingRejection, ERR_STAIR_VOID_PARTIAL);
  assert.deepEqual(serializeGraph(g2), bytes);
});

// ---- tap の対象外（吹抜けから始めていない）・脱出境界・自己吸収の防止 ----

test('吹抜けの外の空きセルのタップ（tap: true）は従来どおり新規候補を作ってダイアログを開く', async () => {
  const ctx = await setup();
  const { state } = ctx;
  state.startDrag(...FAR);
  state.commitDrag({ tap: true });
  assert.ok(state.namingRoomId, '候補が作られる');
  assert.equal(state.namingIsNew, true);
});

test('既存部屋のタップ（tap: true）は従来どおり判定1の選択だけ（ダイアログは開かない）', async () => {
  const ctx = await setup();
  const { g2, state } = ctx;
  const existing = g2.addRoom(new Set([keyAt(g2, RIGHT)]), '居間');
  state.startDrag(...RIGHT);
  state.commitDrag({ tap: true });
  assert.equal(state.selectedRoomId, existing.id);
  assert.equal(state.namingRoomId, null);
});

test('runFinishExitBoundary: 開いたままの候補は canSkip（無編集スキップ判定）が見る前に取り消される', async () => {
  const ctx = await setup();
  const { g2, state, project } = ctx;
  const v = voidRooms(g2)[0];
  const roomCount = g2.rooms.length;
  drag(state, [LEFT, RIGHT]);
  assert.equal(g2.rooms.length, roomCount + 1, '前提: 候補が作られている');
  const undoCount = undoManager._undoStack.length;
  const seen = [];
  const stamps = { canSkip: async (g) => { seen.push(g.rooms.length); return { skip: true }; } };
  const result = await runFinishExitBoundary(g2, project, state, { stamps });
  assert.deepEqual(result, { skipped: true });
  assert.deepEqual(seen, [roomCount], 'canSkip が見た部屋数は候補を作る前と同じ');
  assert.equal(state.namingRoomId, null);
  assert.equal(state._pendingDialogUndo, null);
  assert.equal(voidRooms(g2).length, 1);
  assert.equal(voidRooms(g2)[0].id, v.id);
  assert.equal(undoManager._undoStack.length, undoCount, 'undo の積み数は不変');
});

test('吹抜けの部屋そのものを applyNaming で階段にしても、自分を吸収して消さない', async () => {
  const ctx = await setup();
  const { g2, state, project } = ctx;
  const v = voidRooms(g2)[0];
  const stair = state.applyNaming(v.id, STAIR_PAYLOAD, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.ok(stair, '階段が作られる');
  assert.equal(g2.roomMap.has(stair.roomId), true, '階段のペア部屋が残る');
});

test('吹抜けと二重所有の既存の階段の名前を変えても、吹抜けを消さず拒否もしない（既に階段の部屋は対象外）', async () => {
  const ctx = await setup();
  const { g2, state, project } = ctx;
  const own = placeStair(project, g2, { pts: [RIGHT] });
  const dup = g2.addRoom(new Set([keyAt(g2, RIGHT), keyAt(g2, FAR)]));
  dup.setFeature(RoomFeature.STAIR_VOID); // 階段の足元の一部だけと重なる吹抜け（旧データの二重所有）
  const voidsBefore = voidRooms(g2).length;
  const result = state.applyNaming(own.room.id, { name: '階段A', kind: RoomKind.INTERIOR, feature: RoomFeature.STAIR }, floorHeightAbove(project, project.activePlane));
  assert.equal(state.lastNamingRejection, null);
  assert.equal(result, null, '再変換はしない');
  assert.equal(g2.roomMap.get(own.room.id).name, '階段A');
  assert.equal(voidRooms(g2).length, voidsBefore, '吹抜けは消えない');
});

// ---- 配線（ソース走査。1行まるごと一致）----

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const trimmedLines = src => src.split('\n').map(l => l.trim());

test('【配線】usePointerInteraction: pointerup の仕上げ分岐は押下点との距離8px未満を tap として commitDrag に渡す', () => {
  const lines = trimmedLines(readSrc('../interaction/usePointerInteraction.js'));
  assert.ok(lines.includes('modeRef.current?.commitDrag({ tap: tapDist < 8 });'), 'commitDrag({ tap: ... }) の1行が見つからない');
  assert.ok(lines.includes('const tapDist = Math.hypot((e?.evt?.clientX ?? NaN) - down.x, (e?.evt?.clientY ?? NaN) - down.y);'), 'tapDist の1行が見つからない');
  assert.equal(lines.filter(l => l.includes('.commitDrag(')).length, 1, 'commitDrag の呼び出しは1か所だけ');
});

test('【配線】runFinishExitBoundary: 命名ダイアログの候補の取り消しが、無編集スキップ判定（stamps.canSkip）より前にある', () => {
  const src = readSrc('../finish/finishBoundary.js');
  const s = src.indexOf('export async function runFinishExitBoundary');
  const body = trimmedLines(src.slice(s));
  const discardIdx = body.indexOf('fmode?.discardNamingDialog?.();');
  const skipIdx = body.findIndex(l => l.includes('stamps.canSkip('));
  assert.ok(discardIdx >= 0, 'fmode?.discardNamingDialog?.(); の1行が見つからない');
  assert.ok(skipIdx >= 0 && discardIdx < skipIdx, '取り消しは canSkip より前');
});
