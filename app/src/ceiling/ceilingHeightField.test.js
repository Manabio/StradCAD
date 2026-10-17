// ceilingHeightField.js（天井高の点問い合わせ）の単体テスト。ceilingSurfaces.test.js と同じ fixture で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, CeilingZone, StairType } from '@core';
import { buildCeilingHeightField } from './ceilingHeightField.js';
import { createZone } from './ceilingZones.js';
import { setRoomCeilingShape } from './roomCeilingShape.js';
import { makeGrid, fakeLayer } from '../plan/planTestFixtures.js';
import { planSolids } from '../plan/planSolids.js';

const flat = mm => ({ heightMm: mm, shape: 'flat', dims: [] });
const zOf = (field, x, y) => field.zAt(x, y)?.zMm;

test('平面1部屋: 部屋の CH が全点で返る。chMm・roomId・zoneId null・shape flat も付く', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2600');
  const f = buildCeilingHeightField(g.graph);
  assert.deepEqual(f.zAt(1000, 1500), { zMm: 2600, chMm: 2600, roomId: room.id, zoneId: null, shape: 'flat', dims: [] });
  assert.equal(zOf(f, 3000, 2900), 2600);
  assert.equal(f.surfaces.length, 1);
});

test('区画2つで高さが違う: セルごとに zMm が変わる（主寝室型。左 2400・右 3000）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2400)).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  const f = buildCeilingHeightField(g.graph);
  assert.equal(zOf(f, 1000, 1500), 2400);
  assert.equal(zOf(f, 3000, 1500), 3000);
  assert.notEqual(f.zAt(1000, 1500).zoneId, f.zAt(3000, 1500).zoneId);
});

test('傾斜: 上がる向き +x の区画は両端で baseZ・baseZ+rise、中央で線形（2400→3000 の中央 2700）。向き 180 は逆', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0), g.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  const f = buildCeilingHeightField(g.graph);
  assert.equal(zOf(f, 0, 500), 2400);
  assert.equal(zOf(f, 1000, 500), 2550);
  assert.equal(zOf(f, 2000, 500), 2700);
  assert.equal(zOf(f, 4000, 500), 3000);
  const g2 = makeGrid([0, 2000, 4000], [0, 1000]);
  const r2 = g2.interior([[0, 0], [1, 0]]);
  r2.setCeilingZones(createZone(g2.graph, r2, [g2.cell(0, 0), g2.cell(1, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 180] }).zones);
  const f2 = buildCeilingHeightField(g2.graph);
  assert.equal(zOf(f2, 0, 500), 3000);
  assert.equal(zOf(f2, 4000, 500), 2400);
});

test('円弧: 軸 0（x に平行）で y 方向の中心線が baseZ+rise・縁が baseZ', () => {
  const g = makeGrid([0, 4000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = buildCeilingHeightField(g.graph);
  assert.ok(Math.abs(zOf(f, 2000, 1000) - 2800) < 1e-6);
  assert.ok(Math.abs(zOf(f, 2000, 0) - 2400) < 1e-6);
  assert.ok(Math.abs(zOf(f, 500, 2000) - 2400) < 1e-6);
  const mid = zOf(f, 2000, 500);
  assert.ok(mid > 2400 && mid < 2800, `中間は縁と頂の間: ${mid}`);
});

test('ドーム: 中心で baseZ+rise・周縁で baseZ', () => {
  const g = makeGrid([0, 2000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2300, shape: 'dome', dims: [500] }).zones);
  const f = buildCeilingHeightField(g.graph);
  assert.equal(zOf(f, 1000, 1000), 2800);
  assert.equal(zOf(f, 0, 1000), 2300);
  assert.equal(zOf(f, 1000, 2000), 2300);
  assert.equal(zOf(f, 500, 500), 2581.25); // 中心から半分の位置（p=q=−0.5）
});

test('部屋の形状（customOverrides ceilingShape）が区画なしの残りの面に効く。区画の面は区画の形状のまま', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(2800)).zones);
  setRoomCeilingShape(room, { shape: 'slope', dims: [300, 90] });
  const f = buildCeilingHeightField(g.graph);
  // 残り（x 0..2000）は y 方向に 2400→2700
  assert.equal(zOf(f, 1000, 0), 2400);
  assert.equal(zOf(f, 1000, 1500), 2550);
  assert.equal(zOf(f, 1000, 3000), 2700);
  assert.equal(zOf(f, 3000, 1500), 2800, '区画は平面のまま');
});

test('面の外・天井なし部屋（VOID・STAIR・屋根）の点は null。STAIR_VOID は平らな面（既定天井高）で返る', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000, 5000], [0, 1000]);
  const room = g.interior([[0, 0]]);
  g.feature([[1, 0]], RoomFeature.VOID);
  const pair = g.feature([[2, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0)]) });
  g.feature([[3, 0]], RoomFeature.STAIR_VOID);
  const f = buildCeilingHeightField(g.graph);
  assert.notEqual(f.zAt(500, 500), null);
  assert.equal(f.zAt(1500, 500).roomId, room.id, 'VOID は壁なしで接する隣の部屋の天井に溶け込む（裁定 2026-10-17）');
  assert.equal(f.zAt(2500, 500), null, '区画なしの階段');
  assert.equal(f.zAt(-100, 500), null, '部屋の外');
  assert.equal(f.zAt(4500, 500), null, '部屋なし');
  assert.equal(zOf(f, 3500, 500), g.graph.defaultCeilingHeight, 'STAIR_VOID は平らな面');
  assert.equal(f.zAt(3500, 500).shape, 'flat');
});

