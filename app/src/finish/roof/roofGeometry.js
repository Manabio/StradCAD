/**
 * 屋根の範囲の幾何（純関数。store.js / snap.js / .jsx を静的 import しない）。ステップ B2。
 */

const EPS = 1e-6;

function uniqueSorted(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

/**
 * 屋根範囲の「短手」(mm)。範囲に内接する全ての軸平行な矩形の短辺の最大。セルの分割の取り方には
 * 依存しない（L字は2本の腕のうち太い方の幅）。離れた成分はそれぞれ独立に測り、その最大を返す。
 * 空・面積0だけなら 0。
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} boundsList セルの矩形（cellBoundsList の結果）
 * @returns {number}
 */
export function roofShortSpanMm(boundsList) {
  const rects = (boundsList ?? []).filter(b => b && b.x2 - b.x1 > EPS && b.y2 - b.y1 > EPS);
  if (rects.length === 0) return 0;

  const xs = uniqueSorted(rects.flatMap(b => [b.x1, b.x2]));
  const ys = uniqueSorted(rects.flatMap(b => [b.y1, b.y2]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const xIndex = v => xs.findIndex(x => Math.abs(x - v) <= EPS);
  const yIndex = v => ys.findIndex(y => Math.abs(y - v) <= EPS);

  // 座標圧縮した格子に塗る（filled[j][i]）
  const filled = Array.from({ length: ny }, () => new Array(nx).fill(0));
  for (const b of rects) {
    for (let j = yIndex(b.y1); j < yIndex(b.y2); j++) {
      for (let i = xIndex(b.x1); i < xIndex(b.x2); i++) filled[j][i] = 1;
    }
  }
  // 累積和（prefix[j][i] = 左上 (0,0) から (i-1,j-1) までの塗り数）
  const prefix = Array.from({ length: ny + 1 }, () => new Array(nx + 1).fill(0));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      prefix[j + 1][i + 1] = prefix[j][i + 1] + prefix[j + 1][i] - prefix[j][i] + filled[j][i];
    }
  }
  const filledCount = (i0, j0, i1, j1) => // 格子 [i0,i1) × [j0,j1) の塗り数
    prefix[j1][i1] - prefix[j0][i1] - prefix[j1][i0] + prefix[j0][i0];

  let best = 0;
  for (let j0 = 0; j0 < ny; j0++) {
    for (let j1 = j0 + 1; j1 <= ny; j1++) {
      const h = ys[j1] - ys[j0];
      if (h <= best) continue; // 短辺は h を超えられない
      for (let i0 = 0; i0 < nx; i0++) {
        for (let i1 = i0 + 1; i1 <= nx; i1++) {
          const w = xs[i1] - xs[i0];
          const short = Math.min(w, h);
          if (short <= best) continue;
          if (filledCount(i0, j0, i1, j1) === (i1 - i0) * (j1 - j0)) best = short;
        }
      }
    }
  }
  return best;
}
