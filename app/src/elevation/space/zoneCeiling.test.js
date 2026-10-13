// zoneCeiling.js（展開図が天伏の平面区画の高さに追従するための点問い合わせ）の単体テスト。
// 区画の作り方は ceiling/ceilingHeightField.test.js と同じ fixture。期待値はリテラル。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, StairType, Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import {
  zoneCeilingFieldOf, zoneCeilingChAt, zoneCeilingChAlong, zoneCeilingChTopAt, zoneCeilingEdgesAlong, zoneCeilingFarEdge,
  zoneCeilingDepthEdges, zoneCeilingRunRangeAt,
} from './zoneCeiling.js';
import { createZone } from '../../ceiling/ceilingZones.js';
import { setRoomCeilingShape } from '../../ceiling/roomCeilingShape.js';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { worldToCell, CEILING_CELL_GRID } from '../../finish/gridCells.js';
import { buildCeilingHeightField } from '../../ceiling/ceilingHeightField.js';
import { makeGrid } from '../../plan/planTestFixtures.js';

const flat = mm => ({ heightMm: mm, shape: 'flat', dims: [] });

// 主寝室型: 2室分の幅 x 0..2000 / 2000..5000、左 2400・右 3000 の平面区画（部屋CH 2500）
function twoZoneGrid() {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2400)).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  return { ...g, room };
}

test('【区画なしは field null】区画を持たない図面と graph null は null（何も変わらない早道）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  g.interior([[0, 0]]);
  assert.equal(zoneCeilingFieldOf(g.graph), null);
  assert.equal(zoneCeilingFieldOf(null), null);
  assert.equal(zoneCeilingChAt(null, null, 0, 0), null);
});

test('【平面区画は chMm】区画の上の点は区画の高さ（部屋 FL 基準）・区画の無い残りは null', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.ok(f);
  assert.equal(zoneCeilingChAt(f, room, 3500, 1500), 3000);
  assert.equal(zoneCeilingChAt(f, room, 1000, 1500), null, '区画に入らない残りは部屋の CH に落とす');
  assert.equal(zoneCeilingChAt(f, room, 9000, 1500), null, '面の外');
});

test('【床段差の二重加算なし】床 +100 の部屋の区画は chMm のまま（床段差を含まない）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setFloorLevel(100);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(3000)).zones);
  assert.equal(zoneCeilingChAt(zoneCeilingFieldOf(g.graph), room, 1000, 1500), 3000);
});

test('【円弧・ドームの区画だけの図面】field は作る（E4）。平面の点問い合わせは null・includeCurved なしの ChAlong も null（遠側などは部屋の CH）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'dome', dims: [500] }).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.ok(f, '円弧・ドームがあれば field を作る');
  assert.equal(zoneCeilingChAt(f, room, 1000, 1500), null, '平面の点問い合わせは円弧・ドームに答えない');
  assert.equal(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 0, hi: 1000 }), null, '既定は円弧・ドームを答えない');
  assert.equal(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 3000, hi: 3500 }), null, '円弧も既定では null');
});

// ---- E4: 円弧・ドームの片（includeCurved）。壁の仕上げ面の奥行き座標で評価し、頭頂 apex を返す ----
// 円弧 1 セル x 0..4000 × y 0..3000・底 2400・ライズ 400。軸 90（y に平行）なら幅は x 方向 4000 で R=(2000²+400²)/(2×400)=5200。
function arcGrid(dims, heightMm = 2400) {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm, shape: 'arc', dims }).zones);
  return { ...g, room, f: zoneCeilingFieldOf(g.graph) };
}
const CURVED = { isVertical: false, depthCoord: 1500, probeDepth: 1495, includeCurved: true };

test('【arc（軸に直交する面）の両端と apex】軸 90・走り x の面: 全長で 両端 2400・頭頂 x=2000 で 2800', () => {
  const { room, f } = arcGrid([400, 90]);
  const a = zoneCeilingChAlong(f, room, { ...CURVED, lo: 0, hi: 4000 });
  near(a.chLo, 2400, '左端'); near(a.chHi, 2400, '右端');
  assert.equal(a.apex.along, 2000);
  near(a.apex.ch, 2800, '中心線 = chMm + ライズ');
});

