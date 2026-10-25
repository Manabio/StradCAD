// sectionTypes.js の isSolidBand / solidRectsOf の単体テスト（展開図一般化Phase 6b-2 設計(d)。
// .claude/elevation-redesign.md §5.12）。columnsの手書きリテラルから「実体で囲まれた矩形」を
// 直接検証し、その矩形が階段のささらの見えがかり（isStringer。sectionEmit.js）を実際に
// 切るところまで elevationPrimitives.js の subtractRectsFromPrimitives と組み合わせて確認する
// （呼び出し側=sectionStair.jsのstairPrimitivesForCutと同じ組み立て方。「D1」の縮小再現）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isSolidBand, solidRectsOf, slabJunctionOf, slabSolidRectsOf, slabTopIsRealFloor, zToY, ceilProfileEdgeAt, makeSectionCut } from './sectionTypes.js';
import { isStringer } from './sectionEmit.js';
import { subtractRectsFromPrimitives } from '../elevationPrimitives.js';
import { ElevationLineRole, weightForRole } from '../elevationStyle.js';

// D1の縮小再現: 列0(x:-150..0)にslab[2400..3000]、列1(x:0..60)にその上に立つcut[3000..3800]、
// 列2(x:60..200)は壁の向こう側＝階段室側（実データはhidden[0..5400]＝2a壁。この帯では実体として
// 数えない＝探査済みの非実体）。「6」実データと同じ構成（cutの下端z0=3000がslabの上端z1=3000に
// 一致＝スラブの上に壁が載り、向こう側に小口が見える）。
function makeD1LikeColumns() {
  return [
    { x0: -150, x1: 0, worldLo: 0, worldHi: 150, bands: [{ kind: 'slab', z0: 2400, z1: 3000 }] },
    { x0: 0, x1: 60, worldLo: 150, worldHi: 210, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
    { x0: 60, x1: 200, worldLo: 210, worldHi: 350, bands: [{ kind: 'hidden', z0: 0, z1: 5400 }] },
  ];
}

// sectionStair.jsのstairPrimitivesForCutと同じ変換（z→y。solidRectsOfはz空間のまま返すため、
// 呼び出し側でzToYへ変換してから subtractRectsFromPrimitives へ渡す）。
function toYRects(columns) {
  return solidRectsOf(columns).map(r => ({ xLo: r.xLo, xHi: r.xHi, yLo: zToY(r.zHi), yHi: zToY(r.zLo) }));
}

// ---- isSolidBand ----
test('isSolidBand: slab/cut/cutAlongは実体、wall/hidden/open/farVoidは対象外', () => {
  assert.equal(isSolidBand({ kind: 'slab' }), true);
  assert.equal(isSolidBand({ kind: 'cut' }), true);
  assert.equal(isSolidBand({ kind: 'cutAlong' }), true);
  assert.equal(isSolidBand({ kind: 'wall' }), false);
  assert.equal(isSolidBand({ kind: 'hidden' }), false);
  assert.equal(isSolidBand({ kind: 'open' }), false);
  assert.equal(isSolidBand({ kind: 'farVoid' }), false);
});

// ---- solidRectsOf: farX延長 ----
test('solidRectsOf: slabの矩形は、その上に立つcut壁の向こう側の面(farX)まで延びる', () => {
  const rects = solidRectsOf(makeD1LikeColumns());
  const slabRect = rects.find(r => Math.abs(r.zLo - 2400) < 1);
  assert.ok(slabRect, '前提: slab由来の矩形が1件あるはず');
  // cut壁(x:0..60)の向こう側の面=60まで延びる（GAP_EPSだけ内側へ縮めた値なので厳密一致ではない）。
  assert.ok(Math.abs(slabRect.xHi - 60) < 1e-3, `slabの矩形はfarX=60まで延びるはず（実際:${slabRect.xHi}）`);
  assert.ok(Math.abs(slabRect.xLo - (-150)) < 1e-3, '手前側(lo)は列の実幅のまま');
});

// ---- slabJunctionOf のgate（ユーザー裁定2026-09-13「6」C: 壁の向こう側が未探査なら小口は無い）----
const slabRunOf = () => ({ x0: -150, x1: 0, band: { z0: 2400, z1: 3000 } });
const cutRunOf = () => ({ x0: 0, x1: 60, band: { z0: 3000, z1: 3800 } });
const withBeyond = beyondBands => [
  { x0: -150, x1: 0, bands: [{ kind: 'slab', z0: 2400, z1: 3000 }] },
  { x0: 0, x1: 60, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
  ...(beyondBands ? [{ x0: 60, x1: 200, bands: beyondBands }] : []),
];

test('【失敗系・6C】slabJunctionOf: 壁の向こう側に列が無い（未探査）なら小口は無い（nullで、スラブも延びない）', () => {
  // 実機「6」C左端: はり出し列に上階の腰壁だけが立ち、その下（自階の壁＋床構造）は自階の窓の外。
  const columns = withBeyond(null);
  assert.equal(slabJunctionOf(columns, slabRunOf(), cutRunOf()), null);
  const rect = slabSolidRectsOf(columns).find(r => Math.abs(r.zLo - 2400) < 1);
  assert.ok(Math.abs(rect.xHi - 0) < 1e-6, `未探査側へは延びずxHi=0（列の実幅）のはず（実際:${rect.xHi}）`);
});

test('【失敗系・6C】slabJunctionOf: 向こう側の列がスラブのz範囲を実体(slab/cut)で占めていれば小口は無い', () => {
  assert.equal(slabJunctionOf(withBeyond([{ kind: 'slab', z0: 2400, z1: 3000 }]), slabRunOf(), cutRunOf()), null,
    'スラブが続いている');
  assert.equal(slabJunctionOf(withBeyond([{ kind: 'cut', z0: 0, z1: 5400 }]), slabRunOf(), cutRunOf()), null,
    '別の切断壁の中');
  // z範囲の中点(2700)を内部に含む非実体の帯が無い（2400..2700はslab、2700..5400はopen）。
  assert.equal(slabJunctionOf(withBeyond([{ kind: 'slab', z0: 2400, z1: 2700 }, { kind: 'open', z0: 2700, z1: 5400 }]),
    slabRunOf(), cutRunOf()), null);
});

test('slabJunctionOf: 向こう側の列に探査済みの空気（wall/open/見えがかり由来hidden/farVoid）があれば小口が立つ（nearX/farXは従来どおり）', () => {
  for (const band of [
    { kind: 'wall', z0: 1500, z1: 5400, distMm: 750 },   // 実機「6」B
    { kind: 'open', z0: 0, z1: 5400 },
    { kind: 'hidden', z0: 0, z1: 5400, hiddenOf: 'wall' }, // 実機「6」D1（2a壁＝この帯では実体として数えない）
    { kind: 'hidden', z0: 0, z1: 5400 },                  // 出自なし（手書き列）は見えがかり由来とみなす
    { kind: 'farVoid', z0: 2400, z1: 3000 },
  ]) {
    const hit = slabJunctionOf(withBeyond([band]), slabRunOf(), cutRunOf());
    assert.deepEqual(hit, { nearX: 0, farX: 60, slabOnLoSide: true }, `kind=${band.kind}`);
  }
});

test('【失敗系】slabJunctionOf: 向こう側のhiddenが切断壁由来（hiddenOf:cut）なら断面の中＝小口は立たない', () => {
  assert.equal(slabJunctionOf(withBeyond([{ kind: 'hidden', z0: 0, z1: 5400, hiddenOf: 'cut' }]),
    slabRunOf(), cutRunOf()), null);
});

test('【失敗系】slabJunctionOf: スラブのz範囲の一部だけが空気（残りが実体）なら小口は立たない（範囲全体の被覆で判定）', () => {
  // 2400..2650はcut、2650..3000はopen——中点2700は空気だが範囲全体は覆われていない。
  assert.equal(slabJunctionOf(withBeyond([{ kind: 'cut', z0: 0, z1: 2650 }, { kind: 'open', z0: 2650, z1: 5400 }]),
    slabRunOf(), cutRunOf()), null);
  // 空気の帯2本の和で覆われていれば立つ。
  assert.deepEqual(slabJunctionOf(withBeyond([{ kind: 'open', z0: 0, z1: 2650 }, { kind: 'wall', z0: 2650, z1: 5400, distMm: 750 }]),
    slabRunOf(), cutRunOf()), { nearX: 0, farX: 60, slabOnLoSide: true });
});

test('【失敗系】slabJunctionOf: 壁がスラブの上に載っていなければ（z不一致）向こう側が空気でもnull', () => {
  const columns = withBeyond([{ kind: 'open', z0: 0, z1: 5400 }]);
  assert.equal(slabJunctionOf(columns, slabRunOf(), { x0: 0, x1: 60, band: { z0: 3200, z1: 3800 } }), null);
});

// ---- slabTopIsRealFloor（スラブの上面が実在する床か。slabJunctionOfの関門）----
// スラブ側の列（x:-150..0）にだけ upperFloorZ / floorZ を載せる。向こう側は空気（open）。
const withSlabCol = (extra, slabBand = {}) => [
  { x0: -150, x1: 0, bands: [{ kind: 'slab', z0: 2400, z1: 3000, ...slabBand }], ...extra },
  { x0: 0, x1: 60, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
  { x0: 60, x1: 200, bands: [{ kind: 'open', z0: 0, z1: 5400 }] },
];
const hitOf = { nearX: 0, farX: 60, slabOnLoSide: true };
// 関数が読むのは slabRun.band.floorZ（列の帯ではない）。列の帯と走りの帯に同じ floorZ を置く。
const slabRunWith = slabBand => ({ x0: -150, x1: 0, band: { z0: 2400, z1: 3000, ...slabBand } });
// 鏡像（スラブが壁の hi 側＝右）: 列 x:0..150 のスラブ・壁は x:-60..0。
const mirrorCols = extra => [
  { x0: -200, x1: -60, bands: [{ kind: 'open', z0: 0, z1: 5400 }] },
  { x0: -60, x1: 0, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
  { x0: 0, x1: 150, bands: [{ kind: 'slab', z0: 2400, z1: 3000 }], ...extra },
];
const mirrorRun = { x0: 0, x1: 150, band: { z0: 2400, z1: 3000 } };
const mirrorHit = { nearX: 0, farX: -60, slabOnLoSide: false };

test('slabTopIsRealFloor: 上階の実在の床（upperFloorZ が z1 と一致）なら立つ', () => {
  const columns = withSlabCol({ upperFloorZ: 3000 });
  assert.equal(slabTopIsRealFloor(columns, slabRunOf(), hitOf), true);
  assert.deepEqual(slabJunctionOf(columns, slabRunOf(), cutRunOf()), hitOf);
});

test('slabTopIsRealFloor: 自階の床構造（slab 帯の floorZ が z1）なら upperFloorZ が null でも立つ（下階に階段がある階）', () => {
  const columns = withSlabCol({ upperFloorZ: null }, { floorZ: 3000 });
  const run = { x0: -150, x1: 0, band: { z0: 2400, z1: 3000, floorZ: 3000 } };
  assert.equal(slabTopIsRealFloor(columns, run, hitOf), true);
  assert.deepEqual(slabJunctionOf(columns, run, cutRunOf()), hitOf);
});

test('【失敗系】slabTopIsRealFloor: upperFloorZ が null の見かけだけのスラブは偽（小口は立たず、スラブも延びない）', () => {
  const columns = withSlabCol({ upperFloorZ: null }, { floorZ: 0 });
  const run = slabRunWith({ floorZ: 0 });
  assert.equal(slabTopIsRealFloor(columns, run, hitOf), false);
  assert.equal(slabJunctionOf(columns, run, cutRunOf()), null);
  assert.equal(slabTopIsRealFloor(columns, slabRunOf(), hitOf), false, 'floorZ を持たない走りでも偽');
  const rect = slabSolidRectsOf(columns).find(r => Math.abs(r.zLo - 2400) < 1);
  assert.ok(Math.abs(rect.xHi - 0) < 1e-6, `延びずxHi=0のはず（実際:${rect.xHi}）`);
});

test('【失敗系】slabTopIsRealFloor: upperFloorZ が z1 と違う（3階の床）なら偽', () => {
  const columns = withSlabCol({ upperFloorZ: 6000 }, { floorZ: 0 });
  const run = slabRunWith({ floorZ: 0 });
  assert.equal(slabTopIsRealFloor(columns, run, hitOf), false);
  assert.equal(slabJunctionOf(columns, run, cutRunOf()), null);
});

test('【A-4】slabTopIsRealFloor: 条件 (3) は走りの band.floorZ で決まる（z1 と一致なら真・不一致／非有限なら偽。upperFloorZ は null）', () => {
  const columns = withSlabCol({ upperFloorZ: null });
  assert.equal(slabTopIsRealFloor(columns, slabRunWith({ floorZ: 3000 }), hitOf), true, '自階の床構造 floorZ≈z1');
  assert.equal(slabTopIsRealFloor(columns, slabRunWith({ floorZ: 2400 }), hitOf), false, 'floorZ≠z1');
  assert.equal(slabTopIsRealFloor(columns, slabRunWith({ floorZ: NaN }), hitOf), false, '非有限');
});

test('【A-T2】slabTopIsRealFloor: 鏡像（スラブが壁の hi 側＝slabOnLoSide=false）でも upperFloorZ が null なら偽・z1 なら真', () => {
  assert.equal(slabTopIsRealFloor(mirrorCols({ upperFloorZ: null }), mirrorRun, mirrorHit), false);
  assert.equal(slabTopIsRealFloor(mirrorCols({ upperFloorZ: 3000 }), mirrorRun, mirrorHit), true);
  assert.equal(slabTopIsRealFloor(mirrorCols({ upperFloorZ: 6000 }), mirrorRun, mirrorHit), false, '3階の床');
});

test('【A-T3】slabTopIsRealFloor: 見る列が無い（走りの外・離れた壁）は true（従来どおり）。columns 未指定も true', () => {
  const columns = withSlabCol({ upperFloorZ: null });
  assert.equal(slabTopIsRealFloor(columns, slabRunOf(), { nearX: 500, farX: 560, slabOnLoSide: true }), true, '離れた壁');
  assert.equal(slabTopIsRealFloor(columns, { x0: -1000, x1: -500, band: { z0: 2400, z1: 3000 } }, hitOf), true, '走りの外');
  assert.equal(slabTopIsRealFloor(undefined, slabRunOf(), hitOf), true, 'columns なし');
});

test('slabTopIsRealFloor: upperFloorZ が未定義（手書きの列）は従来どおり素通し', () => {
  assert.equal(slabTopIsRealFloor(withSlabCol({}), slabRunOf(), hitOf), true);
});

// ---- 正常系: isStringerのpolylineが farX で切られる ----
test('【正常系・D1縮小再現】subtractRectsFromPrimitives: ささらの見えがかり(isStringer)は、slabの矩形をfarXまで延ばした厳密内部で切られる', () => {
  const columns = makeD1LikeColumns();
  const rects = toYRects(columns);
  const stringer = {
    type: 'polyline', weight: weightForRole(ElevationLineRole.DETAIL),
    points: [[-50, zToY(2700)], [100, zToY(2400)]],
  };
  assert.ok(isStringer(stringer), '前提: DETAILのpolyline(2点以上)はisStringer');
  const out = subtractRectsFromPrimitives([stringer], rects);
  assert.equal(out.length, 1, '矩形の外に残る区間だけの1本になるはず');
  const [p0, p1] = out[0].points;
  // 矩形の向こう側の面x=60から、元の終点(100,2400)まで残る。
  assert.ok(Math.abs(p0[0] - 60) < 1e-3, `残る区間の始点xはfarX=60のはず（実際:${p0[0]}）`);
  assert.ok(Math.abs(p0[1] - zToY(2480)) < 1e-2, `始点zは線分とfarXの交点2480のはず（実際:${-p0[1]}）`);
  assert.ok(Math.abs(p1[0] - 100) < 1e-3 && Math.abs(p1[1] - zToY(2400)) < 1e-3,
    '終点は元のまま(100,z2400)残るはず');
});

// ---- 失敗系①: CUT(踏面)は対象外 ----
test('【失敗系①】isStringer: CUT(踏面)のpolylineは対象外で、同配置でも切られない', () => {
  const columns = makeD1LikeColumns();
  const rects = toYRects(columns);
  const points = [[-50, zToY(2700)], [100, zToY(2400)]];
  const tread = { type: 'polyline', weight: weightForRole(ElevationLineRole.CUT), points };
  assert.equal(isStringer(tread), false, '前提: CUTのpolylineはisStringerではない');
  // stairPrimitivesForCutの呼び出し側と同じ組み立て方（isStringerのものだけ矩形減算に通す）。
  const out = tread.type === 'polyline' && isStringer(tread) ? subtractRectsFromPrimitives([tread], rects) : [tread];
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].points, points, '踏面(CUT)はそのまま残るはず（点も不変）');
});

// ---- 失敗系②: 矩形の辺上にある縦線は切られない ----
test('【失敗系②】subtractRectsFromPrimitives: 矩形の辺(x=farX)にちょうど乗る縦線は「厳密内部」ではないため切られない', () => {
  const columns = makeD1LikeColumns();
  const rects = toYRects(columns);
  // x=60(farXそのもの)に乗る、z2400..3000の縦線（面C x=1492.5の復路ささらと同じ状況の縮小再現）。
  const onEdge = {
    type: 'polyline', weight: weightForRole(ElevationLineRole.DETAIL),
    points: [[60, zToY(2400)], [60, zToY(3000)]],
  };
  const out = subtractRectsFromPrimitives([onEdge], rects);
  assert.equal(out.length, 1, '辺上の縦線は矩形の内部ではないため、分割されず1本のまま残るはず');
  assert.deepEqual(out[0].points, onEdge.points, '点も不変のはず');
});

// ---- F1: hidden/wallだけの列は矩形を作らない（P0実測のD1構成の再現） ----
// .claude/elevation-redesign.md §5.12「P0実測」の実データそのまま: 「6」D1(seq2)は
// local -150..0がslab[2400..3000]、0..57.5はhidden[0..3000]（13⇔6の壁）、
// 57.5..2512.5はhidden[0..5400]＝x>0にslabは無い。hiddenはisSolidBandの対象外なので、
// 矩形はslab由来の1件（x=-150..0）だけになり、hidden帯の範囲（x>0。z=4000付近を含む）には
// 矩形が無い＝そこを通るisStringer polylineは切られない。
test('【F1】solidRectsOf: hidden帯だけの列は矩形を作らない（P0実測のD1構成）', () => {
  const columns = [
    { x0: -150, x1: 0, worldLo: 0, worldHi: 150, bands: [{ kind: 'slab', z0: 2400, z1: 3000 }] },
    { x0: 0, x1: 57.5, worldLo: 150, worldHi: 207.5, bands: [{ kind: 'hidden', z0: 0, z1: 3000 }] },
    { x0: 57.5, x1: 2512.5, worldLo: 207.5, worldHi: 2662.5, bands: [{ kind: 'hidden', z0: 0, z1: 5400 }] },
  ];
  const rects = solidRectsOf(columns);
  assert.equal(rects.length, 1, 'hidden帯は矩形を作らないため、slab由来の1件だけのはず');
  assert.ok(Math.abs(rects[0].zLo - 2400) < 1 && Math.abs(rects[0].xHi - 0) < 1,
    `矩形はslab(x:-150..0, z:2400..3000)のまま延びていないはず（実際:${JSON.stringify(rects[0])}）`);

  // x=1000,z=4000付近（hidden帯の範囲内）を通るisStringer polylineは矩形の外なので切られない。
  const stringer = {
    type: 'polyline', weight: weightForRole(ElevationLineRole.DETAIL),
    points: [[900, zToY(4200)], [1100, zToY(3800)]],
  };
  const out = subtractRectsFromPrimitives([stringer], toYRects(columns));
  assert.equal(out.length, 1, '矩形と無関係な位置なので分割されないはず');
  assert.deepEqual(out[0].points, stringer.points, '点も不変のはず');
});

// ---- F1: wallだけの列も同様（isSolidBandの対象外） ----
test('【F1】solidRectsOf: wall帯だけの列も矩形を作らない', () => {
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 5400 }] }];
  assert.deepEqual(solidRectsOf(columns), []);
  const stringer = {
    type: 'polyline', weight: weightForRole(ElevationLineRole.DETAIL),
    points: [[100, zToY(4200)], [900, zToY(3800)]],
  };
  const out = subtractRectsFromPrimitives([stringer], toYRects(columns));
  assert.deepEqual(out, [stringer], 'wallだけの列は矩形を作らないため素通しのはず');
});

