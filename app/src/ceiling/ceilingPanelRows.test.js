// 天伏パネルの行の組み立て（純モジュール）。内部タブは仕上げ表の述語（interiorTabRooms）と一致する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType, DEFAULT_CEILING_PANEL, DEFAULT_CEILING_FINISH, CeilingZone } from '@core';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';
import { assignZoneShape } from './ceilingZones.js';
import { setRoomCeilingShape } from './roomCeilingShape.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { buildCeilingCellOwners } from './ceilingOwners.js';
import { DEFAULT_STAIR_ROOM_NAME } from '../finish/roomNamingOptions.js';
import { rowZoneDetail, interiorRows, stairRows,selectionSummary, selectionSpanMm, ceilingWriteTargetRoom, ceilingZoneTargetRoom, materialDisplay, zoneDetailRows, stairZoneDetailRows, remainderRow } from './ceilingPanelRows.js';

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

test('【失敗系】stairRows: 階段が無い階は空配列。変換元の部屋が消えた階段も例外にせず出す（行 id は所属の rowId＝roomId、名前は既定名。S11 の裁定。roomId の無い階段は「タイプ 段数」）', () => {
  const g = makeGrid(XS, [0, 1000]);
  assert.deepEqual(stairRows(g.graph), []);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: 'gone', totalSteps: 12 });
  const bare = g.graph.addStair({ type: StairType.STRAIGHT, totalSteps: 12 });
  assert.deepEqual(stairRows(g.graph).map(r => [r.id, r.name]), [['gone', DEFAULT_STAIR_ROOM_NAME], [bare.id, '直進 12段']]);
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

test('CH 欄のレンジ（S12a）: 区画が無くても残りの面（部屋の形状）が傾斜ならレンジ。平面に戻せば従来の raw。CH がレンジ表記なら raw のまま', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  const plain = g.interior([[2, 0]]);
  r.setOverride('ceilingHeight', '2400');
  plain.setOverride('ceilingHeight', '2350');
  const ch = room => interiorRows(g.graph).find(x => x.id === room.id).ch;
  assert.equal(r.ceilingZones.length, 0, '前提: 区画なし');
  assert.equal(ch(r), '2400');
  setRoomCeilingShape(r, { shape: 'slope', dims: [600, 0] });
  assert.equal(ch(r), '2400～3000');
  assert.equal(ch(plain), '2350', '形状なしの部屋は従来どおり');
  setRoomCeilingShape(r, { shape: 'dome', dims: [250] });
  assert.equal(ch(r), '2400～2650');
  setRoomCeilingShape(r, { shape: 'flat', dims: [] });
  assert.equal(ch(r), '2400');
  r.setOverride('ceilingHeight', '2300～2500');
  setRoomCeilingShape(r, { shape: 'slope', dims: [600, 0] });
  assert.equal(ch(r), '2300～2500', '部屋 CH がレンジ表記なら raw のまま');
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

test('CH 欄のレンジ（S6b）: 円弧・ドームも基準高〜基準高＋ライズ（階段の対の部屋の区画も階段の行に出る）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  r.setOverride('ceilingHeight', '2400');
  const ch = () => interiorRows(g.graph).find(x => x.id === r.id).ch;
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [500, 0] }));
  assert.equal(ch(), '2400～2900', '円弧');
  r.setCeilingZones([]);
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'dome', dims: [700] }));
  assert.equal(ch(), '2400～3100', 'ドーム');
  const pair = g.feature([[2, 0], [3, 0]], RoomFeature.STAIR);
  pair.setOverride('ceilingHeight', '2400');
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0), g.cell(3, 0)]) });
  pair.setCeilingZones(assignZoneShape(g.graph, pair, [g.cell(2, 0), g.cell(3, 0)], { heightMm: 2400, shape: 'slope', dims: [1800, 0] }));
  assert.equal(stairRows(g.graph).find(x => x.id === pair.id).ch, '2400～4200');
});

