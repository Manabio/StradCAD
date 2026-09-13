// sectionTypes.js の isSolidBand / solidRectsOf の単体テスト（展開図一般化Phase 6b-2 設計(d)。
// .claude/elevation-redesign.md §5.12）。columnsの手書きリテラルから「実体で囲まれた矩形」を
// 直接検証し、その矩形が階段のささらの見えがかり（isStringer。sectionEmit.js）を実際に
// 切るところまで elevationPrimitives.js の subtractRectsFromPrimitives と組み合わせて確認する
// （呼び出し側=sectionStair.jsのstairPrimitivesForCutと同じ組み立て方。「D1」の縮小再現）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSolidBand, solidRectsOf, zToY } from './sectionTypes.js';
import { isStringer } from './sectionEmit.js';
import { subtractRectsFromPrimitives } from '../elevationPrimitives.js';
import { ElevationLineRole, weightForRole } from '../elevationStyle.js';

// D1の縮小再現: 列0(x:-150..0)にslab[2400..3000]、列1(x:0..60)にその上に立つcut[3000..3800]。
// 「6」実データと同じ構成（cutの下端z0=3000がslabの上端z1=3000に一致＝スラブの上に壁が載る）。
function makeD1LikeColumns() {
  return [
    { x0: -150, x1: 0, worldLo: 0, worldHi: 150, bands: [{ kind: 'slab', z0: 2400, z1: 3000 }] },
    { x0: 0, x1: 60, worldLo: 150, worldHi: 210, bands: [{ kind: 'cut', z0: 3000, z1: 3800 }] },
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
