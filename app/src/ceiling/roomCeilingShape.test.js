// roomCeilingShape.js（部屋の天井の形状・寸法。customOverrides の ceilingShape／ceilingDims。S12a）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph } from '@core';
import { undoManager } from '../undoManager.js';
import { withFinishUndo } from '../finish/finishUndo.js';
import { makeRoomUndefined } from '../finish/roomUndefined.js';
import { snapshotRoomsState, restoreRoomsState } from '../finish/roomReinterpret.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { makeGrid } from '../plan/planTestFixtures.js';
import {
  roomCeilingShapeOf, setRoomCeilingShape, applyRoomCeilingHeightDraft, ROOM_CEILING_SHAPE_KEY, ROOM_CEILING_DIMS_KEY,
} from './roomCeilingShape.js';

const room1 = () => makeGrid([0, 2000], [0, 3000]).interior([[0, 0]]);

test('既定は平面（キーなし）', () => {
  const room = room1();
  assert.deepEqual(roomCeilingShapeOf(room), { shape: 'flat', dims: [] });
  assert.equal(room.customOverrides.size, 0);
});

test('書込みと読戻し: slope [500,90]・arc [300,0]・dome [400]。キーは customOverrides の文字列', () => {
  const room = room1();
  for (const spec of [{ shape: 'slope', dims: [500, 90] }, { shape: 'arc', dims: [300, 0] }, { shape: 'dome', dims: [400] }]) {
    assert.deepEqual(setRoomCeilingShape(room, spec), spec);
    assert.deepEqual(roomCeilingShapeOf(room), spec);
  }
  assert.equal(room.customOverrides.get(ROOM_CEILING_SHAPE_KEY), 'dome');
  assert.equal(room.customOverrides.get(ROOM_CEILING_DIMS_KEY), '400');
  setRoomCeilingShape(room, { shape: 'slope', dims: [500, 90] });
  assert.equal(room.customOverrides.get(ROOM_CEILING_DIMS_KEY), '500,90');
});

test('平面を書くと2キーとも消える。不正な指定（正規化で平面に落ちる）も同じ', () => {
  const room = room1();
  setRoomCeilingShape(room, { shape: 'slope', dims: [500, 90] });
  setRoomCeilingShape(room, { shape: 'flat', dims: [] });
  assert.equal(room.customOverrides.has(ROOM_CEILING_SHAPE_KEY), false);
  assert.equal(room.customOverrides.has(ROOM_CEILING_DIMS_KEY), false);
  setRoomCeilingShape(room, { shape: 'dome', dims: [400] });
  assert.deepEqual(setRoomCeilingShape(room, { shape: 'slope', dims: [-5, 90] }), { shape: 'flat', dims: [] }, '負のライズ');
  assert.equal(room.customOverrides.size, 0, '不正値は書かず、前の値も消える');
});

test('【失敗系】壊れた dims・未知の形状・個数違い・負のライズ・列挙外の向きは平面・[]（例外にしない）', () => {
  const room = room1();
  const cases = [
    ['slope', ''], ['slope', 'a,b'], ['slope', '500'], ['slope', '500,45'], ['slope', '-500,90'], ['slope', '0,90'],
    ['arc', '300,30'], ['dome', ''], ['dome', 'x'], ['wavy', '1,2'], ['', '500,90'],
  ];
  for (const [shape, dims] of cases) {
    room.customOverrides.set(ROOM_CEILING_SHAPE_KEY, shape);
    room.customOverrides.set(ROOM_CEILING_DIMS_KEY, dims);
    assert.deepEqual(roomCeilingShapeOf(room), { shape: 'flat', dims: [] }, `${shape} / ${dims}`);
  }
  room.customOverrides.delete(ROOM_CEILING_DIMS_KEY);
  room.customOverrides.set(ROOM_CEILING_SHAPE_KEY, 'slope');
  assert.deepEqual(roomCeilingShapeOf(room), { shape: 'flat', dims: [] }, 'dims キーなし');
});

test('【失敗系】dims の解析は厳密（S12b）: 空要素 "500,,90"・16進 "0x1F4,0"・余分な要素 "500,90,7"・指数 "5e2,90"・空白だけは平面。空白つきの正しい値と小数は読める', () => {
  const room = room1();
  for (const [shape, dims] of [['slope', '500,,90'], ['slope', '0x1F4,0'], ['slope', '500,90,7'], ['slope', '5e2,90'], ['slope', ',500'], ['slope', '  '], ['dome', '400,'], ['dome', '4 00']]) {
    room.customOverrides.set(ROOM_CEILING_SHAPE_KEY, shape);
    room.customOverrides.set(ROOM_CEILING_DIMS_KEY, dims);
    assert.deepEqual(roomCeilingShapeOf(room), { shape: 'flat', dims: [] }, `${shape} / ${dims}`);
  }
  room.customOverrides.set(ROOM_CEILING_SHAPE_KEY, 'slope');
  room.customOverrides.set(ROOM_CEILING_DIMS_KEY, ' 500.5 , 90 ');
  assert.deepEqual(roomCeilingShapeOf(room), { shape: 'slope', dims: [500.5, 90] });
});

