// elevationStyle.js の不変条件テスト（.claude/elevation-model.md §3.3 I9）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLineWeightsPx, DEFAULT_PX_PER_MM } from '../viewport.js';
import {
  ElevationLineRole, weightForRole,
  TRIANGLE_ANGLE_DEG, TRIANGLE_HEIGHT_SCREEN_MM, FACE_GAP_SCREEN_MM,
} from './elevationStyle.js';

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
