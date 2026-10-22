// ceilingCutHeight.js（天伏の切断高の解決。部屋ごと・壁は天井のある側の低い方。裁定 2026-10-22）の単体テスト。ceilingSurfaces.test.js と同じ fixture で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, CeilingZone, StairType } from '@core';
import { ceilingCutResolverOf } from './ceilingCutHeight.js';
import { makeGrid, assignZoneSpec, addBeamH } from '../plan/planTestFixtures.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { beamSolids } from '../plan/planSolids.js';
import { planSolidsLayerPrimitivesUp } from '../plan/planSolidsLayerFilter.js';
import { buildCeilingHeightField } from './ceilingHeightField.js';

const BASE = 1500;
// 部屋の切断高＝天井面の最低点の 1 mm 下（CUT_BELOW_CEILING_MM＝2·eps。遮蔽が効く最小の差。定数の注を参照）
const below = z => z - 1;

test('部屋ごと: 天井の高さが違う部屋は、それぞれの天井面の直下で切る。階の値より高い天井の部屋も（一般化）。範囲は階の値と全部屋を含む', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const high = g.interior([[0, 0]]);
  const mid = g.interior([[1, 0]]);
  const low = g.interior([[2, 0]]);
  high.setOverride('ceilingHeight', '2600');
  mid.setOverride('ceilingHeight', '2200');
  low.setOverride('ceilingHeight', '1200');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.baseCutMm, BASE);
  assert.equal(r.uniform, false);
  assert.deepEqual(r.rooms, [
    { roomId: high.id, minCeilingZ: 2600, cutMm: below(2600) },
    { roomId: mid.id, minCeilingZ: 2200, cutMm: below(2200) },
    { roomId: low.id, minCeilingZ: 1200, cutMm: below(1200) },
  ]);
  assert.deepEqual(r.range, { min: below(1200), max: below(2600) });
  assert.equal(r.cutZAt(1000, 1500), below(2600));
  assert.equal(r.cutZAt(3000, 1500), below(2200));
  assert.equal(r.cutZAt(5000, 1500), below(1200));
  assert.equal(r.cutZAt(9000, 1500), BASE, '索引外（部屋の外）は階の値');
});

test('階の値は opts.baseCutMm で替えられる。天井の無い所はその値・部屋の切断高は階の値に依らない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setOverride('ceilingHeight', '2400');
  const r = ceilingCutResolverOf(g.graph, { baseCutMm: 3000 });
  assert.equal(r.baseCutMm, 3000);
  assert.equal(r.cutZAt(1000, 1500), below(2400));
  assert.equal(r.cutZAt(5000, 1500), 3000);
  assert.deepEqual(r.range, { min: below(2400), max: 3000 });
});

test('一様: 全部屋の切断高が階の値と同じ（天井のある部屋が無い・ちょうどその高さの天井）なら uniform（数値の切断高と同じ）。1 mm でもずれれば uniform ではない', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  g.feature([[0, 0]], RoomFeature.VOID);
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.uniform, true);
  assert.deepEqual(r.range, { min: BASE, max: BASE });
  assert.equal(r.cutZAt(1000, 1500), BASE);
  const flat = makeGrid([0, 2000], [0, 3000]);
  flat.interior([[0, 0]]).setOverride('ceilingHeight', String(BASE + 1));
  assert.equal(ceilingCutResolverOf(flat.graph).uniform, true, '天井が階の値+1 ならちょうど階の値で切る');
  const off = makeGrid([0, 2000], [0, 3000]);
  off.interior([[0, 0]]).setOverride('ceilingHeight', String(BASE + 2));
  assert.equal(ceilingCutResolverOf(off.graph).uniform, false);
});

test('傾斜・ドーム: 部屋の切断高は面の最低点（基準高）の直下。平均や最高点は使わない（低い側 1000・ライズ 2000 → 最低点 1000）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  const slope = g.interior([[0, 0]]);
  slope.setCeilingZones(assignZoneSpec(g.graph, slope, [g.cell(0, 0)], { heightMm: 1000, shape: 'slope', dims: [2000, 0] }));
  const dome = g.interior([[1, 0]]);
  dome.setCeilingZones(assignZoneSpec(g.graph, dome, [g.cell(1, 0)], { heightMm: 2000, shape: 'dome', dims: [500] }));
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.rooms.map(e => [e.roomId, e.minCeilingZ]), [[slope.id, 1000], [dome.id, 2000]]);
  assert.equal(r.cutZAt(2000, 2000), below(1000));
  assert.equal(r.cutZAt(6000, 2000), below(2000));
});