// ---- 失敗系③: bandが無ければ素通し ----
test('【失敗系③】solidRectsOf: 列にbandが1本も無ければ空配列（素通し）', () => {
  const columns = [{ x0: -150, x1: 100, worldLo: 0, worldHi: 250, bands: [] }];
  assert.deepEqual(solidRectsOf(columns), []);
  const stringer = {
    type: 'polyline', weight: weightForRole(ElevationLineRole.DETAIL),
    points: [[-50, zToY(2700)], [100, zToY(2400)]],
  };
  const out = subtractRectsFromPrimitives([stringer], toYRects(columns));
  assert.deepEqual(out, [stringer], 'bandが無い(=矩形が無い)ときは元のprimsをそのまま返すはず');
});

// ---- T-a: 同一オーナーでzが割れたslab帯2本は1本に結合しfarX延長が全高に効く ----
// sectionEmit.jsのslabRunsが持つ「同一オーナー(floorZ一致)でzが連続するslab帯は1本の
// スラブとして数える」縦マージ（QA是正2026-09-13・F4で単一情報源化）が、solidRectsOfの
// farX延長にも正しく効くことの固定。
test('【T-a】solidRectsOf: 同一オーナーでzが割れたslab帯2本は1本に結合しfarX延長が全高に効く', () => {
  const columns = [
    { x0: -150, x1: 0, worldLo: 0, worldHi: 150,
      bands: [{ kind: 'slab', z0: 0, z1: 1500, floorZ: 3000 }, { kind: 'slab', z0: 1500, z1: 3000, floorZ: 3000 }] },
    { x0: 0, x1: 60, worldLo: 150, worldHi: 210, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
    { x0: 60, x1: 200, worldLo: 210, worldHi: 350, bands: [{ kind: 'open', z0: 0, z1: 5400 }] },
  ];
  const rects = solidRectsOf(columns);
  // rectsには`cut`帯自身の直接矩形（x:0..60, z:3000..3800）も1件含まれる——slab由来の矩形
  // だけを`zLo`で選び出して検証する。
  const slabRects = rects.filter(r => r.zLo < 3000);
  assert.equal(slabRects.length, 1, '同一オーナー(floorZ一致)のslab帯2本はsameSlabOwnerで1本のrunに結合されるはず');
  assert.ok(Math.abs(slabRects[0].zLo - 0) < 1 && Math.abs(slabRects[0].zHi - 3000) < 1,
    `結合後の矩形はz0..3000の全高になるはず（実際:${JSON.stringify(slabRects[0])}）`);
  assert.ok(Math.abs(slabRects[0].xHi - 60) < 1e-3,
    `結合された矩形の上端z=3000にcut壁が立つため、farX延長(xHi=60)が全高に効くはず（実際:${slabRects[0].xHi}）`);
});

// ---- 失敗系・T-a: floorZが異なれば結合せず、farX延長は該当するrunだけに効く ----
test('【失敗系・T-a】solidRectsOf: floorZが異なるslab帯2本は結合されず、farX延長は上段のrunだけに効く', () => {
  const columns = [
    { x0: -150, x1: 0, worldLo: 0, worldHi: 150,
      bands: [{ kind: 'slab', z0: 0, z1: 1500, floorZ: 1500 }, { kind: 'slab', z0: 1500, z1: 3000, floorZ: 3000 }] },
    { x0: 0, x1: 60, worldLo: 150, worldHi: 210, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
    { x0: 60, x1: 200, worldLo: 210, worldHi: 350, bands: [{ kind: 'open', z0: 0, z1: 5400 }] },
  ];
  const rects = solidRectsOf(columns);
  const slabRects = rects.filter(r => r.zLo < 3000);
  assert.equal(slabRects.length, 2, 'floorZが異なる（別オーナー）ので結合されずslab由来2件のはず');
  const lower = slabRects.find(r => Math.abs(r.zLo - 0) < 1);
  assert.ok(lower, '下段(z0..1500)の矩形があるはず');
  assert.ok(Math.abs(lower.xHi - 0) < 1e-3,
    `下段の上端z=1500にはcut壁が立っていないためfarX延長が効かずxHi≈0(列の実幅)のはず（実際:${lower.xHi}）`);
});

// ---- T-b: 退化した帯(z0===z1)は矩形を作らない（削除した旧clipStairDetailInSlabBandの
// 退化系テストの後継） ----
test('【T-b・失敗系】solidRectsOf: 退化した帯(z0===z1)は矩形を作らない', () => {
  const columns = [{ x0: -150, x1: 0, worldLo: 0, worldHi: 150, bands: [{ kind: 'slab', z0: 3000, z1: 3000 }] }];
  assert.deepEqual(solidRectsOf(columns), []);
});

// ---- 天井プロファイル解決の単一情報源は ceilProfileEdgeAt（sectionEngine.jsの列分割が使う。展開図一般化
// Phase 6b-3・エンジン内単一情報源化）。以下は旧 ceilProfileZAt（低い側の高さ。製品からは呼ばれなくなり削除）
// の期待をそのまま引き継ぐ: [x0,x1]の中点を含む区間のceilZを返す。範囲外は端の区間の値へクランプする。
const ceilProfileZAt = (profile, x0, x1) => {
  const edge = ceilProfileEdgeAt(profile, x0, x1);
  return edge ? Math.min(edge.z0, edge.z1) : null;
};
test('【ceilProfileZAt】区間一様なら[x0,x1]の位置に関わらず同じceilZを返す', () => {
  const profile = [{ loX: 0, hiX: 2000, ceilZ: 2400 }];
  assert.equal(ceilProfileZAt(profile, 0, 0), 2400);
  assert.equal(ceilProfileZAt(profile, 1000, 1000), 2400);
  assert.equal(ceilProfileZAt(profile, 1900, 1900), 2400);
});

test('【ceilProfileZAt】区間ごとに天井高が違えば、[x0,x1]の中点を含む区間のceilZを返す', () => {
  const profile = [
    { loX: 0, hiX: 1000, ceilZ: 2400 },
    { loX: 1000, hiX: 2000, ceilZ: 3000 },
  ];
  assert.equal(ceilProfileZAt(profile, 300, 300), 2400, '区間0(低い方)の中点はceilZ=2400のはず');
  assert.equal(ceilProfileZAt(profile, 1500, 1500), 3000, '区間1(高い方)の中点はceilZ=3000のはず');
  // [x0,x1]の中点で判定する（呼び出し側=sectionEngine.jsのbuildColumnsは列自身の実幅を渡す）。
  assert.equal(ceilProfileZAt(profile, 900, 1100), 2400,
    '中点1000は区間0の上端(hiX=1000)ちょうどなので区間0側にマッチするはず');
});

test('【失敗系・ceilProfileZAt】profileの範囲外は端の区間の値へクランプする', () => {
  const profile = [
    { loX: 0, hiX: 1000, ceilZ: 2400 },
    { loX: 1000, hiX: 2000, ceilZ: 3000 },
  ];
  assert.equal(ceilProfileZAt(profile, -500, -500), 2400, '範囲より手前は先頭区間の値へクランプ');
  assert.equal(ceilProfileZAt(profile, 2500, 2500), 3000, '範囲より奥は末尾区間の値へクランプ');
});

test('【失敗系・ceilProfileZAt】profileが無い・空なら打ち切らない(null)', () => {
  assert.equal(ceilProfileZAt(undefined, 0, 0), null);
  assert.equal(ceilProfileZAt([], 0, 0), null);
});

// ---- ceilProfileEdgeAt: 傾斜天井の受け口（E3a-1）。区間は ceilZ（loX）と任意の ceilZHi（hiX）で直線を表す。
test('【ceilProfileEdgeAt】平面の区間はz0===z1・傾斜の区間は[x0,x1]の両端を線形補間する', () => {
  assert.deepEqual(ceilProfileEdgeAt([{ loX: 0, hiX: 4000, ceilZ: 2400 }], 0, 1000), { z0: 2400, z1: 2400 });
  const sloped = [{ loX: 0, hiX: 4000, ceilZ: 2400, ceilZHi: 3000 }];
  assert.deepEqual(ceilProfileEdgeAt(sloped, 0, 4000), { z0: 2400, z1: 3000 });
  assert.deepEqual(ceilProfileEdgeAt(sloped, 1000, 2000), { z0: 2550, z1: 2700 });
  // ceilProfileZAt は傾いた区間では低い側を返す。
  assert.equal(ceilProfileZAt(sloped, 1000, 2000), 2550);
  assert.equal(ceilProfileZAt([{ loX: 0, hiX: 4000, ceilZ: 3000, ceilZHi: 2400 }], 0, 4000), 2400);
});

test('【ceilProfileEdgeAt】区間外は端の区間の端点の値で水平・区間ごとに別の傾き', () => {
  const profile = [
    { loX: 0, hiX: 1000, ceilZ: 2400, ceilZHi: 2800 },
    { loX: 1000, hiX: 2000, ceilZ: 3000 },
  ];
  assert.deepEqual(ceilProfileEdgeAt(profile, -500, -100), { z0: 2400, z1: 2400 }, '先頭より手前＝先頭区間のloXの値');
  assert.deepEqual(ceilProfileEdgeAt(profile, 2100, 2500), { z0: 3000, z1: 3000 }, '末尾より奥＝末尾区間の値');
  assert.deepEqual(ceilProfileEdgeAt(profile, 0, 1000), { z0: 2400, z1: 2800 });
  assert.deepEqual(ceilProfileEdgeAt(profile, 1000, 2000), { z0: 3000, z1: 3000 });
  const lastSloped = [{ loX: 0, hiX: 1000, ceilZ: 2400, ceilZHi: 2800 }];
  assert.deepEqual(ceilProfileEdgeAt(lastSloped, 1500, 1800), { z0: 2800, z1: 2800 }, '末尾が傾斜なら奥は hiX の高さで水平');
});

test('【失敗系・ceilProfileEdgeAt】profileが無い・空・ceilZ非有限はnull／ceilZHiが非有限・同値・区間幅0は平面', () => {
  assert.equal(ceilProfileEdgeAt(undefined, 0, 0), null);
  assert.equal(ceilProfileEdgeAt([], 0, 0), null);
  assert.equal(ceilProfileEdgeAt([{ loX: 0, hiX: 1000, ceilZ: NaN, ceilZHi: 3000 }], 0, 500), null);
  const flat = { z0: 2400, z1: 2400 };
  assert.deepEqual(ceilProfileEdgeAt([{ loX: 0, hiX: 1000, ceilZ: 2400, ceilZHi: NaN }], 0, 1000), flat);
  assert.deepEqual(ceilProfileEdgeAt([{ loX: 0, hiX: 1000, ceilZ: 2400, ceilZHi: Infinity }], 0, 1000), flat);
  assert.deepEqual(ceilProfileEdgeAt([{ loX: 0, hiX: 1000, ceilZ: 2400, ceilZHi: 2400 }], 0, 1000), flat);
  assert.deepEqual(ceilProfileEdgeAt([{ loX: 500, hiX: 500, ceilZ: 2400, ceilZHi: 3000 }], 500, 500), flat);
});

// ---- 契約: 関数ごとの opts 読み取りキー ----
//   buildSectionFromLine = CutSpec ∪ ProbeInputs ∪ RenderStyle ∪ BandInjections − gapFloorProfile・floorlessRanges・memberCeilZAt・memberSplitsGaps（転送しない）
//   buildCutContent      = Pick の 11 キー（endExtendMm・upperPlaneOverhang・bandRoomBounds・RenderStyle 全部・gapBeamRects・gapFloorProfile・floorlessRanges・memberCeilZAt・memberSplitsGaps）
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

// `export function name(` の開始行〜次の `\nexport ` 直前（なければ末尾）。withProbeExtension の opts は別物なので含めない。
function functionBody(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

// `opts.X` / `opts?.X` と、`const|let|var { a, b: c, d = 1 } = opts` の分割代入名。
function optsKeysRead(body) {
  const read = new Set([...body.matchAll(/\bopts\??\.(\w+)/g)].map(m => m[1]));
  for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*opts\b/g)) {
    for (const k of m[1].split(',')) { const name = k.split(/[:=]/)[0].trim(); if (name) read.add(name); }
  }
  return read;
}

test('契約: 関数ごとの opts 読み取りキーと 4 typedef の @property が過不足なく一致する', () => {
  const dir = import.meta.dirname;
  const contentSrc = stripComments(fs.readFileSync(path.join(dir, 'sectionContent.js'), 'utf8'));
  const read = optsKeysRead(functionBody(contentSrc, 'buildSectionFromLine'));
  const readCut = optsKeysRead(functionBody(contentSrc, 'buildCutContent'));
  assert.ok(read.size >= 20, `空振り防止: buildSectionFromLine の opts のキーが ${read.size} 個しか読めていない`);
  assert.ok(readCut.size >= 8, `空振り防止: buildCutContent の opts のキーが ${readCut.size} 個しか読めていない`);

  const typesSrc = fs.readFileSync(path.join(dir, 'sectionTypes.js'), 'utf8');
  const start = typesSrc.indexOf('@typedef {object} CutSpec');
  const block = typesSrc.slice(start, typesSrc.indexOf('*/', start));
  assert.ok(start >= 0 && block.includes('@typedef {object} BandInjections'), '4 typedef のブロックが読めない');
  const groups = {};
  let current = null;
  for (const line of block.split('\n')) {
    const t = line.match(/@typedef \{object\} (\w+)/);
    if (t) { current = t[1]; groups[current] = new Set(); continue; }
    const p = line.match(/@property\s+\{.*\}\s+\[?(\w+)\]?/);
    if (p && current) groups[current].add(p[1]);
  }
  assert.deepEqual(Object.keys(groups), ['CutSpec', 'ProbeInputs', 'RenderStyle', 'BandInjections']);
  const declared = new Set(Object.values(groups).flatMap(s => [...s]));
  const total = Object.values(groups).reduce((n, s) => n + s.size, 0);
  assert.equal(declared.size, total, '同じキーが複数の群に重複して宣言されている');
  declared.delete('gapFloorProfile'); // buildSectionFromLine は buildCutContent へ転送しない（呼び出し側も渡さない）
  declared.delete('floorlessRanges'); // 同上（階段帯が buildCutContent へ直接渡す。U1b B3-1）
  declared.delete('memberCeilZAt'); // 同上（階段帯の天井裏の判定。U1b B3-2）
  declared.delete('memberSplitsGaps'); // 同上（階段帯はアキを割らない。U1b B3-2）
  assert.deepEqual([...read].sort(), [...declared].sort(),
    `buildSectionFromLine 読み取り−宣言=${[...read].filter(k => !declared.has(k))} / 宣言−読み取り=${[...declared].filter(k => !read.has(k))}`);
  const pick = ['endExtendMm', 'upperPlaneOverhang', 'bandRoomBounds', ...groups.RenderStyle, 'gapBeamRects', 'gapFloorProfile', 'floorlessRanges',
    'memberCeilZAt', 'memberSplitsGaps'];
  assert.deepEqual([...readCut].sort(), pick.sort(), 'buildCutContent の読み取りが Pick の 11 キーと一致しない');
});

// ---- makeSectionCut（SectionCut の唯一の生成器）----
const validSpec = () => ({
  line: { isVertical: false, axisValue: 0, lo: 0, hi: 1000 }, viewSign: 1, dirSign: 1,
  layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
});

test('makeSectionCut: 必須キー（line/viewSign/dirSign/layers/zRange/baseFloorZ）が欠けたら投げる', () => {
  for (const key of ['line', 'viewSign', 'dirSign', 'layers', 'zRange', 'baseFloorZ']) {
    const spec = validSpec();
    delete spec[key];
    assert.throws(() => makeSectionCut(spec), new RegExp(key), `${key} 欠落`);
    assert.throws(() => makeSectionCut({ ...spec, [key]: undefined }), new RegExp(key), `${key}: undefined`);
  }
  assert.throws(() => makeSectionCut(undefined), /makeSectionCut/);
});

test('makeSectionCut: 渡した spec と同じ own キー集合・値を返し、渡していないキーを足さない', () => {
  const spec = { ...validSpec(), seqNo: '3', face: undefined, stairCut: null };
  const cut = makeSectionCut(spec);
  assert.deepEqual(Object.keys(cut).sort(), Object.keys(spec).sort());
  assert.notEqual(cut, spec, '入力を変更せず別オブジェクトを返す');
  for (const k of Object.keys(spec)) assert.strictEqual(cut[k], spec[k], k);
  for (const k of ['ends', 'face', 'openGapMarks', 'ceilProfile', 'airRoom', 'underRooms', 'bandRoomBounds']) {
    assert.equal(k in makeSectionCut(validSpec()), false, `${k} を既定値で足さない`);
  }
});