test('ceilingZoneTargetRoom と selectionSummary.zone（S6b）: 階段所属は対の部屋（stair.roomId）が書込み先で zone はその部屋の区画の状態。部屋の無い階段・消えた所属は null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  const withRoom = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  const bare = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(2, 0)]) });
  const sel = (stair, rowId, cells) => ({ owner: { kind: 'stair', id: stair.id, rowId }, cellKeys: new Set(cells) });
  const s1 = sel(withRoom, pair.id, [g.cell(0, 0)]);
  assert.equal(ceilingZoneTargetRoom(g.graph, s1), pair);
  assert.deepEqual(selectionSummary(g.graph, s1).zone, { state: 'none', heightMm: null, shape: 'flat', dims: [] });
  pair.setCeilingZones(assignZoneShape(g.graph, pair, [g.cell(0, 0)], { heightMm: 2500, shape: 'slope', dims: [1000, 270] }));
  assert.deepEqual(selectionSummary(g.graph, s1).zone, { state: 'uniform', heightMm: 2500, shape: 'slope', dims: [1000, 270] });
  const s2 = sel(bare, bare.id, [g.cell(2, 0)]);
  assert.equal(ceilingZoneTargetRoom(g.graph, s2), null, '部屋の無い階段');
  assert.equal(selectionSummary(g.graph, s2).zone, null);
  assert.equal(ceilingZoneTargetRoom(g.graph, { owner: { kind: 'stair', id: 'gone', rowId: 'gone' }, cellKeys: new Set() }), null);
});

test('selectionSummary の zone と ceilingZoneTargetRoom: 部屋所属は区画の状態。階段所属で階段が解けなければ null。解けない所属も null', () => {
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

// ---- 区画の内訳（S10）----

test('zoneDetailRows／remainderRow: 平面・傾斜・円弧・ドームの表記（形状名・基準高・寸法・セル数）。基準高 null は「部屋 CH」。残りは部屋 CH とセル数', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
  r.setOverride('ceilingHeight', '2400');
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(1, 0)], { heightMm: 2500, shape: 'slope', dims: [500, 270] }));
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(2, 0)], { heightMm: null, shape: 'arc', dims: [300, 0] }));
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(3, 0)], { heightMm: 2600, shape: 'dome', dims: [400] }));
  const rows = zoneDetailRows(g.graph, r);
  assert.deepEqual(rows.map(z => ({ shapeLabel: z.shapeLabel, heightLabel: z.heightLabel, dimsLabel: z.dimsLabel, cellCount: z.cellCount })), [
    { shapeLabel: '平面', heightLabel: '2800', dimsLabel: '', cellCount: 1 },
    { shapeLabel: '傾斜', heightLabel: '2500', dimsLabel: 'ライズ 500・上がる向き ↑ 上', cellCount: 1 },
    { shapeLabel: '円弧', heightLabel: '部屋 CH', dimsLabel: 'ライズ 300・軸 横', cellCount: 1 },
    { shapeLabel: 'ドーム', heightLabel: '2600', dimsLabel: 'ライズ 400', cellCount: 1 },
  ]);
  assert.deepEqual(rows.map(z => z.zoneId), r.ceilingZones.map(z => z.id), '区画の配列順');
  assert.deepEqual(remainderRow(g.graph, r), { chLabel: '2400', cellCount: 1 });
});

test('zoneDetailRows／remainderRow: 同じ区画が複数セルなら cellCount はその数。全セルが区画なら残りは null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  assert.equal(zoneDetailRows(g.graph, r)[0].cellCount, 2);
  assert.equal(remainderRow(g.graph, r), null);
});

test('stairZoneDetailRows: 階段行（対の部屋）の区画は内訳に出るが、残りは出さない（階段の対の部屋は残りを描かない）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  pair.setOverride('ceilingHeight', '2400');
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  pair.setCeilingZones(assignZoneShape(g.graph, pair, [g.cell(0, 0)], { heightMm: 2500, shape: 'slope', dims: [1000, 0] }));
  const rows = stairZoneDetailRows(g.graph, g.graph.stairs.find(s => s.roomId === pair.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dimsLabel, 'ライズ 1000・上がる向き → 右');
  assert.equal(rows[0].cellCount, 1);
  assert.equal(remainderRow(g.graph, pair), null);
});