test('天井区画: 一部の区画だけ低いと、その部屋の全セルが区画の最低点の直下（部屋に複数の天井高さがあれば小さい方）。高い区画だけなら部屋の CH が最小', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneSpec(g.graph, room, [g.cell(1, 0)], { heightMm: 1100, shape: 'flat', dims: [] }));
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.rooms, [{ roomId: room.id, minCeilingZ: 1100, cutMm: below(1100) }]);
  assert.equal(r.cutZAt(1000, 1500), below(1100), '区画に入らない側のセルも同じ部屋なので同じ切断高');
  assert.equal(r.cutZAt(3000, 1500), below(1100));
  const hi = makeGrid([0, 2000, 4000], [0, 3000]);
  const hr = hi.interior([[0, 0], [1, 0]]);
  hr.setOverride('ceilingHeight', '2400');
  hr.setCeilingZones(assignZoneSpec(hi.graph, hr, [hi.cell(1, 0)], { heightMm: 2800, shape: 'flat', dims: [] }));
  assert.deepEqual(ceilingCutResolverOf(hi.graph).rooms.map(e => e.minCeilingZ), [2400], '低い方は部屋の CH');
});

test('床段差: 面の高さは床段差込みの絶対 z。床 −400・CH 1800 は 1400、床 +200・CH 1200 は 1400、床 +400・CH 1200 は 1600', () => {
  const mk = (floor, ch) => {
    const g = makeGrid([0, 2000], [0, 3000]);
    const room = g.interior([[0, 0]]);
    room.setFloorLevel(floor);
    room.setOverride('ceilingHeight', String(ch));
    return ceilingCutResolverOf(g.graph).rooms.map(e => e.minCeilingZ);
  };
  assert.deepEqual(mk(-400, 1800), [1400]);
  assert.deepEqual(mk(200, 1200), [1400]);
  assert.deepEqual(mk(400, 1200), [1600]);
});

test('部分指定の子は親とまとめて 1 部屋: 親と子の天井面の最小で、どちらのセルでも同じ切断高。無関係の部屋は別', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '1800');
  const other = g.interior([[2, 0]]);
  other.setOverride('ceilingHeight', '2400');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.roomCutMm.get(parent.id), below(1800));
  assert.equal(r.roomCutMm.get(child.id), below(1800));
  assert.equal(r.roomCutMm.get(other.id), below(2400));
  assert.equal(r.cutZAt(1000, 1500), below(1800), '親のセル');
  assert.equal(r.cutZAt(3000, 1500), below(1800), '子のセル');
  assert.equal(r.cutZAt(5000, 1500), below(2400));
  // 親の方が低くても同じ
  parent.setOverride('ceilingHeight', '1600');
  child.setOverride('ceilingHeight', '2000');
  assert.equal(ceilingCutResolverOf(g.graph).roomCutMm.get(child.id), below(1600));
});

test('部分指定の参照先が無い（消えた親）子は単独の部屋として扱う（例外にしない）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const child = g.graph.addRoom(new Set([g.cell(0, 0)]), '孤児', undefined, new Set(['ghost']));
  child.setOverride('ceilingHeight', '2000');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.roomCutMm.get(child.id), below(2000));
});

test('階段の対の部屋（区画の面だけ）と階段下部屋（2a。索引で部屋が勝つ）: 2a が取ったセルは 2a の切断高・対の部屋は自分の区画の面で別', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000, 5000], [0, 1000]);
  const plain = g.interior([[0, 0]]);
  plain.setOverride('ceilingHeight', '2400');
  const pair = g.feature([[1, 0], [2, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(1, 0), g.cell(2, 0)]) });
  pair.setCeilingZones([new CeilingZone({ id: 'z1', cells: [g.cell(1, 0), g.cell(2, 0)], heightMm: 2300 })]);
  const under = g.interior([[2, 0]]); // 階段下部屋（2a）
  under.setOverride('ceilingHeight', '1800');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.roomCutMm.get(pair.id), below(2300), '対の部屋は区画の面（2a が取らなかったセル）');
  assert.equal(r.roomCutMm.get(under.id), below(1800));
  assert.equal(r.cutZAt(1500, 500), below(2300), '階段のセル（2a が取らない側）');
  assert.equal(r.cutZAt(2500, 500), below(1800), '2a のセル');
  assert.equal(r.cutZAt(500, 500), below(2400));
});

