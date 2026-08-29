/**
 * 軸平行矩形に対する線分クリップ・点内外判定（純関数）。
 *
 * 「範囲内かどうかを中点で採否する」フィルタと「範囲の境界で線分を切る」クリップは別物で、
 * 前者では境界をまたぐ線分が全長そのまま残る（描画が境界を突き抜ける）。可視範囲を持つ
 * 描画は必ずクリップ側を使うこと——階段の破れ先破線が上階スラブ開口の縁を突き抜けた不良の原因。
 * 点プリミティブ（段数字など）だけが `pointInRects` の対象になる。
 *
 * store.js / snap.js / .jsx に依存しない（node:test から単体 import 可）。
 */

const EPS = 1e-6;

/** 点 (px,py) が矩形群のいずれかに含まれるか（境界を含む）。 */
export function pointInRects(rects, px, py) {
  return rects.some(r => r.x1 <= px && px <= r.x2 && r.y1 <= py && py <= r.y2);
}

/**
 * 線分を軸平行矩形でクリップする（Liang–Barsky）。矩形の内側に残る部分を返す。
 * 完全に外側、または境界を掠めて点に退化する場合は null。
 * 付随プロパティ（thin/side/port 等）は保持する。
 * @param {{x1:number,y1:number,x2:number,y2:number}} s
 * @param {{x1:number,y1:number,x2:number,y2:number}} r
 */
export function clipSegmentToRect(s, r) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  let t0 = 0, t1 = 1;
  // p<0 は「境界へ入る側」、p>0 は「出る側」。p≈0 は境界に平行（q<0 なら範囲外で棄却）。
  const narrow = (p, q) => {
    if (Math.abs(p) < EPS) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else       { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!narrow(-dx, s.x1 - r.x1)) return null;
  if (!narrow( dx, r.x2 - s.x1)) return null;
  if (!narrow(-dy, s.y1 - r.y1)) return null;
  if (!narrow( dy, r.y2 - s.y1)) return null;
  if (t1 - t0 <= EPS) return null;
  return {
    ...s,
    x1: s.x1 + dx * t0, y1: s.y1 + dy * t0,
    x2: s.x1 + dx * t1, y2: s.y1 + dy * t1,
  };
}

/**
 * 線分の配列を矩形群でクリップする。矩形が隣接していれば、跨ぐ線分は接する複数の断片になる
 * （描画上は連続して見える）。
 * rects が空／未指定なら安全側でクリップしない（範囲が導出できていない＝描画を消さない）。
 */
export function clipSegmentsToRects(segs, rects) {
  if (!rects?.length) return segs;
  const out = [];
  for (const s of segs) {
    for (const r of rects) {
      const c = clipSegmentToRect(s, r);
      if (c) out.push(c);
    }
  }
  return out;
}
