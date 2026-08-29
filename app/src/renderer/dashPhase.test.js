// 一点鎖線の位相合わせ（dashPhase.js）の回帰テスト。
// ユーザー明示指示2026-08その9「展開の一点鎖線が寸法線と交点をとるように調整。図面内で
// 一点鎖線は統一」——基準点（寸法行）に必ずインクが乗ること・位相が基準点で揃うことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DASH_CENTER, DASH_CENTER_PERIOD, centerDashOffsetPx, hasInkAt } from './dashPhase.js';

test('centerDashOffsetPx: 基準点には必ずインクが乗る（寸法線と交点が取れる）', () => {
  // 端で終わる線・途中で寸法行を横切る線の両方を想定し、距離を広く振る。
  for (let d = 0; d <= 200; d += 0.5) {
    assert.equal(hasInkAt(d, centerDashOffsetPx(d)), true, `距離${d}pxの基準点にインクが乗るはず`);
  }
});

test('centerDashOffsetPx: 基準点は長い破線の「中央」に来る（両側に等しい余白）', () => {
  const half = DASH_CENTER[0] / 2;
  for (const d of [0, 3.7, 16, 27.9, 28, 100.25]) {
    const off = centerDashOffsetPx(d);
    // 基準点の前後 half 未満はすべてインク、half をわずかに超えるとすき間。
    assert.equal(hasInkAt(d - half + 0.01, off), true);
    assert.equal(hasInkAt(d + half - 0.01, off), true);
    assert.equal(hasInkAt(d + half + 0.01, off), false, `基準点+${half}pxの先はすき間のはず`);
  }
});

test('centerDashOffsetPx: 同じ基準点を共有する線同士は位相が揃う（図面内の統一）', () => {
  // 始点の異なる2本でも、基準点からの相対位置が同じなら同じインク／すき間になる。
  const offA = centerDashOffsetPx(40);   // 基準点まで40pxの線
  const offB = centerDashOffsetPx(97.5); // 基準点まで97.5pxの線
  for (let k = -30; k <= 30; k += 0.5) {
    assert.equal(hasInkAt(40 + k, offA), hasInkAt(97.5 + k, offB),
      `基準点からの相対位置${k}pxで見え方が一致するはず`);
  }
});

test('centerDashOffsetPx: 返り値は周期内に正規化される／非有限はundefined', () => {
  for (const d of [0, 1, 27, 28, 1000, -5]) {
    const off = centerDashOffsetPx(d);
    assert.ok(off >= 0 && off < DASH_CENTER_PERIOD, `0..${DASH_CENTER_PERIOD}に正規化されるはず（実際:${off}）`);
  }
  assert.equal(centerDashOffsetPx(NaN), undefined);
  assert.equal(centerDashOffsetPx(Infinity), undefined);
});
