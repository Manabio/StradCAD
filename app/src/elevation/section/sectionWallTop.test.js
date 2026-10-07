// 壁の天端プロファイル（関所 kneeDropZRangesAt の wallTop 引数・probeCtx.wallTopProfileFor）。
// 在来木造・折返し階段の隔て壁（最上層は斜め天端・続く層はフルハイト）の S4-1。
// フィクスチャは stairPartition.test.js の EQUAL_UP（隔て壁 x=1000・y 1000〜4000。階高 2400 →
// 端 y=4000 で上階FL+800=3200、踊り場側 y=1000 で 7段鼻×200+800=2200）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature } from '@core';
import { makeProbeContext } from './sectionProbe.js';
import { probeColumnHits, kneeDropZRangesAt } from './sectionHits.js';
import { generateStairPartitionWalls } from '../../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const FH = 2400;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

// 1階層ぶんの graph。stairRects があれば SWITCHBACK を置く。partition=true で隔て壁（在来）を生成する。
function makeFloor(id, elevation, { stairRects = null, roomRects = null, voidRects = null, partition = false, structure = WOOD, stairProps = {} } = {}) {
  const graph = new PlanGraph(new Plane(id, elevation * 1000, id, elevation, 1));
  if (structure) graph.structureOverride = structure;
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  // 全階共通の座標を先に作る（上下階で同じ CL を引けるように）
  for (const x of [0, 1000, 2000]) V(x);
  for (const y of [0, 1000, 4000]) H(y);
  if (roomRects) {
    graph.addRoom(new Set(roomRects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`)), '部屋');
  }
  if (voidRects) {
    graph.addRoom(new Set(voidRects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`)), '').setFeature(RoomFeature.STAIR_VOID);
  }
  let stair = null;
  if (stairRects) {
    const cells = new Set(stairRects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
    const room = graph.addRoom(new Set(cells), '階段');
    stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
  }
  const walls = partition ? generateStairPartitionWalls(graph, { structure: WOOD }) : [];
  return { graph, stair, walls, V, H };
}

// 水平な切断線（y=axisValue）で隔て壁（vertical x=1000）を横切る。
function cutAt(layers, axisValue) {
  return {
    seqNo: '0',
    line: { isVertical: false, axisValue, lo: 0, hi: 2000, buttToleranceMm: 0 },
    viewSign: 1, dirSign: 1, layers,
    zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
    ceilProfile: [{ x0: 0, x1: 2000, ceilZ: 2400 }],
  };
}
// worldMid（壁の長さ方向でない列の位置＝x）を指定して、その列で隔て壁（walls のいずれか）に当たる cut の z1 を返す。
const cutZ1s = (layers, walls, y, worldMid = 1000) => {
  const ctx = makeProbeContext(layers);
  const { hits } = probeColumnHits(cutAt(layers, y), worldMid, ctx);
  return hits.filter(h => h.kind === 'cut' && walls.includes(h.wall)).map(h => h.z1).sort((a, b) => a - b);
};
const THIN_X = 948; // 薄壁（942.5〜955）だけに当たる列