test('天井の無い所: 階段吹抜け（STAIR_VOID）の平らな面・吹抜け・天井なしの部屋・索引外のセルは階の値。階段吹抜けの低い面も部屋の切断高にならない', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  const sv = g.feature([[1, 0]], RoomFeature.STAIR_VOID);
  sv.setOverride('ceilingHeight', '900');
  g.feature([[2, 0]], RoomFeature.VOID);
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.roomCutMm.has(sv.id), false);
  assert.equal(r.cutZAt(3000, 1500), BASE, '階段吹抜け');
  assert.equal(r.cutZAt(5000, 1500), BASE, '吹抜け');
  assert.equal(r.cutZAt(1000, 1500), below(2400));
});

// ---- 壁: 両側の天井のある側の低い方 ----
function sideBySide(chLeft, chRight) {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const left = g.interior([[0, 0]], { walls: true });
  const right = g.interior([[1, 0]], { walls: true });
  left.setOverride('ceilingHeight', String(chLeft));
  right.setOverride('ceilingHeight', String(chRight));
  return { g, left, right };
}

test('壁: 両側に天井があれば低い方。壁の帯は軸をまたぐので、帯のどの位置でも（軸の左右・両面）同じ切断高。壁の外の点は部屋の切断高', () => {
  const { g } = sideBySide(2600, 1200);
  const r = ceilingCutResolverOf(g.graph);
  for (const x of [1942.5, 1960, 1995, 2000, 2005, 2040, 2057.5]) assert.equal(r.cutZAt(x, 1500), below(1200), `x=${x}`);
  assert.equal(r.cutZAt(1900, 1500), below(2600), '壁の外（左の部屋）');
  assert.equal(r.cutZAt(2100, 1500), below(1200), '壁の外（右の部屋）');
  assert.equal(r.wallCutAt(true, 2000, 1500), below(1200));
  const { g: g2 } = sideBySide(2200, 2600);
  assert.equal(ceilingCutResolverOf(g2.graph).cutZAt(2000, 1500), below(2200), '階の値より高い天井どうしでも低い方');
});

test('壁: 天井のある側だけで決める。外壁（反対側は屋外＝天井なし）はある側・階段吹抜けや吹抜けの側は無視・両側とも無ければ階の値', () => {
  const { g } = sideBySide(2600, 2600);
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.cutZAt(-40, 1500), below(2600), '外壁の帯（反対側は屋外）');
  assert.equal(r.cutZAt(4040, 1500), below(2600));
  assert.equal(r.wallCutAt(true, 0, 1500), below(2600));
  const v = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  v.interior([[0, 0]], { walls: true }).setOverride('ceilingHeight', '2400');
  v.feature([[1, 0]], RoomFeature.STAIR_VOID).setOverride('ceilingHeight', '900');
  v.feature([[2, 0]], RoomFeature.VOID);
  const vr = ceilingCutResolverOf(v.graph);
  assert.equal(vr.wallCutAt(true, 2000, 1500), below(2400), '片側が階段吹抜け（天井の無い所）なら天井のある側だけ');
  assert.equal(vr.wallCutAt(true, 4000, 1500), BASE, '両側とも天井が無ければ階の値（階段吹抜け|吹抜け）');
  assert.equal(vr.wallCutAt(true, 6000, 1500), BASE, '片側が吹抜け・外側は屋外');
});

test('壁: 長さ方向で接する部屋が替わると位置ごとに決まる', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  const l0 = g.interior([[0, 0]], { walls: true });
  const l1 = g.interior([[0, 1]], { walls: true });
  const right = g.interior([[1, 0], [1, 1]], { walls: true });
  l0.setOverride('ceilingHeight', '2600');
  l1.setOverride('ceilingHeight', '1300');
  right.setOverride('ceilingHeight', '2400');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.wallCutAt(true, 2000, 750), below(2400));
  assert.equal(r.wallCutAt(true, 2000, 2250), below(1300));
  assert.equal(r.cutZAt(2000, 750), below(2400));
  assert.equal(r.cutZAt(2020, 2250), below(1300));
});

test('壁: 角の小片（壁の長さ範囲の外・直交壁の帯の中）も壁の切断高。外壁の出隅の角は隣り合う外壁と同じ値、建物の外の同じ座標付近は階の値', () => {
  const { g } = sideBySide(2600, 2600);
  const r = ceilingCutResolverOf(g.graph);
  // 左上の出隅: x∈[-45,57.5]・y∈[-45,57.5]（どの壁の長さ範囲にも入らない角の小片）
  assert.equal(r.cutZAt(-30, -30), below(2600));
  assert.equal(r.cutZAt(40, 40), below(2600));
  assert.equal(r.cutZAt(-200, -200), BASE, '角の帯の外（建物の外）');
});

