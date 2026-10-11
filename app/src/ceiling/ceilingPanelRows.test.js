// 天伏パネルの行・木の組み立て（純モジュール）。内部タブは仕上げ表の述語（interiorTabRooms）と一致する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType, DEFAULT_CEILING_PANEL, DEFAULT_CEILING_FINISH, CeilingZone } from '@core';
import { makeGrid, assignZoneHeight, assignZoneSpec } from '../plan/planTestFixtures.js';
import { setRoomCeilingShape } from './roomCeilingShape.js';
import { interiorTabRooms, interiorRoomDisplayName } from '../finish/interiorTabRooms.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { buildCeilingCellOwners } from './ceilingOwners.js';
import { roomGroupId, zoneGroupId, stairGroupId } from './ceilingGroups.js';
import { DEFAULT_STAIR_ROOM_NAME } from '../finish/roomNamingOptions.js';
import {
  interiorRows, stairRows, selectionSpanMm, ceilingWriteTargetRoom, materialDisplay, stairZoneDetailRows,
  ceilingPanelTree, ceilingPanelLines, nodePathOf, selectedNodeId,
} from './ceilingPanelRows.js';

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

test('stairRows: 部屋の無い階段の行は kind=stair、部屋のある階段の行は kind=room', () => {
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
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [2000, 0] }));
  assert.equal(ch(), '2400～4400', '全体が傾斜');
  r.setCeilingZones([]);
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [2000, 0] }));
  assert.equal(ch(), '2400～4400', '半分だけ傾斜・残りは部屋の CH 2400');
  r.setCeilingZones([]);
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(1, 0)], { heightMm: null, shape: 'slope', dims: [1000, 90] }));
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
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [500, 0] }));
  assert.equal(ch(), '2400～2900', '円弧');
  r.setCeilingZones([]);
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'dome', dims: [700] }));
  assert.equal(ch(), '2400～3100', 'ドーム');
  const pair = g.feature([[2, 0], [3, 0]], RoomFeature.STAIR);
  pair.setOverride('ceilingHeight', '2400');
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0), g.cell(3, 0)]) });
  pair.setCeilingZones(assignZoneSpec(g.graph, pair, [g.cell(2, 0), g.cell(3, 0)], { heightMm: 2400, shape: 'slope', dims: [1800, 0] }));
  assert.equal(stairRows(g.graph).find(x => x.id === pair.id).ch, '2400～4200');
});

// ---- 階段の区画の内訳（階段タブの展開用）----

test('stairZoneDetailRows: 階段行（対の部屋）の区画が出る（形状名・基準高・寸法・セル数）。セルは階段所属のものだけ', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  pair.setOverride('ceilingHeight', '2400');
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  pair.setCeilingZones(assignZoneSpec(g.graph, pair, [g.cell(0, 0)], { heightMm: 2500, shape: 'slope', dims: [1000, 0] }));
  const rows = stairZoneDetailRows(g.graph, g.graph.stairs.find(s => s.roomId === pair.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dimsLabel, 'ライズ 1000・上がる向き → 右');
  assert.equal(rows[0].cellCount, 1);
});

test('stairZoneDetailRows／zone 群: 対の部屋に「階段所属のセルだけの区画」があると、階段行には出る（部屋所属のセルだけの区画は出ない）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0]]);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: r.id, cells: new Set([g.cell(2, 0)]) });
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(0, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(2, 0)], { heightMm: 2500, shape: 'slope', dims: [500, 0] }));
  const stair = g.graph.stairs.find(s => s.roomId === r.id);
  const onStair = stairZoneDetailRows(g.graph, stair);
  assert.deepEqual(onStair.map(z => z.shapeLabel), ['傾斜']);
  assert.equal(onStair[0].cellCount, 1);
});

