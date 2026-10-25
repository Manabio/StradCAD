// 階段下の部屋の帯の壁の天端＝階段の裏面（sectionProbe.js addStairFootTops・sectionHits.js activeWallTop・dropReachedFootCap）。S10-8-4-5。
// 裏面は buildRoomBand が自階の層へ注入する（layer.underStairSoffits・underStairRoomRects）。注入が無い層では何もしない。
// 注入があっても、帯の天井断面（cut.ceilProfile。階段下の部屋の帯では裏面そのもの）に届いている壁は天井が止めるので足元の天端は付けない。
// 復路下の壁（addUnderReturnTops）と斜めの隔て板（buildWallTopProfiles）は優先され、足元の規則に上書きされない。
// フィクスチャは sectionUnderReturnTop.test.js の EQUAL_UP（往路 x0〜1000・復路 x1000〜2000・踊り場 y0〜1000）。
// 壁は縦向き x=500（往路の足元の中。長さ方向 y）を、縦の切断線 x=100（視線＋x。壁は視線方向＝wallFace）で見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { makeProbeContext, collectCutBreaks } from './sectionProbe.js';
import { probeColumnHits, footCapLowersCeiling, edgeOnWallZRanges } from './sectionHits.js';
import { generateStairUnderReturnWalls, generateStairPartitionWalls } from '../../finish/stair/stairPartitionWalls.js';
import { stairFootSurfaces } from '../../ceiling/stairFootWallTop.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const FH = 2400;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];
const WALL_PROPS = { finishSide: 1, wallFinish: 12.5, backingOffset: 0, backingDepth: 100 }; // 帯 axis±50

