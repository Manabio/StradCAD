// 昇降機の仕様追加 ステップ3（設置の縦1本）・ステップ4（削除＋タブ＋用途）の
// FinishModeState 側の単体テスト。FinishModeState.test.js と同じ方針
// （mobx以外はDOM/IndexedDBに依存しないため node:test から直接import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature,
  isShaftFeature, ElevatorEquipmentCategory, EvUsage, DEFAULT_EV_USAGE,
} from '@core';
import { FinishModeState } from './FinishModeState.js';
import { worldToCell, refreshCells } from '../finish/gridCells.js';
import { undoManager } from '../undoManager.js';
import { ERR_ELEVATOR_NOT_RECTANGLE, ERR_ELEVATOR_EXTERIOR, ERR_ELEVATOR_NOT_UNASSIGNED } from '../error.js';
import { assertShaftInvariant } from '../finish/equipment/equipmentTestFixtures.js';
import { installEquipment } from '../finish/equipment/equipmentOps.js';
import { snapshotFinishState } from '../finish/finishUndo.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

// 2x2マス格子（x:0-2000-4000, y:0-1500-3000）。
function makeGrid2x2() {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opt);
  return graph;
}

// 3セル横並び格子（left[0,2000]/mid[2000,4000]/right[4000,6000] × y[0,3000]）。
// FinishModeState.test.js の makeThreeCellGraph と同じ形。
function makeThreeCellGraph() {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   6000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opt);
  return graph;
}

// 単一セル格子（FinishModeState.test.js の makeSingleCellGraph と同じ形）。
function makeSingleCellGraph() {
  const graph = makeGraph();
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    opt);
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opt);
  return graph;
}

// 2x2マスをドラッグして新規Roomのダイアログを開く（判定3-未指定）。
function dragFullGrid2x2(state) {
  state.startDrag(1000, 750);
  state.updateDrag(3000, 750);
  state.updateDrag(1000, 2250);
  state.updateDrag(3000, 2250);
  state.commitDrag();
}

const EV_INSTALL = { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.ELEVATOR_EQUIPMENT };

// ================================================================
// S3 正常系
// ================================================================

test('S3正常系: 2x2をドラッグ→昇降機で確定すると行1件・Roomは属性=昇降機かつname=\'\'・selectedEquipmentIdが新しい行のid・undoが1エントリ増え、undoで両方消えredoで戻る', () => {
  const graph = makeGrid2x2();
  const state = new FinishModeState(graph, null);
  dragFullGrid2x2(state);
  assert.ok(state.namingRoomId, '前提: ダイアログが開く');
  const candidateRoomId = state.namingRoomId;
  const undoCountBefore = undoManager._undoStack.length;

  const result = state.applyNaming(candidateRoomId, EV_INSTALL);

  assert.equal(result, null, '戻り値の形は変えない（Stair|null）');
  assert.equal(state.lastNamingRejection, null);
  assert.equal(graph.equipmentRows.length, 1);
  const row = graph.equipmentRows[0];
  assert.equal(row.category, ElevatorEquipmentCategory.EV);
  assert.equal(row.usage, DEFAULT_EV_USAGE);
  assert.equal(row.no, 1);
  const room = graph.roomMap.get(row.roomId);
  assert.ok(room);
  assert.equal(isShaftFeature(room.feature), true);
  assert.equal(room.name, '');
  assert.equal(state.selectedEquipmentId, row.id);
  assert.equal(state.selectedRoomId, null);
  assert.equal(state.selectedStairId, null);
  assert.equal(undoManager._undoStack.length, undoCountBefore + 1);
  assertShaftInvariant(graph, '設置直後');

  undoManager.undo();
  assert.equal(graph.equipmentRows.length, 0, 'undoで行が消えるはず');
  assert.equal(graph.roomMap.has(room.id), false, 'undoでRoomも消えるはず（作成ごと戻る）');

  undoManager.redo();
  assert.equal(graph.equipmentRows.length, 1, 'redoで行が戻るはず');
  assert.ok(graph.roomMap.has(room.id), 'redoでRoomが戻るはず');
  assertShaftInvariant(graph, 'redo後');
});

test('S3正常系: 辺で隣接する2基目でRoomが1つにまとまり、2行が同じroomId', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);

  state.startDrag(1000, 1500); // leftのみ
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.equipmentRows.length, 1);
  const firstRoomId = graph.equipmentRows[0].roomId;

  state.startDrag(3000, 1500); // mid（leftと辺で隣接）
  state.commitDrag();
  assert.ok(state.namingRoomId, '前提: midは未指定セルなのでダイアログが開く');
  state.applyNaming(state.namingRoomId, EV_INSTALL);

  assert.equal(graph.equipmentRows.length, 2);
  const roomIds = new Set(graph.equipmentRows.map(r => r.roomId));
  assert.equal(roomIds.size, 1, '2行が同じroomIdにまとまるはず');
  assert.ok(roomIds.has(firstRoomId), '統合先は先に登録した器具のRoomのはず（roomOrder順で先頭）');
  const room = graph.roomMap.get(firstRoomId);
  assert.deepEqual([...refreshCells(room.cells, graph)].sort(), [leftCell.key, midCell.key].sort());
  assertShaftInvariant(graph);
});

