/**
 * 小屋組（棟木・母屋・小屋梁の位置・束）の幾何の純モジュール（ステップ C1。どこからも呼ばない）。
 * graph・store.js・snap.js・.jsx・react・konva を import しない（node:test から単体で import できる）。
 * 定数（母屋ピッチの候補・軒桁までの残りの上限・束の最大間隔 1820・許容差）は引数で受ける（呼び出し側が structureRules.js・
 * core/constants.js の CL_OVERLAP_TOL_MM を渡す。CL_OVERLAP_TOL_MM=0.5mm＝「他CLと同一座標」とみなす距離）。
 *
 * 座標は mm、y 軸は下向きが正。線の表現 Line={isVertical, coord, lo, hi}:
 *   isVertical は既存の梁（StructuralBeam.isVertical）と同じ意味で、true＝y 方向に走る線（x=coord 一定、
 *   y が lo..hi）、false＝x 方向に走る線（y=coord 一定、x が lo..hi）。
 *
 * 屋根範囲は矩形 rect={x1,y1,x2,y2}（x1<x2, y1<y2）が基本（rect* の関数は矩形専用）。矩形でない範囲は、寄棟だけ
 * orthogonalHipLines（rects＝セル矩形。ステップ C2e-2）で棟木・母屋を導く。矩形でない切妻・片流れは空を返す。
 * 寄棟の隅木・谷木（斜め線）は棟木・母屋とは別の配列で、roofHipDiagonals / orthogonalHipDiagonals（ステップ C2e-2b）。
 *
 * 不正入力の扱い:
 *   - 「何も生えない」入力（rect=null・陸屋根・棟違い・未知の形状・幅/高さ 0 の矩形）は空を返す。
 *   - プログラム誤り（ピッチ候補・残りの上限・許容差が非有限か不正、座標が非有限、x1>x2/y1>y2、lo>hi、
 *     片流れの highSide が不正）は RangeError を投げる。
 */
import { RoofShape, RoofHighSide } from '../core/constants.js';

const HIGH_SIDES = Object.values(RoofHighSide);

function requireFinite(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RangeError(`${name} は有限の数値でなければなりません: ${v}`);
  }
}

function requirePositive(v, name) {
  requireFinite(v, name);
  if (v <= 0) throw new RangeError(`${name} は 0 より大きくなければなりません: ${v}`);
}

function requireNonNegative(v, name) {
  requireFinite(v, name);
  if (v < 0) throw new RangeError(`${name} は 0 以上でなければなりません: ${v}`);
}

const vLine = (x, y1, y2) => ({ isVertical: true, coord: x, lo: y1, hi: y2 });
const hLine = (y, x1, x2) => ({ isVertical: false, coord: y, lo: x1, hi: x2 });

function sortLines(lines) {
  return lines.sort((a, b) =>
    (a.isVertical === b.isVertical ? 0 : (a.isVertical ? 1 : -1)) || a.coord - b.coord || a.lo - b.lo);
}

/**
 * 棟の向き。高さ（y）が幅（x）より大きければ y 方向に走る（true）。正方形（差が tolMm 以下）は横方向＝false。
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect
 * @param {number} [tolMm=0]
 * @returns {boolean}
 */
export function roofRidgeIsVertical(rect, tolMm = 0) {
  return (rect.y2 - rect.y1) - (rect.x2 - rect.x1) > tolMm;
}

/**
 * 母屋の割付（棟木側から軒桁へ向かう。切妻・片流れ・寄棟が共用する唯一の判断）。
 * ピッチは pitchMm（910）固定。1本目の位置（棟木からの距離）の候補 startOffsetsMm（455・910）ごとに
 * start + k*pitch（k=0,1,…）を軒桁の手前（H − tol 未満）まで置き、最後の母屋（無ければ棟木）から軒桁までの
 * 残りが pitchMm に近い案を採る（同じ＝tol 以内なら大きい start）。軒桁と重なる位置・越える位置には置かない。
 * 理由: 柱の割付（910 モジュール）と絡むため（ユーザー裁定 2026-10-02）。
 * @param {object} p
 * @param {number} p.halfSpanMm 棟木（高い側の辺）から軒桁までの距離（>=0）
 * @param {number} p.pitchMm 母屋のピッチ（>0。例 910）。残りの目標値でもある
 * @param {number[]} p.startOffsetsMm 1本目の位置の候補（空でない。各 >0。例 [455, 910]）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{startOffsetMm: number|null, offsetsMm: number[], eaveGapMm: number}} offsetsMm は棟木側からの距離の昇順。
 *   採った案で母屋が1本も無いとき startOffsetMm=null・offsetsMm=[]・eaveGapMm=halfSpanMm
 * @throws {RangeError} 入力が不正
 */
export function purlinLayoutFromRidge({ halfSpanMm, pitchMm, startOffsetsMm, tolMm }) {
  requireNonNegative(halfSpanMm, 'halfSpanMm');
  requirePositive(pitchMm, 'pitchMm');
  if (!Array.isArray(startOffsetsMm) || startOffsetsMm.length === 0) {
    throw new RangeError('startOffsetsMm は空でない配列でなければなりません');
  }
  for (const s of startOffsetsMm) requirePositive(s, 'startOffsetsMm の要素');
  requireNonNegative(tolMm, 'tolMm');
  const layoutOf = start => {
    const offsets = [];
    for (let k = 0; start + k * pitchMm < halfSpanMm - tolMm; k++) offsets.push(start + k * pitchMm); // 軒桁と重なる位置には置かない
    const last = offsets.length > 0 ? offsets[offsets.length - 1] : 0;
    return { startOffsetMm: offsets.length > 0 ? start : null, offsetsMm: offsets, eaveGapMm: halfSpanMm - last };
  };
  // 「残りが pitchMm に近い」の比較はここ1箇所
  const distance = c => Math.abs(pitchMm - c.eaveGapMm);
  let best = null;
  let bestStart = 0;
  for (const start of startOffsetsMm) {
    const c = layoutOf(start);
    if (best === null || distance(c) < distance(best) - tolMm
      || (Math.abs(distance(c) - distance(best)) <= tolMm && start > bestStart)) {
      best = c;
      bestStart = start;
    }
  }
  return best;
}

// ---- 以下 rect* は矩形専用（rect は検証済みの矩形）。layout は purlinLayoutFromRidge の引数のうち
// 半スパン以外（{pitchMm, startOffsetsMm, tolMm}） ----

function rectGableLines(rect, ridgeIsVertical, layout) {
  const { x1, y1, x2, y2 } = rect;
  const ridges = [];
  const purlins = [];
  if (ridgeIsVertical) { // 棟は y 方向。軒は x1 と x2 の2辺
    const c = (x1 + x2) / 2;
    ridges.push(vLine(c, y1, y2));
    for (const o of purlinLayoutFromRidge({ halfSpanMm: (x2 - x1) / 2, ...layout }).offsetsMm) {
      purlins.push(vLine(c - o, y1, y2), vLine(c + o, y1, y2));
    }
  } else { // 棟は x 方向。軒は y1 と y2 の2辺
    const c = (y1 + y2) / 2;
    ridges.push(hLine(c, x1, x2));
    for (const o of purlinLayoutFromRidge({ halfSpanMm: (y2 - y1) / 2, ...layout }).offsetsMm) {
      purlins.push(hLine(c - o, x1, x2), hLine(c + o, x1, x2));
    }
  }
  return { ridges, purlins: sortLines(purlins) };
}

function rectMonoLines(rect, highSide, layout) {
  if (!HIGH_SIDES.includes(highSide)) {
    throw new RangeError(`片流れの highSide が不正です: ${highSide}`);
  }
  const { x1, y1, x2, y2 } = rect;
  const purlins = [];
  // 高い側の辺から低い側の軒へ向かって割り付ける（高い側の辺そのものには置かない）。
  if (highSide === 'top' || highSide === 'bottom') {
    const { offsetsMm } = purlinLayoutFromRidge({ halfSpanMm: y2 - y1, ...layout });
    for (const o of offsetsMm) purlins.push(hLine(highSide === 'top' ? y1 + o : y2 - o, x1, x2));
  } else {
    const { offsetsMm } = purlinLayoutFromRidge({ halfSpanMm: x2 - x1, ...layout });
    for (const o of offsetsMm) purlins.push(vLine(highSide === 'left' ? x1 + o : x2 - o, y1, y2));
  }
  return { ridges: [], purlins: sortLines(purlins) };
}

