// 天伏パネルの行の組み立て（純モジュール）。内部タブは仕上げ表の述語（interiorTabRooms）と一致する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType, DEFAULT_CEILING_PANEL, DEFAULT_CEILING_FINISH, CeilingZone } from '@core';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';
import { assignZoneShape } from './ceilingZones.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { interiorRows, stairRows, selectionSummary, selectionSpanMm, ceilingWriteTargetRoom, ceilingZoneTargetRoom, materialDisplay } from './ceilingPanelRows.js';

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
  assert.deepEqual(selectionSummary(g.graph, sel), { name: '居間', cellCount: 2, ch: roomCeilingHeight(g.graph, a).raw, zone: { state: 'none', heightMm: null, shape: 'flat', dims: [] } });
  assert.equal(selectionSummary(g.graph, null), null);
});

test('selectionSummary: 部屋の無い階段は 名前「タイプ 段数」・ch=null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const s = g.graph.addStair({ type: StairType.STRAIGHT, totalSteps: 12, cells: new Set([g.cell(0, 0)]) });
  const sel = { owner: { kind: 'stair', id: s.id, rowId: s.id }, cellKeys: new Set([g.cell(0, 0)]) };
  assert.deepEqual(selectionSummary(g.graph, sel), { name: '直進 12段', cellCount: 1, ch: null, zone: null });
});

test('【失敗系】selectionSummary: 解けないキーは数えない。行が見つからなければ名前「—」・ch=null（例外にしない）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  const sel = { owner: { kind: 'room', id: a.id, rowId: a.id }, cellKeys: new Set([g.cell(0, 0), 'gone:gone:gone:gone']) };
  assert.equal(selectionSummary(g.graph, sel).cellCount, 1);
  const lost = { owner: { kind: 'room', id: 'x', rowId: 'x' }, cellKeys: new Set([g.cell(0, 0)]) };
  assert.deepEqual(selectionSummary(g.graph, lost), { name: '—', cellCount: 1, ch: null, zone: { state: 'none', heightMm: null, shape: 'flat', dims: [] } });
});

// ---- 天井区画（S5）----

test('CH 欄: 区画が効いている部屋は「残りの部屋 CH＋各区画の高さ」の最小～最大、全部同じなら数値。区画の無い部屋・効く区画の無い部屋は従来の raw。部屋の CH 欄（override）は書き換えない', () => {
  const g = makeGrid(XS, [0, 1000]);
  const mixed = g.interior([[0, 0], [1, 0]]);
  mixed.setOverride('ceilingHeight', '2400');
  mixed.setCeilingZones(assignZoneHeight(g.graph, mixed, [g.cell(1, 0)], 2800));
  const same = g.interior([[2, 0]]);
  same.setOverride('ceilingHeight', '2400');
  same.setCeilingZones(assignZoneHeight(g.graph, same, [g.cell(2, 0)], 2400)); // 全域が区画＝残りなし
  const ghost = g.interior([[3, 0]]);
  ghost.setOverride('ceilingHeight', '2300～2500');
  ghost.setCeilingZones([new CeilingZone({ id: 'z', cells: ['gone:gone:gone:gone'], heightMm: 2900 })]); // 効かない
  const plain = g.interior([[4, 0]]);
  plain.setOverride('ceilingHeight', '2350');
  const ch = id => interiorRows(g.graph).find(r => r.id === id).ch;
  assert.equal(ch(mixed.id), '2400～2800');
  assert.equal(ch(same.id), '2400');
  assert.equal(ch(ghost.id), '2300～2500', '効く区画なし＝raw のまま');
  assert.equal(ch(plain.id), '2350');
  assert.equal(mixed.getFinishInfo().ceilingHeight, '2400', 'override は変えない');
  assert.equal(stairRows(g.graph).length, 0);
});