test('S3正常系: 角だけで接する2基目ではRoomが2つのまま', () => {
  const graph = makeGrid2x2();
  const state = new FinishModeState(graph, null);
  const topLeft = worldToCell(1000, 750, graph);
  const bottomRight = worldToCell(3000, 2250, graph);

  state.startDrag(1000, 750); // 左上セル
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.equipmentRows.length, 1);

  state.startDrag(3000, 2250); // 右下セル（左上とは角だけで接する）
  state.commitDrag();
  assert.ok(state.namingRoomId);
  state.applyNaming(state.namingRoomId, EV_INSTALL);

  assert.equal(graph.equipmentRows.length, 2);
  const roomIds = new Set(graph.equipmentRows.map(r => r.roomId));
  assert.equal(roomIds.size, 2, '角だけで接する場合はRoomが2つのままのはず');
  const [r1] = graph.equipmentRows.filter(r => r.roomId === [...roomIds][0]);
  void r1;
  assert.deepEqual([...refreshCells(graph.roomMap.get([...roomIds][0]).cells, graph)],
    graph.equipmentRows[0].roomId === [...roomIds][0] ? [topLeft.key] : [bottomRight.key]);
  assertShaftInvariant(graph);
});

test('S3正常系: 昇降機のセルでstartDragするとdragStateがnullでselectedEquipmentIdが立つ', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];
  state.selectedEquipmentId = null; // 選択をリセットしてから確認

  state.startDrag(2000, 1500);

  assert.equal(state.dragState, null);
  assert.equal(state.selectedEquipmentId, row.id);
});

test('S3正常系: 昇降機をまたいでドラッグすると、昇降機のセルがvisitedCellsに入らない', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const midCell = worldToCell(3000, 1500, graph);

  state.startDrag(3000, 1500); // mid
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.equipmentRows.length, 1);

  state.startDrag(1000, 1500); // left（未指定セル。ドラッグは開始できる）
  assert.ok(state.dragState);
  state.updateDrag(3000, 1500); // midを跨ぐ
  assert.equal(state.dragState.visitedCells.has(midCell.key), false, '昇降機のセルはvisitedCellsに入らないはず');
});

// ================================================================
// QA指摘（ステップ3全体）: 不足テストの追加（T1〜T4・T7）
// ================================================================

test('T1: 辺で隣接する設置で候補Roomが消える（left設置済→midをドラッグして確定）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(1000, 1500); // left
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.rooms.length, 1, '前提: leftの設置直後はRoomが1つ');

  state.startDrag(3000, 1500); // mid（leftと辺で隣接。未指定セルなのでcommitDragが新規候補Roomを作る）
  state.commitDrag();
  const candidateRoomId = state.namingRoomId;
  assert.ok(candidateRoomId, '前提: 新規候補Roomのダイアログが開く');

  state.applyNaming(candidateRoomId, EV_INSTALL);

  assert.equal(graph.rooms.length, 1, '統合先1つだけになるはず（候補Roomは消える）');
  assert.equal(graph.roomMap.has(candidateRoomId), false, '候補Roomはinstall後にremoveRoomされるはず');
  assertShaftInvariant(graph);
});

test('T2: 未定義セルへの再設置（left・mid設置→leftを削除→leftを再ドラッグして確定）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  state.startDrag(1000, 1500); // left
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const leftRowId = graph.equipmentRows[0].id;
  state.startDrag(3000, 1500); // mid（leftと統合）
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.equipmentRows.length, 2);

  state.deleteEquipment(leftRowId); // leftが未定義化される
  const undefRoomBefore = graph.rooms.find(r => r.feature === RoomFeature.UNDEFINED
    && refreshCells(r.cells, graph).has(leftCell.key));
  assert.ok(undefRoomBefore, '前提: leftを含むUNDEFINEDのRoomがあるはず');

  state.startDrag(1000, 1500); // leftを再ドラッグ
  state.commitDrag();
  assert.ok(state.namingRoomId, '前提: 未定義セルはfree扱いで新規候補Roomのダイアログが開く');
  state.applyNaming(state.namingRoomId, EV_INSTALL);

  const undefRoomAfter = graph.rooms.find(r => r.feature === RoomFeature.UNDEFINED
    && refreshCells(r.cells, graph).has(leftCell.key));
  assert.equal(undefRoomAfter, undefined, 'leftのセルを含むUNDEFINEDのRoomは無いはず');
  assertShaftInvariant(graph);
});

test('T3: 細分した後の削除（1列3基→格子を細分→中央を削除してもI1が成立しセルが重ならない）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftKey  = worldToCell(1000, 1500, graph).key;
  const midKey   = worldToCell(3000, 1500, graph).key;
  const rightKey = worldToCell(5000, 1500, graph).key;
  state.startDrag(1000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  state.startDrag(3000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  state.startDrag(5000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.equipmentRows.length, 3);
  assertShaftInvariant(graph, '細分前');

  // 昇降路の内部を横切る縦・横のCLを足して格子を細分する
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL,   3000, opt); // midを縦に2分割
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt); // 全セルを横に2分割
  assertShaftInvariant(graph, '細分後');

  const midRow = graph.equipmentRows.find(r => r.cellKeys.has(midKey));
  const leftRow = graph.equipmentRows.find(r => r.cellKeys.has(leftKey));
  const rightRow = graph.equipmentRows.find(r => r.cellKeys.has(rightKey));
  const midCellsBefore = refreshCells(midRow.cellKeys, graph);
  assert.equal(midCellsBefore.size, 4, '前提: mid（縦横とも細分される）は細分後4セルになるはず');
  const leftCellsBefore = refreshCells(leftRow.cellKeys, graph);
  const rightCellsBefore = refreshCells(rightRow.cellKeys, graph);
  assert.equal(leftCellsBefore.size, 2, '前提: left（横のみ細分される）は細分後2セルになるはず');
  assert.equal(rightCellsBefore.size, 2, '前提: right（横のみ細分される）は細分後2セルになるはず');

  state.deleteEquipment(midRow.id);

  assert.equal(graph.equipmentRows.length, 2, 'mid行だけ消えるはず');
  // 細分後はmidの元の単一キー（midKey）自体はもう現行セルとして現れない（4つのsubcellに
  // 置き換わっている）ため、未定義Roomは「細分後のmidのセル集合と交差するか」で探す。
  const undefRoom = graph.rooms.find(r => r.feature === RoomFeature.UNDEFINED
    && [...refreshCells(r.cells, graph)].some(c => midCellsBefore.has(c)));
  assert.ok(undefRoom, '空いたセルの未定義Roomがあるはず');
  const undefCells = refreshCells(undefRoom.cells, graph);
  assert.deepEqual([...undefCells].sort(), [...midCellsBefore].sort(),
    '未定義Roomのセルは細分後のmidのセル数（4）と一致するはず');

  const leftRoomCellsAfter = refreshCells(graph.roomMap.get(leftRow.roomId).cells, graph);
  const rightRoomCellsAfter = refreshCells(graph.roomMap.get(rightRow.roomId).cells, graph);
  for (const c of undefCells) {
    assert.equal(leftRoomCellsAfter.has(c), false, '未定義Roomのセルはleft側のRoomと重ならないはず');
    assert.equal(rightRoomCellsAfter.has(c), false, '未定義Roomのセルはright側のRoomと重ならないはず');
  }
  assertShaftInvariant(graph, '削除後');
});

