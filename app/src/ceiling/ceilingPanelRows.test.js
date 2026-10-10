// 天伏パネルの行の組み立て（純モジュール）。内部タブは仕上げ表の述語（interiorTabRooms）と一致する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType } from '@core';
import { makeGrid } from '../plan/planTestFixtures.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { interiorRows, stairRows } from './ceilingPanelRows.js';

const XS = [0, 1000, 2000, 3000, 4000, 5000, 6000];

test('interiorRows: 列は 名前・仕上げ・CH(raw)・天井材(null)。屋外・STAIR_VOID・UNDEFINED は載らず、仕上げ表の述語と同じ部屋・同じ並び', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  a.finish.ceilingMaterial = 'PB9.5';
  const b = g.interior([[1, 0]]);
  const out = g.interior([[2, 0]]);
  out.setKind(RoomKind.EXTERIOR);
  g.feature([[3, 0]], RoomFeature.STAIR_VOID);
  g.feature([[4, 0]], RoomFeature.UNDEFINED);
  const rows = interiorRows(g.graph);
  assert.deepEqual(rows.map(r => r.id), [a.id, b.id]);
  assert.deepEqual(rows.map(r => r.id), interiorTabRooms(g.graph).map(r => r.id));
  assert.equal(rows[0].name, '居間');
  assert.equal(rows[0].ceilingFinish, 'PB9.5');
  assert.equal(rows[0].ceilingBoard, null);
  assert.equal(rows[0].ch, roomCeilingHeight(g.graph, a).raw);
  assert.equal(rows[1].ceilingFinish, null);
});

test('【失敗系】interiorRows: 数値化できないCHのレンジ表記「2300～3500」は raw のまま出る', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  a.setOverride('ceilingHeight', '2300～3500');
  assert.equal(interiorRows(g.graph)[0].ch, '2300～3500');
});

test('【失敗系】interiorRows: 部屋名が空なら仕上げ表と同じ表示名（通常は「（名称未設定）」・階段室は「階段」）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  const s = g.feature([[1, 0]], RoomFeature.STAIR);
  a.setName('');
  s.setName('');
  const rows = interiorRows(g.graph);
  assert.equal(rows[0].name, interiorRoomDisplayName(a));
  assert.equal(rows[0].name, '（名称未設定）');
  assert.equal(rows[1].name, '階段');
});

test('【失敗系】interiorRows: 部屋が無い階は空配列', () => {
  assert.deepEqual(interiorRows(makeGrid(XS, [0, 1000]).graph), []);
});

test('stairRows: 階段は graph.stairs の順。変換元の部屋があればその名前・CH、無ければ「タイプ 段数」で CH は null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const room = g.feature([[0, 0]], RoomFeature.STAIR);
  room.setName('');
  const s1 = g.graph.addStair({ type: StairType.STRAIGHT, roomId: room.id, totalSteps: 15 });
  const s2 = g.graph.addStair({ type: StairType.SWITCHBACK, totalSteps: 20 });
  const rows = stairRows(g.graph);
  assert.deepEqual(rows.map(r => r.id), [room.id, s2.id]);
  assert.equal(s1.roomId, room.id);
  assert.equal(rows[0].name, '階段');
  assert.equal(rows[0].ch, roomCeilingHeight(g.graph, room).raw);
  assert.equal(rows[1].name, '屈折 20段');
  assert.equal(rows[1].ch, null);
  assert.equal(rows[1].ceilingFinish, null);
});

test('stairRows: 部屋の無い階段の行は kind=stair で選択対象外、部屋のある階段の行は kind=room', () => {
  const g = makeGrid(XS, [0, 1000]);
  const room = g.feature([[0, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: room.id });
  const bare = g.graph.addStair({ type: StairType.WINDING });
  const rows = stairRows(g.graph);
  assert.deepEqual(rows.map(r => r.kind), ['room', 'stair']);
  assert.equal(rows[1].id, bare.id);
  assert.ok(interiorRows(g.graph).every(r => r.kind === 'room'));
});

test('【失敗系】stairRows: 階段が無い階は空配列。変換元の部屋が消えた階段も例外にせず「タイプ 段数」で出す', () => {
  const g = makeGrid(XS, [0, 1000]);
  assert.deepEqual(stairRows(g.graph), []);
  const s = g.graph.addStair({ type: StairType.STRAIGHT, roomId: 'gone', totalSteps: 12 });
  assert.deepEqual(stairRows(g.graph).map(r => [r.id, r.name]), [[s.id, '直進 12段']]);
});