test('部屋 CH がレンジ表記で区画がある場合は raw のまま（既定値と合成しない）。区画の高さが全面に効いて部屋 CH を使う面が無ければ区画の表記', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  r.setOverride('ceilingHeight', '2300～2500');
  r.setCeilingZones(assignZoneHeight(g.graph, r, [g.cell(1, 0)], 2800));
  assert.equal(interiorRows(g.graph).find(x => x.id === r.id).ch, '2300～2500');
  r.setCeilingZones(assignZoneHeight(g.graph, r, [g.cell(0, 0)], 2800));
  assert.equal(interiorRows(g.graph).find(x => x.id === r.id).ch, '2800', '部屋 CH を使う面が無ければ区画だけ');
});

test('CH 欄のレンジ（S6a）: 傾斜の区画は低い側〜低い側＋ライズ。全体が傾斜でも、半分だけ傾斜で残りが部屋の CH でも図のラベルと同じ範囲になる', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  r.setOverride('ceilingHeight', '2400');
  const ch = () => interiorRows(g.graph).find(x => x.id === r.id).ch;
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [2000, 0] }));
  assert.equal(ch(), '2400～4400', '全体が傾斜');
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [2000, 0] }));
  assert.equal(ch(), '2400～4400', '半分だけ傾斜・残りは部屋の CH 2400');
  r.setCeilingZones([]);
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(1, 0)], { heightMm: null, shape: 'slope', dims: [1000, 90] }));
  assert.equal(ch(), '2400～3400', '傾斜の基準高 null＝部屋の CH を低い側に');
});

test('selectionSpanMm: 2×1 セルの外接幅 {xMm,yMm}。解けないキーだけ・セルなしは null、selection null も null', () => {
  const g = makeGrid([0, 1000, 3000], [0, 1500]);
  const sel = cells => ({ owner: { kind: 'room', id: 'x', rowId: 'x' }, cellKeys: new Set(cells) });
  assert.deepEqual(selectionSpanMm(g.graph, sel([g.cell(0, 0), g.cell(1, 0)])), { xMm: 3000, yMm: 1500 });
  assert.deepEqual(selectionSpanMm(g.graph, sel([g.cell(1, 0)])), { xMm: 2000, yMm: 1500 });
  assert.deepEqual(selectionSpanMm(g.graph, sel([g.cell(0, 0), 'gone:gone:gone:gone'])), { xMm: 1000, yMm: 1500 }, '解けないキーは数えない');
  assert.equal(selectionSpanMm(g.graph, sel(['gone:gone:gone:gone'])), null);
  assert.equal(selectionSpanMm(g.graph, sel([])), null);
  assert.equal(selectionSpanMm(g.graph, null), null);
});

test('selectionSummary の zone と ceilingZoneTargetRoom: 部屋所属は区画の状態、階段所属は zone=null で書込み先なし（S6 まで無効）。解けない所属も null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0], [1, 0]]);
  a.setCeilingZones(assignZoneHeight(g.graph, a, [g.cell(0, 0)], 2600));
  const sel = cells => ({ owner: { kind: 'room', id: a.id, rowId: a.id }, cellKeys: new Set(cells) });
  assert.deepEqual(selectionSummary(g.graph, sel([g.cell(0, 0)])).zone, { state: 'uniform', heightMm: 2600, shape: 'flat', dims: [] });
  assert.deepEqual(selectionSummary(g.graph, sel([g.cell(0, 0), g.cell(1, 0)])).zone, { state: 'mixed', heightMm: null, shape: 'flat', dims: [] });
  assert.equal(ceilingZoneTargetRoom(g.graph, sel([g.cell(0, 0)])), a);
  const stair = { owner: { kind: 'stair', id: 's', rowId: 's' }, cellKeys: new Set() };
  assert.equal(ceilingZoneTargetRoom(g.graph, stair), null);
  assert.equal(ceilingZoneTargetRoom(g.graph, null), null);
  assert.equal(ceilingZoneTargetRoom(g.graph, { owner: { kind: 'room', id: 'x', rowId: 'x' }, cellKeys: new Set() }), null);
});
