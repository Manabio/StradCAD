/**
 * 屋根伏せ図の線を、上にある屋根の軒先線（外形の閉路）で止める純モジュール（配置図 site/sitePlacementView.js roofPlanLines が使う）。
 * 隠れる側＝閉路の内側（境界上を含む）。線は閉路の辺との交点で区間に分け、中点が閉路の外にある区間だけ残す。
 * 上にある屋根が複数あるときは屋根ごとの閉路の組の和集合で隠す（組どうしは偶奇で打ち消し合わない。組の中の閉路は偶奇）。
 * store.js・snap.js・.jsx・structural/ を静的に import しない（node:test から単体で import できる）。
 * rings は region.outline と同じ形＝閉路ごとの点列 [{points:[x,y,x,y,…]}]（先頭の点を末尾へ足さない。辺は末尾→先頭でも閉じる）。
 */

const PARAM_EPS = 1e-9;

/** rings の全辺（[x1,y1,x2,y2]）。2 点未満の閉路は辺なし。 */
function ringEdges(rings) {
  const edges = [];
  for (const ring of rings ?? []) {
    const p = ring?.points ?? [];
    const n = Math.floor(p.length / 2);
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      edges.push([p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]]);
    }
  }
  return edges;
}

/** 点 (px,py) から線分 [x1,y1,x2,y2] への距離。 */
function distToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 1 組の辺（edges）の内側か。境界上は内側・組の中の閉路はまとめて偶奇（穴は偶奇のまま）。 */
function insideOneGroup(px, py, edges, tolMm) {
  for (const e of edges) if (distToSegment(px, py, e) <= tolMm) return true; // 境界上は内側
  let inside = false;
  for (const [x1, y1, x2, y2] of edges) {
    if ((y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** どれか 1 組の内側なら内側（組の和集合。重なる屋根どうしが偶奇で打ち消し合わない）。 */
function insideAnyGroup(px, py, groupEdges, tolMm) {
  return groupEdges.some(edges => insideOneGroup(px, py, edges, tolMm));
}

/**
 * pt が rings（1 組＝1 つの屋根の外形）の内側か（偶奇判定）。境界上（距離 ≤ tolMm）は内側。
 * @param {{x:number,y:number}} pt
 * @param {Array<{points:number[]}>} rings
 * @param {number} [tolMm]
 */
export function pointInRings(pt, rings, tolMm = 0) {
  return insideOneGroup(pt.x, pt.y, ringEdges(rings), tolMm);
}

/**
 * pt が groups（屋根ごとの閉路の組）のどれかの内側か（組の和集合。組の中は偶奇）。境界上は内側。
 * @param {{x:number,y:number}} pt
 * @param {Array<Array<{points:number[]}>>} groups
 * @param {number} [tolMm]
 */
export function pointInAnyRings(pt, groups, tolMm = 0) {
  return insideAnyGroup(pt.x, pt.y, (groups ?? []).map(ringEdges), tolMm);
}

/** 線分 a→b を分ける区間の境界パラメータ（0・1・閉路の辺との交点・線分上に乗る閉路の頂点。昇順・重複なし）。 */
function splitParams(ax, ay, bx, by, edges, tolMm) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  const ts = [0, 1];
  for (const [x1, y1, x2, y2] of edges) {
    const ex = x2 - x1, ey = y2 - y1;
    const denom = dx * ey - dy * ex;
    const elen = Math.hypot(ex, ey);
    if (Math.abs(denom) > PARAM_EPS * len * elen) {
      const t = ((x1 - ax) * ey - (y1 - ay) * ex) / denom;
      const u = ((x1 - ax) * dy - (y1 - ay) * dx) / denom;
      const uTol = elen > 0 ? tolMm / elen : 0;
      if (t > 0 && t < 1 && u >= -uTol && u <= 1 + uTol) ts.push(t);
    }
    // 辺の端点が線分の上に乗る（共線で重なる・T 字）区間の切れ目
    for (const [qx, qy] of [[x1, y1], [x2, y2]]) {
      if (len === 0) continue;
      const t = ((qx - ax) * dx + (qy - ay) * dy) / (len * len);
      if (t > 0 && t < 1 && Math.abs((qx - ax) * dy - (qy - ay) * dx) / len <= tolMm) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > PARAM_EPS);
}

/**
 * 折れ線のうち groups（屋根ごとの閉路の組）のどれの内側にも無い部分だけを返す（組の和集合で隠す）。closed なら最後の点から最初の点への辺も含める。
 * 閉路の外に出る連続した区間は 1 本にまとめる（closed の折れ線は始点をまたぐ区間も 1 本）。
 * 1 か所も切れなければ入力のまま（closed を保つ）[{points, closed}]・全部隠れれば []。切った結果は closed:false。
 * @param {number[]} points [x,y,x,y,…]
 * @param {boolean} closed
 * @param {Array<Array<{points:number[]}>>} groups 区切り点は全組の辺で探し、内側判定は組ごとの偶奇の和集合
 * @param {number} [tolMm] 境界上とみなす幅（配置図は CL_OVERLAP_TOL_MM を渡す）
 * @returns {Array<{points:number[], closed:boolean}>}
 */
export function clipPolylineOutside(points, closed, groups, tolMm = 0) {
  const groupEdges = (groups ?? []).map(ringEdges);
  const edges = groupEdges.flat();
  const n = Math.floor(points.length / 2);
  if (edges.length === 0 || n < 2) return [{ points, closed }];
  const segCount = closed ? n : n - 1;
  const pieces = [];
  let current = null;
  let allKept = true;
  let firstKept = false;
  let lastKept = false;
  for (let s = 0; s < segCount; s++) {
    const ax = points[2 * s], ay = points[2 * s + 1];
    const j = (s + 1) % n;
    const bx = points[2 * j], by = points[2 * j + 1];
    const ts = splitParams(ax, ay, bx, by, edges, tolMm);
    for (let k = 0; k + 1 < ts.length; k++) {
      const x0 = ax + (bx - ax) * ts[k], y0 = ay + (by - ay) * ts[k];
      const x1 = ax + (bx - ax) * ts[k + 1], y1 = ay + (by - ay) * ts[k + 1];
      const keep = !insideAnyGroup((x0 + x1) / 2, (y0 + y1) / 2, groupEdges, tolMm);
      if (s === 0 && k === 0) firstKept = keep;
      lastKept = keep;
      if (keep) {
        if (current) current.push(x1, y1);
        else { current = [x0, y0, x1, y1]; pieces.push(current); }
      } else {
        current = null;
        allKept = false;
      }
    }
  }
  if (allKept) return [{ points, closed }];
  // 閉じた折れ線で始点をまたいで残る区間（最後の片と最初の片）をつなぐ
  if (closed && firstKept && lastKept && pieces.length > 1) {
    const last = pieces.pop();
    pieces[0] = [...last, ...pieces[0].slice(2)];
  }
  return pieces.map(p => ({ points: p, closed: false }));
}

/**
 * 線の集まりを coverGroups（上にある屋根ごとの閉路の組）の和集合の外側だけにする。各線の role などの属性は保つ（切れた線は closed:false の複数本になる）。
 * coverGroups が空なら lines をそのまま返す。
 * @param {Array<{points:number[], closed:boolean}>} lines
 * @param {Array<Array<{points:number[]}>>} coverGroups
 * @param {number} [tolMm] 配置図は CL_OVERLAP_TOL_MM を渡す
 */
export function clipRoofLinesByCovers(lines, coverGroups, tolMm = 0) {
  if (!coverGroups || coverGroups.length === 0) return lines;
  return lines.flatMap(l => clipPolylineOutside(l.points, l.closed, coverGroups, tolMm).map(piece => ({ ...l, ...piece })));
}
