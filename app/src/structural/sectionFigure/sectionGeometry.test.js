// makeTransform の逆変換（mmX・mmY。部分詳細図ヘルパーのプレビュー上の矩形選択が画面の点を図の座標へ戻すのに使う）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTransform, FIGURE_MARGIN_PX } from './sectionGeometry.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const BOUNDS = { minX: -120, minY: 40, width: 800, height: 500 };

test('makeTransform: mmX(tx(v)) ＝ v・mmY(ty(v)) ＝ v（左端・中央・右端、縮尺 1/10 と 1/100）', () => {
  for (const scale of [1 / 10, 1 / 100]) {
    const t = makeTransform(BOUNDS, scale);
    for (const v of [BOUNDS.minX, BOUNDS.minX + BOUNDS.width / 2, BOUNDS.minX + BOUNDS.width]) approx(t.mmX(t.tx(v)), v);
    for (const v of [BOUNDS.minY, BOUNDS.minY + BOUNDS.height / 2, BOUNDS.minY + BOUNDS.height]) approx(t.mmY(t.ty(v)), v);
  }
});

test('makeTransform: 余白の位置の px は bounds の左上の mm に戻る（px 0 は余白ぶん手前）。既存の項目は不変', () => {
  const t = makeTransform(BOUNDS, 1 / 10);
  approx(t.mmX(FIGURE_MARGIN_PX), BOUNDS.minX);
  approx(t.mmY(FIGURE_MARGIN_PX), BOUNDS.minY);
  approx(t.mmX(0), BOUNDS.minX - FIGURE_MARGIN_PX * 10);
  approx(t.tx(BOUNDS.minX), FIGURE_MARGIN_PX);
  approx(t.sx(100), 10);
  approx(t.pxWidth, BOUNDS.width / 10 + 2 * FIGURE_MARGIN_PX);
});
