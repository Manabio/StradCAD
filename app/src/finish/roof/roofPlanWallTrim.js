/**
 * 下屋の平面の線（軒先の線・棟木・隅木・谷木）の、壁に当たる端を外壁面で止める純モジュール。
 * 屋根範囲の辺は通り芯の上にあり、屋内に接する部分は出幅 0（壁の芯）で終わる。描かれている壁には厚みがあるので、
 * 線の端が壁の中へ食い込んで見える。端を壁の屋根側の外端（外壁面）まで戻す（ユーザー指示2026-10-04「軒先線・隅木・谷木は外壁面どまり」）。
 * 面は faceAt（差し替え可能。製品では finish/wallFaces.js outerWallFaceNear）が返す。壁が無ければ null＝端は通り芯のまま。
 * 縮める向きにだけ動かす（面が端より外側＝線を延ばす向きなら変えない）。store.js・snap.js・.jsx・react-konva を静的に import しない。
 *
 * 外形線（開いた折れ線）の端: 端は必ず隠した区間（屋内に接する区間）かその脇の段差の小辺に突き当たる。最後の線分に直交し
 * 端を通る直線を壁の直線とみなし、端に沿って面まで戻す。面は線が来る側（線の本体の側）。閉じた外形線は変えない。
 * 棟木・隅木・谷木の端: 端が屋内に接する区間（zeroZones）の直線の上（区間の範囲±tol）にあるときだけ、その壁の面まで線に沿って戻す。
 * 2つの区間の直線上にある端（建物の出隅）は戻る量の大きい方。戻すと長さが tol 以下になる線は捨てる。
 */

const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * 開いた外形線の片端を面まで戻した点列。変えないときは null。
 * @param {number[]} points x,y の並び（長さ4以上）
 * @param {boolean} atStart true なら先頭の点、false なら末尾の点
 */
function trimOutlineEnd(points, atStart, { faceAt, reachMm, tolMm }) {
  const n = points.length;
  const [ei, ni] = atStart ? [0, 2] : [n - 2, n - 4];
  const ex = points[ei], ey = points[ei + 1];
  const nx = points[ni], ny = points[ni + 1];
  const horizontal = Math.abs(ny - ey) <= tolMm && Math.abs(nx - ex) > tolMm; // 最後の線分が横＝壁の直線は縦（x=ex）
  const vertical = Math.abs(nx - ex) <= tolMm && Math.abs(ny - ey) > tolMm;
  if (!horizontal && !vertical) return null;
  const face = faceAt({
    isVertical: horizontal, coord: horizontal ? ex : ey, at: horizontal ? ey : ex,
    reachMm, outward: sign(horizontal ? nx - ex : ny - ey), // 線の本体の側
  });
  if (!Number.isFinite(face)) return null;
  const from = horizontal ? ex : ey;
  const body = horizontal ? nx : ny;
  const moved = face - from;
  if (sign(moved) !== sign(body - from) || Math.abs(moved) <= tolMm || Math.abs(moved) >= Math.abs(body - from) - tolMm) return null; // 縮める向きだけ・線分を潰さない
  const next = points.slice();
  next[horizontal ? ei : ei + 1] = face;
  return next;
}

/** 開いた外形線。両端を面まで戻す。 */
function trimOpenOutline(prim, ctx) {
  if (prim.closed || prim.points.length < 4) return prim;
  let points = prim.points;
  for (const atStart of [true, false]) points = trimOutlineEnd(points, atStart, ctx) ?? points;
  return points === prim.points ? prim : { ...prim, points };
}

/**
 * 線（棟木・隅木・谷木）の端 (px,py)（もう一方の端 (ox,oy)）が zeroZones の直線上にあるときに戻す割合（線の長さに対する割合。
 * 戻さないなら 0）。2つ以上の区間の上にあれば大きい方。
 */
function trimFraction(px, py, ox, oy, { faceAt, zeroZones, reachMm, tolMm }) {
  let best = 0;
  for (const z of zeroZones) {
    const across = z.isVertical ? px : py;
    const along = z.isVertical ? py : px;
    if (Math.abs(across - z.coord) > tolMm || along < z.lo - tolMm || along > z.hi + tolMm) continue;
    const d = z.isVertical ? ox - px : oy - py; // 壁に直交する成分
    const roofSide = -z.outward; // 区間の外側（outward）は屋内。屋根はその反対側
    if (Math.abs(d) <= tolMm || sign(d) !== roofSide) continue; // 壁に平行な線・屋内へ向かう線は対象外
    const face = faceAt({ isVertical: z.isVertical, coord: z.coord, at: along, reachMm, outward: roofSide });
    if (!Number.isFinite(face)) continue;
    const frac = (face - across) / d;
    if (frac > 0 && frac > best) best = frac;
  }
  return best;
}

/** 直線の棟木・隅木・谷木。両端を壁の面まで戻す。長さが tol 以下になれば null（捨てる）。 */
function trimStraight(prim, ctx) {
  if (prim.points.length !== 4) return prim;
  const [x1, y1, x2, y2] = prim.points;
  const a = trimFraction(x1, y1, x2, y2, ctx);
  const b = trimFraction(x2, y2, x1, y1, ctx);
  if (a === 0 && b === 0) return prim;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if ((1 - a - b) * len <= ctx.tolMm) return null;
  return { ...prim, points: [x1 + a * (x2 - x1), y1 + a * (y2 - y1), x2 + b * (x1 - x2), y2 + b * (y1 - y2)] };
}

/**
 * 下屋の平面の線の、壁に当たる端を外壁面で止める（入力は変えない）。
 * @param {Array<{kind:'line', role:'outline'|'ridge'|'hip'|'valley', points:number[], closed:boolean}>} primitives roofPlanFigure の線
 * @param {object} p
 * @param {(q:{isVertical:boolean, coord:number, at:number, reachMm:number, outward:1|-1})=>number|null} p.faceAt
 *   壁の外壁面（wallFaces.js outerWallFaceNear と同じ意味。無ければ null）
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1}>} p.zeroZones 屋内に接する区間
 * @param {number} p.reachMm 壁を探す距離（max(軒の出, 妻側の出)＋tol）
 * @param {number} p.tolMm 許容差
 * @returns {Array<object>} 端を戻した線（戻さない線は同じオブジェクト。長さが tol 以下になった線は含まない）
 */
export function trimRoofPlanLinesAtWalls(primitives, { faceAt, zeroZones, reachMm, tolMm }) {
  const ctx = { faceAt, zeroZones: zeroZones ?? [], reachMm, tolMm };
  const out = [];
  for (const prim of primitives) {
    if (prim.kind !== 'line') out.push(prim); // 文字・矢印（ラベル）は線の端止めの対象外
    else if (prim.role === 'outline') out.push(trimOpenOutline(prim, ctx));
    else {
      const trimmed = trimStraight(prim, ctx);
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}
