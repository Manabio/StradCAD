// elevationStyle.js の不変条件テスト（.claude/elevation-model.md §3.3 I9）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLineWeightsPx, DEFAULT_PX_PER_MM } from '../viewport.js';
import {
  ElevationLineRole, weightForRole,
  TRIANGLE_ANGLE_DEG, TRIANGLE_HEIGHT_SCREEN_MM, FACE_GAP_SCREEN_MM,
  MIN_FACE_PX, drawLimitMm, visibleFaceMm, kneeCapFaceMm, kneeCapBottomMm, KNEE_CAP_FACE_MM,
  faceGapLimitMm, strokePxOf,
} from './elevationStyle.js';

// ---- 見付1px保証（ユーザー指示2026-09）: 表示倍率から描画限界を1つ定め、それ未満の見付は限界まで広げる ----
test('drawLimitMm: 描画限界は余白MIN_FACE_PX(1px)＋両線幅の半分に相当するmm。30mm=1pxの倍率・線幅0なら30mm', () => {
  assert.equal(MIN_FACE_PX, 1);
  assert.equal(drawLimitMm(1 / 30), 30);
  // 線幅を加味: 細線1px＋中線2px → 中心間 1+(1+2)/2 = 2.5px = 75mm（余白がちょうど1px）
  assert.equal(drawLimitMm(1 / 30, 3), 75);
});

test('faceGapLimitMm/strokePxOf: 線幅表(lineWeightsPx)から両線の太さを引いて余白1pxの中心間距離にする', () => {
  const lw = { thin: 1, medium: 2, thick: 3 };
  assert.equal(strokePxOf('medium', lw), 2);
  assert.equal(strokePxOf('medium', null), 0, '表が無ければ線幅0（余白のみ）');
  assert.equal(strokePxOf('unknown', lw), 0);
  assert.equal(faceGapLimitMm(1 / 30, lw, 'thin', 'medium'), 75);
  assert.equal(faceGapLimitMm(1 / 30, lw, 'thick', 'thin'), 90);
  assert.equal(faceGapLimitMm(1 / 30, null, 'thin', 'medium'), 30, '表なしは従来どおり中心間1px');
  assert.equal(faceGapLimitMm(undefined, lw, 'thin', 'medium'), 0, 'scale不明は限界0');
});

test('【失敗系】drawLimitMm: scale未指定(undefined/null)・0・負値は限界0（モデル寸法のまま）', () => {
  for (const s of [undefined, null, 0, -1]) assert.equal(drawLimitMm(s), 0, `scale=${s}`);
});

test('visibleFaceMm: 30mm=1pxの倍率で、20mmは1px(=30mm)に広がり、60mmは2px(=60mm)のまま', () => {
  const scale = 1 / 30;
  assert.equal(visibleFaceMm(20, scale), 30);
  assert.equal(visibleFaceMm(30, scale), 30);
  assert.equal(visibleFaceMm(60, scale), 60);
  assert.equal(visibleFaceMm(20, undefined), 20, 'scale不明なら広げない');
});

test('kneeCapFaceMm/kneeCapBottomMm: 腰壁天端は中線（天端）が高さを守り、細線が1px保証後の見付ぶん下がる', () => {
  assert.equal(kneeCapFaceMm(undefined), KNEE_CAP_FACE_MM, 'scale不明は作図値50のまま');
  assert.equal(kneeCapFaceMm(1 / 100), 100, '1/100(px/mm)では50mm<1pxなので100mm(=1px)へ');
  assert.equal(kneeCapBottomMm(800, 1 / 100), 700);
  assert.equal(kneeCapBottomMm(800, 1), 800 - KNEE_CAP_FACE_MM, '1px/mmでは50mm=50pxなのでそのまま');
  assert.equal(kneeCapBottomMm(90, 1 / 100), null, '天端90mmは1px保証後の見付100mmに満たない退化指定');
  // 線幅を加味: 天端が太線3px・下端が細線1px → 中心間 1+(3+1)/2 = 3px = 300mm(1/100)
  const lw = { thin: 1, medium: 2, thick: 3 };
  assert.equal(kneeCapFaceMm(1 / 100, lw, 'thick'), 300);
  assert.equal(kneeCapFaceMm(1 / 100, lw, 'medium'), 250, '見えがかりの天端（中線）なら 1+(2+1)/2=2.5px');
  assert.equal(kneeCapBottomMm(800, 1 / 100, lw, 'thick'), 500);
});

// ---- I9: px(CUT) > px(SILHOUETTE) > px(DETAIL)（校正値ベース固定pxで） ----
test('weightForRole: CUT>SILHOUETTE>DETAILの順にpxが太くなる（viewport.lineWeightsPx適用）', () => {
  const px = resolveLineWeightsPx(DEFAULT_PX_PER_MM);
  const cutPx        = px[weightForRole(ElevationLineRole.CUT)];
  const silhouettePx = px[weightForRole(ElevationLineRole.SILHOUETTE)];
  const detailPx     = px[weightForRole(ElevationLineRole.DETAIL)];
  assert.ok(cutPx > silhouettePx, `CUT(${cutPx})はSILHOUETTE(${silhouettePx})より太いはず`);
  assert.ok(silhouettePx > detailPx, `SILHOUETTE(${silhouettePx})はDETAIL(${detailPx})より太いはず`);
});

test('weightForRole: CUT=thick / SILHOUETTE=medium / DETAIL=thin に対応する', () => {
  assert.equal(weightForRole(ElevationLineRole.CUT), 'thick');
  assert.equal(weightForRole(ElevationLineRole.SILHOUETTE), 'medium');
  assert.equal(weightForRole(ElevationLineRole.DETAIL), 'thin');
});

// ---- 失敗系: 未知roleはthin（安全側フォールバック） ----
test('【失敗系】weightForRole: 未知のroleはthin（細線）にフォールバックする', () => {
  assert.equal(weightForRole('unknown'), 'thin');
  assert.equal(weightForRole(undefined), 'thin');
});

// ---- QA G3: スクリーン固定サイズ定数はユーザー仕様値そのもの（.jsx配線経由でしかテストできない
// 領域のため、定数そのものをここでピン留めする。値が変異しても.jsx側のテストは無いため
// 480緑のまま検出できなかった回帰の再発防止）----
test('【QA G3】TRIANGLE_ANGLE_DEG/TRIANGLE_HEIGHT_SCREEN_MM/FACE_GAP_SCREEN_MMはユーザー仕様値のまま', () => {
  assert.equal(TRIANGLE_ANGLE_DEG, 60, '留め三角: 底辺と斜辺のなす角は60度（ユーザー仕様）');
  assert.equal(TRIANGLE_HEIGHT_SCREEN_MM, 10, '留め三角の高さは実画面10mm（ユーザー仕様）');
  assert.equal(FACE_GAP_SCREEN_MM, 30, '隣接展開図の壁芯間隔は実画面30mm（ユーザー仕様）');
});