test('stairZoneDetailRows／zoneDetailRows: 対の部屋に「階段所属のセルだけの区画」と「部屋所属のセルだけの区画」があると、階段行には前者だけ・部屋行には後者だけ', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: r.id, cells: new Set([g.cell(2, 0)]) });
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(2, 0)], { heightMm: 2500, shape: 'slope', dims: [500, 0] }));
  const stair = g.graph.stairs.find(s => s.roomId === r.id);
  const onStair = stairZoneDetailRows(g.graph, stair);
  assert.deepEqual(onStair.map(z => z.shapeLabel), ['傾斜']);
  assert.equal(onStair[0].cellCount, 1);
  const onRoom = zoneDetailRows(g.graph, r);
  assert.deepEqual(onRoom.map(z => z.shapeLabel), ['平面']);
  assert.equal(onRoom[0].cellCount, 1);
});

// ---- 画面の経路（stairRows／interiorRows の出力 → rowZoneDetail）----

const rowOf = (rows, id) => rows.find(r => r.id === id);
const surfaceCellCount = (graph, roomId) => ceilingSurfacesOf(graph).filter(s => s.roomId === roomId).reduce((n, s) => n + s.rects.length, 0);

test('rowZoneDetail: STAIR ペア部屋を対にする階段の行（stairRows）は区画1件・セル数1・残りなし', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  pair.setCeilingZones(assignZoneShape(g.graph, pair, [g.cell(0, 0)], { heightMm: 2500, shape: 'slope', dims: [1000, 0] }));
  const row = rowOf(stairRows(g.graph), pair.id);
  assert.equal(row.kind, 'room', '前提: 対の部屋を持つ階段の行は roomRow');
  const d = rowZoneDetail(g.graph, row);
  assert.equal(d.zones.length, 1);
  assert.equal(d.zones[0].cellCount, 1);
  assert.equal(d.rest, null);
  assert.equal(d.pairMissing, false);
});

test('rowZoneDetail: 屋内部屋を対にする階段で階段セルが部屋の外 → 内部タブの行は 部屋所属の区画＋残り＋階段所属の区画。セル数の合計は天井面と一致', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: r.id, cells: new Set([g.cell(2, 0)]) });
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(0, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  r.setCeilingZones(assignZoneShape(g.graph, r, [g.cell(2, 0)], { heightMm: 2500, shape: 'slope', dims: [500, 0] }));
  const d = rowZoneDetail(g.graph, rowOf(interiorRows(g.graph), r.id));
  assert.deepEqual(d.zones.map(z => z.shapeLabel), ['平面', '傾斜']);
  assert.equal(d.rest.cellCount, 1);
  const total = d.zones.reduce((n, z) => n + z.cellCount, 0) + d.rest.cellCount;
  assert.equal(total, surfaceCellCount(g.graph, r.id), 'セル数の合計は ceilingSurfacesOf の面のセル数');
  assert.deepEqual(rowZoneDetail(g.graph, rowOf(stairRows(g.graph), r.id)), d, '階段タブの同じ部屋の行も同じ結果');
});

test('rowZoneDetail: 2a が階段セルに重なる → 2a の行には 2a の区画、階段（ペア部屋）の行には階段所属の区画。セルは重複しない', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[2, 0], [3, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0), g.cell(3, 0)]) });
  pair.setCeilingZones([new CeilingZone({ id: 'zp', cells: [g.cell(2, 0), g.cell(3, 0)], heightMm: 2300 })]);
  const under = g.interior([[2, 0]]);
  under.setCeilingZones([new CeilingZone({ id: 'zu', cells: [g.cell(2, 0)], heightMm: 2200 })]);
  const u = rowZoneDetail(g.graph, rowOf(interiorRows(g.graph), under.id));
  const s = rowZoneDetail(g.graph, rowOf(stairRows(g.graph), pair.id));
  assert.deepEqual(u.zones.map(z => [z.zoneId, z.cellCount]), [['zu', 1]]);
  assert.deepEqual(s.zones.map(z => [z.zoneId, z.cellCount]), [['zp', 1]], '2a が取ったセルは階段の区画から落ちる');
});