test('T4: 拒否しても区分を変えない（1セルを屋外＋昇降機で確定→拒否されRoom.kindもfinish状態も不変）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  const candidateRoomId = state.namingRoomId;
  const room = graph.roomMap.get(candidateRoomId);
  const kindBefore = room.kind;
  const snapshotBefore = JSON.stringify(snapshotFinishState(graph));

  const result = state.applyNaming(candidateRoomId, { name: '', kind: RoomKind.EXTERIOR, feature: RoomFeature.ELEVATOR_EQUIPMENT });

  assert.equal(result, null);
  assert.equal(state.lastNamingRejection, ERR_ELEVATOR_EXTERIOR);
  assert.equal(room.kind, kindBefore, '拒否時はRoom.kindが変わらないはず（validateより前にsetKindしてはいけない）');
  assert.equal(JSON.stringify(snapshotFinishState(graph)), snapshotBefore, '拒否時はfinish状態が一切変わらないはず');
});

test('T7: 既存の（未登録の）昇降路Roomの再確定は設置扱いにしない（行が増えず拒否もされない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const cell = worldToCell(2000, 1500, graph);
  const unregistered = graph.addRoom(new Set([cell.key]), '');
  unregistered.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  unregistered.setKind(RoomKind.INTERIOR);

  const result = state.applyNaming(unregistered.id, { name: '', kind: RoomKind.INTERIOR, feature: RoomFeature.ELEVATOR_EQUIPMENT });

  assert.equal(result, null);
  assert.equal(state.lastNamingRejection, null, '既存の昇降路への再確定は拒否されないはず（設置分岐に入らないため）');
  assert.equal(graph.equipmentRows.length, 0, '行は増えないはず（installEquipmentを通らない）');
});

test('_openDialog: 器具選択中に別セルをドラッグして新規候補ダイアログを開くとselectedEquipmentIdがnullに戻る', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(1000, 1500); // left
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];
  state.selectEquipment(row.id);
  assert.equal(state.selectedEquipmentId, row.id, '前提: 器具が選択されている');

  state.startDrag(5000, 1500); // right（leftとは辺で隣接しない未指定セル。新規候補Roomのダイアログが開く）
  state.commitDrag();

  assert.ok(state.namingRoomId, '前提: 新規候補Roomのダイアログが開く');
  assert.equal(state.selectedEquipmentId, null, '_openDialogでselectedEquipmentIdがnullに戻るはず');
});

test('dispose: selectedEquipmentIdがnullに戻る（QA指摘A.3・設計§6）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];
  state.selectEquipment(row.id);
  assert.equal(state.selectedEquipmentId, row.id, '前提: 器具が選択されている');

  state.dispose();

  assert.equal(state.selectedEquipmentId, null);
});

// ================================================================
// ステップ4 S3b: isElevatorInstallIntent・prepareElevatorNaming・applyNaming第4引数equipment
// ================================================================

test('isElevatorInstallIntent: 非昇降機属性→昇降機属性の新規候補は真', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  assert.equal(state.isElevatorInstallIntent(state.namingRoomId, EV_INSTALL), true);
});

test('isElevatorInstallIntent: 内部タブのカード（既存の昇降路Room）の再確定・非昇降機payloadは偽', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const room = graph.roomMap.get(graph.equipmentRows[0].roomId);
  // 既存の昇降路Room（カードの用途変更等）を昇降機のまま渡しても新規設置ではない
  assert.equal(state.isElevatorInstallIntent(room.id, EV_INSTALL), false, '既に昇降機のRoomは新規設置でない');
  // 別の通常Room（名前部屋）へ非昇降機payloadを渡しても新規設置ではない
  const other = graph.addRoom(new Set(), '納戸');
  assert.equal(state.isElevatorInstallIntent(other.id, { name: '納戸', kind: RoomKind.INTERIOR, feature: null }), false);
});

test('isElevatorInstallIntent: 存在しないroomIdは偽', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  assert.equal(state.isElevatorInstallIntent('no-such-id', EV_INSTALL), false);
});

test('prepareElevatorNaming: 状態を一切変えない（snapshotFinishStateのJSON・namingRoomId・_pendingDialogUndoが前後で同一）。拒否文言はapplyNamingと同じ', () => {
  const graph = makeGrid2x2();
  const state = new FinishModeState(graph, null);
  // L字（矩形でない）→拒否されるケースで確認する
  state.startDrag(1000, 750);
  state.updateDrag(3000, 750);
  state.updateDrag(1000, 2250);
  state.commitDrag();
  const roomId = state.namingRoomId;
  const snapshotBefore = JSON.stringify(snapshotFinishState(graph));
  const namingRoomIdBefore = state.namingRoomId;
  const pendingUndoBefore = JSON.stringify(state._pendingDialogUndo);

  const { rejection, cells } = state.prepareElevatorNaming(roomId, EV_INSTALL);

  assert.equal(cells, null);
  assert.equal(JSON.stringify(snapshotFinishState(graph)), snapshotBefore, '状態を変えない');
  assert.equal(state.namingRoomId, namingRoomIdBefore);
  assert.equal(JSON.stringify(state._pendingDialogUndo), pendingUndoBefore);
  assert.equal(state.lastNamingRejection, null, 'prepareElevatorNamingはlastNamingRejectionを書き換えない');

  // applyNamingを実際に呼んだときの拒否文言と一致することを確かめる（検査を2か所に書かない）
  const applyResult = state.applyNaming(roomId, EV_INSTALL);
  assert.equal(applyResult, null);
  assert.equal(state.lastNamingRejection, rejection, 'applyNamingの拒否文言と同一');
});