test('stairZoneDetailRows: 2a が階段セルに重なる → 階段（ペア部屋）の区画から 2a が取ったセルは落ちる', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[2, 0], [3, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0), g.cell(3, 0)]) });
  pair.setCeilingZones([new CeilingZone({ id: 'zp', cells: [g.cell(2, 0), g.cell(3, 0)], heightMm: 2300 })]);
  const under = g.interior([[2, 0]]);
  under.setCeilingZones([new CeilingZone({ id: 'zu', cells: [g.cell(2, 0)], heightMm: 2200 })]);
  const s = stairZoneDetailRows(g.graph, g.graph.stairs[0]);
  assert.deepEqual(s.map(z => [z.zoneId, z.cellCount]), [['zp', 1]]);
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

test('【失敗系】stairRows: 参照切れの roomId の階段は行 id が所属の rowId と一致（選択が行に出る）。部屋の無い階段も同様', () => {
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
});

// ---- 木（S12c）: ceilingPanelTree / ceilingPanelLines / nodePathOf / selectedNodeId ----

/** 親 parent を参照する部分指定の子の部屋を足す。 */
const childOf = (g, parent, cells, name = '子') =>
  g.graph.addRoom(new Set(cells.map(([i, j]) => g.cell(i, j))), name, undefined, new Set([parent.id]));
const ids = nodes => nodes.map(n => n.id);
const types = lines => lines.map(l => l.type);

test('木（内部タブ）: 親1件に1行。屋外・STAIR_VOID・UNDEFINED は載らず、並びは仕上げ表と同じ。部屋ノードの id は群 id', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0]]);
  const b = g.interior([[1, 0]]);
  g.interior([[2, 0]]).setKind(RoomKind.EXTERIOR);
  g.feature([[3, 0]], RoomFeature.STAIR_VOID);
  g.feature([[4, 0]], RoomFeature.UNDEFINED);
  const tree = ceilingPanelTree(g.graph, 'interior', MATERIAL_MAP);
  assert.deepEqual(ids(tree), [roomGroupId(a.id), roomGroupId(b.id)]);
  assert.deepEqual(tree.map(n => n.type), ['room', 'room']);
  assert.deepEqual(tree.map(n => n.room), [a, b]);
  assert.deepEqual([tree[0].name, tree[0].ceilingBoard, tree[0].ceilingFinish, tree[0].ch],
    ['居間', 'PB ア)9.5', 'ビニールクロス', roomCeilingHeight(g.graph, a).raw]);
  assert.equal(tree[0].hasCeiling, true);
  assert.deepEqual(tree[0].cells, new Set([g.cell(0, 0)]), '部屋の残りの群のセル');
});

test('木: 部分指定の子は親の中に入れ子（graph.rooms の順）。子の列は親と同じ（天井材・仕上げは子自身の値）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const p = g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const c1 = childOf(g, p, [[1, 0]], '子A');
  const c2 = childOf(g, p, [[2, 0]], '子B');
  c2.setOverride('ceilingPanel', '301000000002');
  const other = g.interior([[4, 0]]);
  const tree = ceilingPanelTree(g.graph, 'interior', MATERIAL_MAP);
  assert.deepEqual(ids(tree), [roomGroupId(p.id), roomGroupId(other.id)], '子は最上位に出ない');
  // addRoom は部分指定を親の直後へ挿入するので graph.rooms の順は作成順の逆になる。木はその graph.rooms の順に従う
  const roomsOrder = g.graph.rooms.filter(r => r === c1 || r === c2).map(r => roomGroupId(r.id));
  assert.deepEqual(roomsOrder, [roomGroupId(c2.id), roomGroupId(c1.id)], '前提: graph.rooms では子B が先');
  assert.deepEqual(ids(tree[0].children), roomsOrder, 'graph.rooms の順');
  const kid = tree[0].children[0];
  assert.deepEqual([kid.type, kid.name, kid.ceilingBoard, kid.room], ['room', '子B', 'PB ア)12.5', c2]);
  assert.equal(tree[0].ceilingBoard, 'PB ア)9.5', '親の値は子の値に影響されない');
});