test('【失敗系】room が null／getFinishInfo を持たないときは平面', () => {
  assert.deepEqual(roomCeilingShapeOf(null), { shape: 'flat', dims: [] });
  assert.deepEqual(roomCeilingShapeOf(undefined), { shape: 'flat', dims: [] });
  assert.deepEqual(roomCeilingShapeOf({}), { shape: 'flat', dims: [] });
});

test('applyRoomCeilingHeightDraft: 原文不変は触らない・空は clear・正数は数値で set・不正は false で書かない', () => {
  const room = room1();
  room.setOverride('ceilingHeight', '2300～3500');
  assert.equal(applyRoomCeilingHeightDraft(room, '2300～3500', '2300～3500'), true);
  assert.equal(room.customOverrides.get('ceilingHeight'), '2300～3500', 'レンジ表記を壊さない');
  assert.equal(applyRoomCeilingHeightDraft(room, ' 2700 ', '2300～3500'), true);
  assert.strictEqual(room.customOverrides.get('ceilingHeight'), 2700);
  for (const bad of ['abc', '0', '-100', '2300～3500', 'NaN', 'Infinity']) {
    assert.equal(applyRoomCeilingHeightDraft(room, bad, '2700'), false, bad);
    assert.strictEqual(room.customOverrides.get('ceilingHeight'), 2700, `${bad} は書かない`);
  }
  assert.equal(applyRoomCeilingHeightDraft(room, '', '2700'), true);
  assert.equal(room.customOverrides.has('ceilingHeight'), false, '空は override を消す');
  assert.equal(applyRoomCeilingHeightDraft(room, '', ''), true, '空→空は触らない');
});

test('snapshotRoomsState→restoreRoomsState の往復で形状が戻る', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  setRoomCeilingShape(room, { shape: 'slope', dims: [500, 90] });
  const snap = snapshotRoomsState(g.graph);
  setRoomCeilingShape(room, { shape: 'flat', dims: [] });
  restoreRoomsState(g.graph, snap);
  assert.deepEqual(roomCeilingShapeOf(g.graph.roomMap.get(room.id)), { shape: 'slope', dims: [500, 90] });
});

test('FBS encode→decode の往復で文字列 dims が同じ値に戻る（形状なしの部屋は平面のまま）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  const b = g.interior([[1, 0]]);
  setRoomCeilingShape(a, { shape: 'arc', dims: [300, 90] });
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, serializeGraph(g.graph));
  assert.deepEqual(roomCeilingShapeOf(restored.roomMap.get(a.id)), { shape: 'arc', dims: [300, 90] });
  assert.deepEqual(roomCeilingShapeOf(restored.roomMap.get(b.id)), { shape: 'flat', dims: [] });
});

test('makeRoomUndefined で形状は消える', () => {
  const room = room1();
  setRoomCeilingShape(room, { shape: 'dome', dims: [400] });
  makeRoomUndefined(room);
  assert.deepEqual(roomCeilingShapeOf(room), { shape: 'flat', dims: [] });
});

test('undo 往復: withFinishUndo で setRoomCeilingShape → undo で平面、redo で戻る。同じ値の再設定はエントリを積まない', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  const stack = undoManager._undoStack.length;
  withFinishUndo(g.graph, () => setRoomCeilingShape(room, { shape: 'slope', dims: [500, 90] }));
  assert.equal(undoManager._undoStack.length, stack + 1);
  withFinishUndo(g.graph, () => setRoomCeilingShape(g.graph.roomMap.get(room.id), { shape: 'slope', dims: [500, 90] }));
  assert.equal(undoManager._undoStack.length, stack + 1, '差分なしなら積まない');
  undoManager.undo();
  assert.deepEqual(roomCeilingShapeOf(g.graph.roomMap.get(room.id)), { shape: 'flat', dims: [] });
  undoManager.redo();
  assert.deepEqual(roomCeilingShapeOf(g.graph.roomMap.get(room.id)), { shape: 'slope', dims: [500, 90] });
  undoManager.undo();
});