test('prepareElevatorNaming: 拒否が無ければcellsを返す（refreshCells済み）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  const roomId = state.namingRoomId;
  const room = graph.roomMap.get(roomId);

  const { rejection, cells } = state.prepareElevatorNaming(roomId, EV_INSTALL);

  assert.equal(rejection, null);
  assert.deepEqual(cells, refreshCells(room.cells, graph));
});

test('applyNaming: equipment引数（judgeElevatorInstallの判定結果）を渡すとid・category・usage・noをそのまま使う（採番し直さない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  const roomId = state.namingRoomId;
  const equipment = { id: 'ev-fixed-id', category: ElevatorEquipmentCategory.EV, usage: EvUsage.FREIGHT, no: 7 };

  state.applyNaming(roomId, EV_INSTALL, null, { equipment });

  assert.equal(graph.equipmentRows.length, 1);
  const row = graph.equipmentRows[0];
  assert.equal(row.id, equipment.id);
  assert.equal(row.usage, equipment.usage);
  assert.equal(row.no, equipment.no);
});

test('【失敗系】applyNaming: equipmentを渡したのに新規設置でない（isElevatorInstallIntent偽）場合はthrowする（黙って無視しない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(), '納戸');
  const equipment = { id: 'x', category: ElevatorEquipmentCategory.EV, usage: DEFAULT_EV_USAGE, no: 1 };

  assert.throws(() => state.applyNaming(room.id, { name: '納戸', kind: RoomKind.INTERIOR, feature: null }, null, { equipment }));
});

test('equipmentCatalog: projectがあれば建物全体（buildingEquipmentCatalog）を返す', () => {
  const graph = makeSingleCellGraph();
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', graph.plane.id);
  project.addPlane(3000, '2階', 'p2');
  project.replaceEquipmentIndex([['p2', [{ id: 'other', category: 'ev', no: 5, usage: 'passenger' }]]]);
  const state = new FinishModeState(graph, project);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);

  const catalog = state.equipmentCatalog();

  assert.equal(catalog.length, 2);
  assert.ok(catalog.some(c => c.id === 'other'), '他階(project.equipmentIndex)の器具も含む');
});

test('equipmentSpanLabel: projectがあれば全採用階から設置階〜最上階を返す', () => {
  const graph = makeSingleCellGraph();
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', graph.plane.id);
  project.addPlane(3000, '2階', 'p2');
  const state = new FinishModeState(graph, project);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const id = graph.equipmentRows[0].id;
  project.replaceEquipmentIndex([['p2', [{ id, category: 'ev', no: 1, usage: 'passenger' }]]]);

  assert.equal(state.equipmentSpanLabel(id), '1階〜2階');
});

test('【QA回帰・M1】equipmentCatalog: アクティブ階が検討案の平面（project.planesに無い）なら2基設置してもnoが1・2で重複しない（FinishModeStateを通した形）', () => {
  const graph = makeThreeCellGraph(); // plane.id='p1'（projectには一切登録しない＝検討案扱い）
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階（採用）', 'adopted-p1'); // 採用階は別id。混ざらないことを確認する対象
  project.replaceEquipmentIndex([['adopted-p1', [{ id: 'other', category: 'ev', no: 9, usage: 'passenger' }]]]);
  const state = new FinishModeState(graph, project);

  state.startDrag(1000, 1500); // left
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  state.startDrag(5000, 1500); // right（leftとは辺で隣接しない位置。2基別Room）
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);

  const catalog = state.equipmentCatalog();
  assert.deepEqual(catalog.map(c => c.no).sort(), [1, 2], '検討案の平面では自階だけの採番でnoが重複しないはず');
  assert.ok(!catalog.some(c => c.id === 'other'), '採用階(project.equipmentIndex)の器具は混ざらないはず');
});

test('equipmentSpanLabel: projectが無ければ自階の階名だけ（ステップ3の挙動のまま）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const id = graph.equipmentRows[0].id;

  assert.equal(state.equipmentSpanLabel(id), graph.plane.name);
});

// ================================================================
// S3 失敗系
// ================================================================

