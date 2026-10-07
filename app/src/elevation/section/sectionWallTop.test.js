// 壁の天端プロファイル（関所 kneeDropZRangesAt の wallTop 引数・probeCtx.wallTopProfileFor）。
// 在来木造・折返し階段の隔て壁（最上層は斜め天端・続く層はフルハイト）の S4-1。
// フィクスチャは stairPartition.test.js の EQUAL_UP（隔て壁 x=1000・y 1000〜4000。階高 2400 →
// 端 y=4000 で上階FL+800=3200、踊り場側 y=1000 で 7段鼻×200+800=2200）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature, edgeKey } from '@core';
import { makeProbeContext, collectCutBreaks } from './sectionProbe.js';
import { probeColumnHits, kneeDropZRangesAt } from './sectionHits.js';
import { buildColumns, buildSectionFigure } from './sectionEngine.js';
import { emitColumns } from './sectionEmit.js';
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

test('最上層（直上の層が階高だけ上・上に続きの階段なし）: cut 経路の隔て壁は斜め天端（オーナー壁・薄壁とも）。踊り場端 y=1000 で2200・y=1500 で 2366.7・y=2500 は 2700（上に部屋が無い＝CH で止めない）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1);
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  assert.equal(f1.walls.length, 2);
  for (const x of [1000, THIN_X]) {
    const [a] = cutZ1s(layers, f1.walls, 1000, x);
    near(a, 2200);
    near(cutZ1s(layers, f1.walls, 1500, x)[0], 2200 + 1000 * 500 / 3000);
    near(cutZ1s(layers, f1.walls, 2500, x)[0], 2700); // S4-2: 階段室の吹抜けには CH の天井が無い＝視線の上限（上階の天井）まで
    assert.equal(cutZ1s(layers, f1.walls, 1000, x).length, 1, `列 x=${x} で当たるのは1枚`);
  }
});

