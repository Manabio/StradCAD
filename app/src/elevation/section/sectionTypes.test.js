// sectionTypes.js の isSolidBand / solidRectsOf の単体テスト（展開図一般化Phase 6b-2 設計(d)。
// .claude/elevation-redesign.md §5.12）。columnsの手書きリテラルから「実体で囲まれた矩形」を
// 直接検証し、その矩形が階段のささらの見えがかり（isStringer。sectionEmit.js）を実際に
// 切るところまで elevationPrimitives.js の subtractRectsFromPrimitives と組み合わせて確認する
// （呼び出し側=sectionStair.jsのstairPrimitivesForCutと同じ組み立て方。「D1」の縮小再現）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSolidBand, solidRectsOf, slabJunctionOf, slabSolidRectsOf, zToY, ceilProfileZAt } from './sectionTypes.js';
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

// ---- ceilProfileZAt: sectionEngine.jsの列分割(ceilZ)・elevationBand.jsのstairOverが共有する
// 天井プロファイル解決の単一情報源（展開図一般化Phase 6b-3・エンジン内単一情報源化）。
// [x0,x1]の中点を含む区間のceilZを返す。範囲外は端の区間の値へクランプする。
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