test('壁: 四隅すべての角の小片が壁の切断高（長さ方向の小さい側・大きい側の両端の延長）。角の帯の外は階の値', () => {
  const { g } = sideBySide(2600, 2600);
  const r = ceilingCutResolverOf(g.graph);
  for (const [x, y] of [[-30, -30], [4030, -30], [-30, 3030], [4030, 3030]]) assert.equal(r.cutZAt(x, y), below(2600), `角 (${x}, ${y})`);
  for (const [x, y] of [[-200, -200], [4200, -200], [-200, 3200], [4200, 3200]]) assert.equal(r.cutZAt(x, y), BASE, `外 (${x}, ${y})`);
});

// T 字: 通しの壁 y=1500（上は部屋 T、下は B1|B2）と、幹の壁 x=2000（B1 と B2 の間）。交点の帯の中の点 (2020, 1460) は両方の壁の帯の中
function tJunction(chT, chB1, chB2) {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  g.interior([[0, 0], [1, 0]], { walls: true }).setOverride('ceilingHeight', String(chT));
  g.interior([[0, 1]], { walls: true }).setOverride('ceilingHeight', String(chB1));
  g.interior([[1, 1]], { walls: true }).setOverride('ceilingHeight', String(chB2));
  return ceilingCutResolverOf(g.graph);
}

test('壁: 帯が重なる所（T 字の交点）は両方の壁の切断高の小さい方。どちらの壁が小さい配置でも（帯の並びに依らない）', () => {
  // 幹（B1|B2）が小さい: 通し＝T|B2 の小さい方 2399、幹＝1199 → 1199
  const a = tJunction(2400, 1200, 2600);
  assert.equal(a.wallCutAt(false, 1500, 2020), below(2400), '前提: 通しの壁のその位置は 2399');
  assert.equal(a.wallCutAt(true, 2000, 1557.5), below(1200), '前提: 幹の壁は 1199');
  assert.equal(a.cutZAt(2020, 1460), below(1200));
  // 通しが小さい: 通し＝T 1200 → 1199、幹＝B1|B2＝2399 → 1199
  const b = tJunction(1200, 2400, 2600);
  assert.equal(b.wallCutAt(false, 1500, 2020), below(1200));
  assert.equal(b.wallCutAt(true, 2000, 1557.5), below(2400));
  assert.equal(b.cutZAt(2020, 1460), below(1200));
});

test('壁: 直交壁に届かない壁の端は延ばさない（縦の壁の端と同じ y に横の壁があっても x が離れていれば、端の外は階の値）', () => {
  const g = makeGrid([0, 2000, 6000, 8000], [0, 3000]);
  const a = g.interior([[0, 0]], { walls: true });
  a.setOverride('ceilingHeight', '2400');
  g.interior([[2, 0]], { walls: true }).setOverride('ceilingHeight', '2400');
  for (const w of g.graph.walls.filter(w => !w.isVertical && w.axisCL.effectiveValue === 0 && Math.max(w.coord1, w.coord2) < 3000)) g.graph.removeShape(w.id); // A の上の壁を外す
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.cutZAt(1990, 500), below(2400), '前提: A の右の壁の帯の中');
  assert.equal(r.cutZAt(1990, -30), BASE, '右の壁の端（y=57.5）の外。遠い B の上の壁の帯（y −45〜57.5）には届かないので延ばさない');
  assert.equal(r.cutZAt(6000, -30), below(2400), '対照: B の左上の角（B の上の壁と左の壁が接する）は延びる');
});

test('壁: 部分指定の子と親にまたがる壁は、親子をまとめた切断高になる', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]], { walls: true });
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '1800');
  const next = g.interior([[2, 0]], { walls: true });
  next.setOverride('ceilingHeight', '2600');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.wallCutAt(true, 4000, 1500), below(1800), '子と隣室の間の壁＝親子の最小と隣室の小さい方');
  assert.equal(r.wallCutAt(true, 2000, 1500), below(1800), '親と子の間（同じ部屋）の仮想の壁も同値');
});

// ---- 下がり梁（天井より低い梁。裁定 2026-10-22）: 梁型が見える位置まで部屋全体の切断高を下げる ----
// addBeamH の既定断面は成 200: levelOffset（天端）1640 → z 1440〜1640
const dropBeam = (graph, opts) => addBeamH(graph, { levelOffset: 1640, ...opts });