function rectHipLines(rect, layout) {
  const { x1, y1, x2, y2 } = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  const ridges = [];
  if (Math.abs(w - h) > layout.tolMm) { // 正方形（方形）は棟木なし
    if (w > h) ridges.push(hLine((y1 + y2) / 2, x1 + h / 2, x2 - h / 2));
    else ridges.push(vLine((x1 + x2) / 2, y1 + w / 2, y2 - w / 2));
  }
  const purlins = [];
  // 棟木（正方形は中心）からの距離 o の位置に環を置く。軒からの内側への距離 d = 半スパン − o。
  const half = Math.min(w, h) / 2;
  for (const o of purlinLayoutFromRidge({ halfSpanMm: half, ...layout }).offsetsMm) {
    const d = half - o;
    purlins.push(
      hLine(y1 + d, x1 + d, x2 - d), hLine(y2 - d, x1 + d, x2 - d),
      vLine(x1 + d, y1 + d, y2 - d), vLine(x2 - d, y1 + d, y2 - d),
    );
  }
  return { ridges, purlins: sortLines(purlins) };
}

// ---- 矩形でない寄棟（直交多角形）。ステップ C2e-2 ----

const GEOM_EPS = 1e-6;

/** 昇順の値を、先頭（最小）から tol 以内のものをその最小の値へ寄せて返す（重複なし）。 */
function snapSorted(values, tol) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length === 0 || v - out[out.length - 1] > tol) out.push(v);
  }
  return out;
}

/** 昇順の値から、前の値と EPS 以内のものを除く。 */
function dedupeSorted(values) {
  const out = [];
  for (const v of values) if (out.length === 0 || v - out[out.length - 1] > GEOM_EPS) out.push(v);
  return out;
}

/**
 * 直交多角形の寄棟の棟木・母屋の線。建物範囲 P（rects の和集合。穴も軒として扱う）の内側へ、外周から L∞ 距離 d の
 * 等高線（P の内側へ半辺 d の正方形を収められる点の集合 E_d の境界）を求める。
 *  - 母屋＝軒から pitchMm ごとの段 d（k*pitchMm）で、E_d の境界のうち片側だけが E_d の内側の辺。
 *  - 棟木＝E_d が幅 0 につぶれる段（座標の対の差の半分）で、つぶれた辺（両側とも E_d の外）。
 *    孤立した点（正方形の翼の頂点＝方形）は線にならない。隅木・谷木（斜め線）は orthogonalHipDiagonals。
 * 直交多角形の E_d の境界は必ず「元の x ±d」「元の y ±d」の上にあるので、座標を圧縮した格子で正確に求まる。
 * 矩形の寄棟（roofFramingLines の rectHipLines）とは割付の基準が違う（矩形は棟木から、こちらは軒から。ユーザー裁定）。
 * 半スパンが pitchMm の倍数の矩形では位置が一致する。
 * 線は {isVertical, coord, lo, hi, levelMm}（levelMm＝軒からの内側への距離）。同じ種別・段・向き・座標で端が接する辺は
 * 1本にまとめる（棟木の十字は交点で切らない）。長さ tolMm 以下は捨てる。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 建物範囲のセル矩形（幅か高さが tolMm 以下は無視）
 * @param {number} p.pitchMm 母屋のピッチ（>0。例 910）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{ridges: Array<object>, purlins: Array<object>}}
 * @throws {RangeError} pitchMm・tolMm が不正、rects が配列でない、座標が非有限か逆順
 */
export function orthogonalHipLines({ rects, pitchMm, tolMm }) {
  requirePositive(pitchMm, 'pitchMm');
  requireNonNegative(tolMm, 'tolMm');
  const field = buildOrthoField(rects, tolMm);
  if (!field) return { ridges: [], purlins: [] };
  const { fits, S } = field;

  // 3. 段の集合。棟木の段 H＝座標の対の差の半分、母屋の段 D＝k*pitchMm（H の値と tolMm 以内なら H の値に寄せる）
  const ridgeLevels = ridgeLevelsOf(field, tolMm);
  const levels = ridgeLevels.map(d => ({ d, ridge: true, purlin: false }));
  for (let k = 1; k * pitchMm <= S + tolMm; k++) {
    const d = k * pitchMm;
    const same = levels.find(l => l.ridge && Math.abs(l.d - d) <= tolMm);
    if (same) same.purlin = true;
    else levels.push({ d, ridge: false, purlin: true });
  }
  levels.sort((a, b) => a.d - b.d);

  // 4. 段ごとの評価。辺は (種別, 段, 向き, 座標) ごとに集め、5. で端の接する辺を1本にまとめる
  const groups = new Map();
  const addSegment = (kind, d, isVertical, coord, lo, hi) => {
    const key = `${kind}|${d}|${isVertical}|${coord}`;
    if (!groups.has(key)) groups.set(key, { kind, d, isVertical, coord, segs: [] });
    groups.get(key).segs.push([lo, hi]);
  };
  for (const { d, ridge, purlin } of levels) {
    const { X, Y, cell } = levelCells(field, d);
    if (X.length === 0 || Y.length === 0) continue;
    for (let k = 0; k < Y.length; k++) { // 横の辺 y=Y[k]、x は X[i]..X[i+1]
      for (let i = 0; i + 1 < X.length; i++) {
        const up = cell(i, k - 1);
        const down = cell(i, k);
        if (purlin && up !== down) addSegment('purlin', d, false, Y[k], X[i], X[i + 1]);
        else if (ridge && !up && !down && fits(midOf(X, i), Y[k], d)) addSegment('ridge', d, false, Y[k], X[i], X[i + 1]);
      }
    }
    for (let k = 0; k < X.length; k++) { // 縦の辺 x=X[k]、y は Y[j]..Y[j+1]
      for (let j = 0; j + 1 < Y.length; j++) {
        const left = cell(k - 1, j);
        const right = cell(k, j);
        if (purlin && left !== right) addSegment('purlin', d, true, X[k], Y[j], Y[j + 1]);
        else if (ridge && !left && !right && fits(X[k], midOf(Y, j), d)) addSegment('ridge', d, true, X[k], Y[j], Y[j + 1]);
      }
    }
  }

  // 5. つなぎ
  const ridges = [];
  const purlins = [];
  for (const g of groups.values()) {
    g.segs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [lo, hi] of g.segs) {
      const last = merged[merged.length - 1];
      if (last && lo <= last[1] + GEOM_EPS) last[1] = Math.max(last[1], hi);
      else merged.push([lo, hi]);
    }
    for (const [lo, hi] of merged) {
      if (hi - lo <= tolMm) continue;
      (g.kind === 'ridge' ? ridges : purlins).push({ isVertical: g.isVertical, coord: g.coord, lo, hi, levelMm: g.d });
    }
  }
  return { ridges: sortLines(ridges), purlins: sortLines(purlins) };
}

const midOf = (A, i) => (A[i] + A[i + 1]) / 2;

/**
 * 直交多角形の寄棟の共通の下ごしらえ（orthogonalHipLines・orthogonalHipDiagonals が共用）。rects を検査し、
 * 座標を圧縮した格子・収まり判定・段の候補を返す。使える矩形が無ければ null。
 * @throws {RangeError} rects が配列でない、座標が非有限か逆順
 */