test('kneeDropZRangesAt: wallTop があれば [floorZ, min(ceilZ, zAt)]・topAt を持つ。zAt≦floorZ は空。無ければ従来（全高）', () => {
  const { graph, walls } = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const w = walls[0];
  const top = { zAt: along => 2000 + along };
  const r = kneeDropZRangesAt(graph, w, 100, 0, 2400, top);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].z0, r[0].z1], [0, 2100]);
  assert.equal(r[0].topAt(5), 2005);
  assert.equal(kneeDropZRangesAt(graph, w, 1000, 0, 2400, top)[0].z1, 2400, 'ceilZ でクランプ');
  assert.deepEqual(kneeDropZRangesAt(graph, w, 100, 0, 2400, { zAt: () => 0 }), [], '天端が床以下なら空');
  assert.deepEqual(kneeDropZRangesAt(graph, w, 100, 0, 2400, null), [{ z0: 0, z1: 2400 }]);
  assert.deepEqual(kneeDropZRangesAt(graph, w, 100, 0, 2400), [{ z0: 0, z1: 2400 }]);
});

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≒ ${b}`);

test('最上層（直上の層が階高だけ上・上に続きの階段なし）: cut 経路の隔て壁は斜め天端（オーナー壁・薄壁とも）。踊り場端 y=1000 で2200・y=1500 で 2366.7・y=2500 は ceilZ 2400 でクランプ', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1);
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  assert.equal(f1.walls.length, 2);
  for (const x of [1000, THIN_X]) {
    const [a] = cutZ1s(layers, f1.walls, 1000, x);
    near(a, 2200);
    near(cutZ1s(layers, f1.walls, 1500, x)[0], 2200 + 1000 * 500 / 3000);
    near(cutZ1s(layers, f1.walls, 2500, x)[0], 2400);
    assert.equal(cutZ1s(layers, f1.walls, 1000, x).length, 1, `列 x=${x} で当たるのは1枚`);
  }
});

test('続く層（上に重なる階段がある）→ フルハイト（踊り場端でも ceilZ いっぱい）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1, { stairRects: EQUAL_UP });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  assert.deepEqual(cutZ1s(layers, f1.walls, 1000), [2400]);
  assert.deepEqual(cutZ1s(layers, f1.walls, 1000, THIN_X), [2400]);
});

test('【失敗系】直上の層が無い（階高が決まらない）→ フルハイト', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }];
  assert.deepEqual(cutZ1s(layers, f1.walls, 1000), [2400]);
});

test('【失敗系】在来木造でない層（S造）→ 現状と同一（フルハイト）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  f1.graph.structureOverride = 'S造';
  const f2 = makeFloor('p2', 1);
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  assert.deepEqual(cutZ1s(layers, f1.walls, 1000), [2400]);
});

test('【失敗系】sections が不正（riser が決まらない）→ フルハイト', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  f1.stair.sections = [6, 1];
  const f2 = makeFloor('p2', 1);
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  assert.deepEqual(cutZ1s(layers, f1.walls, 1000), [2400]);
});

test('【失敗系】隔て壁でない同形の壁（軸オフセットが仕様外）は天端プロファイルに載らない（フルハイト）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1);
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const [owner] = f1.walls;
  const clone = f1.graph.addWall(owner.axisCL, 200, true, owner.clStart, 0, owner.clEnd, 0,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 90 });
  const ctx = makeProbeContext(layers);
  assert.equal(ctx.wallTopProfileFor(layers[0]).has(clone.id), false);
  assert.equal(ctx.wallTopProfileFor(layers[0]).has(owner.id), true);
});

test('wallTopProfileFor は層ごとにキャッシュされる（同じ Map を返す）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }];
  const ctx = makeProbeContext(layers);
  assert.equal(ctx.wallTopProfileFor(layers[0]), ctx.wallTopProfileFor(layers[0]));
});

// ---- 配線テスト（cutAlong / wallFace の引数・層の一般規則・床基準）----
// 隔て壁（x=1000 縦）を、縦の切断線（isVertical:true）で見る。axisValue=500 なら壁は視線方向（wallFace）、
// axisValue=1000 なら壁は切断線の中（cutAlong）。列の位置 worldMid は壁の長さ方向（y）。
function alongCut(layers, axisValue) {
  return {
    seqNo: '0',
    line: { isVertical: true, axisValue, lo: 0, hi: 5000, buttToleranceMm: 0 },
    viewSign: 1, dirSign: 1, layers,
    zRange: { loZ: 0, hiZ: 6000 }, baseFloorZ: 0,
    ceilProfile: [{ x0: 0, x1: 5000, ceilZ: 6000 }],
  };
}
const alongHits = (layers, walls, axisValue, y, kind) => {
  const ctx = makeProbeContext(layers);
  return probeColumnHits(alongCut(layers, axisValue), y, ctx).hits.filter(h => h.kind === kind && walls.includes(h.wall));
};
test('T1 wallFace 経路: 壁に沿って見る列（y=2500）の z1 は zAt(2500)=2700（天井・capZ が高いとき。引数を消すと全高になる）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1, { voidRects: EQUAL_UP }); // 上階が階段吹抜け（床なし）で、見えがかりの上限（capZ）が斜め天端より高い
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const hs = alongHits(layers, f1.walls, 500, 2500, 'wallFace');
  assert.ok(hs.length >= 1, 'wallFace 候補がある');
  for (const h of hs) near(h.z1, 2700);
});

// cutAlong は isRoomWall の壁を除外する（isCutAlongWall）ため、実の隔て壁はこの経路に来ない。
// 経路の配線だけを守るため、自立した壁（isRoomWall なし）にプロファイルを直接差し込む。
test('T2 cutAlong 経路: 壁に沿った切断線（axis=1000）の z1 = min(ceilZ, zAt(worldMid))（引数を消すと全高）', () => {
  const f1 = makeFloor('p1', 0, { roomRects: EQUAL_UP });
  const { V, H } = f1;
  const wall = f1.graph.addWall(V(1000), 0, true, H(1000), 0, H(4000), 0, {});
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }];
  const ctx = makeProbeContext(layers);
  ctx.wallTopProfileFor = () => new Map([[wall.id, { zAt: along => 1000 + along / 10 }]]);
  const z1At = (y) => probeColumnHits(alongCut(layers, 1000), y, ctx).hits.filter(h => h.kind === 'cutAlong' && h.wall === wall).map(h => h.z1);
  assert.deepEqual(z1At(1100), [1110]);
  assert.deepEqual(z1At(3900), [1390]);
  assert.deepEqual(z1At(2500), [1250]);
  const ctxNone = makeProbeContext(layers);
  assert.deepEqual(probeColumnHits(alongCut(layers, 1000), 1100, ctxNone).hits.filter(h => h.kind === 'cutAlong').map(h => h.z1), [2400], '対照: プロファイルなしは全高');
});

test('T3 層の並び順に依存しない: [below(-2400), self(0), above(2400)] をどの順に並べても同じ斜め天端（y=1500 で 2366.7）', () => {
  const f0 = makeFloor('p0', -1);
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1);
  const below = { graph: f0.graph, floorZMm: -FH, role: 'below' };
  const self = { graph: f1.graph, floorZMm: 0, role: 'self' };
  const above = { graph: f2.graph, floorZMm: FH, role: 'above' };
  for (const layers of [[below, self, above], [above, self, below], [self, above, below], [above, below, self]]) {
    const z = cutZ1s(layers, f1.walls, 1500);
    assert.equal(z.length, 1);
    near(z[0], 2200 + 1000 * 500 / 3000);
  }
});

test("T4 隔て壁が 'above' 層（floorZMm=2400）にあり、その上にもう1層: z1 = 2400 + 2200（層の絶対床が基準）", () => {
  const f0 = makeFloor('p0', 0);
  const f1 = makeFloor('p1', 1, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 2);
  const layers = [{ graph: f0.graph, floorZMm: 0, role: 'self' }, { graph: f1.graph, floorZMm: FH, role: 'above' },
    { graph: f2.graph, floorZMm: 2 * FH, role: 'above' }];
  const ctx = makeProbeContext(layers);
  const { hits } = probeColumnHits(cutAt(layers, 1000), 1000, ctx);
  const z = hits.filter(h => h.kind === 'cut' && f1.walls.includes(h.wall)).map(h => h.z1);
  assert.equal(z.length, 1);
  near(z[0], FH + 2200);
});

test('T5 階段室の実効FLが datum と違っても（floorLevel=+100）天端は階段室の床から（2200+100）。floorOffsetMm も引く', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1);
  f1.graph.roomMap.get(f1.stair.roomId).setFloorLevel(100);
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const ctx = makeProbeContext(layers);
  near(ctx.wallTopProfileFor(layers[0]).get(f1.walls[0].id).zAt(1000), 2300);
  const ctx2 = makeProbeContext(layers, { floorOffsetMm: 50 });
  near(ctx2.wallTopProfileFor(layers[0]).get(f1.walls[0].id).zAt(1000), 2250);
});
