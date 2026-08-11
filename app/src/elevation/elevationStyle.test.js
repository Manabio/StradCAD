// elevationStyle.js の不変条件テスト（.claude/elevation-model.md §3.3 I9）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLineWeightsPx, DEFAULT_PX_PER_MM } from '../viewport.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

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