function buildOrthoField(rects, tolMm) {
  if (!Array.isArray(rects)) throw new RangeError('rects は配列でなければなりません');
  rects.forEach((r, i) => {
    for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(r?.[k], `rects[${i}].${k}`);
    if (r.x2 < r.x1 || r.y2 < r.y1) throw new RangeError(`rects[${i}] の座標が逆順です: ${JSON.stringify(r)}`);
  });
  const live = rects.filter(r => r.x2 - r.x1 > tolMm && r.y2 - r.y1 > tolMm);
  if (live.length === 0) return null;

  // 1. 座標の圧縮と塗り（累積和 acc[j][i]＝セル (0..i-1, 0..j-1) の塗り数）
  const xs = snapSorted(live.flatMap(r => [r.x1, r.x2]), tolMm);
  const ys = snapSorted(live.flatMap(r => [r.y1, r.y2]), tolMm);
  const indexOf = (arr, v) => {
    let best = 0;
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
    return best;
  };
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const filled = Array.from({ length: ny }, () => new Array(nx).fill(false));
  for (const r of live) {
    for (let j = indexOf(ys, r.y1); j < indexOf(ys, r.y2); j++) {
      for (let i = indexOf(xs, r.x1); i < indexOf(xs, r.x2); i++) filled[j][i] = true;
    }
  }
  const acc = Array.from({ length: ny + 1 }, () => new Array(nx + 1).fill(0));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) acc[j + 1][i + 1] = acc[j][i + 1] + acc[j + 1][i] - acc[j][i] + (filled[j][i] ? 1 : 0);
  }
  const x0 = xs[0];
  const xN = xs[nx];
  const y0 = ys[0];
  const yN = ys[ny];

  // 2. 収まり判定: 中心 (cx,cy)・半辺 h の正方形が P に収まるか
  const fits = (cx, cy, h) => {
    if (cx - h < x0 - GEOM_EPS || cx + h > xN + GEOM_EPS || cy - h < y0 - GEOM_EPS || cy + h > yN + GEOM_EPS) return false;
    let ia = 0;
    while (xs[ia + 1] <= cx - h + GEOM_EPS) ia++;
    let ib = ia;
    while (ib + 1 < nx && xs[ib + 1] < cx + h - GEOM_EPS) ib++;
    let ja = 0;
    while (ys[ja + 1] <= cy - h + GEOM_EPS) ja++;
    let jb = ja;
    while (jb + 1 < ny && ys[jb + 1] < cy + h - GEOM_EPS) jb++;
    const count = acc[jb + 1][ib + 1] - acc[ja][ib + 1] - acc[jb + 1][ia] + acc[ja][ia];
    return count === (ib - ia + 1) * (jb - ja + 1);
  };

  // 段の候補の元。S＝つぶれきる段（短辺の半分）、hCand＝座標の対の差の半分（フィルタ前）
  const S = Math.min(xN - x0, yN - y0) / 2;
  const hCand = [];
  for (let a = 0; a < xs.length; a++) for (let b = a + 1; b < xs.length; b++) hCand.push((xs[b] - xs[a]) / 2);
  for (let a = 0; a < ys.length; a++) for (let b = a + 1; b < ys.length; b++) hCand.push((ys[b] - ys[a]) / 2);
  const cellFilled = (i, j) => filled[j]?.[i] === true; // 圧縮格子のセル (i,j)＝xs[i]..xs[i+1]×ys[j]..ys[j+1] が P の内側か
  return { xs, ys, x0, xN, y0, yN, fits, S, hCand, indexOf, cellFilled };
}

/** 棟木の段（軒からの距離）の候補。座標の対の差の半分のうち 0 より大きく S 以下のものを、tolMm 以内で寄せて昇順に返す。 */
function ridgeLevelsOf(field, tolMm) {
  return snapSorted(field.hCand.filter(h => h > tolMm && h <= field.S + tolMm), tolMm);
}

/**
 * 段 d の等高線 E_d の格子。X・Y＝E_d の境界が乗りうる座標（元の座標 ±d のうち範囲内）、cell(i,j)＝
 * X[i]..X[i+1]×Y[j]..Y[j+1] のセルが E_d の内側か（範囲外の添字は false）。
 */
function levelCells(field, d) {
  const { xs, ys, x0, xN, y0, yN, fits } = field;
  const within = (lo, hi) => v => v >= lo - GEOM_EPS && v <= hi + GEOM_EPS;
  const X = dedupeSorted(xs.flatMap(v => [v - d, v + d]).filter(within(x0 + d, xN - d)).sort((a, b) => a - b));
  const Y = dedupeSorted(ys.flatMap(v => [v - d, v + d]).filter(within(y0 + d, yN - d)).sort((a, b) => a - b));
  if (X.length === 0 || Y.length === 0) return { X, Y, cell: () => false };
  const cellIn = Array.from({ length: X.length - 1 }, (_, i) => Array.from({ length: Y.length - 1 }, (_, j) => fits(midOf(X, i), midOf(Y, j), d)));
  return { X, Y, cell: (i, j) => (cellIn[i]?.[j] === true) };
}

/**
 * 直交多角形の寄棟の「方形の頂点」（正方形の翼の中心。棟木が幅 0 の点につぶれた所＝棟木の線にならない孤立点）。
 * 棟木の段 d ごとに、E_d の格子点で、(1) その点が E_d に属し、(2) 周りの4セルが全て E_d の外、(3) 接する辺の中点
 * （端の辺は存在する分だけ）がどれも E_d に属さないもの。x・y の昇順。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 建物範囲のセル矩形（orthogonalHipLines と同じ）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{x:number, y:number, levelMm:number}>}
 * @throws {RangeError} tolMm が不正、rects が配列でない、座標が非有限か逆順
 */
export function orthogonalHipApexes({ rects, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  const field = buildOrthoField(rects, tolMm);
  if (!field) return [];
  const { fits } = field;
  const out = [];
  for (const d of ridgeLevelsOf(field, tolMm)) {
    const { X, Y, cell } = levelCells(field, d);
    for (let k = 0; k < X.length; k++) {
      for (let m = 0; m < Y.length; m++) {
        if (!fits(X[k], Y[m], d)) continue;
        if (cell(k - 1, m - 1) || cell(k, m - 1) || cell(k - 1, m) || cell(k, m)) continue;
        const touching = [];
        if (k > 0) touching.push([midOf(X, k - 1), Y[m]]);
        if (k + 1 < X.length) touching.push([midOf(X, k), Y[m]]);
        if (m > 0) touching.push([X[k], midOf(Y, m - 1)]);
        if (m + 1 < Y.length) touching.push([X[k], midOf(Y, m)]);
        if (touching.some(([x, y]) => fits(x, y, d))) continue;
        out.push({ x: X[k], y: Y[m], levelMm: d });
      }
    }
  }
  return out.sort((a, b) => a.x - b.x || a.y - b.y);
}

/**
 * 直交多角形の寄棟の隅木・谷木（ステップ C2e-2b）。等高線 E_d の角の軌跡で、45° の直線になる。
 * 出隅（E_d の角のうち内側の象限が1つ）は隅木 'hip'、入隅（内側が3つ）は谷木 'valley'。角は d が大きくなるにつれ
 * 内側の象限の方向（谷木は外側の象限の逆）へ動く。元の頂点に無い「隠れた出隅」（翼の幅が違うときに、狭い翼の
 * 仮想の出隅の軌跡）からも出る。孤立した頂点（方形）に4本が集まっても、同じ直線上の逆向きの2本はつなげない。
 * 角の生まれ・消え・合流は段の候補（座標の対の差の半分）でしか起きないので、その間の区間の中央で1回だけ角を判定する。
 * 矩形も同じ規則（4隅→棟木の端。正方形は中心）。ピッチ・割付には依存しない。
 * 戻り値は (x1,y1)＝軒側の端、(x2,y2)＝上端。kind（hip→valley）・x1・y1・x2・y2 の昇順。長さ（段の幅）が tolMm 以下は捨てる。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 建物範囲のセル矩形（幅か高さが tolMm 以下は無視）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>}
 * @throws {RangeError} tolMm が不正、rects が配列でない、座標が非有限か逆順
 */
export function orthogonalHipDiagonals({ rects, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  const field = buildOrthoField(rects, tolMm);
  if (!field) return [];
  const { xs, ys, S, hCand, indexOf } = field;
  // tolMm で寄せない（寄せると事象の段を跨ぐ。xs は寄せ済みなので事象は hCand と正確に一致する）
  const T = dedupeSorted([0, ...hCand.filter(h => h > GEOM_EPS && h <= S + GEOM_EPS).sort((a, b) => a - b)]);
  const groups = new Map();
  for (let k = 0; k + 1 < T.length; k++) {
    const m = (T[k] + T[k + 1]) / 2;
    const { X, Y, cell } = levelCells(field, m);
    for (let i = 0; i < X.length; i++) {
      for (let j = 0; j < Y.length; j++) {
        // 4象限の内外。象限 (sx,sy)＝(+1/-1, +1/-1) は点から見た向き
        const quads = [[-1, -1, cell(i - 1, j - 1)], [1, -1, cell(i, j - 1)], [-1, 1, cell(i - 1, j)], [1, 1, cell(i, j)]];
        const inside = quads.filter(q => q[2]);
        const corners = [];
        if (inside.length === 1) corners.push({ kind: 'hip', sx: inside[0][0], sy: inside[0][1] });
        else if (inside.length === 3) {
          const out = quads.find(q => !q[2]);
          corners.push({ kind: 'valley', sx: -out[0], sy: -out[1] });
        } else if (inside.length === 2 && inside[0][0] !== inside[1][0] && inside[0][1] !== inside[1][1]) {
          // 対角の2象限（区間の中央では起きないはず）。内側の象限ごとに出隅
          for (const q of inside) corners.push({ kind: 'hip', sx: q[0], sy: q[1] });
        }
        for (const c of corners) {
          const xa = xs[indexOf(xs, X[i] - c.sx * m)];
          const yb = ys[indexOf(ys, Y[j] - c.sy * m)];
          const key = `${c.kind}|${c.sx}|${c.sy}|${xa}|${yb}`;
          if (!groups.has(key)) groups.set(key, { ...c, xa, yb, segs: [] });
          groups.get(key).segs.push([T[k], T[k + 1]]);
        }
      }
    }
  }
  const out = [];
  for (const g of groups.values()) {
    g.segs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [lo, hi] of g.segs) {
      const last = merged[merged.length - 1];
      if (last && lo <= last[1] + GEOM_EPS) last[1] = Math.max(last[1], hi);
      else merged.push([lo, hi]);
    }
    for (const [lo, hi] of merged) {
      if (hi - lo <= tolMm) continue;
      out.push({ kind: g.kind, x1: g.xa + g.sx * lo, y1: g.yb + g.sy * lo, x2: g.xa + g.sx * hi, y2: g.yb + g.sy * hi });
    }
  }
  const kindRank = k => (k === 'hip' ? 0 : 1);
  return out.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2);
}