function makeFloor(id, elevation, { stairRects = null, steel = false, extraRoom = null, wallsKind = null } = {}) {
  const graph = new PlanGraph(new Plane(id, elevation * 1000, id, elevation, 1));
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  for (const x of [0, 100, 500, 1000, 2000]) V(x);
  for (const y of [0, 1000, 3000, 4000, 5000]) H(y);
  const key = ([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`;
  if (extraRoom) graph.addRoom(new Set(extraRoom.map(key)), '部屋');
  let stair = null, walls = [];
  if (stairRects) {
    const cells = new Set(stairRects.map(key));
    const room = graph.addRoom(new Set(cells), '階段');
    stair = graph.addStair({
      type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up',
      ...(steel ? { structure: StructuralMaterialType.STEEL } : {}),
    });
    if (wallsKind === 'underReturn') walls = generateStairUnderReturnWalls(graph, { structure: WOOD });
    if (wallsKind === 'partition') walls = generateStairPartitionWalls(graph, { structure: WOOD });
  }
  return { graph, stair, walls, V, H };
}

// 縦の切断線 x=100（run は y。視線＋x）。壁 x=500（縦）は視線方向＝wallFace。ceilProfile は帯の天井断面（局所 x＝世界 y）
function cutOf(layers, ceilProfile = [{ loX: 0, hiX: 5000, ceilZ: FH }], axisValue = 100) {
  return {
    seqNo: '0',
    line: { isVertical: true, axisValue, lo: 0, hi: 5000, buttToleranceMm: 0 },
    viewSign: 1, dirSign: 1, layers,
    zRange: { loZ: 0, hiZ: FH }, baseFloorZ: 0, ceilProfile,
  };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≒ ${b}`);
const faceHits = (cut, ctx, wall, mid, span = null) =>
  probeColumnHits(cut, mid, ctx, span).hits.filter(h => h.kind === 'wallFace' && h.wall === wall);

// 階段下の部屋の帯が注入するもの（buildRoomBand と同じ形）。階段の足元に掛かる部屋の実セルの矩形は roomRects
function soffitsOf(graph, upperGraph, stair) {
  return stairFootSurfaces(graph, { floorHeightOf: () => FH, floorZOf: () => 0, aboveGraph: upperGraph })
    .map(surface => ({ stairId: String(stair.id), stairRoomId: stair.roomId ?? null, surface }));
}

// 階段（steel でも footCap の対象）の自階＋上階の層、足元の内外にまたがる壁 x=500（y 1000〜5000）。inject=false なら注入しない
function fixture({ inject = true, roomRects } = {}) {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, steel: true, extraRoom: [[0, 4000, 2000, 5000]] });
  const wall = f1.graph.addWall(f1.V(500), 0, true, f1.H(1000), 0, f1.H(5000), 0, WALL_PROPS);
  const f2 = makeFloor('p2', 1, { extraRoom: [[0, 0, 2000, 5000]] }); // 上階に実の部屋（視線の上限＝自階の天井 2400）
  const self = { graph: f1.graph, floorZMm: 0, role: 'self' };
  if (inject) {
    self.underStairSoffits = soffitsOf(f1.graph, f2.graph, f1.stair);
    if (roomRects) self.underStairRoomRects = roomRects;
  }
  const layers = [self, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  return { f1, f2, wall, layers, self, ctx: makeProbeContext(layers) };
}

// 帯の天井断面を、足元の天端のプロファイルそのものにしたもの（天井が裏面になった帯と同じ＝壁は天井に届いている）
function ceilProfileLike(prof, hiZ = FH) {
  const ks = prof.crossings([]);
  const out = [];
  let cursor = 0;
  const push = (lo, hi, z0, z1) => { if (hi - lo > 1e-9) out.push({ loX: lo, hiX: hi, ceilZ: z0, ceilZHi: z1 }); };
  for (let i = 0; i + 1 < ks.length; i++) {
    const [a, b] = [ks[i], ks[i + 1]];
    const [z0, z1] = [prof.zAt(a + 1e-4), prof.zAt(b - 1e-4)];
    if (!Number.isFinite(z0) || !Number.isFinite(z1)) continue;
    push(cursor, a, hiZ, hiZ);
    push(a, b, z0, z1);
    cursor = b;
  }
  push(cursor, 5000, hiZ, hiZ);
  return out;
}

test('注入が無い層（階段帯・あらわしの下・他の部屋）では足元の天端を付けない＝従来どおり全高。壁の候補・列の分割も注入なしと変わらない', () => {
  const base = fixture({ inject: false });
  assert.equal(base.ctx.wallTopProfileFor(base.layers[0]).get(base.wall.id), undefined);
  const hits = faceHits(cutOf(base.layers), base.ctx, base.wall, 2500, { worldLo: 2400, worldHi: 2600 });
  assert.ok(hits.length >= 1);
  for (const h of hits) { near(h.z1, FH); assert.equal(h.profiledTop, undefined); assert.equal(h.junctionTop, undefined); }
  // 上階の層（注入の対象外）に注入があっても無視する
  const f = fixture({ inject: false });
  f.layers[1].underStairSoffits = soffitsOf(f.f1.graph, f.f2.graph, f.f1.stair);
  assert.equal(makeProbeContext(f.layers).wallTopProfileFor(f.layers[1]).size, 0);
  assert.equal(makeProbeContext(f.layers).wallTopProfileFor(f.layers[0]).get(f.wall.id), undefined);
});

test('注入があり天井断面が 2400 の水平（裏面が壁を止めている）: wallFace の z1 は列の幅の両端の高い方・topEdge は両端の天端・junctionTop。viaStair は付かない', () => {
  const { wall, layers, ctx } = fixture();
  const prof = ctx.wallTopProfileFor(layers[0]).get(wall.id);
  assert.ok(prof && prof.footCap === true, '前提: 足元の天端が求まる');
  const hits = faceHits(cutOf(layers), ctx, wall, 2500, { worldLo: 2400, worldHi: 2600 });
  assert.ok(hits.length >= 1, 'wallFace 候補がある');
  const [a, b] = [prof.zAt(2400), prof.zAt(2600)];
  assert.ok(Math.abs(a - b) > 1, `前提: 天端は斜め（${a} ≠ ${b}）`);
  assert.ok(Math.max(a, b) < FH - 1, '前提: 天井より低い');
  for (const h of hits) {
    near(h.z1, Math.max(a, b));
    near(h.topEdge.zAtLo, a); near(h.topEdge.zAtHi, b);
    assert.equal(h.profiledTop, true);
    assert.equal(h.junctionTop, true, '天端は階段の裏面との取り合い＝細線');
    assert.equal(h.viaStair, undefined, '足元の天端の壁へ viaStair を広げない');
  }
});

test('collectCutBreaks: 天井より低い足元の天端の節が列の境界になる／天井断面に届いているときは注入なしと同じ分割', () => {
  const { layers, wall, ctx } = fixture();
  const prof = ctx.wallTopProfileFor(layers[0]).get(wall.id);
  const flat = collectCutBreaks(cutOf(layers), ctx);
  const knots = prof.crossings([]).filter(a => a > 1000 + 1e-3 && a < 5000 - 1e-3);
  assert.ok(knots.length >= 5, `前提: 節が複数（${knots}）`);
  for (const k of knots) assert.ok(flat.some(x => Math.abs(x - k) < 1e-3), `節 ${k} が列の境界にある`);
  // 天井断面＝裏面に届いている → 壁の天端は冗長＝節で割らない（注入なしと同じ）
  const reached = cutOf(layers, ceilProfileLike(prof));
  const noInj = fixture({ inject: false });
  assert.deepEqual(collectCutBreaks(reached, ctx), collectCutBreaks(cutOf(noInj.layers, ceilProfileLike(prof)), noInj.ctx));
});

test('天井断面に届いている壁（天端＝帯の天井）は足元の天端を付けない（profiledTop・junctionTop・topEdge なし）。天井より下がる所が一部でもあれば残る', () => {
  const { wall, layers, ctx } = fixture();
  const prof = ctx.wallTopProfileFor(layers[0]).get(wall.id);
  const reached = cutOf(layers, ceilProfileLike(prof));
  for (const span of [{ worldLo: 2400, worldHi: 2600 }, null]) {
    const hits = faceHits(reached, ctx, wall, 2500, span);
    assert.ok(hits.length >= 1);
    for (const h of hits) {
      near(h.z1, FH);
      assert.equal(h.profiledTop, undefined);
      assert.equal(h.junctionTop, undefined);
      assert.equal(h.topEdge, undefined);
    }
  }
  // 帯の天井断面が天端より 1mm でも高ければ（壁が天井に届かない）足元の天端は残る
  const higher = cutOf(layers, ceilProfileLike(prof).map(s => ({ ...s, ceilZ: s.ceilZ + 1, ceilZHi: s.ceilZHi == null ? undefined : s.ceilZHi + 1 })));
  const kept = faceHits(higher, ctx, wall, 2500, { worldLo: 2400, worldHi: 2600 });
  assert.ok(kept.length >= 1);
  for (const h of kept) assert.equal(h.profiledTop, true);
  // 判定の単位: 全区間で届く→false／天井断面が水平 2400 → true
  assert.equal(footCapLowersCeiling(prof, reached, 1000, 5000), false);
  assert.equal(footCapLowersCeiling(prof, cutOf(layers), 1000, 5000), true);
});

test('足元の外の壁の区間は 2400 のまま・profiledTop／junctionTop を付けない（足元の天端は足元の中だけ有効）', () => {
  const { wall, layers, ctx } = fixture();
  const prof = ctx.wallTopProfileFor(layers[0]).get(wall.id);
  assert.equal(prof.zAt(4500), Infinity, '前提: y=4500 は足元の外');
  const hits = faceHits(cutOf(layers), ctx, wall, 4500, { worldLo: 4400, worldHi: 4600 });
  assert.ok(hits.length >= 1, '前提: 足元の外の区間に壁の候補がある');
  for (const h of hits) {
    near(h.z1, FH);
    assert.equal(h.profiledTop, undefined);
    assert.equal(h.junctionTop, undefined);
    assert.equal(h.topEdge, undefined);
  }
});

test('壁の厚み方向の評価は部屋に面する縁（underStairRoomRects）の面の位置。無ければ帯の 3 点の最小。節の値は帯の実効 FL 基準（floorOffsetMm を引く）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, steel: true });
  // 横向きの壁 y=3000（長さ方向 x 0〜1000・往路の足元の中）。厚み方向 y が往路の傾斜の向き
  const wall = f1.graph.addWall(f1.H(3000), 0, false, f1.V(0), 0, f1.V(1000), 0, WALL_PROPS);
  const f2 = makeFloor('p2', 1);
  const soffits = soffitsOf(f1.graph, f2.graph, f1.stair);
  const surface = soffits[0].surface;
  const profOf = (extra, opts = {}) => {
    const self = { graph: f1.graph, floorZMm: 0, role: 'self', underStairSoffits: soffits, ...extra };
    const layers = [self, { graph: f2.graph, floorZMm: FH, role: 'above' }];
    return makeProbeContext(layers, opts).wallTopProfileFor(self).get(wall.id);
  };
  const [zLo, zHi] = [2950, 3050].map(y => surface.zAt(500, y));
  assert.ok(Math.abs(zHi - zLo) > 10, `前提: 厚み方向に傾斜（${zLo}→${zHi}）`);
  const roomAbove = [{ x1: 0, x2: 1000, y1: 3050, y2: 4000 }]; // y>3050 側が部屋＝壁の帯の高い側（hi）の縁が室内側
  const roomBelow = [{ x1: 0, x2: 1000, y1: 1000, y2: 2950 }]; // y<2950 側が部屋＝低い側（lo）の縁が室内側
  near(profOf({ underStairRoomRects: roomAbove }).zAt(500), zHi);
  near(profOf({ underStairRoomRects: roomBelow }).zAt(500), zLo);
  const dflt = profOf({});
  near(dflt.zAt(500), Math.min(zLo, zHi, surface.zAt(500, 3000)));
  assert.ok(Math.abs(profOf({ underStairRoomRects: roomAbove }).zAt(500) - dflt.zAt(500)) > 5 || Math.abs(profOf({ underStairRoomRects: roomBelow }).zAt(500) - dflt.zAt(500)) > 5,
    '面の位置の評価は 3 点最小と値が違う');
  // 部屋が壁の両側・どちらにも無い → 3 点最小
  near(profOf({ underStairRoomRects: [{ x1: 0, x2: 1000, y1: 1000, y2: 4000 }] }).zAt(500), dflt.zAt(500));
  near(profOf({ underStairRoomRects: [{ x1: 5000, x2: 6000, y1: 0, y2: 100 }] }).zAt(500), dflt.zAt(500));
  near(profOf({ underStairRoomRects: [] }).zAt(500), dflt.zAt(500));
  // 帯の実効 FL（floorOffsetMm）を引く
  near(profOf({ underStairRoomRects: roomAbove }, { floorOffsetMm: 200 }).zAt(500), zHi - 200);
});

