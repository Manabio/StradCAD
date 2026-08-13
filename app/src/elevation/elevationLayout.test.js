// elevationLayout.js の不変条件テスト（.claude/elevation-model.md §3.3 I7 等）。
// 循環スクロールはユーザー指示により廃止（クランプスクロールへ全面置き換え）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseElevationScale, screenMmToModelMm, layoutBands, clampScrollY,
  visibleBandPlacements, bandIdAtY, clampFaceOffset, bandContentOriginMm,
  miterTriangleVertices, verticalDimLabelBox,
} from './elevationLayout.js';
import { BAND_GAP_MM } from './elevationStyle.js';

// sectionGeometry.js NICE_SCALES と同じ値（非公開のためテスト側で同じ集合を持つ）。
const NICE_SCALES = [
  1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 8, 1 / 10, 1 / 15, 1 / 20, 1 / 25,
  1 / 30, 1 / 40, 1 / 50, 1 / 75, 1 / 100, 1 / 150, 1 / 200, 1 / 300, 1 / 500,
];

// ---- I7: NICE_SCALES要素／画面が高いほど単調非減少／最高帯がbudgetPxに収まる ----
test('chooseElevationScale: 返り値はNICE_SCALESの要素である', () => {
  const bands = [{ heightMm: 2400 }, { heightMm: 3000 }];
  const scale = chooseElevationScale(bands, { width: 1000, height: 900 });
  assert.ok(NICE_SCALES.includes(scale), `${scale} はNICE_SCALESの要素ではない`);
});

test('chooseElevationScale: 画面が高いほど倍率は単調非減少になる', () => {
  const bands = [{ heightMm: 2700 }];
  const small = chooseElevationScale(bands, { width: 1000, height: 400 });
  const large = chooseElevationScale(bands, { width: 1000, height: 2000 });
  assert.ok(large >= small, `画面拡大で倍率が下がってはいけない(${small} -> ${large})`);
});

test('chooseElevationScale: 最も背の高い帯がbudgetPx(=height/2.2)に収まる', () => {
  const bands = [{ heightMm: 2400 }, { heightMm: 4000 }];
  const height = 1200;
  const scale = chooseElevationScale(bands, { width: 1000, height });
  const budgetPx = height / 2.2;
  assert.ok(4000 * scale <= budgetPx + 1e-6, '最高帯がbudgetPxに収まっていない');
});

// ---- screenMmToModelMm: 実画面mm→モデルmm換算（倍率決定とギャップ換算の循環回避の要） ----
test('screenMmToModelMm: 実画面mm×校正値(px/mm)÷倍率(px/mm)でモデルmmになる', () => {
  // 校正値3.78px/mm(=96dpi相当)・倍率1/50(px/mm)で実画面30mmは 30*3.78/(1/50) = 5670mm
  const v = screenMmToModelMm(30, 3.78, 1 / 50);
  assert.ok(Math.abs(v - 5670) < 1e-6, `期待値5670に対し実際:${v}`);
});

test('【失敗系】screenMmToModelMm: scale<=0は0を返す（0除算にならない）', () => {
  assert.equal(screenMmToModelMm(30, 3.78, 0), 0);
  assert.equal(screenMmToModelMm(30, 3.78, -1), 0);
});

// ---- layoutBands ----
test('layoutBands: 帯を縦に積み、contentHeightMmは最後の帯の下端（帯間の余白を含まない）', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 2000 }], 100);
  assert.deepEqual(layout.placements, [
    { roomId: 'a', topMm: 0, heightMm: 1000 },
    { roomId: 'b', topMm: 1100, heightMm: 2000 },
  ]);
  assert.equal(layout.contentHeightMm, 3100, '最後の帯(topMm=1100,height=2000)の下端。末尾の帯間100は含まない');
});