/**
 * 寄棟の隅木・谷木（描画の唯一の入口）。shape が寄棟でなければ空。rect があれば矩形（roofFramingLines と同じ検査。
 * 幅か高さが tolMm 以下は空）、rect=null なら rects（セル矩形。空でなければ）。矩形も orthogonalHipDiagonals へ通す。
 * 斜め線は束を受け取らない（束は roofFramingLines の棟木・母屋の線だけ）。
 * @param {object} p
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} p.rect
 * @param {Array<object>|null} [p.rects]
 * @param {string} p.shape RoofShape の値
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>}
 * @throws {RangeError} 許容差が不正、rect の座標が非有限か逆順
 */
export function roofHipDiagonals({ rect, rects = null, shape, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  if (shape !== RoofShape.HIP) return [];
  if (!rect) {
    return Array.isArray(rects) && rects.length > 0 ? orthogonalHipDiagonals({ rects, tolMm }) : [];
  }
  for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(rect[k], `rect.${k}`);
  if (rect.x2 < rect.x1 || rect.y2 < rect.y1) {
    throw new RangeError(`rect の座標が逆順です: ${JSON.stringify(rect)}`);
  }
  if (rect.x2 - rect.x1 <= tolMm || rect.y2 - rect.y1 <= tolMm) return [];
  return orthogonalHipDiagonals({ rects: [rect], tolMm });
}

// ---- 屋根の外形線（軒先・けらば。ステップ D1） ----

/**
 * 屋根範囲 P（rects の和集合）の外周の辺を閉路ごとに返す（穴があれば穴も別の閉路）。圧縮格子（buildOrthoField）の
 * 単位辺のうち内外が分かれるものを、内側が進行方向の右（y 下向きの画面で時計回り）になるようにつなぎ、同一直線上で
 * 続く辺は1本に併合する。斜めに接する頂点（4辺が集まる）は内側へ曲がる辺を優先してつなぐ（どちらでも閉路にはなる）。
 * 辺は {isVertical, coord, lo, hi, outward, dir}。isVertical は roofFramingLines の線と同じ意味、outward＝外側が
 * coord の +方向(+1)か -方向(-1)か、dir＝閉路を進む向きが lo→hi(+1)か hi→lo(-1)か。閉路の辺は進行順。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形（幅か高さが tolMm 以下は無視）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1, dir:1|-1}>>}
 * @throws {RangeError} tolMm が不正、rects が配列でない、座標が非有限か逆順
 */
export function orthogonalBoundaryLoops({ rects, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  const field = buildOrthoField(rects, tolMm);
  if (!field) return [];
  const { xs, ys, cellFilled } = field;
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  // 単位辺。from・to は格子点の添字 [i, j]
  const units = [];
  for (let k = 0; k <= ny; k++) { // 横の辺 y=ys[k]、x は xs[i]..xs[i+1]。内側が下なら外側は -y・進行は +x
    for (let i = 0; i < nx; i++) {
      const up = cellFilled(i, k - 1);
      const down = cellFilled(i, k);
      if (up === down) continue;
      const outward = down ? -1 : 1;
      const dir = -outward;
      units.push({ isVertical: false, line: k, a: i, outward, dir, from: dir > 0 ? [i, k] : [i + 1, k], to: dir > 0 ? [i + 1, k] : [i, k] });
    }
  }
  for (let k = 0; k <= nx; k++) { // 縦の辺 x=xs[k]、y は ys[j]..ys[j+1]。内側が右なら外側は -x・進行は -y
    for (let j = 0; j < ny; j++) {
      const left = cellFilled(k - 1, j);
      const right = cellFilled(k, j);
      if (left === right) continue;
      const outward = right ? -1 : 1;
      const dir = outward;
      units.push({ isVertical: true, line: k, a: j, outward, dir, from: dir > 0 ? [k, j] : [k, j + 1], to: dir > 0 ? [k, j + 1] : [k, j] });
    }
  }
  const keyOf = ([i, j]) => `${i},${j}`;
  const outgoing = new Map();
  for (const u of units) {
    const key = keyOf(u.from);
    if (!outgoing.has(key)) outgoing.set(key, []);
    outgoing.get(key).push(u);
  }
  const travel = u => (u.isVertical ? [0, u.dir] : [u.dir, 0]);
  const loops = [];
  for (const u0 of units) {
    if (u0.used) continue;
    const raw = [];
    let cur = u0;
    for (;;) {
      cur.used = true;
      raw.push(cur);
      if (keyOf(cur.to) === keyOf(u0.from)) break;
      const cands = (outgoing.get(keyOf(cur.to)) ?? []).filter(c => !c.used);
      if (cands.length === 0) break;
      const [tx, ty] = travel(cur);
      cur = cands.find(c => { const [cx, cy] = travel(c); return cx === -ty && cy === tx; }) ?? cands[0]; // 内側（進行方向の右）へ曲がる辺を優先
    }
    // 同一直線上で続く単位辺を1本にまとめる。先頭は「前の辺の続きでない」辺から始める
    const continues = (p, e) => p.isVertical === e.isVertical && p.line === e.line && p.dir === e.dir;
    let start = raw.findIndex((e, i) => !continues(raw[(i + raw.length - 1) % raw.length], e));
    if (start < 0) start = 0;
    const ordered = [...raw.slice(start), ...raw.slice(0, start)];
    const runs = [];
    for (const e of ordered) {
      const last = runs[runs.length - 1];
      if (last && continues(last[last.length - 1], e)) last.push(e);
      else runs.push([e]);
    }
    loops.push(runs.map(run => {
      const first = run[0];
      const a = Math.min(...run.map(e => e.a));
      const b = Math.max(...run.map(e => e.a)) + 1;
      const along = first.isVertical ? ys : xs;
      const across = first.isVertical ? xs : ys;
      return { isVertical: first.isVertical, coord: across[first.line], lo: along[a], hi: along[b], outward: first.outward, dir: first.dir };
    }));
  }
  return loops;
}

/**
 * 辺が軒（eave）かけらば（gable）か。寄棟は全辺が軒。切妻は棟木に平行な辺（棟木が縦なら縦の辺）が軒で、棟木の端の側
 * （棟木と直交する辺）がけらば。片流れは高い側とその反対の辺（highSide が top/bottom なら横の辺、left/right なら縦の辺）が軒で、
 * 残る2辺がけらば。陸屋根・棟違い・未知の形状は小屋組を持たない（呼び出し側が region にしない）ので RangeError。
 * @param {object} p
 * @param {string} p.shape RoofShape の値
 * @param {boolean|null} [p.ridgeIsVertical] 切妻のときだけ使う（boolean 必須）
 * @param {string|null} [p.highSide] 片流れのときだけ使う（RoofHighSide の値必須）
 * @param {boolean} p.isVertical 辺の向き（x=coord 一定＝true）
 * @returns {'eave'|'gable'}
 * @throws {RangeError} 形状が未知・小屋組を持たない、切妻の ridgeIsVertical が boolean でない、片流れの highSide が不正
 */
export function roofEdgeKind({ shape, ridgeIsVertical = null, highSide = null, isVertical }) {
  if (shape === RoofShape.HIP) return 'eave';
  if (shape === RoofShape.GABLE) {
    if (typeof ridgeIsVertical !== 'boolean') throw new RangeError(`切妻の ridgeIsVertical は boolean でなければなりません: ${ridgeIsVertical}`);
    return isVertical === ridgeIsVertical ? 'eave' : 'gable';
  }
  if (shape === RoofShape.MONO) {
    if (!HIGH_SIDES.includes(highSide)) throw new RangeError(`片流れの highSide が不正です: ${highSide}`);
    return isVertical === (highSide === 'left' || highSide === 'right') ? 'eave' : 'gable';
  }
  throw new RangeError(`外形線を持たない形状です: ${shape}`);
}

/** 辺 edge を、出幅 0 の区間 zones（同じ向き・同じ直線・同じ外側の区間）で分けた部分（昇順）。base は区間の外の出幅。 */
function splitEdgeByZones(edge, base, zones, tolMm) {
  const hit = zones
    .filter(z => z.isVertical === edge.isVertical && Math.abs(z.coord - edge.coord) <= tolMm && z.outward === edge.outward)
    .map(z => [Math.max(z.lo, edge.lo), Math.min(z.hi, edge.hi)])
    .filter(([a, b]) => b - a > tolMm)
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of hit) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + tolMm) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const parts = [];
  let pos = edge.lo;
  for (const [a0, b0] of merged) {
    const a = a0 - pos <= tolMm ? pos : a0;
    const b = edge.hi - b0 <= tolMm ? edge.hi : b0;
    if (a > pos) parts.push({ lo: pos, hi: a, overhangMm: base });
    parts.push({ lo: a, hi: b, overhangMm: 0 });
    pos = b;
  }
  if (edge.hi > pos) parts.push({ lo: pos, hi: edge.hi, overhangMm: base });
  const joined = []; // 隣り合う同じ出幅の部分は1つにする（出幅 0 の屋根・全体が接する辺で段差を作らない）
  for (const p of parts) {
    const last = joined[joined.length - 1];
    if (last && last.overhangMm === p.overhangMm) last.hi = p.hi;
    else joined.push({ ...p });
  }
  return joined;
}