test('下がり梁: 天井より低い梁がある部屋は、部屋全体の切断高が梁の下端の直下（−1）まで下がる。天井の最低点（minCeilingZ）は天井のまま', () => {
  const g = makeGrid([0, 4000], [0, 4000]);
  const room = g.interior([[0, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2400');
  const beam = dropBeam(g.graph, { axis: 1000, from: 500, to: 3500 });
  const shallower = addBeamH(g.graph, { axis: 3000, from: 500, to: 3500, levelOffset: 2040 }); // z 1840〜2040（後から作った浅い梁）
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.droppedBeams, [
    { beamId: beam.id, zLo: 1440, roomIds: [room.id] },
    { beamId: shallower.id, zLo: 1840, roomIds: [room.id] },
  ]);
  assert.deepEqual(r.rooms, [{ roomId: room.id, minCeilingZ: 2400, cutMm: below(1440) }]);
  assert.equal(r.cutZAt(3000, 3000), below(1440), '梁から離れた部屋の中も同じ（部屋全体）');
  assert.deepEqual(r.range, { min: below(1440), max: BASE });
});

test('下がり梁: 壁の切断高は両側の部屋の値（梁で下がった値）に従う。梁の無い隣室とは低い方', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const left = g.interior([[0, 0]], { walls: true });
  const right = g.interior([[1, 0]], { walls: true });
  left.setOverride('ceilingHeight', '2400');
  right.setOverride('ceilingHeight', '2400');
  dropBeam(g.graph, { axis: 1500, from: 300, to: 1700 });
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.wallCutAt(true, 2000, 500), below(1440), '左右の部屋の間の壁（左が梁で下がっている）');
  assert.equal(r.cutZAt(2000, 500), below(1440));
  assert.equal(r.wallCutAt(true, 4000, 500), below(2400), '梁の無い右の部屋の外壁は右の部屋の値');
  assert.equal(r.wallCutAt(true, 0, 500), below(1440), '左の部屋の外壁');
  assert.equal(r.cutZAt(3000, 1500), below(2400), '右の部屋の中');
});

test('下がり梁: 部分指定の親子は群で最小。子の中の梁で親の部屋も下がる', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '2400');
  const other = g.interior([[2, 0]]);
  other.setOverride('ceilingHeight', '2400');
  dropBeam(g.graph, { axis: 1500, from: 2300, to: 3700 }); // 子のセルの中
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.roomCutMm.get(child.id), below(1440));
  assert.equal(r.roomCutMm.get(parent.id), below(1440), '親も群の最小');
  assert.equal(r.roomCutMm.get(other.id), below(2400), '無関係の部屋は下がらない');
});

test('下がり梁: 壁の帯の中に収まる梁（外壁の中の梁）・天井より上の梁・天井の無い所（吹抜け・屋外）の梁では下げない', () => {
  const mk = () => {
    const g = makeGrid([0, 2000, 4000], [0, 3000]);
    const room = g.interior([[0, 0]], { walls: true });
    room.setOverride('ceilingHeight', '2400');
    g.feature([[1, 0]], RoomFeature.VOID);
    return g;
  };
  const inWall = mk();
  dropBeam(inWall.graph, { axis: 0, from: 100, to: 1900 }); // 外壁 y=0 の帯 [−45, 57.5] の中（足元 y −50〜50）
  assert.deepEqual(ceilingCutResolverOf(inWall.graph).droppedBeams, [], '壁の帯の中');
  assert.equal(ceilingCutResolverOf(inWall.graph).roomCutMm.size, 1);
  assert.equal([...ceilingCutResolverOf(inWall.graph).roomCutMm.values()][0], below(2400));
  const above = mk();
  addBeamH(above.graph, { axis: 1500, from: 300, to: 1700, levelOffset: 2700 }); // z 2500〜2700（天井 2400 より上）
  assert.deepEqual(ceilingCutResolverOf(above.graph).droppedBeams, [], '天井より上の床梁');
  const flush = mk();
  addBeamH(flush.graph, { axis: 1500, from: 300, to: 1700, levelOffset: 2400 }); // z 2200〜2400: 天端が天井に届いていても、下端が天井より下なら下がり梁
  assert.equal(ceilingCutResolverOf(flush.graph).droppedBeams.length, 1, '対照: 天井に届く成 200 の梁は下がり梁');
  const outside = mk();
  dropBeam(outside.graph, { axis: 1500, from: 2300, to: 3700 }); // 吹抜け（天井の無い所）の上
  const out = ceilingCutResolverOf(outside.graph);
  assert.deepEqual(out.droppedBeams, [], '天井の無い所の梁');
  assert.equal(out.cutZAt(3000, 1500), BASE, '吹抜けの上は階の値のまま');
  assert.equal(out.roomCutMm.get(outside.graph.rooms[0].id), below(2400));
});