// ---- QA A2: topMarginMmは「この帯を置く直前」に追加で空ける（topMmを押し下げる） ----
test('【QA A2】layoutBands: topMarginMmは帯を置く直前に追加で空け、以降の帯もその分だけ後ろへずれる', () => {
  const layout = layoutBands([
    { roomId: 'a', heightMm: 1000 },
    { roomId: 'b', heightMm: 1000, topMarginMm: 500 },
    { roomId: 'c', heightMm: 1000 },
  ], 100);
  assert.deepEqual(layout.placements, [
    { roomId: 'a', topMm: 0, heightMm: 1000 },
    { roomId: 'b', topMm: 1100 + 500, heightMm: 1000 }, // aの下端(1000)+gap(100)+bのtopMarginMm(500)
    { roomId: 'c', topMm: 1100 + 500 + 1000 + 100, heightMm: 1000 },
  ]);
});

// ---- 失敗系: topMarginMm未指定は0扱い（既存の呼び出し元との後方互換） ----
test('【失敗系・QA A2】layoutBands: topMarginMm未指定は0として扱われる（既存呼び出し元と同じ結果になる）', () => {
  const withoutField = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 2000 }], 100);
  const withZero = layoutBands([
    { roomId: 'a', heightMm: 1000, topMarginMm: 0 },
    { roomId: 'b', heightMm: 2000, topMarginMm: 0 },
  ], 100);
  assert.deepEqual(withoutField.placements, withZero.placements);
});

// ---- clampScrollY: 循環廃止後のクランプ仕様 ----
test('clampScrollY: 上端は0、下端はcontentHeightMm-viewHeightMm', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 2000 }], 100);
  // contentHeightMm=3100
  assert.equal(clampScrollY(-500, layout, 1000), 0, '上端より上へは行けない');
  assert.equal(clampScrollY(9999, layout, 1000), 2100, '下端(3100-1000)で頭打ち');
  assert.equal(clampScrollY(1500, layout, 1000), 1500, '範囲内はそのまま');
});

test('clampScrollY: 全帯が画面に収まる場合はクランプ範囲が[0,0]に潰れる（スクロール不要）', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }], 100);
  // contentHeightMm=1000 <= viewHeightMm=2000
  assert.equal(clampScrollY(9999, layout, 2000), 0);
  assert.equal(clampScrollY(-9999, layout, 2000), 0);
});

// ---- visibleBandPlacements / bandIdAtY: 循環なし ----
test('visibleBandPlacements: scrollYMm分だけ単純に平行移動する（循環しない）', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  const result = visibleBandPlacements(layout, 300, 1500);
  assert.deepEqual(result, [
    { roomId: 'a', topMm: -300, heightMm: 1000 },
    { roomId: 'b', topMm: 900, heightMm: 1000 },
  ]);
});

test('visibleBandPlacements: 画面範囲外の帯は含まれず、複製（±contentHeightMm等）も作らない', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  // 下端いっぱいまでスクロールしても、先頭帯(a)の複製が下に現れてはいけない（循環廃止）。
  const maxScroll = clampScrollY(9999, layout, 1000);
  const result = visibleBandPlacements(layout, maxScroll, 1000);
  assert.equal(result.filter(p => p.roomId === 'a').length, 0, '循環していれば先頭帯aが複製されて現れてしまう');
  assert.equal(result.filter(p => p.roomId === 'b').length, 1);
});

test('bandIdAtY: scrollYMm分だけ単純に平行移動した座標で判定する（循環しない）', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  assert.equal(bandIdAtY(layout, 0, 500), 'a');
  assert.equal(bandIdAtY(layout, 0, 1300), 'b');
  assert.equal(bandIdAtY(layout, 0, 1100), null, '帯間のギャップはどの帯にも属さない');
  assert.equal(bandIdAtY(layout, 0, 99999), null, '画面外（循環しない）はどの帯にも属さない');
});