test('木: 親がタブに無い子（親が未定義・屋外・欠落）は最上位に出る', () => {
  const g = makeGrid(XS, [0, 1000]);
  const undef = g.feature([[0, 0]], RoomFeature.UNDEFINED);
  const outdoor = g.interior([[1, 0]]);
  outdoor.setKind(RoomKind.EXTERIOR);
  const c1 = childOf(g, undef, [[0, 0]], '未定義の子');
  const c2 = childOf(g, outdoor, [[1, 0]], '屋外の子');
  const c3 = g.graph.addRoom(new Set([g.cell(2, 0)]), '欠落の子', undefined, new Set(['gone']));
  const tree = ceilingPanelTree(g.graph, 'interior');
  assert.deepEqual(ids(tree), [roomGroupId(c1.id), roomGroupId(c2.id), roomGroupId(c3.id)]);
  assert.ok(tree.every(n => n.children.length === 0));
});

test('木: 複数の親を持つ子は、タブにいる最初の親（graph.rooms の順）の下だけに入る', () => {
  const g = makeGrid(XS, [0, 1000]);
  const p1 = g.interior([[0, 0], [1, 0]]);
  const p2 = g.interior([[2, 0], [3, 0]]);
  const c = g.graph.addRoom(new Set([g.cell(1, 0), g.cell(2, 0)]), '跨ぎ', undefined, new Set([p2.id, p1.id])); // Set の順は p2 が先
  const tree = ceilingPanelTree(g.graph, 'interior');
  assert.deepEqual(ids(tree), [roomGroupId(p1.id), roomGroupId(p2.id)]);
  assert.deepEqual(ids(tree[0].children), [roomGroupId(c.id)], 'graph.rooms で先の親 p1 の下');
  assert.deepEqual(tree[1].children, []);
});

test('木: 子の入れ子は何段でも辿れる。参照が循環していても取り残された部屋は最上位に出る（例外・無限再帰にしない）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const p = g.interior([[0, 0], [1, 0]]);
  const c = childOf(g, p, [[1, 0]], '子');
  const gc = childOf(g, c, [[1, 0]], '孫');
  assert.deepEqual(ids(ceilingPanelTree(g.graph, 'interior')[0].children[0].children), [roomGroupId(gc.id)]);
  // 循環: p と c が互いを参照
  p.referenceRoomIds = new Set([c.id]);
  const tree = ceilingPanelTree(g.graph, 'interior');
  const all = [];
  const walk = ns => ns.forEach(n => { all.push(n.id); walk(n.children); });
  walk(tree);
  assert.deepEqual([...new Set(all)].sort(), [roomGroupId(p.id), roomGroupId(c.id), roomGroupId(gc.id)].sort(), '全部屋がどこかに出る');
  assert.equal(all.length, new Set(all).size, '重複して出ない');
});

test('木: VOID（吹抜け）の部分指定の子は部屋ノードとして出るが天井なし（hasCeiling false）。開くと欄ではなく「天井なし」の1行', () => {
  const g = makeGrid(XS, [0, 1000]);
  const p = g.interior([[0, 0], [1, 0]]);
  const v = childOf(g, p, [[1, 0]], '吹抜け');
  v.setFeature(RoomFeature.VOID);
  const tree = ceilingPanelTree(g.graph, 'interior');
  const node = tree[0].children[0];
  assert.deepEqual([node.id, node.hasCeiling], [roomGroupId(v.id), false]);
  const lines = ceilingPanelLines(tree, [roomGroupId(p.id), roomGroupId(v.id)]);
  const note = lines.find(l => l.type === 'note');
  assert.equal(note.text, '天井なし');
  assert.equal(note.depth, 2);
  assert.ok(!lines.some(l => l.nodeId === roomGroupId(v.id) && l.type === 'roomFields'), '形状・天井高の欄は出さない');
});

