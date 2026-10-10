/**
 * 天井区画の形状から天井面の高さ関数を作る（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 見上げの天井立体（plan/planSolids.js ceilingSolids）が、勾配のある立体として zAt を付けるときに使う（下屋 roofSolids と同じ経路）。
 *
 * 基準は面の矩形群の外接矩形 B。baseZ＝基準高の絶対 z（層の FL＋床段差＋基準高）。
 *   flat : zAt なし・zLo = zHi = baseZ
 *   slope: 上がる向き（度。y 下向き座標で 0=+x 右・90=+y 下・180=左・270=上）の軸上の座標を B で正規化した u∈[0,1]（上がる側が 1）、
 *          z = baseZ + ライズ × u。zLo = baseZ・zHi = baseZ + ライズ。B の外の点は端の値にクランプ。
 *   arc・dome: S6b で幾何を足す。当面は flat と同じ扱い（関数の口は4形状で揃える）。
 * 矩形が無い・B が潰れている・寸法が形状に合わない場合も flat と同じ（例外にしない）。
 */
import { validCeilingDims } from '../core/ceilingZone.js';
import { CeilingShape } from '../core/constants.js';
import { chevronPoints } from '../renderer/chevron.js';
import { ROOF_LABEL_FONT_MM, ROOF_LABEL_ARROW_MM, ROOF_LABEL_GAP_MM, ROOF_LABEL_HEAD_MM, estimatedTextWidth } from '../finish/roof/roofPlanFigure.js';

/**
 * @param {{shape: string, dims: number[], baseZ: number, rects: Array<{x1:number,y1:number,x2:number,y2:number}>}} p
 * @returns {{zLo: number, zHi: number, zAt: ((x:number, y:number) => number)|null}}
 */
export function ceilingShapeSolidZ({ shape, dims, baseZ, rects }) {
  const flat = { zLo: baseZ, zHi: baseZ, zAt: null };
  if (shape !== CeilingShape.SLOPE || !validCeilingDims(shape, dims) || !Array.isArray(rects) || rects.length === 0) return flat;
  const x1 = Math.min(...rects.map(r => r.x1)), x2 = Math.max(...rects.map(r => r.x2));
  const y1 = Math.min(...rects.map(r => r.y1)), y2 = Math.max(...rects.map(r => r.y2));
  const [rise, dir] = dims;
  const alongX = dir === 0 || dir === 180;
  const lo = alongX ? x1 : y1, hi = alongX ? x2 : y2;
  if (!(hi - lo > 0)) return flat;
  const reverse = dir === 180 || dir === 270; // 上がる側が座標の小さい側
  const zAt = (x, y) => {
    const t = ((alongX ? x : y) - lo) / (hi - lo);
    const u = Math.min(Math.max(reverse ? 1 - t : t, 0), 1);
    return baseZ + rise * u;
  };
  return { zLo: baseZ, zHi: baseZ + rise, zAt };
}

const UP_VECTOR = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

/** 面積最大の矩形（同面積は y1→x1 の小さい方）。 */
function largestRect(rects) {
  let best = null, bestArea = -1;
  for (const r of rects) {
    const a = (r.x2 - r.x1) * (r.y2 - r.y1);
    if (a > bestArea + 1e-6 || (Math.abs(a - bestArea) <= 1e-6 && (r.y1 < best.y1 || (r.y1 === best.y1 && r.x1 < best.x1)))) { best = r; bestArea = a; }
  }
  return best;
}

/**
 * 平面以外の形状の面に付ける注記（見上げの詳細 LOD だけ。detailOnly:true の arrow・text）。planSolids の Solid.marks と同じ形。
 * 基準点＝面積最大の矩形の中心。傾斜は**上がる向き**の矢印（階段の上り矢印と同じ向き。下屋は水下向き）と
 * 「傾斜 CH低い側〜高い側」（roomMetrics.js の傾斜 CH 表記と同じ「〜」）。寸法・矢じりは下屋の傾斜ラベルと共通
 * （ROOF_LABEL_*・chevronPoints）。平面・矩形なし・寸法が形状に合わないときは []。円弧・ドームは S6b。
 * @param {{key: string, shape: string, dims: number[], chMm: number, rects: Array<object>}} p  key は prim の key の接頭辞
 * @returns {Array<{anchor: {x: number, y: number}, prims: Array<object>}>}
 */
export function ceilingShapeMarks({ key, shape, dims, chMm, rects }) {
  if (shape !== CeilingShape.SLOPE || !validCeilingDims(shape, dims) || !Array.isArray(rects) || rects.length === 0 || !Number.isFinite(chMm)) return [];
  const r = largestRect(rects);
  const a = { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
  const [dx, dy] = UP_VECTOR[dims[1]];
  const L = ROOF_LABEL_ARROW_MM, F = ROOF_LABEL_FONT_MM, G = ROOF_LABEL_GAP_MM;
  const points = [a.x - (dx * L) / 2, a.y - (dy * L) / 2, a.x + (dx * L) / 2, a.y + (dy * L) / 2];
  const text = `傾斜 CH${Math.round(chMm)}〜${Math.round(chMm + dims[0])}`;
  // 縦の矢印は右隣、横の矢印は下に文字を置く（文字は常に横書き。x,y は文字の左上）
  const at = dx === 0 ? { x: a.x + G, y: a.y - F / 2 } : { x: a.x - estimatedTextWidth(text, F) / 2, y: a.y + G };
  return [{
    anchor: a,
    prims: [
      { kind: 'arrow', key: `${key}:arrow`, points, head: chevronPoints(points, ROOF_LABEL_HEAD_MM), detailOnly: true },
      { kind: 'text', key: `${key}:text`, ...at, text, fontSizeMm: F, detailOnly: true },
    ],
  }];
}