/**
 * 屋根の外形線（軒先・けらば。ステップ D1）。屋根範囲（rects。矩形は [rect]）の外周の辺を、種別（roofEdgeKind）ごとの出幅
 * だけ外へ平行移動した閉じた線を返す。基準は屋根範囲の辺（通り芯）から水平に測る。辺のうち zeroZones に含まれる部分
 * （下屋の辺が屋内に接する部分）は出幅 0（壁に当たる）。辺の途中で出幅が変わるときは、その辺を部分に分け、段差の小辺を
 * 挿入する（辺ごとではなく部分ごと）。隣り合う辺は直交するので、移動した2本の線の交点が頂点（隅木・谷木に当たる角も
 * 同じ式）。穴があれば穴の辺も外形（穴の内側＝外側）として同じ規則で移動する（穴の外形線は穴の中へ縮む）。
 * 出幅が辺の長さより大きい凹み（入隅の極小の辺など）での線の反転は扱わない（実データで起きない前提）。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形
 * @param {string} p.shape RoofShape の値（roofEdgeKind と同じ）
 * @param {boolean|null} [p.ridgeIsVertical]
 * @param {string|null} [p.highSide]
 * @param {number} p.eaveOverhangMm 軒の出幅（>=0）
 * @param {number} p.gableOverhangMm 妻側（けらば）の出幅（>=0）
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1}>} [p.zeroZones] 出幅 0 の区間
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{edges: Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1, overhangMm:number}>, outline: Array<{points:number[]}>}}
 *   edges＝辺の部分（閉路の進行順。出幅つき）、outline＝閉路ごとの頂点列（points は x,y の並び）
 * @throws {RangeError} 出幅が負・非有限、形状・向きの指定が不正（roofEdgeKind）、rects が不正（orthogonalBoundaryLoops）
 */
export function roofOutline({ rects, shape, ridgeIsVertical = null, highSide = null, eaveOverhangMm, gableOverhangMm, zeroZones = [], tolMm }) {
  requireNonNegative(eaveOverhangMm, 'eaveOverhangMm');
  requireNonNegative(gableOverhangMm, 'gableOverhangMm');
  const loops = orthogonalBoundaryLoops({ rects, tolMm });
  const partLoops = loops.map(loop => loop.flatMap(edge => {
    const kind = roofEdgeKind({ shape, ridgeIsVertical, highSide, isVertical: edge.isVertical });
    const parts = splitEdgeByZones(edge, kind === 'eave' ? eaveOverhangMm : gableOverhangMm, zeroZones, tolMm);
    if (edge.dir < 0) parts.reverse();
    return parts.map(p => ({ isVertical: edge.isVertical, coord: edge.coord, lo: p.lo, hi: p.hi, outward: edge.outward, dir: edge.dir, overhangMm: p.overhangMm }));
  }));
  const shifted = e => e.coord + e.outward * e.overhangMm;
  const outline = partLoops.map(parts => {
    const points = [];
    parts.forEach((p, i) => {
      const q = parts[(i + 1) % parts.length];
      if (p.isVertical !== q.isVertical) { // 直交する辺: 2本の線の交点
        const v = p.isVertical ? p : q;
        const h = p.isVertical ? q : p;
        points.push(shifted(v), shifted(h));
      } else if (Math.abs(shifted(p) - shifted(q)) > GEOM_EPS) { // 同じ直線上で出幅が変わる: 段差の小辺
        const b = p.dir > 0 ? p.hi : p.lo;
        if (p.isVertical) points.push(shifted(p), b, shifted(q), b);
        else points.push(b, shifted(p), b, shifted(q));
      }
    });
    // 細い穴が出幅でつぶれる（両側の外形線が同じ位置で出会う）と同じ点が続くので、連続する同一点（閉路の先頭と末尾を含む）は1つにする。
    const dedup = [];
    for (let i = 0; i < points.length; i += 2) {
      const n = dedup.length;
      if (n >= 2 && Math.abs(dedup[n - 2] - points[i]) <= GEOM_EPS && Math.abs(dedup[n - 1] - points[i + 1]) <= GEOM_EPS) continue;
      dedup.push(points[i], points[i + 1]);
    }
    while (dedup.length >= 4 && Math.abs(dedup[0] - dedup[dedup.length - 2]) <= GEOM_EPS && Math.abs(dedup[1] - dedup[dedup.length - 1]) <= GEOM_EPS) dedup.splice(-2, 2);
    return { points: dedup };
  });
  const edges = partLoops.flat().map(e => ({ isVertical: e.isVertical, coord: e.coord, lo: e.lo, hi: e.hi, outward: e.outward, overhangMm: e.overhangMm }));
  return { edges, outline };
}

