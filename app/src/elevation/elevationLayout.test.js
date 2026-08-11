// elevationLayout.js の不変条件テスト（.claude/elevation-model.md §3.3 I7・I8）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseElevationScale, layoutBands, wrapOffset, visibleBandPlacements, bandIdAtY, clampFaceOffset,
  bandContentOriginMm,
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

// ---- layoutBands / wrapOffset 基本 ----
test('layoutBands: 帯を縦に積み、周期は最後の帯の下端＋帯間になる', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 2000 }], 100);
  assert.deepEqual(layout.placements, [
    { roomId: 'a', topMm: 0, heightMm: 1000 },
    { roomId: 'b', topMm: 1100, heightMm: 2000 },
  ]);
  assert.equal(layout.totalMm, 3200);
});

test('wrapOffset: 負のオフセット・totalMmを超える値も[0,totalMm)へ正規化する', () => {
  assert.equal(wrapOffset(-100, 1000), 900);
  assert.equal(wrapOffset(1500, 1000), 500);
  assert.equal(wrapOffset(500, 1000), 500);
});

// ---- I8: 周期性 visibleBandPlacements(l,o)===visibleBandPlacements(l,o+totalMm) ----
test('visibleBandPlacements: offsetMmはtotalMmを法として周期的', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  const a = visibleBandPlacements(layout, 350, 1500);
  const b = visibleBandPlacements(layout, 350 + layout.totalMm, 1500);
  assert.deepEqual(a, b);
});

test('visibleBandPlacements: 負オフセットも正しく処理する', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  const a = visibleBandPlacements(layout, -layout.totalMm + 350, 1500);
  const b = visibleBandPlacements(layout, 350, 1500);
  assert.deepEqual(a, b);
});

test('visibleBandPlacements: o=totalMm-εでは先頭帯が画面下端付近に折り返して現れる', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  const eps = 1;
  const result = visibleBandPlacements(layout, layout.totalMm - eps, 2500);
  const first = result.find(p => p.roomId === 'a' && p.topMm > 0);
  assert.ok(first, '先頭帯(a)が正のtopMmで現れるはず');
  assert.ok(Math.abs(first.topMm - eps) < 1e-6, `先頭帯は画面上端から${eps}mmの位置に来るはず（実際:${first?.topMm}）`);
});

test('bandIdAtY: 周期内の座標から所属する帯のroomIdを返す', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  assert.equal(bandIdAtY(layout, 0, 500), 'a');
  assert.equal(bandIdAtY(layout, 0, 1300), 'b');
  assert.equal(bandIdAtY(layout, 0, 1100), null, '帯間のギャップはどの帯にも属さない');
});

// ---- clampFaceOffset ----
test('clampFaceOffset: 帯幅が画面幅より狭ければ中央寄せの1点にクランプする', () => {
  const v = clampFaceOffset(9999, { widthMm: 3000 }, 5000);
  assert.equal(v, -1000);
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

test('【QA F9】clampFaceOffset: 帯幅が画面に収まる場合は(minX+maxX)/2基準で中央寄せする', () => {
  const band = { bounds: { minX: -330, maxX: 2670 } }; // widthMm=3000
  const v = clampFaceOffset(0, band, 5000);
  assert.equal(v, -330 - (5000 - 3000) / 2, 'minX基準の中央寄せになっているはず');
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

  // 現行ElevationLayer.jsx:29相当の「旧ロジック」（minYを無視してtopMmをそのままy=0に対応させる。
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

// ---- QA F8: 描画上端が0より上・下端が0より下になるオフセットで帯がvisibleBandPlacementsに含まれる ----
// 注: -totalMmシフト自体は、layoutBandsが「各帯の直後に必ずgapMm(>0)を積む」実装である限り
// 数学的に到達不能（あらゆる帯についてtopMm+heightMm < totalMm-gapMm < totalMmが恒に成立するため、
// shift=-totalMmの候補が[-heightMm,viewHeightMm)へ入ることは無い）。削除はせず(QA F8指示)、
// 対称性の保険として残す。以下は要求された「上端が0より上・下端が0より下」のシナリオの回帰テスト
// （-totalMm分岐固有ではなくshift=0で満たされる。数学的な証明ゆえ正直にそう記す）。
test('【QA F8】visibleBandPlacements: 描画上端が0より上・下端が0より下になる帯が含まれる', () => {
  const layout = layoutBands([{ roomId: 'a', heightMm: 1000 }, { roomId: 'b', heightMm: 1000 }], 200);
  // 帯bの中央あたりに視点が来るようスクロールする（topMm=1200のbが画面をまたぐ）。
  const offsetMm = 1200 + 500; // bの上端から500mm分スクロールし、bが上端0をまたぐ
  const result = visibleBandPlacements(layout, offsetMm, 2000);
  const b = result.find(p => p.roomId === 'b');
  assert.ok(b, '帯bが可視配置に含まれるはず');
  assert.ok(b.topMm < 0 && b.topMm + b.heightMm > 0, `帯bの描画範囲が0をまたぐはず（実際:top=${b.topMm}）`);
});

// ---- 失敗系: 帯が0件 ----
test('【失敗系】layoutBands/visibleBandPlacements: 帯が0件なら空配列・totalMm=0で例外を投げない', () => {
  const layout = layoutBands([]);
  assert.equal(layout.totalMm, 0);
  assert.deepEqual(visibleBandPlacements(layout, 0, 1000), []);
  assert.equal(bandIdAtY(layout, 0, 500), null);
});
