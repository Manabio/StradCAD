// ================================================================
// クリップ矩形による経路の選別（純関数）。ページ座標（pt・左上原点）の経路列と矩形 {x,y,w,h}。
// 線分を切り取らない。矩形に線分が 1 本でも掛かる（矩形内に端点がある・矩形の辺と交わる）経路を丸ごと採る
// （クリップは「どの図を採るか」の選別であって、図形の切り抜きではない）。矩形の外を通るだけの経路は捨てる。
// ================================================================

/** 有限で幅・高さが正の矩形か。 */
export function isValidClip(clip) {
  return !!clip && [clip.x, clip.y, clip.w, clip.h].every(Number.isFinite) && clip.w > 0 && clip.h > 0;
}

// Liang–Barsky: 線分 a→b が矩形 [x0,x1]×[y0,y1]（境界を含む）と共有点を持つか。
function segmentTouchesRect(a, b, x0, y0, x1, y1) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges = [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
  }
  return true;
}

/**
 * @param {{segments: {a:{x,y}, b:{x,y}}[], bbox: object}[]} paths ページ座標
 * @param {{x:number, y:number, w:number, h:number}} clip ページ座標（pt）
 * @returns {object[]} 矩形に掛かる経路（元の順序）
 */
export function selectPathsInClip(paths, clip) {
  if (!isValidClip(clip)) return [];
  const x1 = clip.x + clip.w;
  const y1 = clip.y + clip.h;
  return paths.filter(path => {
    const { bbox } = path;
    if (bbox.maxX < clip.x || bbox.minX > x1 || bbox.maxY < clip.y || bbox.minY > y1) return false;
    return path.segments.some(({ a, b }) => segmentTouchesRect(a, b, clip.x, clip.y, x1, y1));
  });
}