// ---- 寄棟の小屋梁のための「翼」の分け方（ステップ C2e-3a。呼び出し元は woodRoofFraming.js＝C2e-3b） ----

/** 区間 [lo,hi] から taken（{lo,hi}）を引いた残りのうち、長さが tol を超えるもの（昇順）。 */
function subtractIntervals(lo, hi, taken, tol) {
  const out = [];
  let cur = lo;
  for (const t of taken.filter(t => t.hi > lo && t.lo < hi).sort((a, b) => a.lo - b.lo)) {
    if (t.lo - cur > tol) out.push({ lo: cur, hi: t.lo });
    cur = Math.max(cur, t.hi);
  }
  if (hi - cur > tol) out.push({ lo: cur, hi });
  return out;
}

function requireLevelLine(l, name) {
  requireFinite(l?.coord, `${name}.coord`);
  requireFinite(l.lo, `${name}.lo`);
  requireFinite(l.hi, `${name}.hi`);
  if (l.hi < l.lo) throw new RangeError(`${name} の lo>hi です: ${JSON.stringify(l)}`);
  requirePositive(l.levelMm, `${name}.levelMm`);
}

/** 翼の中の線の部分 Portion。levelMm は元の線にあるときだけ付ける。 */
function portionOf(line, lo, hi, extendLo, extendHi) {
  const p = { isVertical: line.isVertical, coord: line.coord, lo, hi };
  if (line.levelMm !== undefined) p.levelMm = line.levelMm;
  return { ...p, lineLo: line.lo, lineHi: line.hi, extendLo, extendHi };
}

/**
 * 寄棟の小屋梁（第1段・第2段）を翼ごとに回すための、翼と線の振り分け（純関数。ステップ C2e-3a）。
 * 翼＝棟木（方形は頂点）を、その段 levelMm だけ四方へ広げた矩形（必ず屋根範囲の中）。翼ごとに矩形の寄棟と同じ手順を回す。
 *  - 翼の順: 段の大きい順 → 棟木の長い順（頂点は 0）→ 桁行が横の翼を先 → 棟木の座標 → 棟木の lo（頂点は x）。主たる翼が先。
 *  - 振り分け（先着）: 母屋ごとに、翼の順に「その翼の矩形の中で軒から同じ距離にある部分」を取る。母屋 ℓ（段 L）が縦なら
 *    ℓ の x が翼の x1+L..x2−L の中にあるときだけ取り、区間は y が [翼の y1+L, 翼の y2−L] との共通部分（横は対称）。
 *    先の翼が取った区間は引き、残りが後の翼の部分。部分の端が先の翼の取った区間に接すれば extendLo/extendHi を立てる
 *    （接合の切れ目で、本当の線の端は lineLo/lineHi）。翼の中で棟木と平行な部分が桁行（keta）、直交する部分が妻側
 *    （中心 center の lo 側 gableLo・hi 側 gableHi）。
 *  - seed（棟木の端の位置）: 棟木の端が別の翼の直交する棟木の上にあれば、その別の翼に自分の棟木の座標を足し、無ければ
 *    自分の seed にする。頂点の翼は頂点の x。
 *  - 被覆性（前提）: どの母屋のどの点も、どれか1つの翼で軒からの距離がその段に等しい。崩れた分は unassigned に返す
 *    （呼び出し側は空であることを確かめる）。center から tolMm 以内の妻側の部分も unassigned に入れる（桁行／妻側を決められない）。
 * rect を渡す入口は矩形の寄棟（翼1つ。正方形判定と seed の式は今の矩形の計画と同じ。rect の全母屋が桁行／妻側に入る。
 * ridges・purlins は roofFramingLines の結果で levelMm 不要。翼の levelMm は短手の半分）。rects の入口は矩形でない寄棟
 * （ridges・purlins は orthogonalHipLines の結果で全て levelMm が要る）。rect も rects も無ければ空。
 * @param {object} p
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} [p.rect]
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>|null} [p.rects]
 * @param {Array<object>} p.ridges 棟木の線 {isVertical, coord, lo, hi, levelMm?}
 * @param {Array<object>} p.purlins 母屋の線（同上）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{wings: Array<object>, unassigned: Array<object>}} Wing＝{ketaVertical, rect, levelMm, ridge(Line|null),
 *   ridgeCross, center, seeds, keta, gableLo, gableHi}、Portion＝{isVertical, coord, lo, hi, levelMm?, lineLo, lineHi,
 *   extendLo, extendHi}。各リストは横線→縦線・coord・lo の昇順
 * @throws {RangeError} tolMm が不正、座標が非有限か逆順、rects の入口で線に levelMm（>0）が無い
 */