test('S3失敗系: L字（矩形でない選択）は拒否され、lastNamingRejectionが矩形の文言・namingRoomIdと候補Roomは残る。その後「なし」で確定すると1エントリで作成ごと戻る', () => {
  const graph = makeGrid2x2();
  const state = new FinishModeState(graph, null);
  // L字: 左上・右上・左下の3セル（右下は含めない）
  state.startDrag(1000, 750);
  state.updateDrag(3000, 750);
  state.updateDrag(1000, 2250);
  state.commitDrag();
  assert.ok(state.namingRoomId);
  const candidateRoomId = state.namingRoomId;
  const candidatePendingUndo = state._pendingDialogUndo;
  const snapshotBeforeReject = JSON.stringify(candidatePendingUndo);
  const undoCountBefore = undoManager._undoStack.length;

  const result = state.applyNaming(candidateRoomId, EV_INSTALL);

  assert.equal(result, null);
  assert.equal(state.lastNamingRejection, ERR_ELEVATOR_NOT_RECTANGLE);
  assert.equal(state.namingRoomId, candidateRoomId, '拒否後もnamingRoomIdは保持されるはず（ダイアログは開いたまま）');
  assert.equal(state.namingIsNew, true);
  assert.notEqual(state.namingCellOrder, null);
  assert.ok(graph.roomMap.has(candidateRoomId), '候補Roomは残るはず');
  assert.equal(JSON.stringify(state._pendingDialogUndo), snapshotBeforeReject, '_pendingDialogUndoは保持されるはず');
  assert.equal(graph.equipmentRows.length, 0, '行は作られないはず');
  assert.equal(undoManager._undoStack.length, undoCountBefore, '拒否時はundoを積まないはず');

  // その後「なし」で確定すると、保持していた_pendingDialogUndoで通常の1エントリになり、作成ごと戻る
  state.applyNaming(candidateRoomId, { name: '', kind: RoomKind.INTERIOR, feature: null });
  assert.equal(undoManager._undoStack.length, undoCountBefore + 1);
  undoManager.undo();
  assert.equal(graph.roomMap.has(candidateRoomId), false, 'undoで候補Roomの作成ごと戻るはず');
});

test('S3失敗系: 屋外は拒否される', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  const candidateRoomId = state.namingRoomId;

  const result = state.applyNaming(candidateRoomId, { name: '', kind: RoomKind.EXTERIOR, feature: RoomFeature.ELEVATOR_EQUIPMENT });

  assert.equal(result, null);
  assert.equal(state.lastNamingRejection, ERR_ELEVATOR_EXTERIOR);
  assert.equal(graph.equipmentRows.length, 0);
  assert.ok(graph.roomMap.has(candidateRoomId));
});

test('S3失敗系: namingIsNew===false（判定2の統合ダイアログ）で昇降機を渡すと拒否される', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);
  const roomA = graph.addRoom(new Set([leftCell.key]), 'A');
  const roomB = graph.addRoom(new Set([midCell.key]), 'B');
  void roomB;

  state.startDrag(1000, 1500);
  state.updateDrag(3000, 1500); // left+midの両方を完全包含（判定2統合）
  state.commitDrag();
  assert.equal(state.namingIsNew, false, '前提: 判定2は既存部屋の統合扱い');
  const dominantId = state.namingRoomId;

  const result = state.applyNaming(dominantId, EV_INSTALL);

  assert.equal(result, null);
  assert.equal(state.lastNamingRejection, ERR_ELEVATOR_NOT_UNASSIGNED);
  assert.equal(graph.equipmentRows.length, 0);
  assert.equal(isShaftFeature(graph.roomMap.get(dominantId).feature), false);
  assert.notEqual(state.namingRoomId, null, 'ダイアログは開いたままのはず');
  void roomA;
});

test('S3失敗系: 既存の部分指定の候補（判定3-その他セル）で昇降機を渡すと拒否される（UIを通さない直接呼び出し）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);
  const parent = graph.addRoom(new Set([leftCell.key, midCell.key]), '親');
  parent.setNamePosition(1000, 1500); // 名前セルはleft。midは「その他セル」

  state.startDrag(3000, 1500); // midのみ（親の名前セルではない）
  state.commitDrag();
  assert.equal(state.namingIsNew, true, '前提: 判定3-その他セルは新規部分指定として開く');
  const partialRoomId = state.namingRoomId;
  assert.equal(graph.roomMap.get(partialRoomId).referenceRoomIds.size, 1, '前提: 部分指定（referenceRoomIds非空）');

  const result = state.applyNaming(partialRoomId, EV_INSTALL);

  assert.equal(result, null);
  assert.equal(state.lastNamingRejection, ERR_ELEVATOR_NOT_UNASSIGNED);
  assert.equal(graph.equipmentRows.length, 0);
});

test('未登録の昇降路（行を持たない旧データのRoom）: セルが部屋ドラッグから外れる／クリックでselectedEquipmentIdがRoomのidになる／新しい器具を隣に設置しても統合されない（Q2）／deleteRoomで消える', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const unregistered = graph.addRoom(new Set([leftCell.key]), '');
  unregistered.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  assert.equal(graph.equipmentRows.length, 0, '前提: 行を持たない（未登録）');

  // セルが部屋ドラッグから外れる
  state.startDrag(1000, 1500);
  assert.equal(state.dragState, null, '未登録の昇降路セルへのstartDragは部屋ドラッグを開始しないはず');
  assert.equal(state.selectedEquipmentId, unregistered.id, 'クリックでselectedEquipmentIdがRoomのidになるはず');

  // 新しい器具を隣に設置しても統合されない（Q2）
  state.startDrag(3000, 1500); // mid（未登録Roomと辺で隣接する未指定セル）
  state.commitDrag();
  assert.ok(state.namingRoomId);
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  assert.equal(graph.equipmentRows.length, 1);
  assert.notEqual(graph.equipmentRows[0].roomId, unregistered.id, '未登録Roomへは統合されないはず（隣接統合の対象外）');
  assert.ok(graph.roomMap.has(unregistered.id), '未登録Roomはそのまま残るはず');

  // deleteRoomで消える（このアプリの一般規約どおり、屋内・子なしRoomの削除は未定義化——
  // roomMapから物理削除されるのは部分指定・屋外部屋のみ。undefined-room-spec.md参照）。
  state.deleteRoom(unregistered.id);
  assert.equal(graph.roomMap.get(unregistered.id).feature, RoomFeature.UNDEFINED,
    '未登録の昇降路Roomの削除も他のRoomと同じく未定義化されるはず');
});

// ================================================================
// S3 配線
// ================================================================

