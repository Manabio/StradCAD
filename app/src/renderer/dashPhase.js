/**
 * 破線パターンと、一点鎖線の位相合わせ（純モジュール。react-konva非依存＝node:testから単体import可）。
 *
 * ユーザー明示指示2026-08その9「展開の一点鎖線が寸法線と交点をとるように調整。図面内で
 * 一点鎖線は統一」。canvas/Konvaの破線は既定で**線の始点から**位相が始まるため、線の端や交点が
 * たまたま切れ目に当たると「交点が取れていない」ように見える。線上の基準点（寸法線の段）を
 * 常に**長い破線の中央**へ合わせることで、
 *   - 交点: 基準点に必ずインクが乗る（寸法線と一点鎖線が確実に交差して見える）
 *   - 統一: 同じ基準点を共有する線同士の位相が揃い、図面内で目が揃う
 * の両方を満たす。
 */

/** 一点鎖線（図面内で唯一のパターン。px）。 */
export const DASH_CENTER = [16, 4, 4, 4];
/** 破線（アキの向こう側等。px）。 */
export const DASH_DASHED = [8, 4];

export const DASH_CENTER_PERIOD = DASH_CENTER.reduce((a, b) => a + b, 0);

/**
 * 基準点を長い破線の中央へ合わせる dashOffset(px)。
 * canvasの`lineDashOffset`は「パターンのどこから描き始めるか」＝始点から距離sの位相が
 * `(s + dashOffset) % period` になる規約のため、`phase(dist) = DASH_CENTER[0]/2` を解く。
 * @param {number} distPx - 線の始点から基準点までの距離(px)
 * @returns {number|undefined} 有限でなければ undefined（呼び出し側は既定位相のまま）
 */
export function centerDashOffsetPx(distPx) {
  if (!Number.isFinite(distPx)) return undefined;
  const off = (DASH_CENTER[0] / 2 - distPx) % DASH_CENTER_PERIOD;
  return off < 0 ? off + DASH_CENTER_PERIOD : off;
}

/**
 * 距離sの位置にインクが乗るか（テスト・検証用の単一情報源）。
 * @param {number} s - 始点からの距離(px)
 * @param {number} dashOffset
 * @returns {boolean}
 */
export function hasInkAt(s, dashOffset = 0) {
  const phase = ((s + dashOffset) % DASH_CENTER_PERIOD + DASH_CENTER_PERIOD) % DASH_CENTER_PERIOD;
  let cursor = 0;
  for (const [i, len] of DASH_CENTER.entries()) {
    if (phase < cursor + len) return i % 2 === 0; // 偶数index=インク・奇数index=すき間
    cursor += len;
  }
  return false;
}