export function hipFramingWings({ rect = null, rects = null, ridges, purlins, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  if (rect) return hipFramingWingsOfRect({ rect, ridges, purlins, tolMm });
  if (rects === null || rects === undefined) return { wings: [], unassigned: [] };
  if (!Array.isArray(rects)) throw new RangeError('rects は配列でなければなりません');
  if (rects.length === 0) return { wings: [], unassigned: [] };
  return hipFramingWingsOfRects({ rects, ridges, purlins, tolMm });
}

function hipFramingWingsOfRect({ rect, ridges, purlins, tolMm }) {
  for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(rect[k], `rect.${k}`);
  if (rect.x2 < rect.x1 || rect.y2 < rect.y1) throw new RangeError(`rect の座標が逆順です: ${JSON.stringify(rect)}`);
  if (rect.x2 - rect.x1 <= tolMm || rect.y2 - rect.y1 <= tolMm) return { wings: [], unassigned: [] };
  const { x1, y1, x2, y2 } = rect;
  const ketaVertical = roofRidgeIsVertical(rect, tolMm);
  const [alongLo, alongHi, crossLo, crossHi] = ketaVertical ? [y1, y2, x1, x2] : [x1, x2, y1, y2];
  const s = crossHi - crossLo;
  const center = (alongLo + alongHi) / 2;
  const keta = [];
  const gableLo = [];
  const gableHi = [];
  const unassigned = [];
  for (const l of sortLines([...purlins])) {
    const portion = portionOf(l, l.lo, l.hi, false, false);
    if (l.isVertical === ketaVertical) keta.push(portion);
    else if (l.coord < center - tolMm) gableLo.push(portion);
    else if (l.coord > center + tolMm) gableHi.push(portion);
    else unassigned.push({ ...l });
  }
  const wing = {
    ketaVertical,
    rect: { x1, y1, x2, y2 },
    levelMm: Math.min(x2 - x1, y2 - y1) / 2,
    ridge: ridges[0] ?? null,
    ridgeCross: (crossLo + crossHi) / 2,
    center,
    seeds: [alongLo + s / 2, alongHi - s / 2].filter((v, i, a) => i === 0 || Math.abs(v - a[0]) > tolMm),
    keta, gableLo, gableHi,
  };
  return { wings: [wing], unassigned: sortLines(unassigned) };
}

function hipFramingWingsOfRects({ rects, ridges, purlins, tolMm }) {
  ridges.forEach((l, i) => requireLevelLine(l, `ridges[${i}]`));
  purlins.forEach((l, i) => requireLevelLine(l, `purlins[${i}]`));
  const wings = [
    ...ridges.map(r => {
      const L = r.levelMm;
      return {
        ketaVertical: r.isVertical,
        rect: r.isVertical
          ? { x1: r.coord - L, y1: r.lo - L, x2: r.coord + L, y2: r.hi + L }
          : { x1: r.lo - L, y1: r.coord - L, x2: r.hi + L, y2: r.coord + L },
        levelMm: L, ridge: r, ridgeCross: r.coord, center: (r.lo + r.hi) / 2, seeds: [],
      };
    }),
    ...orthogonalHipApexes({ rects, tolMm }).map(a => ({
      ketaVertical: false,
      rect: { x1: a.x - a.levelMm, y1: a.y - a.levelMm, x2: a.x + a.levelMm, y2: a.y + a.levelMm },
      levelMm: a.levelMm, ridge: null, ridgeCross: a.y, center: a.x, seeds: [a.x],
    })),
  ];
  const ridgeLength = w => (w.ridge ? w.ridge.hi - w.ridge.lo : 0);
  const ridgeStart = w => (w.ridge ? w.ridge.lo : w.center);
  wings.sort((a, b) => b.levelMm - a.levelMm || ridgeLength(b) - ridgeLength(a)
    || (a.ketaVertical === b.ketaVertical ? 0 : (a.ketaVertical ? 1 : -1))
    || a.ridgeCross - b.ridgeCross || ridgeStart(a) - ridgeStart(b));

  // seed: 棟木の端が別の翼の直交する棟木の上にあれば、その翼へ（その棟木に沿った座標＝自分の棟木の coord）。無ければ自分へ
  for (const w of wings) {
    const r = w.ridge;
    if (!r) continue;
    for (const e of [r.lo, r.hi]) {
      const px = r.isVertical ? r.coord : e;
      const py = r.isVertical ? e : r.coord;
      const hosts = wings.filter(o => o !== w && o.ridge && o.ridge.isVertical !== r.isVertical && (o.ridge.isVertical
        ? Math.abs(px - o.ridge.coord) <= tolMm && py >= o.ridge.lo - tolMm && py <= o.ridge.hi + tolMm
        : Math.abs(py - o.ridge.coord) <= tolMm && px >= o.ridge.lo - tolMm && px <= o.ridge.hi + tolMm));
      if (hosts.length === 0) w.seeds.push(e);
      else for (const o of hosts) o.seeds.push(r.coord);
    }
  }
  for (const w of wings) w.seeds = snapSorted(w.seeds, tolMm);

  // 振り分け（先着）
  const lines = sortLines([...purlins]);
  const taken = lines.map(() => []);
  const unassigned = [];
  for (const w of wings) {
    w.keta = [];
    w.gableLo = [];
    w.gableHi = [];
    lines.forEach((l, i) => {
      const L = l.levelMm;
      const { x1, y1, x2, y2 } = w.rect;
      const [crossLo, crossHi, alongLo, alongHi] = l.isVertical ? [x1, x2, y1, y2] : [y1, y2, x1, x2];
      if (l.coord - crossLo < L - tolMm || crossHi - l.coord < L - tolMm) return;
      const lo = Math.max(l.lo, alongLo + L);
      const hi = Math.min(l.hi, alongHi - L);
      if (hi - lo <= tolMm) return;
      for (const piece of subtractIntervals(lo, hi, taken[i], tolMm)) {
        const portion = portionOf(l, piece.lo, piece.hi,
          taken[i].some(t => Math.abs(t.hi - piece.lo) <= tolMm), taken[i].some(t => Math.abs(t.lo - piece.hi) <= tolMm));
        if (l.isVertical === w.ketaVertical) w.keta.push(portion);
        else if (l.coord < w.center - tolMm) w.gableLo.push(portion);
        else if (l.coord > w.center + tolMm) w.gableHi.push(portion);
        else unassigned.push({ isVertical: l.isVertical, coord: l.coord, lo: piece.lo, hi: piece.hi, levelMm: L });
      }
      taken[i].push({ lo, hi });
    });
    sortLines(w.keta);
    sortLines(w.gableLo);
    sortLines(w.gableHi);
  }
  lines.forEach((l, i) => {
    for (const piece of subtractIntervals(l.lo, l.hi, taken[i], tolMm)) {
      unassigned.push({ isVertical: l.isVertical, coord: l.coord, lo: piece.lo, hi: piece.hi, levelMm: l.levelMm });
    }
  });
  return { wings, unassigned: sortLines(unassigned) };
}

/**
 * 屋根範囲（rects の和集合）の中での、部材の「弦」（ステップ C2e-3a）。部材の直交方向の座標 coord を閉区間（許容差込み）に
 * 含む矩形の、部材に沿う方向の区間を集め、隙間が tolMm 以下のものを併合して、[lo,hi]（許容差込み）を含む区間を返す。
 * isVertical は部材の向き（true＝x=coord を y 方向に走る）。無ければ null。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects
 * @param {boolean} p.isVertical
 * @param {number} p.coord
 * @param {number} p.lo
 * @param {number} p.hi
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{lo:number, hi:number}|null}
 * @throws {RangeError} tolMm が不正、rects が配列でない、座標が非有限か逆順
 */
export function orthogonalChord({ rects, isVertical, coord, lo, hi, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  requireFinite(coord, 'coord');
  requireFinite(lo, 'lo');
  requireFinite(hi, 'hi');
  if (hi < lo) throw new RangeError(`lo>hi です: ${lo}, ${hi}`);
  if (!Array.isArray(rects)) throw new RangeError('rects は配列でなければなりません');
  const spans = [];
  rects.forEach((r, i) => {
    for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(r?.[k], `rects[${i}].${k}`);
    if (r.x2 < r.x1 || r.y2 < r.y1) throw new RangeError(`rects[${i}] の座標が逆順です: ${JSON.stringify(r)}`);
    const [crossLo, crossHi, alongLo, alongHi] = isVertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
    if (coord >= crossLo - tolMm && coord <= crossHi + tolMm) spans.push({ lo: alongLo, hi: alongHi });
  });
  spans.sort((a, b) => a.lo - b.lo);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.lo <= last.hi + tolMm) last.hi = Math.max(last.hi, s.hi);
    else merged.push({ ...s });
  }
  return merged.find(s => s.lo - tolMm <= lo && hi <= s.hi + tolMm) ?? null;
}

/**
 * 矩形の屋根の棟木・母屋の線（水平距離で割り付け。勾配は位置に影響しない）。矩形専用。
 * 母屋は棟木側から軒桁へ割り付ける（purlinLayoutFromRidge。ピッチ・1本目の候補は引数）。
 *  - 切妻: 棟＝矩形の中央（向きは ridgeIsVertical。未指定なら roofRidgeIsVertical）。母屋は棟から両側へ
 *    割付の位置（半スパン＝短手の半分）。端は屋根範囲の辺まで。
 *  - 片流れ: 棟木なし。highSide（'top'|'bottom'|'left'|'right'。y 軸が下向き正なので top＝y が小さい辺 y1、
 *    bottom＝y2、left＝x1、right＝x2）が高い側。高い側の辺から低い側の軒へ割付の位置。高い側の辺そのものには置かない。
 *  - 寄棟: 棟木（正方形は中心）からの距離が割付の位置に環（4辺に平行。軒からの内側への距離 d＝半スパン−割付の位置。
 *    横線は x1+d..x2-d、縦線は y1+d..y2-d）。棟木は長辺方向に長さ（長辺−短辺）の線。正方形は棟木なし（方形）。
 *    ridgeIsVertical は無視。
 *  - 陸屋根・棟違い・未知の形状・幅か高さが tolMm 以下の矩形は空。
 *  - rect=null のとき、shape が寄棟で rects（セル矩形の配列）が空でなければ矩形でない寄棟（orthogonalHipLines。
 *    purlinStartOffsetsMm は使わない）。それ以外の rect=null は空。rect があれば rects は無視する。
 * @param {object} p
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} p.rect
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>|null} [p.rects] 矩形でない建物範囲のセル矩形（rect=null のとき）
 * @param {string} p.shape RoofShape の値
 * @param {boolean} [p.ridgeIsVertical] 切妻の棟が y 方向か
 * @param {string|null} [p.highSide] 片流れの高い側
 * @param {number} p.purlinPitchMm 母屋のピッチ（>0。例 910）
 * @param {number[]} p.purlinStartOffsetsMm 母屋の1本目の位置（棟木から）の候補（空でない。各 >0。例 [455, 910]）
 * @param {number} p.tolMm 許容差（>=0。例 CL_OVERLAP_TOL_MM）
 * @returns {{ridges: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>, purlins: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}}
 * @throws {RangeError} ピッチ・許容差が不正、rect の座標が非有限か逆順、片流れで highSide が不正
 */