test('長さ方向が切断の走り方向の壁（縦断された壁 cutAlong）は足元の天端を使う／切断壁（cut。長さ方向が奥行き）は使わず天井断面の斜線に任せる', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, steel: true });
  // 切断線 x=500 の上に立つ縦の壁（cutAlong・往路の足元の中）と、切断線を横切る横の壁 y=3000（cut。長さ方向 x）
  const along = f1.graph.addWall(f1.V(500), 0, true, f1.H(1000), 0, f1.H(4000), 0, WALL_PROPS);
  const crossing = f1.graph.addWall(f1.H(3000), 0, false, f1.V(0), 0, f1.V(1000), 0, WALL_PROPS);
  const f2 = makeFloor('p2', 1, { extraRoom: [[0, 0, 2000, 5000]] });
  const self = { graph: f1.graph, floorZMm: 0, role: 'self', underStairSoffits: soffitsOf(f1.graph, f2.graph, f1.stair) };
  const layers = [self, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const ctx = makeProbeContext(layers);
  const prof = ctx.wallTopProfileFor(self);
  assert.equal(prof.get(along.id)?.footCap, true, '前提: 両方の壁にプロファイルがある');
  assert.equal(prof.get(crossing.id)?.footCap, true);
  const alongHits = probeColumnHits(cutOf(layers, undefined, 500), 2500, ctx, { worldLo: 2450, worldHi: 2550 }).hits.filter(h => h.kind === 'cutAlong' && h.wall === along);
  assert.ok(alongHits.length >= 1, '前提: 縦断された壁の候補がある');
  for (const h of alongHits) { assert.equal(h.profiledTop, true); assert.ok(h.z1 < FH - 1, `天端は天井より低い（${h.z1}）`); }
  // 天井断面が天端に届いていれば縦断された壁も足元の天端は付かない
  const reached = cutOf(layers, ceilProfileLike(prof.get(along.id)), 500);
  const alongReached = probeColumnHits(reached, 2500, ctx, { worldLo: 2450, worldHi: 2550 }).hits.filter(h => h.kind === 'cutAlong' && h.wall === along);
  assert.ok(alongReached.length >= 1);
  for (const h of alongReached) { assert.equal(h.profiledTop, undefined); near(h.z1, FH); }
  // 切断壁: y=3000 は切断線 x=500 を横切る。足元の天端は使わない（profiledTop なし・z1 は天井まで）
  const cutHits = probeColumnHits(cutOf(layers, undefined, 500), 3000, ctx).hits.filter(h => h.kind === 'cut' && h.wall === crossing);
  assert.ok(cutHits.length >= 1, '前提: 切断壁の候補がある');
  for (const h of cutHits) { assert.equal(h.profiledTop, undefined); near(h.z1, FH); }
});