test('rowZoneDetail: 同じ対の部屋を持つ2つの階段は、それぞれの階段所属のセルだけを数える（行は合算）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0)]) });
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(1, 0)]) });
  pair.setCeilingZones([new CeilingZone({ id: 'z', cells: [g.cell(0, 0), g.cell(1, 0)], heightMm: 2300 })]);
  const [s1, s2] = g.graph.stairs;
  assert.equal(stairZoneDetailRows(g.graph, s1)[0].cellCount, 1);
  assert.equal(stairZoneDetailRows(g.graph, s2)[0].cellCount, 1);
  const d = rowZoneDetail(g.graph, rowOf(stairRows(g.graph), pair.id));
  assert.equal(d.zones.length, 1, '同じ区画は1行にまとめる');
  assert.equal(d.zones[0].cellCount, 2);
});

test('【失敗系】rowZoneDetail／stairRows: 参照切れの roomId の階段は行 id が所属の rowId と一致（選択が行に出る）で pairMissing。部屋の無い階段も pairMissing', () => {
  const g = makeGrid(XS, [0, 1000]);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: 'ghost', cells: new Set([g.cell(0, 0)]) });
  g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(1, 0)]) });
  const [dangling, bare] = stairRows(g.graph);
  const owners = buildCeilingCellOwners(g.graph);
  assert.equal(dangling.id, 'ghost');
  assert.equal(dangling.name, DEFAULT_STAIR_ROOM_NAME);
  assert.equal(owners.get(g.cell(0, 0)).rowId, dangling.id, '所属の rowId と行 id が一致');
  assert.equal(bare.id, g.graph.stairs[1].id);
  assert.equal(owners.get(g.cell(1, 0)).rowId, bare.id);
  for (const row of [dangling, bare]) assert.deepEqual(rowZoneDetail(g.graph, row), { zones: [], rest: null, pairMissing: true });
  assert.deepEqual(rowZoneDetail(null, dangling), { zones: [], rest: null, pairMissing: true });
});

test('【失敗系】stairZoneDetailRows: 対の部屋なし・区画なし・graph／stair null は []', () => {
  const g = makeGrid(XS, [0, 1000]);
  g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 0)]) });
  assert.deepEqual(stairZoneDetailRows(g.graph, g.graph.stairs[0]), []);
  const pair = g.feature([[1, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(1, 0)]) });
  assert.deepEqual(stairZoneDetailRows(g.graph, g.graph.stairs.find(s => s.roomId === pair.id)), []);
  assert.deepEqual(stairZoneDetailRows(g.graph, null), []);
  assert.deepEqual(stairZoneDetailRows(null, g.graph.stairs[0]), []);
});

test('【失敗系】zoneDetailRows／remainderRow: 区画の無い部屋・room null・graph null は []／null。効かない区画（解けないキー）は出さない', () => {
  const g = makeGrid(XS, [0, 1000]);
  const plain = g.interior([[0, 0]]);
  assert.deepEqual(zoneDetailRows(g.graph, plain), []);
  assert.equal(remainderRow(g.graph, plain), null);
  assert.deepEqual(zoneDetailRows(g.graph, null), []);
  assert.equal(remainderRow(g.graph, null), null);
  assert.deepEqual(zoneDetailRows(null, plain), []);
  assert.equal(remainderRow(null, plain), null);
  const ghost = g.interior([[1, 0]]);
  ghost.setCeilingZones([new CeilingZone({ id: 'z', cells: ['gone:gone:gone:gone'], heightMm: 2900 })]);
  assert.deepEqual(zoneDetailRows(g.graph, ghost), []);
  assert.deepEqual(remainderRow(g.graph, ghost), { chLabel: roomCeilingHeight(g.graph, ghost).raw, cellCount: 1 });
});