// QA指摘（ステップ3全体・C）: 従来の正規表現（コメント行を除くだけ・部分一致）は、実装を無効化
// しつつ元の式を同じ行の行末コメントとして残す変異（例:
// `if (false) { ... } // if (rejection) { setToast(...); return; }`）でも
// /lastNamingRejection/・/return;/ が本体テキストにマッチし続けるため緑のまま残る（QA実測）。
// 1行まるごとをmフラグの行頭・行末アンカー（^\s*…$）で照合し、トコロテン式の行末コメント残しでは
// マッチしない形に直す（行末に何か続くと$の前提が崩れて不一致になる）。
test('【配線・強化】App.jsx: applyRoomNaming が rejection を読んで1行まるごとの形でreturnし、convertedStair判定より先に評価する', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  assert.match(appSrc, /^\s*const rejection = modeRef\.current\?\.lastNamingRejection;\s*$/m,
    'const rejection = modeRef.current?.lastNamingRejection; が1行まるごとの形で見つからない');
  assert.match(appSrc, /^\s*if \(rejection\) \{ setToast\(\{ msg: rejection, key: Date\.now\(\) \}\); return; \}\s*$/m,
    'if (rejection) { setToast(...); return; } が1行まるごとの形で見つからない');
  const rejectionIdx  = appSrc.indexOf('const rejection = modeRef.current?.lastNamingRejection;');
  const convertedIdx  = appSrc.indexOf('if (convertedStair) {');
  assert.ok(rejectionIdx >= 0 && convertedIdx >= 0 && rejectionIdx < convertedIdx,
    'rejectionの判定はconvertedStairの判定より前にあるはず');
});

test('【配線・強化】App.jsx: <RoomNameInput> へ isNew={mode.namingIsNew} を1行まるごとの形で渡す', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  assert.match(appSrc, /^\s*isNew=\{mode\.namingIsNew\}\s*$/m,
    'isNew={mode.namingIsNew} が1行まるごとの形で見つからない');
});

// ================================================================
// ステップ4 S3b: applyRoomNaming→installElevatorFromNaming の配線
// ================================================================

test('【配線・強化】App.jsx: applyRoomNaming は先頭でisElevatorInstallIntentを見て1行まるごとの形でinstallElevatorFromNamingへ分岐しreturnする（rejection判定より前）', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  assert.match(
    appSrc,
    /^\s*if \(modeRef\.current\?\.isElevatorInstallIntent\(id, payload\)\) \{ guardUi\(installElevatorFromNaming\)\(id, payload\); return; \}\s*$/m,
    'if (modeRef.current?.isElevatorInstallIntent(id, payload)) { guardUi(installElevatorFromNaming)(id, payload); return; } が1行まるごとの形で見つからない',
  );
  const intentIdx = appSrc.indexOf('if (modeRef.current?.isElevatorInstallIntent(id, payload))');
  const rejectionIdx = appSrc.indexOf('const rejection = modeRef.current?.lastNamingRejection;');
  assert.ok(intentIdx >= 0 && rejectionIdx >= 0 && intentIdx < rejectionIdx,
    'isElevatorInstallIntentの分岐はrejection判定より前にあるはず');
});

test('【配線・強化】App.jsx: installElevatorFromNamingの関門内でstructuralSync.whenIdle()の待ちが動的import(equipmentFloorSync.js)より前', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const bodyStart = appSrc.indexOf('async function installElevatorFromNaming(id, payload) {');
  assert.ok(bodyStart >= 0, 'installElevatorFromNaming本体が見つからない');
  const bodyEnd = appSrc.indexOf('\n  }', bodyStart); // 関数本体末尾（2スペースインデントの閉じ括弧）
  const body = appSrc.slice(bodyStart, bodyEnd >= 0 ? bodyEnd : undefined);
  const whenIdleIdx = body.indexOf('await structuralSync.whenIdle();');
  const importIdx   = body.indexOf("await import('./finish/equipment/equipmentFloorSync.js');");
  assert.ok(whenIdleIdx >= 0 && importIdx >= 0 && whenIdleIdx < importIdx,
    'structuralSync.whenIdle()の待ちはequipmentFloorSync.jsの動的importより前にあるはず');
});

test('【配線・強化】RoomNameInput.jsx: featureOptionsForDialog(room, { isNew }).map(opt => ( を1行まるごとの形で呼ぶ', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../finish/RoomNameInput.jsx'), 'utf8');
  assert.match(src, /^\s*\{featureOptionsForDialog\(room, \{ isNew \}\)\.map\(opt => \(\s*$/m,
    '{featureOptionsForDialog(room, { isNew }).map(opt => ( が1行まるごとの形で見つからない');
});

// ================================================================
// S4: 削除
// ================================================================

test('S4: 1基の削除で、同じidのRoomがUNDEFINEDになり行0件', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];
  const roomId = row.roomId;

  state.deleteEquipment(row.id);

  assert.equal(graph.equipmentRows.length, 0);
  const room = graph.roomMap.get(roomId);
  assert.ok(room, '同じidのRoomが残るはず（未定義化）');
  assert.equal(room.feature, RoomFeature.UNDEFINED);
});