// ---- clampFaceOffset ----
// QA F1: 項目10「左三角揃え」のため、帯幅が画面に収まる場合の既定は「中央寄せ」(旧F9)ではなく
// 「minX(=左三角の位置)にクランプ」に変更した（意図的変更。elevationLayout.jsのヘッダコメント参照）。
test('【QA F1】clampFaceOffset: 帯幅が画面幅より狭ければminXにクランプする（中央寄せではない）', () => {
  const v = clampFaceOffset(9999, { widthMm: 3000 }, 5000);
  assert.equal(v, 0, 'bounds省略時のminXは0。収まる帯でも中央寄せせずminXへクランプする');
});

test('clampFaceOffset: 帯幅が画面幅より広ければ[0, widthMm-viewWidthMm]にクランプする', () => {
  assert.equal(clampFaceOffset(-500, { widthMm: 8000 }, 5000), 0);
  assert.equal(clampFaceOffset(99999, { widthMm: 8000 }, 5000), 3000);
  assert.equal(clampFaceOffset(1200, { widthMm: 8000 }, 5000), 1200);
});

// ---- QA F9: bounds.minXが0でない帯（天井高寸法がface[0]の左端よりさらに左へ張り出す）----
test('【QA F9】clampFaceOffset: bounds.minXが負（例:-330）でも、収まらない帯はminXまでスクロールでき0で頭打ちにならない', () => {
  // 帯幅(maxX-minX)=8000、画面幅5000（収まらない）。旧実装は[0, widthMm-viewWidthMm]=[0,3000]に
  // クランプしており、minX=-330にあるCH寸法へは絶対に到達できなかった。
  const band = { bounds: { minX: -330, maxX: 7670 } }; // widthMm=8000
  assert.equal(clampFaceOffset(-9999, band, 5000), -330, 'minXより左には行けないが、minXまでは到達できる');
  assert.equal(clampFaceOffset(99999, band, 5000), 2670, 'maxX-viewWidthMmで頭打ち');
});

// QA F1: 旧仕様（(minX+maxX)/2基準の中央寄せ）を項目10のため廃止し、収まる帯もminXに
// クランプするよう変更した（意図的変更）。faceOffsetForはband.leftAnchorX（=通常minXと一致する
// 左三角の位置）をoffsetMmとして渡すため、この分岐がminXを返すことで全帯の左揃えが成立する。
test('【QA F1】clampFaceOffset: 帯幅が画面に収まる場合もminXにクランプする（中央寄せしない。項目10）', () => {
  const band = { bounds: { minX: -330, maxX: 2670 } }; // widthMm=3000
  const v = clampFaceOffset(0, band, 5000);
  assert.equal(v, -330, '収まる帯でもminXへクランプされ、中央寄せの位置(旧仕様)にはならないはず');
});

// ---- QA F1: 帯の実描画範囲は placement.topMm..topMm+heightMm と一致し、連続帯の間隔は
// bounds.minY の違い（天井高が異なる部屋同士）に関わらず正確にBAND_GAP_MMだけ空く ----
test('【QA F1】bandContentOriginMm: 実描画範囲(topMm+minY..topMm+maxY)がスロットと一致し、連続帯の間隔はBAND_GAP_MMちょうど', () => {
  // CH2400相当の帯(minY=-2400)とCH3600相当の帯(minY=-3600)。maxYは共通500（部屋名枠等）と仮定。
  const bandA = { roomId: 'a', heightMm: 2900, bounds: { minY: -2400, maxY: 500 } };
  const bandB = { roomId: 'b', heightMm: 4100, bounds: { minY: -3600, maxY: 500 } };
  const layout = layoutBands([bandA, bandB], BAND_GAP_MM);
  const [placA, placB] = layout.placements;

  const originA = bandContentOriginMm(placA, bandA);
  const originB = bandContentOriginMm(placB, bandB);

  const renderedTopA = originA + bandA.bounds.minY;
  const renderedBottomA = originA + bandA.bounds.maxY;
  const renderedTopB = originB + bandB.bounds.minY;

  // 現行ElevationLayer.jsx相当の「旧ロジック」（minYを無視してtopMmをそのままy=0に対応させる。
  // ≒bandContentOriginMmをplacement.topMmだけ返す実装に戻すのと同義）だと、
  // renderedTopA===placA.topMm+bandA.bounds.minY!==placA.topMmとなり以下は赤になる
  // （本番シンボルbandContentOriginMmを直接呼んでいるため、この後退で確実に検出できる）。
  assert.equal(renderedTopA, placA.topMm, '帯Aの実描画範囲の上端はスロット上端(topMm)と一致するはず');
  assert.equal(renderedBottomA, placA.topMm + placA.heightMm, '帯Aの実描画範囲の下端はスロット下端と一致するはず');
  assert.equal(renderedTopB, placB.topMm, '帯Bの実描画範囲の上端はスロット上端(topMm)と一致するはず');
  const gap = renderedTopB - renderedBottomA;
  assert.ok(Math.abs(gap - BAND_GAP_MM) < 1e-9,
    `連続帯の実描画範囲の間隔はBAND_GAP_MM(${BAND_GAP_MM})ちょうどのはず（実際:${gap}。minYの違いに引きずられていないか）`);
});