test('木: 区画の行は 部屋の区画の配列順の「区画n」。形状｜寸法の表記｜セル数 と CH（基準高。平面以外は基準高～基準高＋ライズ。null は部屋の CH）。面が0件の区画も行は出す', () => {
  const g = makeGrid(XS, [0, 1000]);
  const r = g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  r.setOverride('ceilingHeight', '2400');
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(2, 0)], { heightMm: 2500, shape: 'slope', dims: [500, 270] }));
  r.setCeilingZones(assignZoneSpec(g.graph, r, [g.cell(3, 0)], { heightMm: null, shape: 'dome', dims: [300] }));
  r.setCeilingZones([...r.ceilingZones, new CeilingZone({ id: 'ghost', cells: ['gone:gone:gone:gone'], heightMm: 2900 })]);
  const [node] = ceilingPanelTree(g.graph, 'interior');
  const zs = node.children;
  assert.deepEqual(zs.map(z => z.type), ['zone', 'zone', 'zone', 'zone']);
  assert.deepEqual(zs.map(z => z.id), r.ceilingZones.map(z => zoneGroupId(r.id, z.id)), '区画の配列順＝群 id');
  assert.deepEqual(zs.map(z => z.name), ['区画1', '区画2', '区画3', '区画4']);
  assert.deepEqual(zs.map(z => z.summary), [
    '平面｜2セル',
    '傾斜｜ライズ 500・上がる向き ↑ 上｜1セル',
    'ドーム｜ライズ 300｜1セル',
    '平面｜0セル',
  ]);
  assert.deepEqual(zs.map(z => z.ch), ['2800', '2500～3000', '2400～2700', '2900']);
  assert.deepEqual(zs.map(z => [z.ceilingBoard, z.ceilingFinish]), Array(4).fill([null, null]), '区画の行は材の列を持たない（colSpan で形状｜寸法｜セル数）');
  assert.equal(zs[0].room, r);
  assert.deepEqual(zs[0].cells, new Set([g.cell(0, 0), g.cell(1, 0)]));
  assert.equal(zs[3].cells.size, 0);
});

test('木（階段タブ）: 階段は graph.stairs の順。対の部屋があれば材・CH は部屋の値、無ければ null。子はその階段所属のセルを持つ区画だけ', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  pair.setName('');
  const s1 = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  const s2 = g.graph.addStair({ type: StairType.WINDING, totalSteps: 9, cells: new Set([g.cell(3, 0)]) });
  pair.setCeilingZones(assignZoneSpec(g.graph, pair, [g.cell(0, 0)], { heightMm: 2500, shape: 'slope', dims: [1000, 0] }));
  const tree = ceilingPanelTree(g.graph, 'stair', MATERIAL_MAP);
  assert.deepEqual(ids(tree), [stairGroupId(s1.id), stairGroupId(s2.id)]);
  assert.deepEqual(tree.map(n => n.type), ['stair', 'stair']);
  assert.equal(tree[0].name, '階段');
  assert.equal(tree[0].room, pair);
  assert.deepEqual([tree[0].ceilingBoard, tree[0].ceilingFinish], ['PB ア)9.5', 'ビニールクロス']);
  assert.equal(tree[0].ch, '2500～3500', '対の部屋の CH 欄（区画のレンジ）');
  assert.deepEqual(tree[0].children.map(z => [z.id, z.name, z.summary]), [[zoneGroupId(pair.id, pair.ceilingZones[0].id), '区画1', '傾斜｜ライズ 1000・上がる向き → 右｜1セル']]);
  assert.deepEqual([tree[1].name, tree[1].room, tree[1].ceilingBoard, tree[1].ceilingFinish, tree[1].ch, tree[1].children], ['回り 9段', null, null, null, null, []]);
  assert.ok(!ids(ceilingPanelTree(g.graph, 'interior')).some(id => id.startsWith('stair:')), '階段ノードは階段タブだけ');
});