test('軸が足元の外の壁（隔て板の位置 x=1000）は足元の天端なし＝全高', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, steel: true });
  const wall = f1.graph.addWall(f1.V(1000), 0, true, f1.H(1000), 0, f1.H(4000), 0, WALL_PROPS);
  const f2 = makeFloor('p2', 1, { extraRoom: [[0, 0, 2000, 5000]] });
  const self = { graph: f1.graph, floorZMm: 0, role: 'self', underStairSoffits: soffitsOf(f1.graph, f2.graph, f1.stair) };
  const layers = [self, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const ctx = makeProbeContext(layers);
  assert.equal(ctx.wallTopProfileFor(self).get(wall.id), undefined);
  const hits = faceHits(cutOf(layers), ctx, wall, 2500, { worldLo: 2400, worldHi: 2600 });
  assert.ok(hits.length >= 1);
  for (const h of hits) { near(h.z1, FH); assert.equal(h.profiledTop, undefined); }
});

test('【失敗系】注入が空・undefined・不正（surface 無し・footprint 無し・NaN の zOffset）→ 足元の天端なし・全高（例外なし）', () => {
  const f = fixture();
  const withInj = injection => {
    const self = { graph: f.f1.graph, floorZMm: 0, role: 'self', underStairSoffits: injection };
    const layers = [self, f.layers[1]];
    return makeProbeContext(layers).wallTopProfileFor(self).get(f.wall.id);
  };
  assert.equal(withInj([]), undefined);
  assert.equal(withInj(undefined), undefined);
  assert.equal(withInj(null), undefined);
  assert.equal(withInj([null, {}, { surface: null }, { surface: { footprint: { rects: [] } } }]), undefined);
  const self = { graph: f.f1.graph, floorZMm: 0, role: 'self', underStairSoffits: f.self.underStairSoffits };
  const layers = [self, f.layers[1]];
  assert.equal(makeProbeContext(layers, { floorOffsetMm: NaN }).wallTopProfileFor(self).get(f.wall.id), undefined, '帯の FL が非有限＝節の値が非有限＝付けない');
  // 直上の層も代わりの階高も無い単層でも、注入された面があれば足元の天端は付く（面は注入側が持つ。階高を引き直さない）
  const solo = { graph: f.f1.graph, floorZMm: 0, role: 'self', underStairSoffits: f.self.underStairSoffits };
  assert.equal(makeProbeContext([solo]).wallTopProfileFor(solo).get(f.wall.id)?.footCap, true);
});

