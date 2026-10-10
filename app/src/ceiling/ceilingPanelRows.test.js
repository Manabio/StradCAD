// 天伏パネルの行の組み立て（純モジュール）。内部タブは仕上げ表の述語（interiorTabRooms）と一致する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType, DEFAULT_CEILING_PANEL, DEFAULT_CEILING_FINISH } from '@core';
import { makeGrid } from '../plan/planTestFixtures.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { interiorRows, stairRows, selectionSummary, ceilingWriteTargetRoom, materialDisplay } from './ceilingPanelRows.js';

const XS = [0, 1000, 2000, 3000, 4000, 5000, 6000];

test('interiorRows: 列は 名前・天井材・仕上げ・CH(raw)。屋外・STAIR_VOID・UNDEFINED は載らず、仕上げ表の述語と同じ部屋・同じ並び', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  a.finish.ceilingMaterial = 'PB9.5'; // 旧の自由文字列は表示に使わない（データとしては残る）
  const b = g.interior([[1, 0]]);
  const out = g.interior([[2, 0]]);
  out.setKind(RoomKind.EXTERIOR);
  g.feature([[3, 0]], RoomFeature.STAIR_VOID);
  g.feature([[4, 0]], RoomFeature.UNDEFINED);
  const rows = interiorRows(g.graph);
  assert.deepEqual(rows.map(r => r.id), [a.id, b.id]);
  assert.deepEqual(rows.map(r => r.id), interiorTabRooms(g.graph).map(r => r.id));
  assert.equal(rows[0].name, '居間');
  assert.equal(rows[0].ceilingBoard, DEFAULT_CEILING_PANEL); // materialMap なし＝コードのまま
  assert.equal(rows[0].ceilingFinish, DEFAULT_CEILING_FINISH);
  assert.equal(rows[0].ch, roomCeilingHeight(g.graph, a).raw);
  assert.equal(rows[1].ceilingBoard, DEFAULT_CEILING_PANEL);
});

const MATERIAL_MAP = new Map([
  [DEFAULT_CEILING_PANEL,  { code: DEFAULT_CEILING_PANEL,  name: 'せっこうボード t=9.5' }],
  [DEFAULT_CEILING_FINISH, { code: DEFAULT_CEILING_FINISH, name: 'ビニールクロス' }],
  ['301000000002',         { code: '301000000002',         name: 'せっこうボード t=12.5' }],
]);

test('interiorRows: materialMap があれば既定の天井材・仕上げは略称表示（「PB ア)9.5」「ビニールクロス」）', () => {
  const g = makeGrid(XS, [0, 1000]);
  g.interior([[0, 0]]);
  const [row] = interiorRows(g.graph, MATERIAL_MAP);
  assert.equal(row.ceilingBoard, 'PB ア)9.5');
  assert.equal(row.ceilingFinish, 'ビニールクロス');
});

test('interiorRows: ceilingPanel の override があればその材（略称表示）。clearOverride で既定に戻る', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  a.setOverride('ceilingPanel', '301000000002');
  assert.equal(interiorRows(g.graph, MATERIAL_MAP)[0].ceilingBoard, 'PB ア)12.5');
  a.clearOverride('ceilingPanel');
  assert.equal(interiorRows(g.graph, MATERIAL_MAP)[0].ceilingBoard, 'PB ア)9.5');
});

test('【失敗系】interiorRows: コードが materialMap で解けなければコードのまま出す（例外にしない）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  a.setOverride('ceilingFinish', '999999999999');
  const [row] = interiorRows(g.graph, MATERIAL_MAP);
  assert.equal(row.ceilingFinish, '999999999999');
  assert.equal(row.ceilingBoard, 'PB ア)9.5');
});

test('ceilingWriteTargetRoom: 部屋の選択はその部屋、階段は stair.roomId の部屋、部屋の無い階段・消えた所属・選択なしは null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  const stairRoom = g.feature([[1, 0]], RoomFeature.STAIR);
  const withRoom = g.graph.addStair({ type: StairType.STRAIGHT, roomId: stairRoom.id });
  const bare = g.graph.addStair({ type: StairType.WINDING });
  const sel = (kind, id, rowId = id) => ({ owner: { kind, id, rowId }, cellKeys: new Set() });
  assert.equal(ceilingWriteTargetRoom(g.graph, sel('room', a.id)), a);
  assert.equal(ceilingWriteTargetRoom(g.graph, sel('stair', withRoom.id, stairRoom.id)), stairRoom);
  assert.equal(ceilingWriteTargetRoom(g.graph, sel('stair', bare.id)), null);
  assert.equal(ceilingWriteTargetRoom(g.graph, sel('room', 'gone')), null);
  assert.equal(ceilingWriteTargetRoom(g.graph, sel('stair', 'gone')), null);
  assert.equal(ceilingWriteTargetRoom(g.graph, null), null);
});

test('materialDisplay: 空コードは null、materialMap なしはコードのまま、名前が無い材もコードのまま', () => {
  assert.equal(materialDisplay(MATERIAL_MAP, ''), null);
  assert.equal(materialDisplay(MATERIAL_MAP, undefined), null);
  assert.equal(materialDisplay(null, '301000000001'), '301000000001');
  assert.equal(materialDisplay(new Map([['x', { code: 'x' }]]), 'x'), 'x');
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
  assert.equal(rows[1].ceilingBoard, null);
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

test('selectionSummary: 部屋の選択は 名前・解けたセル数・CH(raw)。selection が null なら null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0], [1, 0]]);
  const sel = { owner: { kind: 'room', id: a.id, rowId: a.id }, cellKeys: new Set([g.cell(0, 0), g.cell(1, 0)]) };
  assert.deepEqual(selectionSummary(g.graph, sel), { name: '居間', cellCount: 2, ch: roomCeilingHeight(g.graph, a).raw });
  assert.equal(selectionSummary(g.graph, null), null);
});

test('selectionSummary: 部屋の無い階段は 名前「タイプ 段数」・ch=null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const s = g.graph.addStair({ type: StairType.STRAIGHT, totalSteps: 12, cells: new Set([g.cell(0, 0)]) });
  const sel = { owner: { kind: 'stair', id: s.id, rowId: s.id }, cellKeys: new Set([g.cell(0, 0)]) };
  assert.deepEqual(selectionSummary(g.graph, sel), { name: '直進 12段', cellCount: 1, ch: null });
});

test('【失敗系】selectionSummary: 解けないキーは数えない。行が見つからなければ名前「—」・ch=null（例外にしない）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  const sel = { owner: { kind: 'room', id: a.id, rowId: a.id }, cellKeys: new Set([g.cell(0, 0), 'gone:gone:gone:gone']) };
  assert.equal(selectionSummary(g.graph, sel).cellCount, 1);
  const lost = { owner: { kind: 'room', id: 'x', rowId: 'x' }, cellKeys: new Set([g.cell(0, 0)]) };
  assert.deepEqual(selectionSummary(g.graph, lost), { name: '—', cellCount: 1, ch: null });
});
