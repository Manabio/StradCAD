// 部屋の取り合いの割当て（Room.detailRefs）の仕上げ undo のテスト（部分詳細図 S8a）。finishUndo.roofZones.test.js と同型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph } from '../core.js';
import { DetailSlot, RoomFeature } from '../core/constants.js';
import { undoManager } from '../undoManager.js';
import { withFinishUndo, snapshotFinishState } from './finishUndo.js';
import { roomDetailRefsAfterSelect } from './roomDetailRefsEdit.js';

const { FLOOR_WALL, WALL_CEILING } = DetailSlot;

function graphWithRoom() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const room = graph.addRoom(new Set(['c1:r1']), '居間', 'rm0');
  return { graph, room };
}

test('仕上げ undo の snapshot の rooms に detailRefs が載る（割当てなしは null）', () => {
  const { graph, room } = graphWithRoom();
  assert.equal(snapshotFinishState(graph).rooms.rooms[0].detailRefs, null);
  room.setDetailRefs({ [FLOOR_WALL]: 'df-1' });
  assert.deepEqual(snapshotFinishState(graph).rooms.rooms[0].detailRefs, { [FLOOR_WALL]: 'df-1' });
});

test('割当ての選択を withFinishUndo で包むと undo/redo で戻る（1 エントリずつ）。別の仕上げ操作を挟んでも失われない', () => {
  const { graph, room } = graphWithRoom();
  const before = undoManager._undoStack.length;
  withFinishUndo(graph, () => room.setDetailRefs(roomDetailRefsAfterSelect(room, FLOOR_WALL, 'df-1')));
  withFinishUndo(graph, () => room.setDetailRefs(roomDetailRefsAfterSelect(room, WALL_CEILING, 'df-2')));
  assert.equal(undoManager._undoStack.length, before + 2);
  assert.deepEqual(room.detailRefs, { [FLOOR_WALL]: 'df-1', [WALL_CEILING]: 'df-2' });
  withFinishUndo(graph, () => room.setName('居間2')); // 別の仕上げ操作
  undoManager.undo();
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1', [WALL_CEILING]: 'df-2' }, '別操作の undo で割当てが失われない');
  undoManager.undo();
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1' }, 'undo で 2 つ目の選択が戻る');
  undoManager.undo();
  assert.equal(graph.roomMap.get('rm0').detailRefs, null, 'undo で最初の選択も戻り null');
  undoManager.redo();
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1' }, 'redo で戻る');
  undoManager.redo();
  undoManager.redo();
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1', [WALL_CEILING]: 'df-2' });
  undoManager.undo(); undoManager.undo(); undoManager.undo(); // 後始末（積んだ分を戻す）
});

test('部屋の削除（feature=undefined 化）でも detailRefs は残り、undo で feature ごと戻り、redo で再び undefined 化される', () => {
  const { graph, room } = graphWithRoom();
  room.setDetailRefs({ [FLOOR_WALL]: 'df-1' });
  withFinishUndo(graph, () => room.setFeature(RoomFeature.UNDEFINED));
  assert.equal(graph.roomMap.get('rm0').feature, RoomFeature.UNDEFINED);
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1' }, '削除で割当てを捨てない');
  undoManager.undo();
  assert.equal(graph.roomMap.get('rm0').feature, null);
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1' }, 'undo 後も割当てが残る');
  undoManager.redo();
  assert.equal(graph.roomMap.get('rm0').feature, RoomFeature.UNDEFINED);
  assert.deepEqual(graph.roomMap.get('rm0').detailRefs, { [FLOOR_WALL]: 'df-1' }, 'redo 後も割当てが残る');
  undoManager.undo(); // 後始末
});

test('【不変条件】部屋カードの「部分詳細」select の変更は withFinishUndo(graph, () => …) 経由（undo 対象）で、判断は roomDetailRefsAfterSelect を通る', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'FinishTable.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/withFinishUndo\(graph, \(\) => room\.setDetailRefs\(roomDetailRefsAfterSelect\(room, sel\.slot, e\.target\.value\)\)\)/.test(src),
    'room.setDetailRefs(roomDetailRefsAfterSelect(...)) が withFinishUndo(graph, () => …) の直接引数になっていない');
  assert.ok(/roomDetailRefSelects\(room\)/.test(src), 'select の組み立てが roomDetailRefSelects を通っていない');
});