export function roofFramingLines({ rect, rects = null, shape, ridgeIsVertical, highSide = null, purlinPitchMm, purlinStartOffsetsMm, tolMm }) {
  requirePositive(purlinPitchMm, 'purlinPitchMm');
  if (!Array.isArray(purlinStartOffsetsMm) || purlinStartOffsetsMm.length === 0) {
    throw new RangeError('purlinStartOffsetsMm は空でない配列でなければなりません');
  }
  for (const s of purlinStartOffsetsMm) requirePositive(s, 'purlinStartOffsetsMm の要素');
  requireNonNegative(tolMm, 'tolMm');
  const layout = { pitchMm: purlinPitchMm, startOffsetsMm: purlinStartOffsetsMm, tolMm };
  const empty = { ridges: [], purlins: [] };
  if (!rect) {
    // 矩形でない寄棟（rect=null・rects＝セル矩形）だけ orthogonalHipLines。矩形かどうかは呼び出し側（region）が保証する。
    if (shape === RoofShape.HIP && Array.isArray(rects) && rects.length > 0) {
      return orthogonalHipLines({ rects, pitchMm: purlinPitchMm, tolMm });
    }
    return empty;
  }
  for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(rect[k], `rect.${k}`);
  if (rect.x2 < rect.x1 || rect.y2 < rect.y1) {
    throw new RangeError(`rect の座標が逆順です: ${JSON.stringify(rect)}`);
  }
  if (rect.x2 - rect.x1 <= tolMm || rect.y2 - rect.y1 <= tolMm) return empty;

  // 形状の分岐はここだけ（矩形専用の rect* を呼ぶ）。
  const vertical = typeof ridgeIsVertical === 'boolean' ? ridgeIsVertical : roofRidgeIsVertical(rect, tolMm);
  switch (shape) {
    case RoofShape.GABLE: return rectGableLines(rect, vertical, layout);
    case RoofShape.MONO: return rectMonoLines(rect, highSide, layout);
    case RoofShape.HIP: return rectHipLines(rect, layout);
    default: return empty; // 陸屋根・棟違い・未知
  }
}

/**
 * 小屋梁（母屋・棟木と直交する梁）の位置。線に沿った座標の昇順配列を返す。
 * 各線について「端点＋その線を覆う support＋選んだ位置」の間隔が maxPitchMm 以下（超過は tolMm まで許容）に
 * なる最少本数を貪欲法で選ぶ:
 *   1. 違反（間隔 > max+tol）のある (a,b) のうち a（＝a+max）が最小のものを取る（全ての線を通して）。
 *   2. (a+tol, a+max+tol] の候補から、tiers（優先順位の高い順の座標列）の最上位で非空の tier の最大値。
 *   3. 無ければ gridOriginOf(a) を原点とする gridModuleMm グリッドの最大点。それも無ければ a+max。
 *   4. 違反が無くなるまで繰り返す。選んだ位置は、範囲が覆う全ての線に効く（1本で複数の線の違反を解く）。
 * 出力を support として与え直すと [] になる（冪等）。
 * lines は全て同じ isVertical（混在は RangeError。寄棟は向きごとに分けて呼ぶ）。長さ tolMm 以下の線は無視。
 * @param {object} p
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number}>} p.lines
 * @param {Array<{at:number,lo:number,hi:number}>} [p.supports] 既存の直交材。at＝線に沿った座標、
 *   lo..hi＝線と直交する方向の範囲（線の coord がこの範囲内なら、その線を支える）
 * @param {number[][]} [p.tiers] 優先順位の高い順の座標列（例 [通り芯, 中心線]）
 * @param {(a:number)=>number|undefined} [p.gridOriginOf] 位置 a 付近の 910 グリッドの原点（無ければ undefined）
 * @param {number} p.maxPitchMm 束の最大間隔（>0。例 1820）
 * @param {number} p.gridModuleMm グリッド間隔（>0。例 910）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {number[]}
 * @throws {RangeError} 数値が不正、線・support の座標が非有限か lo>hi、isVertical が混在
 */
export function koyaBeamPositions({ lines, supports = [], tiers = [], gridOriginOf, maxPitchMm, gridModuleMm, tolMm }) {
  requirePositive(maxPitchMm, 'maxPitchMm');
  requirePositive(gridModuleMm, 'gridModuleMm');
  requireNonNegative(tolMm, 'tolMm');
  const live = [];
  for (const l of lines ?? []) {
    requireFinite(l.coord, 'line.coord');
    requireFinite(l.lo, 'line.lo');
    requireFinite(l.hi, 'line.hi');
    if (l.lo > l.hi) throw new RangeError(`line の lo が hi より大きい: ${l.lo} > ${l.hi}`);
    if (l.hi - l.lo <= tolMm) continue;
    live.push(l);
  }
  for (const s of supports ?? []) {
    requireFinite(s.at, 'support.at');
    requireFinite(s.lo, 'support.lo');
    requireFinite(s.hi, 'support.hi');
    if (s.lo > s.hi) throw new RangeError(`support の lo が hi より大きい: ${s.lo} > ${s.hi}`);
  }
  if (live.some(l => l.isVertical !== live[0].isVertical)) {
    throw new RangeError('lines の isVertical が混在しています');
  }
  if (live.length === 0) return [];

  const chosen = [];
  const pointsOf = line => {
    const pts = [line.lo, line.hi];
    const inside = v => v >= line.lo - tolMm && v <= line.hi + tolMm;
    for (const s of supports) {
      if (inside(s.at) && line.coord >= s.lo - tolMm && line.coord <= s.hi + tolMm) pts.push(s.at);
    }
    for (const c of chosen) if (inside(c)) pts.push(c);
    return pts.sort((p, q) => p - q);
  };
  const pick = a => {
    const min = a + tolMm;
    const max = a + maxPitchMm + tolMm;
    for (const tier of tiers ?? []) {
      let best = null;
      for (const v of tier) {
        if (Number.isFinite(v) && v > min && v <= max && (best === null || v > best)) best = v;
      }
      if (best !== null) return best;
    }
    const origin = typeof gridOriginOf === 'function' ? gridOriginOf(a) : undefined;
    if (Number.isFinite(origin)) {
      const g = origin + Math.floor((max - origin) / gridModuleMm) * gridModuleMm;
      if (g > min) return g;
    }
    return a + maxPitchMm;
  };

  // 各反復で位置が1つ増え、増えた位置は a より tol 以上先なので有限回で終わる。
  for (;;) {
    let first = null;
    for (const line of live) {
      const pts = pointsOf(line);
      for (let i = 0; i + 1 < pts.length; i++) {
        if (pts[i + 1] - pts[i] > maxPitchMm + tolMm && (first === null || pts[i] < first)) first = pts[i];
      }
    }
    if (first === null) break;
    chosen.push(pick(first));
  }
  return chosen.sort((p, q) => p - q);
}

/**
 * 束の位置: 母屋・棟木の線と、直交する横架材との全交点（重複は tolMm 内を同一とみなして除く）。
 * 端での接触（線の端が材の上、材の端が線の上）も tolMm まで含める。平行な組は交点なし。
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number}>} lines
 * @param {Array<{isVertical:boolean,axis:number,lo:number,hi:number}>} members 横架材（axis＝材の軸の座標）
 * @param {number} tolMm 許容差（>=0）
 * @returns {Array<{x:number,y:number}>} x 昇順、同 x は y 昇順
 * @throws {RangeError} 座標が非有限、許容差が不正
 */
export function roofStrutPoints(lines, members, tolMm) {
  requireNonNegative(tolMm, 'tolMm');
  for (const l of lines ?? []) for (const k of ['coord', 'lo', 'hi']) requireFinite(l[k], `line.${k}`);
  for (const m of members ?? []) for (const k of ['axis', 'lo', 'hi']) requireFinite(m[k], `member.${k}`);
  const points = [];
  for (const l of lines ?? []) {
    for (const m of members ?? []) {
      if (l.isVertical === m.isVertical) continue;
      if (m.axis < l.lo - tolMm || m.axis > l.hi + tolMm) continue; // 線の範囲内か
      if (l.coord < m.lo - tolMm || l.coord > m.hi + tolMm) continue; // 材の範囲内か
      const p = l.isVertical ? { x: l.coord, y: m.axis } : { x: m.axis, y: l.coord };
      if (!points.some(q => Math.abs(q.x - p.x) <= tolMm && Math.abs(q.y - p.y) <= tolMm)) points.push(p);
    }
  }
  return points.sort((p, q) => p.x - q.x || p.y - q.y);
}
