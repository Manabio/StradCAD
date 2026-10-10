// 仕上げ表「内部」タブの部屋の述語（純モジュール）。FinishTable.jsx と天伏パネルの共用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature } from '@core';
import { makeGrid } from '../plan/planTestFixtures.js';
import { interiorTabRooms, interiorRoomDisplayName } from './interiorTabRooms.js';

test('interiorTabRooms: 屋内の通常部屋・屋内階段は載り、屋外・STAIR_VOID・UNDEFINED・昇降路は載らない（graph.rooms の順）', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000, 5000, 6000], [0, 1000]);
  const normal = g.interior([[0, 0]]);
  const stair = g.feature([[1, 0]], RoomFeature.STAIR);
  const outdoor = g.interior([[2, 0]]);
  outdoor.setKind(RoomKind.EXTERIOR);
  g.feature([[3, 0]], RoomFeature.STAIR_VOID);
  g.feature([[4, 0]], RoomFeature.UNDEFINED);
  g.feature([[5, 0]], RoomFeature.ELEVATOR_EQUIPMENT);
  assert.deepEqual(interiorTabRooms(g.graph).map(r => r.id), [normal.id, stair.id]);
});

test('【失敗系】interiorTabRooms: 部屋が1つも無い階は空配列（例外にしない）', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  assert.deepEqual(interiorTabRooms(g.graph), []);
});

test('interiorRoomDisplayName: 名前が空なら階段室は「階段」・それ以外は「（名称未設定）」', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const a = g.interior([[0, 0]]);
  const s = g.feature([[1, 0]], RoomFeature.STAIR);
  assert.equal(interiorRoomDisplayName(a), '居間');
  a.setName('');
  s.setName('');
  assert.equal(interiorRoomDisplayName(a), '（名称未設定）');
  assert.equal(interiorRoomDisplayName(s), '階段');
});