test('部分指定の子の点は子の CH（床段差込みの面）。親の点は親の CH', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '2100');
  const f = buildCeilingHeightField(g.graph);
  assert.equal(zOf(f, 3000, 1500), 2100);
  assert.equal(f.zAt(3000, 1500).roomId, child.id);
  assert.equal(zOf(f, 1000, 1500), 2400);
});

test('床段差: zMm に床段差が乗る（FL+400 の子は親と同じ 2400。FL−150・CH 2400 は 2250。傾斜の基準にも乗る）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(400);
  const low = g.interior([[2, 0]]);
  low.setFloorLevel(-150);
  low.setOverride('ceilingHeight', '2400');
  low.setCeilingZones(createZone(g.graph, low, [g.cell(2, 0)], { heightMm: 2400, shape: 'slope', dims: [300, 0] }).zones);
  const f = buildCeilingHeightField(g.graph);
  assert.equal(zOf(f, 3000, 1500), 2400);
  assert.equal(zOf(f, 4100, 1500), 2250 + 300 * 100 / 2000, '傾斜の低い側（共有辺 4000 は先勝ちで子に取られるので内側の点）');
  assert.equal(zOf(f, 6000, 1500), 2550);
});

test('共有辺の上の点は ceilingSurfacesOf の順で先勝ち（決定的）。内部の点は各部屋', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  const b = g.interior([[1, 0]]);
  a.setOverride('ceilingHeight', '2600');
  b.setOverride('ceilingHeight', '2200');
  const f = buildCeilingHeightField(g.graph);
  assert.equal(f.zAt(2000, 1500).roomId, a.id);
  assert.equal(zOf(f, 2000, 1500), 2600);
  assert.equal(f.zAt(2001, 1500).roomId, b.id);
  assert.equal(f.surfaceAt(1999, 1500).roomId, a.id);
});

test('【失敗系】graph null は空の場で例外にしない。非有限の座標は null', () => {
  const f = buildCeilingHeightField(null);
  assert.deepEqual(f.surfaces, []);
  assert.equal(f.surfaceAt(0, 0), null);
  assert.equal(f.zAt(0, 0), null);
  const g = makeGrid([0, 2000], [0, 2000]);
  g.interior([[0, 0]]);
  const f2 = buildCeilingHeightField(g.graph);
  assert.equal(f2.zAt(NaN, 100), null);
  assert.equal(f2.zAt(100, undefined), null);
});

test('【失敗系】不正な形状・寸法（ライズ 0・向きが列挙外）の面は flat に落ちて zMm が一定。例外にしない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setCeilingZones([
    new CeilingZone({ id: 'bad1', cells: [g.cell(0, 0)], heightMm: 2500, shape: 'slope', dims: [0, 0] }),
    new CeilingZone({ id: 'bad2', cells: [g.cell(1, 0)], heightMm: 2700, shape: 'slope', dims: [500, 45] }),
  ]);
  const f = buildCeilingHeightField(g.graph);
  assert.doesNotThrow(() => f.zAt(500, 500));
  assert.equal(zOf(f, 100, 500), 2500);
  assert.equal(zOf(f, 1900, 500), 2500);
  assert.equal(zOf(f, 2100, 500), 2700);
  assert.equal(zOf(f, 3900, 500), 2700);
});

test('planSolids の天井立体と同じ高さ（層 FL を引いた値）: 傾斜・円弧・ドーム・部屋の形状・床段差を混ぜても footprint 内の各点で一致', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 2000, 4000]);
  const slopeRoom = g.interior([[0, 0], [0, 1]]);
  slopeRoom.setCeilingZones(createZone(g.graph, slopeRoom, [g.cell(0, 0), g.cell(0, 1)], { heightMm: 2400, shape: 'slope', dims: [600, 90] }).zones);
  const arcRoom = g.interior([[1, 0]]);
  arcRoom.setFloorLevel(-150);
  arcRoom.setCeilingZones(createZone(g.graph, arcRoom, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 90] }).zones);
  const domeRoom = g.interior([[2, 0], [2, 1]]);
  domeRoom.setCeilingZones(createZone(g.graph, domeRoom, [g.cell(2, 0), g.cell(2, 1)], { heightMm: 2300, shape: 'dome', dims: [500] }).zones);
  const shapedRoom = g.interior([[1, 1]]);
  setRoomCeilingShape(shapedRoom, 'slope', [300, 0]);
  const FZ = 3123;
  const ceilings = planSolids([fakeLayer({ graph: g.graph, floorZMm: FZ })], { ceilings: true }).filter(s => s.kind === 'ceiling');
  assert.equal(ceilings.length, 4);
  const f = buildCeilingHeightField(g.graph);
  let points = 0;
  for (const solid of ceilings) {
    for (const r of solid.footprint.rects) {
      for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
        const x = r.x1 + (r.x2 - r.x1) * i / 4, y = r.y1 + (r.y2 - r.y1) * j / 4;
        const expected = (solid.zAt ? solid.zAt(x, y) : solid.zLo) - FZ;
        const got = f.zAt(x, y);
        assert.ok(got, `面がある: (${x},${y})`);
        assert.equal(got.roomId, solid.source.id.split('#')[0]);
        assert.ok(Math.abs(got.zMm - expected) < 1e-9, `(${x},${y}) field=${got.zMm} planSolids=${expected}`);
        points++;
      }
    }
  }
  assert.equal(points, 9 * 6, '矩形 6 つ（傾斜 2・円弧 1・ドーム 2・部屋形状 1）× 9 点');
});