test('【失敗系】木: graph null は []、部屋の無い階は []、階段の無い階の階段タブは []', () => {
  assert.deepEqual(ceilingPanelTree(null, 'interior'), []);
  assert.deepEqual(ceilingPanelTree(null, 'stair'), []);
  const g = makeGrid(XS, [0, 1000]);
  assert.deepEqual(ceilingPanelTree(g.graph, 'interior'), []);
  assert.deepEqual(ceilingPanelTree(g.graph, 'stair'), []);
});

test('ceilingPanelLines: expandedPath に従って各段1つだけ開く。部屋を開くと 欄→区画→子の部屋 の順（子は1段深い）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const p = g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  const c = childOf(g, p, [[3, 0]], '子');
  p.setCeilingZones(assignZoneHeight(g.graph, p, [g.cell(0, 0)], 2600));
  c.setCeilingZones(assignZoneHeight(g.graph, c, [g.cell(3, 0)], 2300));
  const q = g.interior([[4, 0]]);
  const tree = ceilingPanelTree(g.graph, 'interior');
  const P = roomGroupId(p.id), C = roomGroupId(c.id), Q = roomGroupId(q.id);
  const pz = zoneGroupId(p.id, p.ceilingZones[0].id), cz = zoneGroupId(c.id, c.ceilingZones[0].id);

  const closed = ceilingPanelLines(tree, []);
  assert.deepEqual(closed.map(l => [l.nodeId, l.depth, l.type, l.expanded]), [[P, 0, 'room', false], [Q, 0, 'room', false]]);

  const open = ceilingPanelLines(tree, [P]);
  assert.deepEqual(open.map(l => [l.nodeId, l.depth, l.type]), [
    [P, 0, 'room'], [P, 1, 'roomFields'], [pz, 1, 'zone'], [C, 1, 'room'], [Q, 0, 'room'],
  ]);
  assert.equal(open[0].expanded, true);
  assert.equal(open[3].expanded, false, '子は開かない');

  const deep = ceilingPanelLines(tree, [P, C, cz]);
  assert.deepEqual(deep.map(l => [l.nodeId, l.depth, l.type]), [
    [P, 0, 'room'], [P, 1, 'roomFields'], [pz, 1, 'zone'],
    [C, 1, 'room'], [C, 2, 'roomFields'], [cz, 2, 'zone'], [cz, 3, 'zoneFields'],
    [Q, 0, 'room'],
  ]);

  const swapped = ceilingPanelLines(tree, [Q]);
  assert.deepEqual(swapped.map(l => [l.nodeId, l.depth, l.type]), [[P, 0, 'room'], [Q, 0, 'room'], [Q, 1, 'roomFields']], '最上位は1つだけ開く');

  const stale = ceilingPanelLines(tree, ['room:gone', 'zone:gone#x']);
  assert.deepEqual(stale.map(l => l.nodeId), [P, Q], '木に無い id が経路に残っていても例外にせず、何も開かない');
  assert.equal(new Set(deep.map(l => l.key)).size, deep.length, 'key は一意');
});

test('ceilingPanelLines: 階段タブは階段の区画だけ（部屋レベルの欄 roomFields を出さない）。区画なしは1行の注記、対の部屋なしはその旨', () => {
  const g = makeGrid(XS, [0, 1000]);
  const pair = g.feature([[0, 0], [1, 0]], RoomFeature.STAIR);
  const s1 = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  const s2 = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(3, 0)]) });
  pair.setCeilingZones(assignZoneSpec(g.graph, pair, [g.cell(0, 0)], { heightMm: 2500, shape: 'slope', dims: [1000, 0] }));
  const tree = ceilingPanelTree(g.graph, 'stair');
  const S1 = stairGroupId(s1.id), S2 = stairGroupId(s2.id), z = zoneGroupId(pair.id, pair.ceilingZones[0].id);
  const l1 = ceilingPanelLines(tree, [S1]);
  assert.deepEqual(l1.map(l => [l.nodeId, l.depth, l.type]), [[S1, 0, 'stair'], [z, 1, 'zone'], [S2, 0, 'stair']]);
  assert.ok(!types(l1).includes('roomFields'), '階段の残りは天井を持たない＝部屋レベルの欄なし');
  assert.deepEqual(types(ceilingPanelLines(tree, [S1, z])), ['stair', 'zone', 'zoneFields', 'stair']);
  const l2 = ceilingPanelLines(tree, [S2]);
  assert.deepEqual(l2.filter(l => l.type === 'note').map(l => l.text), ['区画なし（対の部屋なし）']);
  pair.setCeilingZones([]);
  const l3 = ceilingPanelLines(ceilingPanelTree(g.graph, 'stair'), [S1]);
  assert.deepEqual(l3.filter(l => l.type === 'note').map(l => l.text), ['区画なし']);
});