test('【arc の端の値】縁より内側の片: 走り x 500..3000 は R=5200 の円の高さ（t=−1500／+1000）', () => {
  const { room, f } = arcGrid([400, 90]);
  const a = zoneCeilingChAlong(f, room, { ...CURVED, lo: 500, hi: 3000 });
  const z = t => 2400 + Math.sqrt(5200 ** 2 - t ** 2) - (5200 - 400);
  near(a.chLo, z(-1500), '左'); near(a.chHi, z(1000), '右');
  near(a.apex.ch, 2800, '頭頂');
});

test('【arc（軸に平行な面）は一定で apex なし】軸 0（x に平行）を走り x の面で見ると高さは depthCoord だけで決まる（中心 y=1500 で 2800）', () => {
  const { room, f } = arcGrid([400, 0]);
  const a = zoneCeilingChAlong(f, room, { ...CURVED, lo: 0, hi: 4000 });
  near(a.chLo, 2800, '中心線の深さ'); near(a.chHi, 2800, '同じ');
  assert.equal('apex' in a, false, '走り方向に一定＝水平線');
  // 縁の深さ（壁の仕上げ面の近く）は低い
  const edge = zoneCeilingChAlong(f, room, { ...CURVED, depthCoord: 0, lo: 0, hi: 4000 });
  near(edge.chLo, 2400, '縁'); assert.equal('apex' in edge, false);
});

test('【arc の縦の面】軸 0 の円弧を走り y（isVertical）の面で見ると頭頂 y=1500（幅 3000・R=(1500²+400²)/800=3012.5）', () => {
  const { room, f } = arcGrid([400, 0]);
  const a = zoneCeilingChAlong(f, room, { isVertical: true, depthCoord: 2000, probeDepth: 1995, lo: 0, hi: 3000, includeCurved: true });
  near(a.chLo, 2400, '縁'); near(a.chHi, 2400, '縁');
  assert.equal(a.apex.along, 1500);
  near(a.apex.ch, 2800, '頭頂');
});

test('【dome の壁面上の最高点】ライズ 500・x 0..4000 × y 0..3000: 走り x の面を y=1500（中央）で見ると頭頂 x=2000 で 2900・y=750 では 2400+500×(1−0.25)=2775', () => {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'dome', dims: [500] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  const mid = zoneCeilingChAlong(f, room, { ...CURVED, depthCoord: 1500, lo: 0, hi: 4000 });
  near(mid.chLo, 2400, '周縁'); near(mid.apex.ch, 2900, '頭頂'); assert.equal(mid.apex.along, 2000);
  const q = zoneCeilingChAlong(f, room, { ...CURVED, depthCoord: 750, probeDepth: 755, lo: 0, hi: 4000 });
  near(q.apex.ch, 2775, '壁面上の最高点は壁の奥行きで決まる');
  assert.equal(zoneCeilingChTopAt(f, room, 1000, 1500), 2900, 'ChTopAt はドームの頂点');
});

test('【片の範囲に最高点が無ければ apex なし】頭頂 x=2000 が片 2500..4000 の外・縁ぎりぎり（0.5mm）の片も apex なし', () => {
  const { room, f } = arcGrid([400, 90]);
  const a = zoneCeilingChAlong(f, room, { ...CURVED, lo: 2500, hi: 4000 });
  assert.equal('apex' in a, false);
  near(a.chLo, 2400 + Math.sqrt(5200 ** 2 - 500 ** 2) - 4800, '左端は円の高さ');
  const edge = zoneCeilingChAlong(f, room, { ...CURVED, lo: 1999.5, hi: 4000 });
  assert.equal('apex' in edge, false, '端から 1mm 未満の頭頂は返さない');
});