test('S4: 1列3基（1つのRoom）の中央を削除→昇降路Roomが2つ（元のidはno最小の側）と未定義Roomが1つ、3基目のroomIdが付け替わりnoが1・2に詰まる', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell  = worldToCell(1000, 1500, graph);
  const midCell   = worldToCell(3000, 1500, graph);
  const rightCell = worldToCell(5000, 1500, graph);

  state.startDrag(1000, 1500); // left
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  state.startDrag(3000, 1500); // mid（leftと統合）
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  state.startDrag(5000, 1500); // right（midと統合）
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);

  assert.equal(graph.equipmentRows.length, 3);
  const originalRoomId = graph.equipmentRows[0].roomId;
  assert.equal(new Set(graph.equipmentRows.map(r => r.roomId)).size, 1, '前提: 3基とも同じRoom');
  const midRow = graph.equipmentRows.find(r => refreshCells(r.cellKeys, graph).has(midCell.key));
  assertShaftInvariant(graph, '削除前');

  state.deleteEquipment(midRow.id);

  assert.equal(graph.equipmentRows.length, 2, '中央の行だけ消えるはず');
  const remaining = graph.equipmentRows;
  assert.deepEqual(remaining.map(r => r.no).sort(), [1, 2], 'noが1・2に詰まるはず');
  const leftRow  = remaining.find(r => refreshCells(r.cellKeys, graph).has(leftCell.key));
  const rightRow = remaining.find(r => refreshCells(r.cellKeys, graph).has(rightCell.key));
  assert.ok(leftRow && rightRow);
  assert.equal(leftRow.roomId, originalRoomId, '元のRoom（id維持）はno最小の行を含む成分に残るはず');
  assert.notEqual(rightRow.roomId, originalRoomId, '3基目は別Roomへ付け替わるはず（角のみ・非連結）');
  assert.equal(leftRow.no, 1);
  assert.equal(rightRow.no, 2);

  // 空いたセル（中央）は未定義部屋化される
  const undefRoom = graph.rooms.find(r => r.feature === RoomFeature.UNDEFINED
    && refreshCells(r.cells, graph).has(midCell.key));
  assert.ok(undefRoom, '空いたセルの未定義Roomがあるはず');
  assertShaftInvariant(graph, '削除後');
});

test('S4: 削除も用途変更もundo1エントリ。同じ用途は積まない', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];

  let undoCountBefore = undoManager._undoStack.length;
  state.setEquipmentUsage(row.id, EvUsage.FREIGHT);
  assert.equal(undoManager._undoStack.length, undoCountBefore + 1);
  assert.equal(graph.equipmentRows[0].usage, EvUsage.FREIGHT);

  undoCountBefore = undoManager._undoStack.length;
  state.setEquipmentUsage(row.id, EvUsage.FREIGHT); // 同値
  assert.equal(undoManager._undoStack.length, undoCountBefore, '同値はundoを積まないはず');

  undoCountBefore = undoManager._undoStack.length;
  state.deleteEquipment(row.id);
  assert.equal(undoManager._undoStack.length, undoCountBefore + 1);
});

test('S4: buildEquipmentTabEntriesに未登録のRoomが並ぶ', async () => {
  const { buildEquipmentTabEntries } = await import('../finish/equipment/equipmentTab.js');
  const graph = makeSingleCellGraph();
  const room = graph.addRoom(new Set(['dummy']), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const entries = buildEquipmentTabEntries({
    rows: graph.equipmentRows, rooms: graph.rooms, symbols: new Map(),
    spanLabelOf: () => '1階', currentFloorLabel: '1階',
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'unregistered');
  assert.equal(entries[0].roomId, room.id);
});

test('S4失敗系: 行のroomIdが存在しないRoomを指している（壊れたデータ）→行だけ消えて例外にならない', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  graph.addEquipmentRow({
    id: 'orphan', category: ElevatorEquipmentCategory.EV, usage: DEFAULT_EV_USAGE, no: 1,
    cellKeys: new Set(['dummy']), roomId: 'no-such-room',
  });

  assert.doesNotThrow(() => state.deleteEquipment('orphan'));
  assert.equal(graph.equipmentRows.length, 0);
});

test('S4失敗系: 存在しない器具idの削除は何もせずundoも積まない', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const undoCountBefore = undoManager._undoStack.length;

  state.deleteEquipment('no-such-id');

  assert.equal(undoManager._undoStack.length, undoCountBefore, '存在しないidの削除はundoを積まないはず');
});

test('S4: _deleteRoomNoUndoが昇降路のRoomを消すとき、そのRoomを指す行も消える', () => {
  const graph = makeGrid2x2();
  const state = new FinishModeState(graph, null);
  dragFullGrid2x2(state);
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];
  const roomId = row.roomId;
  const room = graph.roomMap.get(roomId);
  // deleteRoomは通常セル除外により昇降路Roomに到達しないはずだが、防御的な道連れ削除を直接確認する。
  room.referenceRoomIds.clear(); // _deleteRoomNoUndoの分岐（親/単一=未定義化）を通す

  state.deleteRoom(roomId);

  assert.equal(graph.equipmentRows.some(r => r.roomId === roomId), false, 'ぶら下がった行が残らないはず');
});

test('【防御】commitDragのroomsフィルタは、dragStateへ紛れ込んだ昇降路セルをRoomの拡張・統合対象から除外する（通常はセル除外で到達しないが二重の守り）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);
  const shaftRoom = graph.addRoom(new Set([leftCell.key]), '');
  shaftRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  state.startDrag(3000, 1500); // mid（未指定セル）
  assert.ok(state.dragState);
  // 通常は_roomExcludedStairKeys経由の除外でleftCellはvisitedCellsに入らないが、
  // ドリフト（何らかの理由でstairKeysの捕捉漏れ）を模して直接混入させる。
  state.dragState.visitedCells.set(leftCell.key, leftCell);

  state.commitDrag();

  assert.deepEqual([...refreshCells(shaftRoom.cells, graph)], [leftCell.key],
    '昇降路RoomのセルはcommitDragのroomsフィルタで拡張・統合の対象外のため変わらないはず');
  void midCell;
});