test('nodePathOf: 部屋は1段、子は親→子、子の区画は3段、階段の区画は階段タブで 階段→区画。そのタブに無い・消えた群は null', () => {
  const g = makeGrid(XS, [0, 1000]);
  const p = g.interior([[0, 0], [1, 0], [2, 0]]);
  const c = childOf(g, p, [[2, 0]], '子');
  c.setCeilingZones(assignZoneHeight(g.graph, c, [g.cell(2, 0)], 2300));
  p.setCeilingZones(assignZoneHeight(g.graph, p, [g.cell(0, 0)], 2600));
  const pair = g.feature([[4, 0], [5, 0]], RoomFeature.STAIR);
  const st = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(4, 0), g.cell(5, 0)]) });
  pair.setCeilingZones(assignZoneHeight(g.graph, pair, [g.cell(4, 0)], 2500));
  const P = roomGroupId(p.id), C = roomGroupId(c.id);
  const cz = zoneGroupId(c.id, c.ceilingZones[0].id), pz = zoneGroupId(p.id, p.ceilingZones[0].id);
  const sz = zoneGroupId(pair.id, pair.ceilingZones[0].id);
  assert.deepEqual(nodePathOf(g.graph, P, 'interior'), [P]);
  assert.deepEqual(nodePathOf(g.graph, pz, 'interior'), [P, pz]);
  assert.deepEqual(nodePathOf(g.graph, C, 'interior'), [P, C]);
  assert.deepEqual(nodePathOf(g.graph, cz, 'interior'), [P, C, cz]);
  assert.deepEqual(nodePathOf(g.graph, stairGroupId(st.id), 'stair'), [stairGroupId(st.id)]);
  assert.deepEqual(nodePathOf(g.graph, sz, 'stair'), [stairGroupId(st.id), sz]);
  assert.deepEqual(nodePathOf(g.graph, sz, 'interior'), [roomGroupId(pair.id), sz], '階段室の部屋は内部タブにも載り、区画もそこに出る');
  assert.equal(nodePathOf(g.graph, stairGroupId(st.id), 'interior'), null, 'そのタブに無い');
  assert.equal(nodePathOf(g.graph, P, 'stair'), null);
  assert.equal(nodePathOf(g.graph, zoneGroupId(p.id, 'gone'), 'interior'), null, '消えた区画');
  assert.equal(nodePathOf(g.graph, 'bogus', 'interior'), null);
  assert.equal(nodePathOf(null, P, 'interior'), null);
});

test('selectedNodeId: 群が今あれば selection.groupId、無い（undo などで消えた）・selection なしは null（選択なし扱い）', () => {
  const g = makeGrid(XS, [0, 1000]);
  const a = g.interior([[0, 0], [1, 0]]);
  const sel = groupId => ({ owner: { kind: 'room', id: a.id, rowId: a.id }, groupId, cellKeys: new Set() });
  assert.equal(selectedNodeId(g.graph, sel(roomGroupId(a.id))), roomGroupId(a.id));
  assert.equal(selectedNodeId(g.graph, sel(zoneGroupId(a.id, 'gone'))), null);
  assert.equal(selectedNodeId(g.graph, null), null);
  assert.equal(selectedNodeId(null, sel(roomGroupId(a.id))), null);
});