test('【arc の失敗系】円弧でない軸・非有限・別の部屋は null／弦と同じ高さ（ライズ 0 相当の周縁の深さ）は apex なし', () => {
  const { room, f } = arcGrid([400, 90]);
  assert.equal(zoneCeilingChAlong(f, room, { ...CURVED, lo: NaN, hi: 4000 }), null);
  assert.equal(zoneCeilingChAlong(f, room, { ...CURVED, lo: 5000, hi: 6000, probeDepth: 1495 }), null, '面の外');
  assert.equal(zoneCeilingChAlong(f, null, { ...CURVED, lo: 0, hi: 4000 }), null);
  const dome = (() => {
    const g = makeGrid([0, 4000], [0, 3000]);
    const r = g.interior([[0, 0]]);
    r.setCeilingZones(createZone(g.graph, r, [g.cell(0, 0)], { heightMm: 2400, shape: 'dome', dims: [500] }).zones);
    return { r, f: zoneCeilingFieldOf(g.graph) };
  })();
  const onEdge = zoneCeilingChAlong(dome.f, dome.r, { ...CURVED, depthCoord: 0, probeDepth: 5, lo: 0, hi: 4000 });
  near(onEdge.chHi, 2400, '周縁の壁面は全長で底の高さ'); assert.equal('apex' in onEdge, false, '一直線＝頭頂なし');
});