// ---- 失敗系: 帯が0件 ----
test('【失敗系】layoutBands/visibleBandPlacements/clampScrollY: 帯が0件なら空配列・contentHeightMm=0で例外を投げない', () => {
  const layout = layoutBands([]);
  assert.equal(layout.contentHeightMm, 0);
  assert.deepEqual(visibleBandPlacements(layout, 0, 1000), []);
  assert.equal(bandIdAtY(layout, 0, 500), null);
  assert.equal(clampScrollY(500, layout, 1000), 0);
});

// ---- miterTriangleVertices: 部屋範囲の留め三角（直角三角形）の頂点座標 ----
test('miterTriangleVertices: outerからtopへ真上heightPx、innerへ底辺沿いdir方向にheightPx/tan(angle)進む', () => {
  const heightPx = 10, angleDeg = 60;
  const v = miterTriangleVertices(100, 200, 1, heightPx, angleDeg);
  const expectedBase = heightPx / Math.tan((angleDeg * Math.PI) / 180);
  assert.deepEqual(v.outer, [100, 200]);
  assert.deepEqual(v.top, [100, 200 - heightPx], 'topはouterの真上(y減少)');
  assert.ok(Math.abs(v.inner[0] - (100 + expectedBase)) < 1e-9, `innerのxはouter+底辺幅のはず（実際:${v.inner[0]}）`);
  assert.equal(v.inner[1], 200, 'innerはouterと同じy（底辺=引出線上）');
});

test('miterTriangleVertices: dir=-1では底辺がouterから左（x減少方向）へ伸びる', () => {
  const v = miterTriangleVertices(100, 200, -1, 10, 60);
  assert.ok(v.inner[0] < 100, `dir=-1ではinner.xはouter.xより小さいはず（実際:${v.inner[0]}）`);
});

// ---- 失敗系: heightPx=0は退化三角形（3頂点が同一y）になるが例外を投げない ----
test('【失敗系】miterTriangleVertices: heightPx=0でも例外を投げず、top/inner/outerが同じyになる', () => {
  const v = miterTriangleVertices(0, 0, 1, 0, 60);
  assert.equal(v.top[1], 0);
  assert.equal(v.inner[1], 0);
  assert.equal(v.inner[0], 0);
});

// ---- verticalDimLabelBox: 天井高寸法の縦書き回転（反時計回り90°）配置 ----
test('verticalDimLabelBox: rotation=-90（CCW90°）・寸法線の左側（x<lineX）に配置される', () => {
  const box = verticalDimLabelBox(500, 300);
  assert.equal(box.rotation, -90);
  assert.ok(box.x < 500, `寸法線(x=500)より左に配置されるはず（実際:${box.x}）`);
  assert.equal(box.y, 300, '寸法線の中点yと同じ高さに配置される');
  assert.equal(box.offsetX, box.width / 2);
  assert.equal(box.offsetY, box.height / 2);
});