test('undo→redo→undo: 削除後の各時点でRoom・行の全フィールドが一致する', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];
  const roomId = row.roomId;
  const afterInstallRowData = graph.equipmentRows[0].toData();
  const afterInstallRoomCells = [...graph.roomMap.get(roomId).cells];

  state.deleteEquipment(row.id);
  const afterDeleteRoomFeature = graph.roomMap.get(roomId).feature;
  assert.equal(afterDeleteRoomFeature, RoomFeature.UNDEFINED);
  assert.equal(graph.equipmentRows.length, 0);

  undoManager.undo();
  assert.equal(graph.equipmentRows.length, 1);
  assert.deepEqual(graph.equipmentRows[0].toData(), afterInstallRowData, 'undo後の行は削除前と全フィールド一致するはず');
  assert.deepEqual([...graph.roomMap.get(roomId).cells], afterInstallRoomCells);
  assert.equal(isShaftFeature(graph.roomMap.get(roomId).feature), true);

  undoManager.redo();
  assert.equal(graph.equipmentRows.length, 0);
  assert.equal(graph.roomMap.get(roomId).feature, RoomFeature.UNDEFINED, 'redo後は削除後の状態に戻るはず');

  undoManager.undo();
  assert.equal(graph.equipmentRows.length, 1);
  assert.deepEqual(graph.equipmentRows[0].toData(), afterInstallRowData, '2回目のundoでも同じ状態に戻るはず');
});

// ================================================================
// installEquipment 単体: Q7（3つ以上の昇降路Roomに同時に辺で接する場合の全結合）
// ================================================================

test('installEquipment: 新しい器具が2つの昇降路Roomに同時に辺で接する（間を埋める）→Roomが1つにまとまり3行すべてが同じroomId、消えたRoomを指す行が無い', () => {
  const graph = makeThreeCellGraph();
  const leftCell  = worldToCell(1000, 1500, graph);
  const midCell   = worldToCell(3000, 1500, graph);
  const rightCell = worldToCell(5000, 1500, graph);

  const leftRoom  = graph.addRoom(new Set([leftCell.key]), '');
  leftRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const rightRoom = graph.addRoom(new Set([rightCell.key]), '');
  rightRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.addEquipmentRow({ id: 'eq-left', category: 'ev', usage: DEFAULT_EV_USAGE, no: 1, cellKeys: new Set([leftCell.key]), roomId: leftRoom.id });
  graph.addEquipmentRow({ id: 'eq-right', category: 'ev', usage: DEFAULT_EV_USAGE, no: 2, cellKeys: new Set([rightCell.key]), roomId: rightRoom.id });

  const { roomId } = installEquipment(graph, {
    id: 'eq-mid', category: 'ev', usage: DEFAULT_EV_USAGE, no: 3, cells: new Set([midCell.key]),
  });

  const roomIds = new Set(graph.equipmentRows.map(r => r.roomId));
  assert.equal(roomIds.size, 1, '3行すべてが同じroomIdにまとまるはず');
  assert.ok(roomIds.has(roomId));
  assert.equal(graph.roomMap.has(leftRoom.id) && graph.roomMap.has(rightRoom.id), false,
    '統合元の2つのうち少なくとも一方は消えるはず（統合先以外）');
  for (const r of [leftRoom, rightRoom]) {
    if (r.id !== roomId) assert.equal(graph.roomMap.has(r.id), false, '消えたRoomを指す行が無いはず（付け替え済み）');
  }
  assertShaftInvariant(graph);
});

// ================================================================
// S4 配線
// ================================================================

// QA指摘（ステップ3全体・C）: 部分一致（コメント除去のみ）は「実装を無効化しつつ元の式を
// 同じ行の行末コメントとして残す変異」を検出できない。1行まるごとをmフラグの行頭・行末
// アンカー（^\s*…$）で照合する形へ直す。
test('【配線・強化】FinishTable.jsx: mode.selectedEquipmentId が立ったら activeTab を equipment へ切り替える effect が1行まるごとの形である', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../finish/FinishTable.jsx'), 'utf8');
  assert.match(src, /^\s*useEffect\(\(\) => \{ if \(mode\.selectedEquipmentId\) setActiveTab\('equipment'\); \}, \[mode\.selectedEquipmentId\]\);\s*$/m,
    'FinishTable.jsx に selectedEquipmentId の自動切替 effect が1行まるごとの形で見つからない');
});

test('【配線・強化】EquipmentTab.jsx: 用途のonChange・削除の確定・行のonClickが各1行まるごとの形でmodeを呼ぶ', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../finish/equipment/EquipmentTab.jsx'), 'utf8');
  assert.match(src, /^\s*onClick=\{\(\) => mode\.selectEquipment\(entry\.id\)\}\s*$/m,
    'onClick={() => mode.selectEquipment(entry.id)} が1行まるごとの形で見つからない');
  assert.match(src, /^\s*onChange=\{e => mode\.setEquipmentUsage\(entry\.id, e\.target\.value\)\}\s*$/m,
    'onChange={e => mode.setEquipmentUsage(entry.id, e.target.value)} が1行まるごとの形で見つからない');
  assert.match(src, /^\s*if \(value === 'ok'\) mode\.deleteEquipment\(deleteRowId\);\s*$/m,
    "if (value === 'ok') mode.deleteEquipment(deleteRowId); が1行まるごとの形で見つからない");
});

// ================================================================
// S4: 平面のハイライト（selectedEquipmentCellKeys）
// ================================================================

test('selectedEquipmentCellKeys: 選択に追従する（未選択は空・器具行選択でその行のセル・部屋/階段選択に切り替わると空に戻る）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const cell = worldToCell(2000, 1500, graph);
  assert.deepEqual([...state.selectedEquipmentCellKeys], [], '前提: 未選択は空集合');

  state.startDrag(2000, 1500);
  state.commitDrag();
  state.applyNaming(state.namingRoomId, EV_INSTALL);
  const row = graph.equipmentRows[0];

  assert.deepEqual([...state.selectedEquipmentCellKeys], [cell.key], '選択中の器具のセルを返すはず');

  const otherRoom = graph.addRoom(new Set(['dummy']), '部屋');
  state.selectRoom(otherRoom.id);
  assert.deepEqual([...state.selectedEquipmentCellKeys], [], '部屋選択に切り替わると空に戻るはず');

  state.selectEquipment(row.id);
  assert.deepEqual([...state.selectedEquipmentCellKeys], [cell.key], '再選択で戻るはず');
});