test('復路下の壁（平らな天端）は足元の規則に上書きされない（footCap でないプロファイルのまま）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, wallsKind: 'underReturn' });
  const f2 = makeFloor('p2', 1);
  const self = { graph: f1.graph, floorZMm: 0, role: 'self', underStairSoffits: soffitsOf(f1.graph, f2.graph, f1.stair) };
  const layers = [self, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const prof = makeProbeContext(layers).wallTopProfileFor(self);
  assert.ok(f1.walls.length >= 1);
  for (const w of f1.walls) {
    const p = prof.get(w.id);
    assert.ok(p, '復路下の壁にプロファイルがある');
    assert.equal(p.footCap, undefined);
    assert.equal(p.junction, true);
    assert.equal(p.zAt(1200), p.zAt(1800), '平らな天端');
  }
});

test('edgeOnWallZRanges は足元の天端（footCap）を使わない＝注入ありでも注入なしと同じ z 範囲（天井まで）', () => {
  const on = fixture(), off = fixture({ inject: false });
  assert.equal(on.ctx.wallTopProfileFor(on.layers[0]).get(on.wall.id)?.footCap, true, '前提: 注入ありでは足元の天端がある');
  for (const depth of [1500, 2500, 3500]) {
    const a = edgeOnWallZRanges(cutOf(on.layers), on.layers[0], on.wall, depth, 500, on.ctx);
    const b = edgeOnWallZRanges(cutOf(off.layers), off.layers[0], off.wall, depth, 500, off.ctx);
    assert.deepEqual(a, b, `depth=${depth}`);
    assert.ok(a.length > 0, `前提: 範囲が求まる（depth=${depth}）`);
    for (const r of a) assert.ok(r.z1 >= FH - 1e-6, `天井まで（z1=${r.z1}）`);
  }
});

test('斜めの隔て板の天端は足元の規則に上書きされない（footCap なし・従来の斜めの値）', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, wallsKind: 'partition' });
  const f2 = makeFloor('p2', 1);
  const self = { graph: f1.graph, floorZMm: 0, role: 'self', underStairSoffits: soffitsOf(f1.graph, f2.graph, f1.stair) };
  const layers = [self, { graph: f2.graph, floorZMm: FH, role: 'above' }];
  const prof = makeProbeContext(layers).wallTopProfileFor(self);
  assert.ok(f1.walls.length >= 1);
  for (const w of f1.walls) {
    const p = prof.get(w.id);
    assert.ok(p, '隔て板にプロファイルがある');
    assert.equal(p.footCap, undefined);
    near(p.zAt(1500), 2200 + 1000 * 500 / 3000); // sectionWallTop.test.js T3 と同じ斜めの値（踊り場端 2200・傾き 1/3）
  }
});