test('下がり梁: 床梁（天端が床面 FL で下端が床より下。z −200〜0 など）は部屋の中に見えないので部屋を下げない。床段差のある部屋では床面（段差込み）が基準', () => {
  const g = makeGrid([0, 4000], [0, 4000]);
  const room = g.interior([[0, 0]]);
  room.setOverride('ceilingHeight', '2400');
  addBeamH(g.graph, { axis: 1500, from: 300, to: 1700, levelOffset: 0 }); // z −200〜0
  addBeamH(g.graph, { axis: 2500, from: 300, to: 1700, levelOffset: 100 }); // z −100〜100（床をまたぐ）
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.droppedBeams, []);
  assert.equal(r.roomCutMm.get(room.id), below(2400));
  // 床 +400 の部屋: 床面は 400。z 300〜500 の梁は床をまたぐので対象外、z 500〜700 の梁（床面より上）は下がり梁
  const s = makeGrid([0, 4000, 8000], [0, 4000]);
  s.interior([[0, 0]]).setOverride('ceilingHeight', '2400'); // 床 0 の部屋（全体の最低の床面を 0 にして速い除外を通す）
  const step = s.interior([[1, 0]]);
  step.setFloorLevel(400);
  step.setOverride('ceilingHeight', '2400');
  addBeamH(s.graph, { axis: 1500, from: 4300, to: 5700, levelOffset: 500 });
  const above = addBeamH(s.graph, { axis: 2500, from: 4300, to: 5700, levelOffset: 700 });
  assert.deepEqual(ceilingCutResolverOf(s.graph).droppedBeams.map(d => d.beamId), [above.id]);
});

test('下がり梁: opts.beamSolids（呼び元が作った自階の梁の立体）を渡すと、渡さない場合と同じ結果。空配列を渡せば梁なし扱い', () => {
  const g = makeGrid([0, 4000], [0, 4000]);
  g.interior([[0, 0]], { walls: true }).setOverride('ceilingHeight', '2400');
  dropBeam(g.graph, { axis: 1000, from: 500, to: 3500 });
  addBeamH(g.graph, { axis: 3000, from: 500, to: 3500, levelOffset: 0 }); // 床梁
  const own = beamSolids({ graph: g.graph, floorZMm: 0 });
  const viaOpts = ceilingCutResolverOf(g.graph, { beamSolids: own });
  const plain = ceilingCutResolverOf(g.graph);
  assert.deepEqual(viaOpts.droppedBeams, plain.droppedBeams);
  assert.deepEqual(viaOpts.rooms, plain.rooms);
  assert.equal(plain.droppedBeams.length, 1);
  assert.deepEqual(ceilingCutResolverOf(g.graph, { beamSolids: [] }).droppedBeams, [], '渡した立体だけを見る');
});