// 傾斜の区画: 1セル x 0..4000 × y 0..3000・底 2400・ライズ 600・向き dir
function slopeGrid(dir) {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, dir] }).zones);
  return { ...g, room, f: zoneCeilingFieldOf(g.graph) };
}
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg} 実際:${actual} 期待:${expected}`);

test('【slope の面の両端値】向き 0/180（走りが x の面）: 全長で 2400→3000／3000→2400・半分の区間で 2400→2700', () => {
  const q = { isVertical: false, depthCoord: 1500, probeDepth: 1495 };
  for (const [dir, lo, hi] of [[0, 2400, 3000], [180, 3000, 2400]]) {
    const { room, f } = slopeGrid(dir);
    const full = zoneCeilingChAlong(f, room, { ...q, lo: 0, hi: 4000 });
    near(full.chLo, lo, `dir ${dir} lo`); near(full.chHi, hi, `dir ${dir} hi`);
  }
  const { room, f } = slopeGrid(0);
  const half = zoneCeilingChAlong(f, room, { ...q, lo: 0, hi: 2000 });
  near(half.chLo, 2400, '半分 lo'); near(half.chHi, 2700, '半分 hi');
});

test('【slope の面の両端値】向き 90/270（走りが y の面）: 全長で 2400→3000／3000→2400', () => {
  for (const [dir, lo, hi] of [[90, 2400, 3000], [270, 3000, 2400]]) {
    const { room, f } = slopeGrid(dir);
    const v = zoneCeilingChAlong(f, room, { isVertical: true, depthCoord: 2000, probeDepth: 1995, lo: 0, hi: 3000 });
    near(v.chLo, lo, `dir ${dir} lo`); near(v.chHi, hi, `dir ${dir} hi`);
  }
});

test('【走りに直交する傾斜は両端同値で奥行き座標の値】向き 90 の傾斜を水平の面（走り x・奥行き y）で見ると depthCoord=750 で 2400+600×750/3000', () => {
  const { room, f } = slopeGrid(90);
  const c = zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 750, probeDepth: 755, lo: 100, hi: 3900 });
  near(c.chLo, 2550, 'lo'); near(c.chHi, 2550, 'hi');
});

test('【flat は両端同値】区画つき平面は {chMm, chMm}・区画なしの残りは null', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.deepEqual(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 2000, hi: 5000 }), { chLo: 3000, chHi: 3000 });
  assert.equal(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 0, hi: 2000 }), null, '区画に入らない残り（平面）は null');
});

test('【arc・dome・他の部屋・面なし・両端が別の面は null】', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  const b = g.interior([[1, 0]]);
  b.setCeilingZones(createZone(g.graph, b, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const c = g.interior([[2, 0]]);
  c.setCeilingZones(createZone(g.graph, c, [g.cell(2, 0)], { heightMm: 2400, shape: 'dome', dims: [500] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  const q = (lo, hi) => ({ isVertical: false, depthCoord: 1500, lo, hi });
  assert.ok(zoneCeilingChAlong(f, a, q(0, 2000)), '前提: a の傾斜は引ける');
  assert.equal(zoneCeilingChAlong(f, b, q(2000, 4000)), null, '円弧');
  assert.equal(zoneCeilingChAlong(f, c, q(4000, 6000)), null, 'ドーム');
  assert.equal(zoneCeilingChAlong(f, b, q(0, 2000)), null, '他の部屋の面');
  assert.equal(zoneCeilingChAlong(f, a, q(7000, 9000)), null, '面なし');
  assert.equal(zoneCeilingChAlong(f, a, q(1000, 3000)), null, '両端が別の面（辺で割っていない片）は防御で null');
  assert.equal(zoneCeilingChAlong(f, null, q(0, 2000)), null);
  assert.equal(zoneCeilingChAlong(null, a, q(0, 2000)), null);
});

test('【ChTopAt】slope・arc は chMm＋ライズ・flat 区画は chMm・面なし/他の部屋は null（dome は別テスト）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  const b = g.interior([[1, 0]]);
  b.setCeilingZones(createZone(g.graph, b, [g.cell(1, 0)], { heightMm: 2700, shape: 'flat', dims: [] }).zones);
  const c = g.interior([[2, 0]]);
  c.setCeilingZones(createZone(g.graph, c, [g.cell(2, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.equal(zoneCeilingChTopAt(f, a, 100, 1500), 3000, '低い側の点でも最高点');
  assert.equal(zoneCeilingChTopAt(f, b, 3000, 1500), 2700);
  assert.equal(zoneCeilingChTopAt(f, c, 5000, 1500), 2800, '円弧は面の最高点（2400＋ライズ400。E4）');
  assert.equal(zoneCeilingChTopAt(f, a, 3000, 1500), null, '他の部屋の面');
  assert.equal(zoneCeilingChTopAt(f, a, 9000, 1500), null, '面なし');
  assert.equal(zoneCeilingChTopAt(null, a, 100, 1500), null);
});

test('【includeShaped】slope の辺は既定では返らず、指定すると返る（arc の辺は includeCurved まで返らない）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0], [1, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  const q = { isVertical: false, depthCoord: 1500, lo: -100, hi: 7000 };
  assert.deepEqual(zoneCeilingEdgesAlong(f, q), []);
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, includeShaped: true }), [0, 2000], 'slope（x 0..2000）の辺だけ');
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, includeCurved: true }), [2000, 4000], 'arc（x 2000..4000）の辺だけ');
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, includeShaped: true, includeCurved: true }), [0, 2000, 4000]);
});

test('【失敗系】他の部屋の面・room null・STAIR の対の部屋の区画・STAIR_VOID の面は null', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], flat(2700)).zones);
  const b = g.interior([[1, 0]]);
  const pair = g.feature([[2, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0)]) });
  pair.setCeilingZones(createZone(g.graph, pair, [g.cell(2, 0)], flat(2800)).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.equal(zoneCeilingChAt(f, a, 1000, 1500), 2700);
  assert.equal(zoneCeilingChAt(f, b, 1000, 1500), null, '他の部屋の面');
  assert.equal(zoneCeilingChAt(f, null, 1000, 1500), null, 'room null');
  assert.equal(zoneCeilingChAt(f, pair, 5000, 1500), null, '天井を持たない STAIR の対の部屋');
  const g2 = makeGrid([0, 2000, 4000], [0, 3000]);
  const ok = g2.interior([[0, 0]]);
  ok.setCeilingZones(createZone(g2.graph, ok, [g2.cell(0, 0)], flat(2700)).zones);
  const sv = g2.feature([[1, 0]], RoomFeature.STAIR_VOID);
  assert.equal(zoneCeilingChAt(zoneCeilingFieldOf(g2.graph), sv, 3000, 1500), null, 'STAIR_VOID の面は zoneId なし');
});

test('【失敗系】getFinishInfo が例外を投げる部屋がいても zoneCeilingFieldOf は例外にせず null', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2700)).zones);
  const bad = g.interior([[1, 0]]);
  bad.getFinishInfo = () => { throw new Error('壊れた部屋'); };
  assert.throws(() => buildCeilingHeightField(g.graph), /壊れた部屋/, '前提: 足場そのものは例外を投げる');
  let f;
  assert.doesNotThrow(() => { f = zoneCeilingFieldOf(g.graph); });
  assert.equal(f, null, '例外は握りつぶして区画なし扱い（展開図全体を巻き添えにしない）');
});

test('【辺は探査行を含む矩形だけ・(lo,hi) の内側だけ・昇順】', () => {
  const { graph, room } = twoZoneGrid();
  const f = zoneCeilingFieldOf(graph);
  // 面は水平（isVertical=false）: 走り方向 x・奥行き y。区画の x 辺は 0, 2000, 5000
  const q = { isVertical: false, depthCoord: 1500, lo: -100, hi: 6000 };
  assert.deepEqual(zoneCeilingEdgesAlong(f, q), [0, 2000, 5000]);
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, lo: 0, hi: 5000 }), [2000], '端点ちょうどは含めない');
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, depthCoord: 3500 }), [], '奥行きが矩形の外');
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, depthCoord: 0 }), [], '奥行きが矩形の辺ちょうど（厳密に含まない）');
  assert.deepEqual(zoneCeilingEdgesAlong(null, q), []);
  // 垂直面: 走り方向 y・奥行き x。y 辺は 0, 3000
  assert.deepEqual(zoneCeilingEdgesAlong(f, { isVertical: true, depthCoord: 1000, lo: -1, hi: 9999 }), [0, 3000]);
  assert.ok(room);
});

// ---- zoneCeilingFarEdge（E3b-1: 視線の先＝奥の端の高さ）----
const slope = (mm, rise, dir) => ({ heightMm: mm, shape: 'slope', dims: [rise, dir] });

// 3000×2000 の1室に区画 slope[600, dir]（底 2400）。
function slopeRoom(dir, opts = {}) {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]], opts);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], slope(2400, 600, dir)).zones);
  return { ...g, room, field: zoneCeilingFieldOf(g.graph) };
}

test('【奥の端・4方向×面の向き】水平の面（走り x・奥行き y）と垂直の面（走り y・奥行き x）で、視線の向き ±1 ごとに奥の端の高さが 2400/3000 になる', () => {
  // [isVertical, startCoord, dir, 勾配の向き, run, 期待 chLo=chHi]
  const cases = [
    [false, 0, +1, 90, [500, 2500], 3000],    // y=2000 が奥・+y に上がる→高い側
    [false, 0, +1, 270, [500, 2500], 2400],   // 奥が低い側
    [false, 2000, -1, 90, [500, 2500], 2400], // 反対側から見る: 奥は y=0
    [false, 2000, -1, 270, [500, 2500], 3000],
    [true, 0, +1, 0, [200, 1800], 3000],      // x=3000 が奥・+x に上がる
    [true, 0, +1, 180, [200, 1800], 2400],
    [true, 3000, -1, 0, [200, 1800], 2400],   // 奥は x=0
    [true, 3000, -1, 180, [200, 1800], 3000],
  ];
  for (const [isVertical, startCoord, dir, sd, [runLo, runHi], expected] of cases) {
    const { room, graph, field } = slopeRoom(sd);
    const r = zoneCeilingFarEdge(field, graph, room, { isVertical, runLo, runHi, startCoord, dir });
    const label = `isVertical=${isVertical} start=${startCoord} dir=${dir} 勾配=${sd}`;
    assert.ok(r, label);
    assert.equal(r.alongRun, false, label);
    assert.equal(r.chLo, expected, label);
    assert.equal(r.chHi, expected, `${label}: 奥行き方向の傾斜は走りによらず同値`);
  }
});

test('【奥の端・走り方向の傾斜は alongRun】水平の面で +x 勾配は runLo/runHi の高さ（500→2500, 2500→2900）、垂直の面で -y 勾配は 200→2940, 1800→2460', () => {
  {
    const { room, graph, field } = slopeRoom(0);
    const r = zoneCeilingFarEdge(field, graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
    assert.deepEqual(r, { chLo: 2500, chHi: 2900, alongRun: true });
  }
  {
    const { room, graph, field } = slopeRoom(270);
    const r = zoneCeilingFarEdge(field, graph, room, { isVertical: true, runLo: 200, runHi: 1800, startCoord: 0, dir: +1 });
    assert.equal(r.alongRun, true);
    assert.ok(Math.abs(r.chLo - 2940) < 1e-9 && Math.abs(r.chHi - 2460) < 1e-9, JSON.stringify(r));
  }
});

test('【奥の端に壁あり】奥 y=2000 の壁の仕上げ面（2000−57.5）で評価する＝2400+600×1942.5/2000＝2982.75。壁なしは座標 2000 の 3000', () => {
  const q = { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 };
  const walled = slopeRoom(90, { walls: true });
  assert.ok(Math.abs(zoneCeilingFarEdge(walled.field, walled.graph, walled.room, q).chLo - 2982.75) < 1e-9);
  const plain = slopeRoom(90);
  assert.equal(zoneCeilingFarEdge(plain.field, plain.graph, plain.room, q).chLo, 3000);
});

test('【奥の端に壁あり・天井芯が先】同座標 y=2000 に天井芯（先頭）と中心線（後）が並んでも、中心線の壁の仕上げ面 2982.75 で評価する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.CEILING });
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 3000)];
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 2000)];
  assert.equal(graph.centerLines[0].discipline, Discipline.CEILING, '前提: 天井芯が先頭');
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '居間');
  generateRoomWallsFromOutline(graph, room);
  const key = worldToCell(1500, 1000, graph, CEILING_CELL_GRID).key;
  room.setCeilingZones(createZone(graph, room, [key], slope(2400, 600, 90)).zones);
  const r = zoneCeilingFarEdge(zoneCeilingFieldOf(graph), graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
  assert.ok(r && Math.abs(r.chLo - 2982.75) < 1e-9, JSON.stringify(r));
});

test('【面が奥で途切れる・同じ面が続く】区画が 2 セル（y0..1000, 1000..2000）なら奥は 2000（3000）。1000 で別の区画に変わるなら奥は 1000（区画 A の bbox の高い側 3000）', () => {
  {
    const g = makeGrid([0, 3000], [0, 1000, 2000]);
    const room = g.interior([[0, 0], [0, 1]]);
    room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0), g.cell(0, 1)], slope(2400, 600, 90)).zones);
    const r = zoneCeilingFarEdge(zoneCeilingFieldOf(g.graph), g.graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
    assert.equal(r.chLo, 3000, '同じ面の 2 矩形を越えて y=2000 まで進む');
  }
  {
    const g = makeGrid([0, 3000], [0, 1000, 2000]);
    const room = g.interior([[0, 0], [0, 1]]);
    room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], slope(2400, 600, 90)).zones);
    room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 1)], flat(2700)).zones);
    const f = zoneCeilingFieldOf(g.graph);
    const r = zoneCeilingFarEdge(f, g.graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
    assert.deepEqual(r, { chLo: 3000, chHi: 3000, alongRun: false }, '区画 A の奥 y=1000 で止まる（2 矩形の面ではない）');
    assert.deepEqual(zoneCeilingFarEdge(f, g.graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 1000, dir: +1 }),
      { chLo: 2700, chHi: 2700, alongRun: false }, '区画 B の中から始めれば平面');
  }
});

test('【平面の区画は従来と同じ値】flat 区画は {chMm, chMm, alongRun false}。床段差 +100 でも chMm のまま（床段差を含まない）', () => {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  room.setFloorLevel(100);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2700)).zones);
  const r = zoneCeilingFarEdge(zoneCeilingFieldOf(g.graph), g.graph, room, { isVertical: false, runLo: 100, runHi: 900, startCoord: 0, dir: +1 });
  assert.deepEqual(r, { chLo: 2700, chHi: 2700, alongRun: false });
});

test('【部屋形状の傾斜も対象】区画なしの部屋形状 slope[300,+y]（部屋の CH 2500）は奥の端 2800。床段差込みの zMm は使わない', () => {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setFloorLevel(100);
  setRoomCeilingShape(room, { shape: 'slope', dims: [300, 90] });
  const r = zoneCeilingFarEdge(zoneCeilingFieldOf(g.graph), g.graph, room, { isVertical: false, runLo: 100, runHi: 900, startCoord: 0, dir: +1 });
  assert.deepEqual(r, { chLo: 2800, chHi: 2800, alongRun: false });
});

test('【失敗系・null】区画なしの部屋・他の部屋・room null・field null・dir 不正・非有限の座標は null。円弧・ドームも null', () => {
  const q = { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 };
  const g = makeGrid([0, 3000, 6000], [0, 2000]);
  const slopeR = g.interior([[0, 0]]);
  slopeR.setCeilingZones(createZone(g.graph, slopeR, [g.cell(0, 0)], slope(2400, 600, 90)).zones);
  const plainR = g.interior([[1, 0]]); // 区画なし（flat・zoneId なし）
  const field = zoneCeilingFieldOf(g.graph);
  assert.ok(field);
  assert.ok(zoneCeilingFarEdge(field, g.graph, slopeR, q), '前提: 正常な問い合わせは値を返す');
  assert.equal(zoneCeilingFarEdge(field, g.graph, plainR, { ...q, runLo: 3500, runHi: 5500 }), null, '区画なしの部屋は null');
  assert.equal(zoneCeilingFarEdge(field, g.graph, plainR, q), null, '面の所有者でない部屋は null');
  assert.equal(zoneCeilingFarEdge(field, g.graph, null, q), null);
  assert.equal(zoneCeilingFarEdge(null, g.graph, slopeR, q), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, dir: 0 }), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, dir: 2 }), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, startCoord: NaN }), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, runLo: NaN }), null);
  // 円弧・ドーム（slope の部屋が別にあって field は null でない）
  for (const [shape, dims] of [['arc', [400, 90]], ['dome', [500]]]) {
    const h = makeGrid([0, 3000, 6000], [0, 2000]);
    const a = h.interior([[0, 0]]);
    a.setCeilingZones(createZone(h.graph, a, [h.cell(0, 0)], { heightMm: 2400, shape, dims }).zones);
    const b = h.interior([[1, 0]]);
    b.setCeilingZones(createZone(h.graph, b, [h.cell(1, 0)], slope(2400, 600, 90)).zones);
    const f = zoneCeilingFieldOf(h.graph);
    assert.ok(f, shape);
    assert.equal(zoneCeilingFarEdge(f, h.graph, a, q), null, shape);
  }
});

test('【歩く上限】奥へ続く同じ面の矩形が 64 を超える異常な格子は null（64 以内なら値）', () => {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  const chain = n => {
    const s = {
      roomId: room.id, zoneId: 'z', shape: 'slope', dims: [600, 90], chMm: 2400, zMm: 2400,
      rects: Array.from({ length: n }, (_, i) => ({ x1: 0, x2: 3000, y1: i * 100, y2: (i + 1) * 100 })),
    };
    const inRect = (r, x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
    return { surfaces: [s], surfaceAt: (x, y) => (s.rects.some(r => inRect(r, x, y)) ? s : null) };
  };
  const q = { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 };
  assert.equal(zoneCeilingFarEdge(chain(65), g.graph, room, q), null);
  const r = zoneCeilingFarEdge(chain(40), g.graph, room, q);
  assert.equal(r.chLo, 3000, '40 矩形（y 0..4000）の奥 y=4000 で u=1');
});

// ---- E3b-3: 奥の端は走り範囲全体で探す／面の境界で割るための問い合わせ ----
// L 字の面: 格子 x 0/2000/4000 × y 0/1000/2000 の 3 セル（(0,0)(1,0)(0,1)。(1,1) が欠ける）に 1 つの slope[600,+y]（底 2400・面の bbox は y0..2000）。
function lShapedSlope() {
  const g = makeGrid([0, 2000, 4000], [0, 1000, 2000]);
  const room = g.interior([[0, 0], [1, 0], [0, 1]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0), g.cell(1, 0), g.cell(0, 1)], slope(2400, 600, 90)).zones);
  return { ...g, room, field: zoneCeilingFieldOf(g.graph) };
}

test('【奥の端は走り範囲全体を覆う面だけたどる】L 字の面: 中央 1 行（x<2000）なら y=2000 まで続く 3000、範囲の端（x 3000）が面から外れる範囲 [500,3500] は y=1000 で止まる 2700', () => {
  const { field, graph, room } = lShapedSlope();
  const base = { isVertical: false, startCoord: 0, dir: +1 };
  assert.deepEqual(zoneCeilingFarEdge(field, graph, room, { ...base, runLo: 500, runHi: 1500 }), { chLo: 3000, chHi: 3000, alongRun: false }, '範囲全体が x<2000＝面が y=2000 まで続く');
  assert.deepEqual(zoneCeilingFarEdge(field, graph, room, { ...base, runLo: 500, runHi: 3500 }), { chLo: 2700, chHi: 2700, alongRun: false }, '範囲の右半分は y=1000 で面が途切れる＝中央 1 行（x=2000）が続いても止まる');
  assert.deepEqual(zoneCeilingFarEdge(field, graph, room, { ...base, runLo: 3000, runHi: 3000 }), { chLo: 2700, chHi: 2700, alongRun: false }, '点の問い合わせ（lo==hi）は点を含む矩形だけで判断する');
});

test('【壁の探査幅は片の走り範囲全体】奥の端 y=1000 の壁が範囲 [0,6000] の右端（x4000..6000）にしか無くても仕上げ面（1000−57.5）で評価する＝2682.75。範囲の中央 ±10mm だけ見れば壁なし 2700', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 1000, 2000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]], { walls: true }); // 右 2 列は y0..1000 だけ＝y=1000 に右端の壁
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0), g.cell(1, 0), g.cell(2, 0), g.cell(0, 1), g.cell(1, 1)], slope(2400, 600, 90)).zones);
  const field = zoneCeilingFieldOf(g.graph);
  const r = zoneCeilingFarEdge(field, g.graph, room, { isVertical: false, runLo: 0, runHi: 6000, startCoord: 0, dir: +1 });
  assert.ok(r && Math.abs(r.chLo - 2682.75) < 1e-9, JSON.stringify(r));
  const narrow = zoneCeilingFarEdge(field, g.graph, room, { isVertical: false, runLo: 2990, runHi: 3010, startCoord: 0, dir: +1 });
  assert.ok(narrow && Math.abs(narrow.chLo - 2982.75) < 1e-9, `狭い範囲（面が y=2000 まで続く）はその奥の壁 y=2000: ${JSON.stringify(narrow)}`);
});

test('【zoneCeilingDepthEdges】走り座標を含む矩形の奥行き方向の辺（形状を問わない）を昇順・重複なしで返す。範囲の外・走りが外れる矩形・field null は対象外', () => {
  const g = makeGrid([0, 4000], [0, 2000, 4000, 6000]);
  const room = g.interior([[0, 0], [0, 1], [0, 2]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(3000)).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 1)], { heightMm: 2800, shape: 'arc', dims: [400, 90] }).zones);
  const field = zoneCeilingFieldOf(g.graph);
  assert.deepEqual(zoneCeilingDepthEdges(field, { isVertical: false, runCoord: 1000, lo: 0, hi: 6000 }), [2000, 4000], '平面・円弧・残りの面の辺（端の 0/6000 は厳密な内側ではない）');
  assert.deepEqual(zoneCeilingDepthEdges(field, { isVertical: false, runCoord: 1000, lo: 2000, hi: 4000 }), [], '範囲の端ちょうどは含めない');
  assert.deepEqual(zoneCeilingDepthEdges(field, { isVertical: false, runCoord: 9000, lo: 0, hi: 6000 }), [], '走り座標が矩形の外');
  assert.deepEqual(zoneCeilingDepthEdges(null, { isVertical: false, runCoord: 1000, lo: 0, hi: 6000 }), []);
});

test('【zoneCeilingRunRangeAt】深さ depthCoord で runCoord を含む面の走り範囲へ絞る（形状を問わない）。矩形の外・field null は [lo,hi] のまま', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 2000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 2800, shape: 'dome', dims: [500] }).zones);
  const other = g.interior([[2, 0]]); // 使える面（平面の区画）を 1 つ置く＝field が null にならない
  other.setCeilingZones(createZone(g.graph, other, [g.cell(2, 0)], flat(3000)).zones);
  const field = zoneCeilingFieldOf(g.graph);
  assert.ok(field, '前提: field あり');
  const q = { isVertical: false, depthCoord: 1000, runCoord: 3000, lo: 0, hi: 4000 };
  assert.deepEqual(zoneCeilingRunRangeAt(field, q), { lo: 2000, hi: 4000 }, 'ドームの面 x2000..4000 に絞る（x=2000 の辺で左を切る）');
  assert.deepEqual(zoneCeilingRunRangeAt(field, { ...q, runCoord: 1000 }), { lo: 0, hi: 2000 }, '残りの面 x0..2000');
  assert.deepEqual(zoneCeilingRunRangeAt(field, { ...q, depthCoord: 9000 }), { lo: 0, hi: 4000 }, '深さが全矩形の外');
  assert.deepEqual(zoneCeilingRunRangeAt(null, q), { lo: 0, hi: 4000 });
});