test('【失敗系・S4-2】cut 経路: 上階に実の部屋があれば視線は上階の床で止まる＝従来どおり部屋の天井（CH 2400）でクランプ', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  const f2 = makeFloor('p2', 1, { roomRects: EQUAL_UP });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  for (const x of [1000, THIN_X]) {
    near(cutZ1s(layers, f1.walls, 1000, x)[0], 2200);
    near(cutZ1s(layers, f1.walls, 2500, x)[0], 2400);
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

test('T2b cutAlong 経路: 天端プロファイルの壁は部屋の天井（CH 2400）で止めず視線の上限まで（上が吹抜け）。上に実の部屋があれば CH で止まる', () => {
  const build = above => {
    const f1 = makeFloor('p1', 0, { roomRects: EQUAL_UP });
    const wall = f1.graph.addWall(f1.V(1000), 0, true, f1.H(1000), 0, f1.H(4000), 0, {});
    const f2 = above === 'room' ? makeFloor('p2', 1, { roomRects: EQUAL_UP }) : makeFloor('p2', 1, { voidRects: EQUAL_UP });
    const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
    const ctx = makeProbeContext(layers);
    ctx.wallTopProfileFor = () => new Map([[wall.id, { zAt: along => 2000 + along / 5 }]]); // along=3000 で 2600（> CH 2400）
    return probeColumnHits(alongCut(layers, 1000), 3000, ctx).hits.filter(h => h.kind === 'cutAlong' && h.wall === wall).map(h => h.z1);
  };
  assert.deepEqual(build('void'), [2600]);
  assert.deepEqual(build('room'), [2400]);
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

// ======== S4-2: 天端が斜めの帯（topEdge）========
// 隔て壁（x=1000 縦・y 1000..4000。外形はオーナー壁 1057.5・薄壁 942.5）を、縦の切断線 x=500（壁は視線方向＝wallFace）で見る。
// 天端は y=1000 で 2200・y=4000 で 3200（傾き 1/3）。上階FL（2400）を横切るのは y=1600。
function slopeCut(layers, extra = {}) {
  return { ...alongCut(layers, 500), ...extra };
}
function slopeFixture({ above = 'void', far = false } = {}) {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, partition: true });
  if (far) f1.graph.addWall(f1.V(1400), 0, true, f1.H(1000), 0, f1.H(4000), 0, {}); // 隔て壁の向こうの壁（見えがかり）
  const f2 = above === 'room' ? makeFloor('p2', 1, { roomRects: EQUAL_UP })
    : above === 'stair' ? makeFloor('p2', 1, { stairRects: EQUAL_UP })
      : makeFloor('p2', 1, { voidRects: EQUAL_UP });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  return { f1, f2, layers, ctx: makeProbeContext(layers) };
}
const hasBreak = (breaks, v) => breaks.some(b => Math.abs(b - v) < 1e-6);

test('S4-2 列の境界: 斜めの天端が上階FL・切断の床・上端を横切る位置で列を割る（それぞれ単独で効く）', () => {
  const { layers, ctx } = slopeFixture();
  const base = collectCutBreaks(slopeCut(layers), ctx);
  assert.ok(hasBreak(base, 1600), `上階FL 2400 → y=1600。実際: ${base}`);
  // 上階FL以外の水準は、それぞれ別の切断の値で単独に確かめる（FH=2400 と重ならない値）
  const floorOnly = collectCutBreaks(slopeCut(layers, { baseFloorZ: 2300 }), ctx);
  assert.ok(hasBreak(floorOnly, 1300), `cut.baseFloorZ 2300 → y=1300。実際: ${floorOnly}`);
  const topOnly = collectCutBreaks(slopeCut(layers, { zRange: { loZ: 0, hiZ: 2700 } }), ctx);
  assert.ok(hasBreak(topOnly, 2500), `cut.zRange.hiZ 2700 → y=2500。実際: ${topOnly}`);
  assert.ok(!hasBreak(base, 1300) && !hasBreak(base, 2500), '他の水準の位置は割らない');
});

test('【失敗系・S4-2】列の境界: 斜め天端を持たない（続く層・非在来・斜面の範囲外の水準）なら割らない', () => {
  const cont = slopeFixture({ above: 'stair' });
  assert.ok(!hasBreak(collectCutBreaks(slopeCut(cont.layers), cont.ctx), 1600), '続く層（フルハイト）');
  const steel = slopeFixture();
  steel.f1.graph.structureOverride = 'S造';
  assert.ok(!hasBreak(collectCutBreaks(slopeCut(steel.layers), makeProbeContext(steel.layers)), 1600), '非在来');
  const { layers, ctx } = slopeFixture();
  const out = collectCutBreaks(slopeCut(layers, { zRange: { loZ: 0, hiZ: 9000 }, baseFloorZ: 100 }), ctx);
  assert.deepEqual(out, [0, 1000, 1600, 4000, 5000], '斜面（2200..3200）の外の水準 0/100/9000 では割らない（上階FL 2400 だけ）');
});

test('S4-2 probeColumnHits(span): wallFace の z1 は列の幅の両端の高い方・topEdge は両端の高さ（span 省略は列中央の1点・topEdge なし）', () => {
  const { f1, layers, ctx } = slopeFixture();
  const faceHits = (mid, span) => probeColumnHits(slopeCut(layers), mid, ctx, span).hits
    .filter(h => h.kind === 'wallFace' && f1.walls.includes(h.wall));
  const lo = faceHits(1300, { worldLo: 1000, worldHi: 1600 });
  assert.ok(lo.length >= 1);
  for (const h of lo) {
    near(h.z1, 2400);
    near(h.topEdge.zAtLo, 2200); near(h.topEdge.zAtHi, 2400);
    assert.equal(h.profiledTop, true);
  }
  const hi = faceHits(2800, { worldLo: 1600, worldHi: 4000 });
  assert.ok(hi.length >= 1);
  for (const h of hi) { near(h.z1, 3200); near(h.topEdge.zAtLo, 2400); near(h.topEdge.zAtHi, 3200); }
  const mid = faceHits(1300, null);
  assert.ok(mid.length >= 1);
  for (const h of mid) { near(h.z1, 2300); assert.equal(h.topEdge, undefined); }
});

test('【失敗系・S4-2】probeColumnHits(span): 上限（上階の床）で頭打ちなら topEdge なし（斜線が帯の上端を超えない）・天端プロファイルの無い壁は span を渡しても不変', () => {
  const room = slopeFixture({ above: 'room', far: true });
  const hits = probeColumnHits(slopeCut(room.layers), 2800, room.ctx, { worldLo: 1600, worldHi: 4000 }).hits
    .filter(h => h.kind === 'wallFace');
  const part = hits.filter(h => room.f1.walls.includes(h.wall));
  assert.ok(part.length >= 1);
  for (const h of part) { near(h.z1, 2400); assert.equal(h.topEdge, undefined, '2400 で頭打ち（斜面は 3200 まで）'); }
  const other = hits.filter(h => !room.f1.walls.includes(h.wall));
  assert.ok(other.length >= 1, '隔て壁でない壁の wallFace がある');
  for (const h of other) { assert.equal(h.topEdge, undefined); assert.equal(h.profiledTop, undefined); }
  // span なしと z 範囲が同じ（天端プロファイルの無い壁は span の影響を受けない）
  const plain = probeColumnHits(slopeCut(room.layers), 2800, room.ctx).hits.filter(h => other.some(o => o.wall === h.wall));
  assert.deepEqual(plain.map(h => [h.z0, h.z1]), other.map(h => [h.z0, h.z1]));
});

test('S4-2 buildColumns: 列は上階FLの位置で割れ、帯は上端＝高い側・topEdge は両端の高さ。dirSign<0 では図の x0側/x1側へ入れ替わる', () => {
  const { layers, ctx } = slopeFixture();
  const cols = buildColumns(slopeCut(layers), ctx);
  assert.deepEqual(cols.map(c => [c.x0, c.x1]), [[0, 1000], [1000, 1600], [1600, 4000], [4000, 5000]]);
  const w = i => cols[i].bands.find(b => b.kind === 'wall');
  near(w(1).z1, 2400); near(w(1).topEdge.zAtX0, 2200); near(w(1).topEdge.zAtX1, 2400);
  near(w(2).z1, 3200); near(w(2).topEdge.zAtX0, 2400); near(w(2).topEdge.zAtX1, 3200);
  // z区間の分割（上階FL 2400・自室の天井 2400）で割れた下の帯は、上の帯（天端に届いている）へ畳まれても topEdge を保つ
  assert.equal(cols[2].bands.filter(b => b.kind === 'wall').length, 1, '壁の帯は1本に畳まれる');
  // dirSign<0: ローカルx は y が大きいほど小さい。world の列 [1000,1600] は x0 側が worldHi
  const rev = buildColumns(slopeCut(layers, { dirSign: -1 }), ctx);
  const byWorld = [...rev].sort((a, b) => a.worldLo - b.worldLo).map(c => c.bands.find(b => b.topEdge)).filter(Boolean);
  assert.equal(byWorld.length, 2);
  near(byWorld[0].topEdge.zAtX0, 2400); near(byWorld[0].topEdge.zAtX1, 2200);
  near(byWorld[1].topEdge.zAtX0, 3200); near(byWorld[1].topEdge.zAtX1, 2400);
});

test('【失敗系・S4-2】buildColumns: 続く層（フルハイト）は従来の矩形の帯のまま（topEdge も profiledTop も無い・列も割れない）', () => {
  const { layers, ctx } = slopeFixture({ above: 'stair' });
  const cols = buildColumns(slopeCut(layers), ctx);
  assert.deepEqual(cols.map(c => [c.x0, c.x1]), [[0, 1000], [1000, 4000], [4000, 5000]]);
  for (const b of cols.flatMap(c => c.bands)) { assert.equal(b.topEdge, undefined); assert.equal(b.profiledTop, undefined); }
});

test('S4-2 列の統合: 斜めの帯と、同じ高さの水平の帯（斜面の外のはね出し）は統合しない（topEdge も比べる）', () => {
  // 壁が斜面の両端の外へ 57.5mm はね出す（隔て壁の柱包み）。はね出し部分は天端が端の値のまま水平。
  const f1 = makeFloor('p1', 0, { roomRects: EQUAL_UP });
  const { V, H } = f1;
  const wall = f1.graph.addWall(V(1000), 0, true, H(1000), -57.5, H(4000), 57.5, {});
  const f2 = makeFloor('p2', 1, { voidRects: EQUAL_UP }); // 上が吹抜け（視線の上限が斜面より高い）
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const ctx = makeProbeContext(layers);
  const clamp = a => Math.min(4000, Math.max(1000, a));
  ctx.wallTopProfileFor = () => new Map([[wall.id, { zAt: a => 2200 + (clamp(a) - 1000) / 3, crossings: () => [] }]]);
  const cols = buildColumns(slopeCut(layers), ctx).filter(c => c.bands.some(b => b.kind === 'wall'));
  assert.deepEqual(cols.map(c => [c.x0, c.x1]), [[942.5, 1000], [1000, 4000], [4000, 4057.5]]);
  assert.equal(cols[0].bands.find(b => b.kind === 'wall').topEdge, undefined, '手前のはね出し＝水平');
  assert.ok(cols[1].bands.find(b => b.kind === 'wall').topEdge, '斜面');
  const last = cols[2].bands.find(b => b.kind === 'wall');
  near(last.z1, 3200);
  assert.equal(last.topEdge, undefined, '向こうのはね出し＝水平（斜面の帯 z1=3200 と同じ高さでも統合されない）');
});

const linesOf = prims => prims.filter(p => p.type === 'line');
const sameLine = (p, x1, y1, x2, y2) => Math.abs(p.x1 - x1) < 1e-6 && Math.abs(p.y1 - y1) < 1e-6
  && Math.abs(p.x2 - x2) < 1e-6 && Math.abs(p.y2 - y2) < 1e-6;

test('S4-2 emit: 天端は列をまたいで連続する一本の斜線・継ぎ目の縦線なし・端の縦線は端の天端の高さまで・水平の天端線なし（奥の壁の下端も）', () => {
  const { layers, ctx } = slopeFixture({ far: true });
  const lines = linesOf(buildSectionFigure(slopeCut(layers), ctx).content);
  const slopes = lines.filter(p => p.weight === 'medium' && Math.abs(p.y1 - p.y2) > 1e-6 && Math.abs(p.x1 - p.x2) > 1e-6);
  assert.equal(slopes.length, 2, JSON.stringify(slopes));
  assert.ok(slopes.some(p => sameLine(p, 1000, -2200, 1600, -2400)), '列 [1000,1600] の斜線');
  assert.ok(slopes.some(p => sameLine(p, 1600, -2400, 4000, -3200)), '列 [1600,4000] の斜線（前の列の終点から連続）');
  assert.equal(lines.filter(p => Math.abs(p.x1 - 1600) < 1e-6 && Math.abs(p.x2 - 1600) < 1e-6).length, 0,
    '継ぎ目 x=1600 に縦線なし（隔て壁も奥の壁も）');
  const medium = lines.filter(p => p.weight === 'medium');
  assert.ok(medium.some(p => sameLine(p, 1000, 0, 1000, -2200)), '踊り場側の端の縦線は 2200 まで（帯の上端 2400 まで伸ばさない）');
  assert.ok(medium.some(p => sameLine(p, 4000, 0, 4000, -3200)), '上り口側の端の縦線は 3200 まで');
  for (const y of [-2400, -3200]) {
    assert.equal(lines.filter(p => Math.abs(p.y1 - y) < 1e-6 && Math.abs(p.y2 - y) < 1e-6).length, 0,
      `水平線 z=${-y} なし（隔て壁の天端も、奥の壁の下端も斜線が受け持つ）`);
  }
  // 壁の中（斜線の下）に線の端点が無い＝笠木の下端の細線・端面の細線（腰壁のもの）を描かない
  const inWall = (x, y) => x > 1000 + 1e-6 && x < 4000 - 1e-6 && -y > 1e-6 && -y < 2200 + (x - 1000) / 3 - 1e-6;
  const inside = p => inWall(p.x1, p.y1) || inWall(p.x2, p.y2) || inWall((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2);
  assert.deepEqual(lines.filter(inside), [], '壁の内側に線なし（端点・中点とも）');
});

test('S4-2 emit: dirSign<0（図の左右が逆）でも斜線・端の縦線は各端の天端の高さ（x1側＝踊り場側 2200・x0側＝上り口側 3200）', () => {
  const { layers, ctx } = slopeFixture();
  // ローカルx = 5000 - y。踊り場側 y=1000 → x=4000、上り口側 y=4000 → x=1000。
  const lines = linesOf(buildSectionFigure(slopeCut(layers, { dirSign: -1 }), ctx).content);
  const medium = lines.filter(p => p.weight === 'medium');
  assert.ok(medium.some(p => sameLine(p, 4000, 0, 4000, -2200)), 'x1側（踊り場側）の端の縦線は 2200 まで');
  assert.ok(medium.some(p => sameLine(p, 1000, 0, 1000, -3200)), 'x0側（上り口側）の端の縦線は 3200 まで');
  const slopes = medium.filter(p => Math.abs(p.y1 - p.y2) > 1e-6 && Math.abs(p.x1 - p.x2) > 1e-6);
  assert.equal(slopes.length, 2);
  assert.ok(slopes.some(p => sameLine(p, 1000, -3200, 3400, -2400)), '上り口（x=1000）から踊り場側へ下がる斜線');
  assert.ok(slopes.some(p => sameLine(p, 3400, -2400, 4000, -2200)));
});

test('S4-2 buildColumns（T-C）: 列の天井（ceilProfile）が斜面の途中にあれば天井の高さで列を割り、下は斜線・上は水平（天井で打ち切る）', () => {
  const { layers, ctx } = slopeFixture();
  const cut = slopeCut(layers, { ceilProfile: [{ loX: 0, hiX: 5000, ceilZ: 2800 }] });
  assert.ok(hasBreak(collectCutBreaks(cut, ctx), 2800), '天井 2800 → y=2800');
  const cols = buildColumns(cut, ctx);
  const wallOf = c => c.bands.find(b => b.kind === 'wall');
  const low = cols.find(c => c.x0 === 1600 && wallOf(c));
  assert.ok(low, '列 [1600,2800]');
  assert.equal(low.x1, 2800);
  near(wallOf(low).z1, 2800);
  near(wallOf(low).topEdge.zAtX0, 2400); near(wallOf(low).topEdge.zAtX1, 2800);
  const high = cols.find(c => c.x0 === 2800 && wallOf(c));
  near(wallOf(high).z1, 2800);
  assert.equal(wallOf(high).topEdge, undefined, '天井より上へ伸びる列は水平 2800');
  assert.ok(wallOf(cols.find(c => c.x0 === 1000)).topEdge, '天井に届かない列 [1000,1600] は斜線のまま');
});

test('S4-2 列の境界: プロファイルを持つ壁の層の部屋の実効天井も斜線の頭打ちの高さとして列を割る', () => {
  const { layers, ctx } = slopeFixture();
  ctx.chOf = (room, graph) => (graph === layers[0].graph ? 2800 : 2400); // 階段室（自階）の天井だけ 2800
  assert.ok(hasBreak(collectCutBreaks(slopeCut(layers), ctx), 2800));
});

test('S4-2 T-A: 上端に届かない帯（手前の垂れ壁に上を隠された斜め天端）は topEdge を持たず、斜線も出ない', () => {
  const { f1, layers, ctx } = slopeFixture({ above: 'room' }); // 上限（上階の床）= 2400
  // 隔て壁の手前（x=700）に、下端 1800・上端 2400 の垂れ壁。隔て壁が見えるのは 0..1800 だけ。
  const front = f1.graph.addWall(f1.V(700), 0, true, f1.H(1000), 0, f1.H(4000), 0, {});
  f1.graph.setKneeDropWall(edgeKey(front.axisCL.id, front.clStart.id, front.clEnd.id), { drop: { bottomHeight: 600 } });
  const cut = slopeCut(layers);
  const parts = buildColumns(cut, ctx).flatMap(c => c.bands).filter(b => b.kind === 'wall' && f1.walls.includes(b.wall));
  assert.ok(parts.length >= 1, '隔て壁の帯が見えている');
  for (const b of parts) { near(b.z1, 1800); assert.equal(b.topEdge, undefined, '上端に届かない帯'); }
  const slants = linesOf(buildSectionFigure(cut, ctx).content)
    .filter(p => Math.abs(p.x1 - p.x2) > 1e-6 && Math.abs(p.y1 - p.y2) > 1e-6 && !p.dash);
  assert.deepEqual(slants, [], '斜線なし（y=1800 は水平線）');
});


test('S4-2 T-B: 斜線の端が上階スラブ端（断面として輪郭を描くスラブの下端）の高さに触れても斜線は消えない', () => {
  // 手組みの列: 斜めの壁の帯[0,2400]の上端がスラブ[2400,3000]の下端に接し、そのスラブに切断壁が載って向こうが空気
  // （ceilProfile なし＝階段帯と同じ。sectionSlabRunsOf が輪郭を担当するスラブ）。
  const wallBand = { kind: 'wall', z0: 0, z1: 2400, distMm: 100, layerRole: 'self', isKneeDrop: true, profiledTop: true,
    topEdge: { zAtX0: 2200, zAtX1: 2400 } };
  const slab = { kind: 'slab', z0: 2400, z1: 3000, floorZ: 2400, ceilZ: 3000 };
  const columns = [
    { x0: 0, x1: 100, worldLo: 0, worldHi: 100, bands: [{ kind: 'open', z0: 0, z1: 6000 }] },
    { x0: 100, x1: 600, worldLo: 100, worldHi: 600, bands: [wallBand, slab] },
    { x0: 600, x1: 700, worldLo: 600, worldHi: 700, bands: [{ ...slab }, { kind: 'cut', z0: 3000, z1: 5400, layerRole: 'above' }] },
    { x0: 700, x1: 1000, worldLo: 700, worldHi: 1000, bands: [{ kind: 'open', z0: 0, z1: 6000 }] },
  ];
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000, buttToleranceMm: 0 }, viewSign: 1, dirSign: 1,
    layers: [], zRange: { loZ: 0, hiZ: 6000 }, baseFloorZ: 0 };
  const lines = linesOf(emitColumns(columns, cut, {}));
  assert.ok(lines.some(p => p.weight === 'medium' && sameLine(p, 100, -2200, 600, -2400)), '斜線が描かれる');
});



test('S4-2 emit: アキの×は斜めの天端で切られた区間を壁として避ける（台形の遮蔽・断片化しない）', () => {
  const { layers, ctx } = slopeFixture();
  const gap = linesOf(buildSectionFigure(slopeCut(layers), ctx).content).filter(p => p.dash === 'center');
  assert.equal(gap.length, 4, '対角線2本が壁の台形で1か所ずつ切られて4断片');
  assert.ok(gap.some(p => Math.abs(p.x1 - 2153.846153846154) < 1e-6 && Math.abs(p.y1 + 2584.6153846153848) < 1e-6),
    '対角線は斜線との交点 (2153.8, 2584.6) で切れる（外接矩形の角 y=3200 では切れない）');
});

test('S4-2 emit: 面全体が斜めの天端の壁なら、上のアキは台形の対角線2本と「ア キ」1つ（台形の重心）', () => {
  const { layers, ctx } = slopeFixture();
  const cut = slopeCut(layers, { line: { isVertical: true, axisValue: 500, lo: 1000, hi: 4000, buttToleranceMm: 0 } });
  const { content } = buildSectionFigure(cut, ctx);
  const gap = linesOf(content).filter(p => p.dash === 'center');
  assert.equal(gap.length, 2, JSON.stringify(gap));
  assert.ok(gap.some(p => sameLine(p, 0, -2200, 3000, -6000)), '左下（斜線の始点）→右上');
  assert.ok(gap.some(p => sameLine(p, 0, -6000, 3000, -3200)), '左上→右下（斜線の終点）');
  const labels = content.filter(p => p.type === 'text' && p.text === 'ア キ');
  assert.equal(labels.length, 1);
  near(labels[0].x, 1500);
  near(-labels[0].y, ((2200 + 3200) / 2 + 6000) / 2);
});

test('S4-2 emit: cut 経路は踊り場端の断面が zAtLandingEnd（2200）で閉じ、笠木の下端の細線を描かない', () => {
  const { layers, ctx } = slopeFixture();
  const cut = { ...cutAt(layers, 1000), zRange: { loZ: 0, hiZ: 6000 }, ceilProfile: undefined };
  const lines = linesOf(buildSectionFigure(cut, ctx).content);
  const cap = lines.filter(p => p.weight === 'thick' && Math.abs(p.y1 + 2200) < 1e-6 && Math.abs(p.y2 + 2200) < 1e-6);
  assert.ok(cap.length >= 1, '断面の上端（太線）が z=2200');
  const under = lines.filter(p => p.weight === 'thin' && !p.dash && Math.abs(p.y1 - p.y2) < 1e-6 && p.y1 < 0 && p.y1 > -2200);
  assert.equal(under.length, 0, '2200 より下に笠木の細線なし');
});