test('下がり梁: 下端が天井面と同じ（eps 以内）の梁は下がり梁ではない。梁の無い階・graph が null は droppedBeams が空', () => {
  const g = makeGrid([0, 4000], [0, 4000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  addBeamH(g.graph, { axis: 1500, from: 300, to: 1700, levelOffset: 2600.4 }); // 下端 2400.4（天井より上）
  addBeamH(g.graph, { axis: 2500, from: 300, to: 1700, levelOffset: 2600 }); // 下端 2400＝天井面
  assert.deepEqual(ceilingCutResolverOf(g.graph).droppedBeams, []);
  assert.deepEqual(ceilingCutResolverOf(null).droppedBeams, []);
  const none = makeGrid([0, 2000], [0, 3000]);
  none.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  assert.deepEqual(ceilingCutResolverOf(none.graph).droppedBeams, []);
});

test('下がり梁: 天井の高さが位置で替わる傾斜天井は、梁の足元と重なる範囲の天井面の最高点と比べる（低い側の短い梁は下がり梁にならず、高い側の同じ高さの梁は下がり梁）', () => {
  const s = makeGrid([0, 4000], [0, 4000]);
  const sl = s.interior([[0, 0]]);
  sl.setCeilingZones(assignZoneSpec(s.graph, sl, [s.cell(0, 0)], { heightMm: 2000, shape: 'slope', dims: [2000, 0] }));
  const z = ceilingSurfacesOf(s.graph)[0];
  const field = buildCeilingHeightField(s.graph);
  const low = field.zAt(200, 1000).zMm, high = field.zAt(3800, 1000).zMm; // 位置で替わる天井面の高さ
  assert.ok(z && Math.abs(high - low) > 100, '前提: 天井面の高さが位置で替わる');
  const mid = (low + high) / 2;
  const beamAt = (lo, hi) => addBeamH(s.graph, { axis: 1000, from: lo, to: hi, levelOffset: mid + 100 }); // 下端 mid−100
  const lowSideBeam = beamAt(100, 300); // 低い側 x≈200: 天井面(low)が下端(mid−100)より下 → 下がり梁ではない
  const highSideBeam = beamAt(3700, 3900); // 高い側 x≈3800: 天井面(high)が下端より上 → 下がり梁
  const ids = ceilingCutResolverOf(s.graph).droppedBeams.map(d => d.beamId);
  assert.ok(lowSideBeam && ids.includes(highSideBeam.id) && !ids.includes(lowSideBeam.id), JSON.stringify({ low, high, mid, ids }));
});

// 傾斜天井: 梁の足元と天井面の重なりの中の最高点と比べる（中心点だけだと、高い側でだけ天井より下に見える梁を取りこぼす）
function slopeScene() {
  const s = makeGrid([0, 4000], [0, 4000]);
  const sl = s.interior([[0, 0]]);
  sl.setCeilingZones(assignZoneSpec(s.graph, sl, [s.cell(0, 0)], { heightMm: 2000, shape: 'slope', dims: [2000, 0] }));
  const field = buildCeilingHeightField(s.graph);
  return { s, sl, atCenter: field.zAt(2000, 1000).zMm, atHigh: field.zAt(3900, 1000).zMm };
}

test('下がり梁: 傾斜天井で、重なりの中心では天井の上・高い側では天井の下にある長い梁は下がり梁になる（中心点だけの比較では取りこぼした）', () => {
  const { s, sl, atCenter, atHigh } = slopeScene();
  const zLo = atCenter + 300; // 中心の天井より上、高い側の天井より下
  assert.ok(atHigh - zLo > 100 && zLo > atCenter, `前提: ${JSON.stringify({ atCenter, atHigh, zLo })}`);
  const beam = addBeamH(s.graph, { axis: 1000, from: 100, to: 3900, levelOffset: zLo + 200 });
  const r = ceilingCutResolverOf(s.graph);
  assert.deepEqual(r.droppedBeams, [{ beamId: beam.id, zLo, roomIds: [sl.id] }]);
  assert.equal(r.roomCutMm.get(sl.id), Math.min(r.rooms[0].minCeilingZ, zLo) - 1, '部屋の切断高は min(天井の最低点, 梁の下端) − 1');
  const lines = planSolidsLayerPrimitivesUp({ graph: s.graph, cutZ: BASE }).filter(p => p.kind === 'line' && p.source.id === beam.id);
  assert.ok(lines.length > 0 && lines.every(p => p.cls === 'below' && p.weight === 'medium' && p.droppedBeam === true), '梁の外形は見え掛かりの中線');
});

test('下がり梁: 半円の天井（円弧）・ドームの頂点のすぐ下（20 mm・5 mm）にある梁を、格子の標本では見落とす位置でも下がり梁にする（最高点は zMaxIn で正確に取る）', () => {
  const beamAt = (id, rect, zLo) => ({ kind: 'beam', footprint: { rects: [rect] }, zLo, zHi: zLo + 200, source: { kind: 'beam', id, layerFloorZ: 0 } });
  // 半円: 幅 4000（y）・ライズ 2000・基準 2000 → 頂点 4000（y=2000 の中心線）。重なり y 800〜4000
  const a = makeGrid([0, 4000], [0, 4000]);
  const arcRoom = a.interior([[0, 0]]);
  arcRoom.setCeilingZones(assignZoneSpec(a.graph, arcRoom, [a.cell(0, 0)], { heightMm: 2000, shape: 'arc', dims: [2000, 0] }));
  const arcField = buildCeilingHeightField(a.graph);
  assert.equal(arcField.zAt(2000, 2000).zMm, 4000, '前提: 頂点は 4000');
  assert.ok(arcField.zAt(2000, 2400).zMm < 3980 && arcField.zAt(2000, 1600).zMm < 3980, '前提: 格子の標本点（y 800/1600/2400/3200/4000）の最大は頂点の 20 mm 下より低い');
  const arcBeam = beamAt('arcBeam', { x1: 1950, x2: 2050, y1: 800, y2: 4000 }, 3980);
  assert.deepEqual(ceilingCutResolverOf(a.graph, { beamSolids: [arcBeam] }).droppedBeams.map(d => d.beamId), ['arcBeam']);
  assert.deepEqual(ceilingCutResolverOf(a.graph, { beamSolids: [{ ...arcBeam, zLo: 4000.4 }] }).droppedBeams, [], '頂点より上（eps 以内）は下がり梁でない');
  // ドーム: 基準 2000・ライズ 1000 → 頂点 3000（中心 2000,2000）。重なり 1500〜4000 の格子点は中心を外す
  const d = makeGrid([0, 4000], [0, 4000]);
  const domeRoom = d.interior([[0, 0]]);
  domeRoom.setCeilingZones(assignZoneSpec(d.graph, domeRoom, [d.cell(0, 0)], { heightMm: 2000, shape: 'dome', dims: [1000] }));
  const domeField = buildCeilingHeightField(d.graph);
  assert.equal(domeField.zAt(2000, 2000).zMm, 3000, '前提: 頂点は 3000');
  const domeBeam = beamAt('domeBeam', { x1: 1500, x2: 4000, y1: 1500, y2: 4000 }, 2995);
  assert.deepEqual(ceilingCutResolverOf(d.graph, { beamSolids: [domeBeam] }).droppedBeams.map(x => x.beamId), ['domeBeam']);
  assert.deepEqual(ceilingCutResolverOf(d.graph, { beamSolids: [{ ...domeBeam, zLo: 3000.4 }] }).droppedBeams, []);
});

test('下がり梁: 足元（壁の帯を引いた残り）が天井面の矩形と辺で接するだけ（重なり 0 mm）の梁は下がり梁ではない', () => {
  const g = makeGrid([0, 4000], [0, 4000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  addBeamH(g.graph, { axis: 4050, from: 500, to: 3500, levelOffset: 1640 }); // 足元 y 4000〜4100: 天井面（y 0〜4000）と y=4000 で接するだけ
  assert.deepEqual(ceilingCutResolverOf(g.graph).droppedBeams, []);
});

test('下がり梁: 天井高の違う 2 部屋で、低い部屋の天井面ちょうど（下端 2000）の梁は、高い部屋（2400）の天井が速い除外を通しても下がり梁ではない。低い部屋の天井より eps を超えて下なら下がり梁', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  const low = g.interior([[1, 0]]);
  low.setOverride('ceilingHeight', '2000');
  addBeamH(g.graph, { axis: 1500, from: 4300, to: 5700, levelOffset: 2200 }); // 下端 2000＝低い部屋の天井面
  assert.deepEqual(ceilingCutResolverOf(g.graph).droppedBeams, [], '面ごとの eps の境目');
  const under = addBeamH(g.graph, { axis: 2500, from: 4300, to: 5700, levelOffset: 2199 }); // 下端 1999
  assert.deepEqual(ceilingCutResolverOf(g.graph).droppedBeams.map(d => d.beamId), [under.id]);
});

test('下がり梁: 間仕切り壁をまたぐ梁は両側の部屋の roomIds に入り、両部屋とも切断高が下がる（壁の帯の中の部分は数えない）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const left = g.interior([[0, 0]], { walls: true });
  const right = g.interior([[1, 0]], { walls: true });
  left.setOverride('ceilingHeight', '2400');
  right.setOverride('ceilingHeight', '2400');
  const beam = dropBeam(g.graph, { axis: 1500, from: 1500, to: 2500 }); // 間仕切り壁 x=2000 の帯をまたぐ
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.droppedBeams.map(d => [d.beamId, [...d.roomIds].sort()]), [[beam.id, [left.id, right.id].sort()]]);
  assert.equal(r.roomCutMm.get(left.id), below(1440));
  assert.equal(r.roomCutMm.get(right.id), below(1440));
  assert.equal(r.wallCutAt(true, 4000, 500), below(1440), '右の部屋の外壁も下がった値');
});

test('【失敗系】graph が null・天井面を持つ部屋が無い・非有限の座標・壁の無い階は例外にしない（階の値）', () => {
  const none = ceilingCutResolverOf(null);
  assert.equal(none.baseCutMm, BASE);
  assert.equal(none.uniform, true);
  assert.deepEqual(none.rooms, []);
  assert.equal(none.cutZAt(0, 0), BASE);
  assert.equal(none.wallCutAt(true, 0, 0), BASE);
  const g = makeGrid([0, 2000], [0, 3000]);
  g.feature([[0, 0]], RoomFeature.VOID);
  assert.deepEqual(ceilingCutResolverOf(g.graph).rooms, []);
  const low = makeGrid([0, 2000], [0, 3000]); // 壁なし
  low.interior([[0, 0]]).setOverride('ceilingHeight', '1000');
  const lr = ceilingCutResolverOf(low.graph);
  assert.equal(lr.cutZAt(NaN, 1500), BASE);
  assert.equal(lr.cutZAt(undefined, undefined), BASE);
  assert.equal(lr.cutZAt(1000, 1500), below(1000));
  assert.equal(lr.wallCutAt(true, NaN, NaN), BASE);
  assert.equal(ceilingCutResolverOf(low.graph, { baseCutMm: NaN }).baseCutMm, BASE, '非有限の baseCutMm は階の値');
});
