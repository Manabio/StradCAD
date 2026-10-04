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
 * 矩形でない下屋の片流れ（L字）は、壁ごとの翼（leanToWingsOf。ステップ E1a）に分けた母屋・継ぎ目の隅木・谷木を
 * leanToWings 引数で渡したときだけ返す（渡さなければ空）。
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
 * @param {Array<object>|null} [p.leanToWings] L字の下屋の翼（leanToWingsOf の wings。rect=null の片流れだけ。既定 null）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>}
 * @throws {RangeError} 許容差が不正、rect の座標が非有限か逆順
 */
export function roofHipDiagonals({ rect, rects = null, shape, leanToWings = null, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  // L字（矩形でない）の下屋の片流れ（rect=null・翼＝leanToWingsOf）は継ぎ目（隅木・谷木）。寄棟ではないが斜め線の入口はここ1つ
  if (!rect && shape === RoofShape.MONO && Array.isArray(leanToWings)) return leanToSeams({ wings: leanToWings, tolMm }).diagonals;
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

/**
 * 辺 edge を、出幅 0 の区間 zones（同じ向き・同じ直線・同じ外側の区間）で分けた部分（昇順）。base は区間の外の出幅。
 * 部分は covered（zones に覆われた部分か）を持つ。同じ出幅の隣り合う部分は1つにするが、keepCovered のときだけ covered が
 * 違えば分けたままにする（roofOutlineExposedPaths。既定の roofOutline は今までどおり出幅だけで1つにする）。
 */
function splitEdgeByZones(edge, base, zones, tolMm, keepCovered = false) {
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
    if (a > pos) parts.push({ lo: pos, hi: a, overhangMm: base, covered: false });
    parts.push({ lo: a, hi: b, overhangMm: 0, covered: true });
    pos = b;
  }
  if (edge.hi > pos) parts.push({ lo: pos, hi: edge.hi, overhangMm: base, covered: false });
  const joined = []; // 隣り合う同じ出幅の部分は1つにする（出幅 0 の屋根・全体が接する辺で段差を作らない）
  for (const p of parts) {
    const last = joined[joined.length - 1];
    if (last && last.overhangMm === p.overhangMm && (!keepCovered || last.covered === p.covered)) last.hi = p.hi;
    else joined.push({ ...p });
  }
  return joined;
}

/**
 * 辺 edge を、辺の部分ごとの種別 kindZones（leanToWingsOf の戻り値。同じ向き・同じ直線・同じ外側の区間）で分け、部分ごとの
 * 出幅（軒 or けらば）で splitEdgeByZones した部分（昇順）。隣り合う同じ出幅の部分は1つにする。辺を隙間なく覆わなければ RangeError。
 */
function splitEdgeByKindZones(edge, kindZones, eaveOverhangMm, gableOverhangMm, zeroZones, tolMm, keepCovered = false) {
  const hit = kindZones
    .filter(z => z.isVertical === edge.isVertical && z.outward === edge.outward && Math.abs(z.coord - edge.coord) <= tolMm)
    .map(z => ({ lo: Math.max(z.lo, edge.lo), hi: Math.min(z.hi, edge.hi), kind: z.kind }))
    .filter(z => z.hi - z.lo > tolMm)
    .sort((p, q) => p.lo - q.lo);
  const parts = [];
  let pos = edge.lo;
  for (const z of hit) {
    if (z.kind !== 'eave' && z.kind !== 'gable') throw new RangeError(`kindZones の kind が不正です: ${z.kind}`);
    if (z.lo - pos > tolMm) throw new RangeError(`kindZones が辺を覆っていません: ${JSON.stringify(edge)}（${pos}..${z.lo}）`);
    if (z.hi <= pos) continue;
    const piece = { ...edge, lo: pos, hi: z.hi };
    parts.push(...splitEdgeByZones(piece, z.kind === 'eave' ? eaveOverhangMm : gableOverhangMm, zeroZones, tolMm, keepCovered));
    pos = z.hi;
  }
  if (edge.hi - pos > tolMm) throw new RangeError(`kindZones が辺を覆っていません: ${JSON.stringify(edge)}（${pos}..${edge.hi}）`);
  const joined = [];
  for (const p of parts) {
    const last = joined[joined.length - 1];
    if (last && last.overhangMm === p.overhangMm && (!keepCovered || last.covered === p.covered)) last.hi = p.hi;
    else joined.push({ ...p });
  }
  if (joined.length > 0) joined[joined.length - 1].hi = edge.hi;
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
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1, kind:'eave'|'gable'}>|null} [p.kindZones]
 *   辺の部分ごとの種別（L字の下屋＝leanToWingsOf の戻り値。ステップ E1a）。null（既定）なら shape・ridgeIsVertical・highSide から
 *   辺ごとに種別を決める（今までの式）。非 null なら roofEdgeKind を呼ばず、辺をこの部分に分けて部分ごとの出幅で動かす
 *   （辺を隙間なく覆わなければ RangeError）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{edges: Array<{isVertical:boolean, coord:number, lo:number, hi:number, outward:1|-1, overhangMm:number}>, outline: Array<{points:number[]}>}}
 *   edges＝辺の部分（閉路の進行順。出幅つき）、outline＝閉路ごとの頂点列（points は x,y の並び）
 * @throws {RangeError} 出幅が負・非有限、形状・向きの指定が不正（roofEdgeKind）、rects が不正（orthogonalBoundaryLoops）
 */
export function roofOutline(args) {
  const partLoops = outlinePartLoops(args, false);
  const shifted = outlineShifted;
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

/** 外形線の辺の部分を出幅ぶん外へ移した線の座標。 */
function outlineShifted(e) {
  return e.coord + e.outward * e.overhangMm;
}

/**
 * roofOutline・roofOutlineExposedPaths の共通の下ごしらえ: 閉路ごとの辺の部分（進行順。{isVertical, coord, lo, hi, outward, dir,
 * overhangMm, covered}）。引数の検査もここ。keepCovered は splitEdgeByZones と同じ（roofOutline は false）。
 */
function outlinePartLoops({ rects, shape, ridgeIsVertical = null, highSide = null, eaveOverhangMm, gableOverhangMm, zeroZones = [], kindZones = null, tolMm }, keepCovered) {
  requireNonNegative(eaveOverhangMm, 'eaveOverhangMm');
  requireNonNegative(gableOverhangMm, 'gableOverhangMm');
  if (kindZones !== null && !Array.isArray(kindZones)) throw new RangeError('kindZones は配列か null でなければなりません');
  const loops = orthogonalBoundaryLoops({ rects, tolMm });
  return loops.map(loop => loop.flatMap(edge => {
    let parts;
    if (kindZones === null) {
      const kind = roofEdgeKind({ shape, ridgeIsVertical, highSide, isVertical: edge.isVertical });
      parts = splitEdgeByZones(edge, kind === 'eave' ? eaveOverhangMm : gableOverhangMm, zeroZones, tolMm, keepCovered);
    } else {
      parts = splitEdgeByKindZones(edge, kindZones, eaveOverhangMm, gableOverhangMm, zeroZones, tolMm, keepCovered);
    }
    if (edge.dir < 0) parts.reverse();
    return parts.map(p => ({ isVertical: edge.isVertical, coord: edge.coord, lo: p.lo, hi: p.hi, outward: edge.outward, dir: edge.dir, overhangMm: p.overhangMm, covered: p.covered }));
  }));
}

/** 点列（x,y の並び）の末尾と同じ点でなければ足す。 */
function pushPointDedup(points, [x, y]) {
  const n = points.length;
  if (n >= 2 && Math.abs(points[n - 2] - x) <= GEOM_EPS && Math.abs(points[n - 1] - y) <= GEOM_EPS) return;
  points.push(x, y);
}

/**
 * 平面の表示用の外形線（軒先・けらば。ステップ1）。roofOutline と同じ引数・同じ線だが、壁の中に重なる部分は描かない:
 * zeroZones（下屋の辺が屋内に接する部分。通り芯＝壁の中）に覆われた辺の部分と、その端の段差の小辺は除く。描くのは
 * 覆われない部分（出幅ぶん移した線。ユーザーが出幅 0 を入れた屋内に接しない辺も含む）と、両側とも描く部分である段差の小辺。
 * ループ全体を描くなら closed:true の1本（roofOutline の outline と同じ点列）、そうでなければ開いた折れ線
 * （ループ始点をまたぐ部分は1本につなぐ）。roofOutline の戻り値は変えない。
 * @param {object} p roofOutline と同じ
 * @returns {Array<{points:number[], closed:boolean}>}
 * @throws {RangeError} roofOutline と同じ
 */
export function roofOutlineExposedPaths(args) {
  const out = [];
  for (const parts of outlinePartLoops(args, true)) {
    const n = parts.length;
    // 線分（from→to）の列。部分ごとの線（移した直線の上）と、出幅の変わる同一直線上の段差の小辺を進行順に並べる。隣り合う線分は端が接する
    const segs = [];
    parts.forEach((p, i) => {
      const prev = parts[(i + n - 1) % n];
      const next = parts[(i + 1) % n];
      const across = outlineShifted(p);
      const pt = (along, at = across) => (p.isVertical ? [at, along] : [along, at]);
      // 端の along 座標: 隣が直交する辺なら隣の移した線の位置（頂点）、同じ直線上の続きなら部分自身の端
      const startAlong = prev.isVertical !== p.isVertical ? outlineShifted(prev) : (p.dir > 0 ? p.lo : p.hi);
      const endAlong = next.isVertical !== p.isVertical ? outlineShifted(next) : (p.dir > 0 ? p.hi : p.lo);
      segs.push({ from: pt(startAlong), to: pt(endAlong), drawn: !p.covered });
      if (next.isVertical === p.isVertical && Math.abs(outlineShifted(next) - across) > GEOM_EPS) {
        const b = p.dir > 0 ? p.hi : p.lo; // 段差の小辺（同じ along の位置で、p の線から next の線へ）
        segs.push({ from: pt(b), to: pt(b, outlineShifted(next)), drawn: !p.covered && !next.covered });
      }
    });
    if (segs.every(s => s.drawn)) {
      const points = [];
      for (const s of segs) pushPointDedup(points, s.to); // 各線分の終点を並べると roofOutline の outline と同じ順（先頭は最初の部分の終点）
      while (points.length >= 4 && Math.abs(points[0] - points[points.length - 2]) <= GEOM_EPS && Math.abs(points[1] - points[points.length - 1]) <= GEOM_EPS) points.splice(-2, 2);
      if (points.length >= 4) out.push({ points, closed: true });
      continue;
    }
    const start = segs.findIndex((s, i) => s.drawn && !segs[(i + segs.length - 1) % segs.length].drawn);
    if (start < 0) continue; // 描く線分が無い
    let path = null;
    const flush = () => { if (path && path.length >= 4) out.push({ points: path, closed: false }); path = null; };
    for (let k = 0; k < segs.length; k++) {
      const s = segs[(start + k) % segs.length];
      if (!s.drawn) { flush(); continue; }
      if (!path) { path = []; pushPointDedup(path, s.from); }
      pushPointDedup(path, s.to);
    }
    flush();
  }
  return out;
}

// ---- 母屋・棟木・隅木の出幅ぶんの延長（描画用。ステップ D2） ----

/** 延長に使う辺（roofOutline の edges）の検査。null・undefined は辺なし（延長しない）。 */
function requireOutlineEdges(edges) {
  if (edges == null) return [];
  if (!Array.isArray(edges)) throw new RangeError('edges は配列でなければなりません');
  for (const e of edges) {
    if (!e || typeof e.isVertical !== 'boolean') throw new RangeError(`edges の isVertical が不正です: ${JSON.stringify(e)}`);
    for (const k of ['coord', 'lo', 'hi']) requireFinite(e[k], `edge.${k}`);
    if (e.outward !== 1 && e.outward !== -1) throw new RangeError(`edges の outward が不正です: ${e.outward}`);
    requireNonNegative(e.overhangMm, 'edge.overhangMm');
  }
  return edges;
}

/**
 * 母屋・棟木の線を、けらば側の出幅ぶん外形線まで延ばした「描画用の線」を返す（ステップ D2。入力の線は変えない）。
 * 線の端点が、線と直交する屋根範囲の辺の上（端の座標が辺の coord、線の coord が辺の [lo,hi]。tolMm で判定）にあり、
 * その辺の外側が線の外向きと同じなら、その辺の部分の出幅だけ外へ延ばす。段差の境目に線が来て複数の部分に属すときは小さい出幅。
 * 端が屋根範囲の内部で終わる線（寄棟の環・棟木・つぶれた棟木）はどの辺の上にも無いので延びない。
 * 辺（edges）が null・空なら線はそのまま。長さ・順序・件数は変えない（束の位置は延長前の線で決める）。
 * @param {object} p
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number}>} p.lines 棟木・母屋の線
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1,overhangMm:number}>|null} p.edges roofOutline の edges
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}
 * @throws {RangeError} tolMm が不正、edges が配列でない・辺の値が不正
 */
export function extendLinesToOutline({ lines, edges, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  const list = requireOutlineEdges(edges);
  const reach = (line, at, outward) => {
    const hits = list.filter(e => e.isVertical !== line.isVertical && e.outward === outward
      && Math.abs(e.coord - at) <= tolMm && e.lo - tolMm <= line.coord && line.coord <= e.hi + tolMm);
    return hits.length === 0 ? 0 : Math.min(...hits.map(e => e.overhangMm));
  };
  return lines.map(line => ({ ...line, lo: line.lo - reach(line, line.lo, -1), hi: line.hi + reach(line, line.hi, 1) }));
}

/**
 * 隅木を軒先の角まで延ばした「描画用の斜め線」を返す（ステップ D2。入力は変えない）。隅木（kind:'hip'）の軒側の端 (x1,y1) が
 * 屋根範囲の角（直交する2辺の上。両辺とも外側が線の向きの逆）にあり、2辺の出幅が等しい（tolMm 以内）なら、その出幅ぶん
 * 45° に外へ延ばす（外形線の角へ）。出幅が違う（下屋の辺が屋内に接する角など）は延ばさない。谷木（valley）は既定では
 * 延ばさない（伏図 D2）。valleys=true（平面の表示）のときだけ、谷木の軒側の端が入隅（直交する2辺の上。両辺とも外側が
 * 線の向きの逆）にあれば同じ規則で外形線の入隅の角まで延ばす。隠れた出隅の隅木（軒側の端が屋根範囲の内部）は延ばさない。
 * 上端 (x2,y2) は変えない。
 * 軒側の端が1本の辺の上にだけある（もう1本の辺の上に無い）ときは、既定（midEdge=false）では延ばさない。midEdge=true
 * （片流れの下屋の L字の継ぎ目＝ステップ E1a）のときだけ、その辺の部分の出幅の最小（段差の境目は小さい方）が 0 より大きければ、
 * その出幅ぶん同じく外へ延ばす。
 * @param {object} p
 * @param {Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>} p.diagonals roofHipDiagonals の戻り値
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1,overhangMm:number}>|null} p.edges roofOutline の edges
 * @param {boolean} [p.midEdge=false] 軒側の端が1本の辺の途中にある隅木も延ばすか（L字の下屋の継ぎ目。既定は延ばさない）
 * @param {boolean} [p.valleys=false] 谷木も延ばすか（平面の表示。既定は延ばさない）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>}
 * @throws {RangeError} tolMm が不正、edges が配列でない・辺の値が不正
 */
export function extendDiagonalsToOutline({ diagonals, edges, midEdge = false, valleys = false, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  const list = requireOutlineEdges(edges);
  return diagonals.map(d => {
    if (d.kind !== 'hip' && !(valleys && d.kind === 'valley')) return d;
    const sx = Math.sign(d.x2 - d.x1);
    const sy = Math.sign(d.y2 - d.y1);
    if (sx === 0 || sy === 0) return d;
    const on = (isVertical, outward) => list.filter(e => e.isVertical === isVertical && e.outward === outward
      && Math.abs(e.coord - (isVertical ? d.x1 : d.y1)) <= tolMm
      && e.lo - tolMm <= (isVertical ? d.y1 : d.x1) && (isVertical ? d.y1 : d.x1) <= e.hi + tolMm);
    const vs = on(true, -sx);
    const hs = on(false, -sy);
    if (vs.length === 0 && hs.length === 0) return d;
    if (vs.length === 0 || hs.length === 0) {
      // 軒側の端が1本の辺の途中にある（片流れの下屋の L字の継ぎ目）。midEdge のときだけ、その部分の出幅の最小だけ外へ
      if (!midEdge) return d;
      const ov = Math.min(...(vs.length > 0 ? vs : hs).map(e => e.overhangMm));
      return ov > 0 ? { ...d, x1: d.x1 - sx * ov, y1: d.y1 - sy * ov } : d;
    }
    const dv = Math.min(...vs.map(e => e.overhangMm));
    const dh = Math.min(...hs.map(e => e.overhangMm));
    if (Math.abs(dv - dh) > tolMm || dv <= 0) return d;
    return { ...d, x1: d.x1 - sx * dv, y1: d.y1 - sy * dv };
  });
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
 * @param {Array<object>|null} [p.leanToWings] L字の下屋の翼（leanToWingsOf の wings。rect=null・片流れのときだけ使う。
 *   渡さなければ今まで通り＝空）
 * @param {number} p.purlinPitchMm 母屋のピッチ（>0。例 910）
 * @param {number[]} p.purlinStartOffsetsMm 母屋の1本目の位置（棟木から）の候補（空でない。各 >0。例 [455, 910]）
 * @param {number} p.tolMm 許容差（>=0。例 CL_OVERLAP_TOL_MM）
 * @returns {{ridges: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>, purlins: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}}
 * @throws {RangeError} ピッチ・許容差が不正、rect の座標が非有限か逆順、片流れで highSide が不正
 */
export function roofFramingLines({ rect, rects = null, shape, ridgeIsVertical, highSide = null, leanToWings = null, purlinPitchMm, purlinStartOffsetsMm, tolMm }) {
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
    // L字（矩形でない）の下屋の片流れ: 翼（leanToWingsOf）ごとの母屋。下屋全体で割付は1つ（leanToMonoLines）
    if (shape === RoofShape.MONO && Array.isArray(leanToWings)) {
      return leanToMonoLines({ wings: leanToWings, pitchMm: purlinPitchMm, startOffsetsMm: purlinStartOffsetsMm, tolMm });
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

// 棟木はピッチ・割付に依存しない（座標の対の差・短手の半分で決まる）。非木造には rules.framing が無くピッチを渡せないので、
// 棟木だけを要る平面の表示（roofRidgeLines）は固定値で roofFramingLines を呼ぶ。値が効かないことは roofFramingPlan.test.js が固定する。
const RIDGE_ONLY_PITCH_MM = 910;
const RIDGE_ONLY_START_OFFSETS_MM = Object.freeze([455, 910]);

/**
 * 棟木の線だけ（平面の表示用。ステップ1）。roofFramingLines の ridges と同じ結果で、切妻（rect）・寄棟（rect か rects）のときだけ
 * 返す。片流れ・陸屋根・棟違い・未知の形状は空（片流れは highSide 無しでも例外にしない）。引数の意味は roofFramingLines と同じ。
 * @param {object} p
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} p.rect
 * @param {Array<object>|null} [p.rects]
 * @param {string} p.shape RoofShape の値
 * @param {boolean} [p.ridgeIsVertical] 切妻の棟が y 方向か
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}
 * @throws {RangeError} 許容差が不正、rect の座標が非有限か逆順
 */
export function roofRidgeLines({ rect, rects = null, shape, ridgeIsVertical, tolMm }) {
  if (shape !== RoofShape.GABLE && shape !== RoofShape.HIP) return [];
  return roofFramingLines({
    rect, rects, shape, ridgeIsVertical, purlinPitchMm: RIDGE_ONLY_PITCH_MM, purlinStartOffsetsMm: RIDGE_ONLY_START_OFFSETS_MM, tolMm,
  }).ridges;
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

// ---- L字（矩形でない）の下屋＝翼ごとの片流れ（ステップ E1a。呼び出し元は E1b。寄棟の翼 hipFramingWings とは別物） ----
//
// 下屋の屋根範囲 P が矩形でないとき、壁（屋内に接する辺）ごとに「その壁から流れる片流れの矩形」＝翼を求める。翼の高い側は
// 壁のある側。壁の上端の高さは全翼で同じなので、母屋の位置（壁からの距離）は全翼で共通の割付を使う。2つの翼が覆う部分
// （壁の角の回り込み）は、各翼の「入り口の辺」（その部分へ延びてきた辺）に近い方の翼が持ち、境目が隅木・谷木になる。

const LEAN_ENTRIES = ['left', 'right', 'top', 'bottom'];
const LEAN_SIDE_RANK = { top: 0, bottom: 1, left: 2, right: 3 };

/** 壁の辺（向き・外側）が表す片流れの高い側。外側が coord の −方向なら壁は屋根の top/left 側。 */
const leanSideOfEdge = (isVertical, outward) => (isVertical ? (outward < 0 ? 'left' : 'right') : (outward < 0 ? 'top' : 'bottom'));
/** 流れが y 方向（top/bottom の翼）か。 */
const leanFlowsAlongY = side => side === 'top' || side === 'bottom';

/** 昇順の配列 arr の中で v に最も近い要素の添字。 */
function nearestIndexOf(arr, v) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[best] - v)) best = i;
  return best;
}

/** 区間 [lo,hi] の組を昇順に並べ、隙間が tol 以下のものを併合する。 */
function mergeRanges(ranges, tol) {
  const merged = [];
  for (const [lo, hi] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + tol) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/** 翼の配列の検査（leanTo* の共通）。 */
function requireLeanToWings(wings) {
  if (!Array.isArray(wings)) throw new RangeError('wings は配列でなければなりません');
  wings.forEach((w, i) => {
    if (!HIGH_SIDES.includes(w?.highSide)) throw new RangeError(`wings[${i}].highSide が不正です: ${w?.highSide}`);
    requireFinite(w.wallCoord, `wings[${i}].wallCoord`);
    requirePositive(w.depthMm, `wings[${i}].depthMm`);
    if (!Array.isArray(w.domain)) throw new RangeError(`wings[${i}].domain は配列でなければなりません`);
    w.domain.forEach((f, k) => {
      for (const key of ['x1', 'y1', 'x2', 'y2']) requireFinite(f?.[key], `wings[${i}].domain[${k}].${key}`);
      if (f.x2 < f.x1 || f.y2 < f.y1) throw new RangeError(`wings[${i}].domain[${k}] の座標が逆順です: ${JSON.stringify(f)}`);
      if (f.entry !== 'direct' && !LEAN_ENTRIES.includes(f.entry)) throw new RangeError(`wings[${i}].domain[${k}].entry が不正です: ${f.entry}`);
    });
  });
}

/**
 * 入り口の辺（延長の部分 f の f.entry。left＝左辺 x=f.x1 から延びてきた）までの距離を、点 (ox+dx·t, oy+dy·t) の t の一次式
 * {sigma, beta}（距離 = sigma·t + beta）で返す。
 */
function leanEntryLinear(f, ox, oy, dx, dy) {
  switch (f.entry) {
    case 'left': return { sigma: dx, beta: ox - f.x1 };
    case 'right': return { sigma: -dx, beta: f.x2 - ox };
    case 'top': return { sigma: dy, beta: oy - f.y1 };
    default: return { sigma: -dy, beta: f.y2 - oy }; // bottom
  }
}

/** 翼の壁からの距離を、点 (ox+dx·t, oy+dy·t) の t の一次式で返す。 */
function leanWallLinear(wing, ox, oy, dx, dy) {
  switch (wing.highSide) {
    case 'top': return { sigma: dy, beta: oy - wing.wallCoord };
    case 'bottom': return { sigma: -dy, beta: wing.wallCoord - oy };
    case 'left': return { sigma: dx, beta: ox - wing.wallCoord };
    default: return { sigma: -dx, beta: wing.wallCoord - ox }; // right
  }
}

/**
 * 一次式 w（距離）が u に勝つ（strict なら <、でなければ ≤。差が tolMm 以内は同距離）t の区間 {lo,hi}（±Infinity あり）。
 * 勝てる t が無ければ null。
 */
function leanWinInterval(w, u, strict, tolMm) {
  const ds = w.sigma - u.sigma;
  const db = w.beta - u.beta;
  if (ds === 0) return (strict ? db < -tolMm : db <= tolMm) ? { lo: -Infinity, hi: Infinity } : null;
  const t = -db / ds;
  return ds > 0 ? { lo: -Infinity, hi: t } : { lo: t, hi: Infinity };
}

/** 区間 J=[jlo,jhi] のうち win（leanWinInterval。null は全く勝てない）の外＝負ける区間。 */
function leanLoseIntervals(jlo, jhi, win) {
  if (!win) return [{ lo: jlo, hi: jhi }];
  const out = [];
  if (win.lo > jlo) out.push({ lo: jlo, hi: Math.min(jhi, win.lo) });
  if (win.hi < jhi) out.push({ lo: Math.max(jlo, win.hi), hi: jhi });
  return out;
}

/**
 * L字（矩形でない）の下屋を、壁ごとの片流れの矩形＝翼に分ける（純関数。ステップ E1a）。
 *  1. 壁の区間＝contacts（屋内に接する屋根範囲の辺の区間。roofBoundaryInteriorContacts）を、同じ向き・同じ直線・同じ外側で
 *     隙間 tolMm 以下を併合し、屋根範囲の外周の辺の上の部分に切る。載らない区間は捨てる。区間が1つも無い（屋内に接さない）
 *     ときは仮の区間（外接矩形が縦長なら left、そうでなければ top。その向きの外周の辺で coord が外接矩形の端のもの全部）。
 *  2. 優先順＝その辺の上の区間の長さの合計（大きい順）→ top→bottom→left→right → coord 昇順 → lo 昇順。
 *  3. 区間ごとに優先順で壁から流れ方向へ「塗られていて印の無い」セルを掃く。外周（塗られていないセル・範囲外）で止まれば
 *     その列は翼になる（奥行き＝壁から外周まで）。印のあるセルで止まれば掃かない。隣り合い奥行きの差が tolMm 以下の列は1翼。
 *  4. 翼ができたら、その翼が覆う流れ方向の各行（left/right の翼は各列）について、横の両側へ「塗られていて直接の印の無い」
 *     セルを進めるだけ進み、延長の印と入り口（右へ延びた部分は 'left'、左へ 'right'、下へ 'top'、上へ 'bottom'）を付ける。
 *     延長の印は重複してよい。後の区間の掃きは延長の印でも止まる。
 *  5. 塗られているのに印が無いセルは unassigned（描かない。probe で報告する）。
 *  6. kindZones＝屋根範囲の外周の辺を、辺の部分ごとに軒（eave）かけらば（gable）に分けたもの。内側のセルを持つ翼（延長のセル
 *     は入り口までの距離が最も近い翼＝leanToOwnerAt）の流れが辺と直交（縦の流れで横の辺・横の流れで縦の辺）なら軒、平行なら
 *     けらば。取り残しのセルの辺は軒。全辺を隙間なく覆う（roofOutline の kindZones に渡す）。
 * 翼＝{highSide, wallCoord, wallEdge:{isVertical,coord,lo,hi,outward}（翼が接する壁の辺の部分）, depthMm, rect, domain}。
 * domain＝{x1,y1,x2,y2,entry}。最初の1つが entry:'direct'（rect そのもの）、以降は延長の部分（流れ方向の行ごとに、翼の端から
 * 止まる所までを1つの矩形にし、同じ範囲で隣り合う行は1つにまとめる。入り口の辺は 'left'＝x1・'right'＝x2・'top'＝y1・'bottom'＝y2）。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形（幅か高さが tolMm 以下は無視。空なら空）
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>} p.contacts 屋内に接する区間
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{wings: Array<object>, unassigned: Array<{x1:number,y1:number,x2:number,y2:number}>,
 *   kindZones: Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1,kind:'eave'|'gable'}>}}
 * @throws {RangeError} tolMm が不正、rects が配列でない・座標が非有限か逆順、contacts が配列でない・値が不正（座標が非有限、
 *   lo>hi、outward が ±1 でない）
 */
export function leanToWingsOf({ rects, contacts, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  if (!Array.isArray(contacts)) throw new RangeError('contacts は配列でなければなりません');
  contacts.forEach((c, i) => {
    if (typeof c?.isVertical !== 'boolean') throw new RangeError(`contacts[${i}].isVertical が不正です: ${c?.isVertical}`);
    for (const k of ['coord', 'lo', 'hi']) requireFinite(c[k], `contacts[${i}].${k}`);
    if (c.hi < c.lo) throw new RangeError(`contacts[${i}] の lo が hi より大きい: ${c.lo} > ${c.hi}`);
    if (c.outward !== 1 && c.outward !== -1) throw new RangeError(`contacts[${i}].outward が不正です: ${c.outward}`);
  });
  const loops = orthogonalBoundaryLoops({ rects, tolMm }); // rects の検査もここ
  if (loops.length === 0) return { wings: [], unassigned: [], kindZones: [] };
  const live = rects.filter(r => r.x2 - r.x1 > tolMm && r.y2 - r.y1 > tolMm);
  const edges = loops.flat();

  // 1. 壁の区間（外周の辺ごとに切って併合）
  const pieces = [];
  edges.forEach((e, ei) => {
    const ranges = contacts
      .filter(c => c.isVertical === e.isVertical && c.outward === e.outward && Math.abs(c.coord - e.coord) <= tolMm)
      .map(c => [Math.max(c.lo, e.lo), Math.min(c.hi, e.hi)])
      .filter(([lo, hi]) => hi - lo > tolMm);
    for (const [lo, hi] of mergeRanges(ranges, tolMm)) pieces.push({ edge: ei, isVertical: e.isVertical, coord: e.coord, outward: e.outward, lo, hi });
  });
  if (pieces.length === 0) { // 接していない下屋
    const minX = Math.min(...live.map(r => r.x1));
    const minY = Math.min(...live.map(r => r.y1));
    const tall = (Math.max(...live.map(r => r.y2)) - minY) - (Math.max(...live.map(r => r.x2)) - minX) > tolMm;
    edges.forEach((e, ei) => {
      if (e.isVertical === tall && e.outward === -1 && Math.abs(e.coord - (tall ? minX : minY)) <= tolMm) {
        pieces.push({ edge: ei, isVertical: e.isVertical, coord: e.coord, outward: e.outward, lo: e.lo, hi: e.hi });
      }
    });
  }

  // 2. 優先順
  const edgeSum = new Map();
  for (const p of pieces) edgeSum.set(p.edge, (edgeSum.get(p.edge) ?? 0) + (p.hi - p.lo));
  const rankOf = p => LEAN_SIDE_RANK[leanSideOfEdge(p.isVertical, p.outward)];
  pieces.sort((a, b) => {
    const diff = edgeSum.get(b.edge) - edgeSum.get(a.edge);
    return (Math.abs(diff) > tolMm ? diff : 0) || rankOf(a) - rankOf(b) || a.coord - b.coord || a.lo - b.lo;
  });

  // 格子と塗り
  const xs = snapSorted([...live.flatMap(r => [r.x1, r.x2]), ...pieces.filter(p => !p.isVertical).flatMap(p => [p.lo, p.hi])], tolMm);
  const ys = snapSorted([...live.flatMap(r => [r.y1, r.y2]), ...pieces.filter(p => p.isVertical).flatMap(p => [p.lo, p.hi])], tolMm);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const filled = Array.from({ length: ny }, (_, j) => Array.from({ length: nx }, (_, i) => {
    const mx = (xs[i] + xs[i + 1]) / 2;
    const my = (ys[j] + ys[j + 1]) / 2;
    return live.some(r => r.x1 < mx && mx < r.x2 && r.y1 < my && my < r.y2);
  }));
  const direct = Array.from({ length: ny }, () => new Array(nx).fill(-1)); // 直接の印（翼の番号）
  const ext = Array.from({ length: ny }, () => Array.from({ length: nx }, () => [])); // 延長の印（翼の番号。重複可）
  const blocked = (i, j) => direct[j][i] >= 0 || ext[j][i].length > 0;

  // 3.・4. 掃きと延長
  const wings = [];
  for (const piece of pieces) {
    const side = leanSideOfEdge(piece.isVertical, piece.outward);
    const flowY = leanFlowsAlongY(side);
    const laneArr = flowY ? xs : ys;
    const stepArr = flowY ? ys : xs;
    const dir = side === 'top' || side === 'left' ? 1 : -1;
    const wallIdx = nearestIndexOf(stepArr, piece.coord);
    const wallCoord = stepArr[wallIdx];
    const first = dir > 0 ? wallIdx : wallIdx - 1;
    const ns = stepArr.length - 1;
    const nl = laneArr.length - 1;
    const cellOf = (l, s) => (flowY ? [l, s] : [s, l]);
    const swept = [];
    for (let l = 0; l < nl; l++) {
      if (laneArr[l] < piece.lo - tolMm || laneArr[l + 1] > piece.hi + tolMm) continue;
      let s = first;
      while (s >= 0 && s < ns) {
        const [i, j] = cellOf(l, s);
        if (!filled[j][i] || blocked(i, j)) break;
        s += dir;
      }
      if (s >= 0 && s < ns) { // 途中で止まった: 塗られていない（外周）なら掃けた、印のあるセルなら掃けない
        const [i, j] = cellOf(l, s);
        if (filled[j][i]) continue;
      }
      const depth = Math.abs((dir > 0 ? stepArr[s] : stepArr[s + 1]) - wallCoord);
      if (depth > tolMm) swept.push({ l, s, depth });
    }
    const groups = [];
    for (const sw of swept) {
      const g = groups[groups.length - 1];
      if (g && sw.l === g[g.length - 1].l + 1 && Math.abs(sw.depth - g[0].depth) <= tolMm) g.push(sw);
      else groups.push([sw]);
    }
    const made = groups.map(g => {
      const idx = wings.length;
      for (const { l, s } of g) for (let t = first; t !== s; t += dir) { const [i, j] = cellOf(l, t); direct[j][i] = idx; }
      const l0 = g[0].l;
      const l1 = g[g.length - 1].l;
      const far = dir > 0 ? stepArr[g[0].s] : stepArr[g[0].s + 1];
      const [flowLo, flowHi] = dir > 0 ? [wallCoord, far] : [far, wallCoord];
      const rect = flowY
        ? { x1: laneArr[l0], y1: flowLo, x2: laneArr[l1 + 1], y2: flowHi }
        : { x1: flowLo, y1: laneArr[l0], x2: flowHi, y2: laneArr[l1 + 1] };
      const wing = {
        highSide: side, wallCoord,
        wallEdge: { isVertical: !flowY, coord: wallCoord, lo: laneArr[l0], hi: laneArr[l1 + 1], outward: dir > 0 ? -1 : 1 },
        depthMm: g[0].depth, rect, domain: [{ ...rect, entry: 'direct' }],
      };
      wings.push(wing);
      return { idx, wing, l0, l1, s0: g[0].s };
    });
    for (const { idx, wing, l0, l1, s0 } of made) { // 延長（その区間の翼がすべて直接の印を持ってから）
      const rows = [];
      for (let t = first; t !== s0; t += dir) rows.push(t);
      rows.sort((a, b) => a - b);
      const runs = [];
      for (const r of rows) {
        for (const [up, entry] of [[1, flowY ? 'left' : 'top'], [-1, flowY ? 'right' : 'bottom']]) {
          let l = up > 0 ? l1 + 1 : l0 - 1;
          let end = up > 0 ? l1 : l0;
          while (l >= 0 && l < nl) {
            const [i, j] = cellOf(l, r);
            if (!filled[j][i] || direct[j][i] >= 0) break;
            ext[j][i].push(idx);
            end = l;
            l += up;
          }
          if (end === (up > 0 ? l1 : l0)) continue;
          const [laneLo, laneHi] = up > 0 ? [laneArr[l1 + 1], laneArr[end + 1]] : [laneArr[end], laneArr[l0]];
          runs.push(flowY
            ? { x1: laneLo, y1: stepArr[r], x2: laneHi, y2: stepArr[r + 1], entry }
            : { x1: stepArr[r], y1: laneLo, x2: stepArr[r + 1], y2: laneHi, entry });
        }
      }
      for (const run of runs) { // 同じ入り口・同じ範囲で流れ方向に隣り合う行は1つ
        const prev = wing.domain.find(m => m.entry === run.entry && (flowY
          ? m.x1 === run.x1 && m.x2 === run.x2 && m.y2 === run.y1
          : m.y1 === run.y1 && m.y2 === run.y2 && m.x2 === run.x1));
        if (prev) { if (flowY) prev.y2 = run.y2; else prev.x2 = run.x2; } else wing.domain.push(run);
      }
    }
  }

  // 5. 取り残し
  const unassigned = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) if (filled[j][i] && !blocked(i, j)) unassigned.push({ x1: xs[i], y1: ys[j], x2: xs[i + 1], y2: ys[j + 1] });
  }

  // 6. 辺の種別
  const kindOf = (owner, isVertical) => (owner === null ? 'eave' : (isVertical === leanFlowsAlongY(wings[owner].highSide) ? 'gable' : 'eave'));
  const kindZones = [];
  for (const e of edges) {
    const alongArr = e.isVertical ? ys : xs;
    const acrossArr = e.isVertical ? xs : ys;
    const ci = nearestIndexOf(acrossArr, e.coord);
    const inner = e.outward < 0 ? ci : ci - 1; // 内側のセルの across 方向の添字
    const parts = [];
    for (let l = 0; l + 1 < alongArr.length; l++) {
      const a = alongArr[l];
      const b = alongArr[l + 1];
      if (a < e.lo - tolMm || b > e.hi + tolMm) continue;
      const [i, j] = e.isVertical ? [inner, l] : [l, inner];
      if (direct[j][i] >= 0) { parts.push({ lo: a, hi: b, kind: kindOf(direct[j][i], e.isVertical) }); continue; }
      if (ext[j][i].length === 0) { parts.push({ lo: a, hi: b, kind: 'eave' }); continue; }
      // 延長のセル: 候補の入り口までの距離が等しくなる点で切り、部分ごとの中点の所有者で決める
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      const [ox, oy, dx, dy] = e.isVertical ? [e.coord, 0, 0, 1] : [0, e.coord, 1, 0];
      const lines = [];
      for (const w of wings) {
        for (const f of w.domain) {
          if (f.entry !== 'direct' && f.x1 <= cx && cx <= f.x2 && f.y1 <= cy && cy <= f.y2) lines.push(leanEntryLinear(f, ox, oy, dx, dy));
        }
      }
      const cuts = [];
      for (let p = 0; p < lines.length; p++) {
        for (let q = p + 1; q < lines.length; q++) {
          if (lines[p].sigma === lines[q].sigma) continue;
          const t = (lines[q].beta - lines[p].beta) / (lines[p].sigma - lines[q].sigma);
          if (t > a + tolMm && t < b - tolMm) cuts.push(t);
        }
      }
      const bounds = [a, ...snapSorted(cuts, tolMm), b];
      for (let k = 0; k + 1 < bounds.length; k++) {
        const m = (bounds[k] + bounds[k + 1]) / 2;
        const owner = leanToOwnerAt(wings, e.isVertical ? e.coord : m, e.isVertical ? m : e.coord, tolMm);
        parts.push({ lo: bounds[k], hi: bounds[k + 1], kind: kindOf(owner, e.isVertical) });
      }
    }
    const joined = [];
    for (const p of parts) {
      const last = joined[joined.length - 1];
      if (last && last.kind === p.kind) last.hi = p.hi;
      else joined.push({ ...p });
    }
    for (const p of joined) kindZones.push({ isVertical: e.isVertical, coord: e.coord, lo: p.lo, hi: p.hi, outward: e.outward, kind: p.kind });
  }
  return { wings, unassigned, kindZones };
}

/**
 * 点 (x,y) を持つ翼の番号（leanToWingsOf の翼。どの翼にも無ければ null）。点を含む部分（domain。許容差込み）を持つ翼が候補で、
 * 直接（'direct'）があればその翼（同じ点を2つの翼が直接で持つのは境界上だけ＝番号の小さい方）、無ければ延長の入り口の辺までの
 * 距離が最小の翼（'left'→x−x1、'right'→x2−x、'top'→y−y1、'bottom'→y2−y。差が tolMm 以内は同距離＝番号の小さい翼）。
 * @param {Array<object>} wings
 * @param {number} x
 * @param {number} y
 * @param {number} tolMm 許容差（>=0）
 * @returns {number|null}
 * @throws {RangeError} 許容差・座標が不正、wings が不正
 */
export function leanToOwnerAt(wings, x, y, tolMm) {
  requireNonNegative(tolMm, 'tolMm');
  requireFinite(x, 'x');
  requireFinite(y, 'y');
  requireLeanToWings(wings);
  let directOwner = null;
  let best = null;
  let bestDist = Infinity;
  wings.forEach((w, idx) => {
    for (const f of w.domain) {
      if (x < f.x1 - tolMm || x > f.x2 + tolMm || y < f.y1 - tolMm || y > f.y2 + tolMm) continue;
      if (f.entry === 'direct') { if (directOwner === null) directOwner = idx; continue; }
      const dist = leanEntryLinear(f, x, y, 0, 0).beta; // 方向 0 なので距離は定数 beta
      if (dist < bestDist - tolMm) { best = idx; bestDist = dist; }
    }
  });
  return directOwner ?? best;
}

/**
 * L字の下屋（翼）の母屋（片流れに棟木は無い）。割付は下屋全体で1つ＝最大奥行きの翼で purlinLayoutFromRidge を1回求め、
 * 各翼は割付のうち自分の奥行き未満（tolMm）の位置だけに置く（壁の上端の高さが全翼で同じなので、同じ位置は同じ高さ）。
 * 位置は壁から wallCoord ± offset（top/left は +、bottom/right は −）。top/bottom の翼は横線、left/right の翼は縦線。
 * 線の範囲は、翼の直接の部分は翼の幅いっぱい、延長の部分は（同じ点を持つ他の翼との比較で）自分の入り口までの距離が
 * 他の翼以下（番号の小さい翼には未満）の区間。長さ tolMm 以下は捨て、同じ線（向き・座標・高い側・壁の座標）で接するものは1本。
 * @param {object} p
 * @param {Array<object>} p.wings leanToWingsOf の wings
 * @param {number} p.pitchMm 母屋のピッチ（>0。例 910）
 * @param {number[]} p.startOffsetsMm 1本目の位置の候補（空でない。各 >0。例 [455, 910]）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{ridges: [], purlins: Array<{isVertical:boolean,coord:number,lo:number,hi:number,offsetMm:number}>}}
 * @throws {RangeError} ピッチ・候補・許容差が不正、wings が不正
 */
export function leanToMonoLines({ wings, pitchMm, startOffsetsMm, tolMm }) {
  const groups = leanToPurlinGroups({ wings, pitchMm, startOffsetsMm, tolMm });
  const purlins = [];
  for (const g of groups) {
    for (const [lo, hi] of mergeRanges(g.segs, GEOM_EPS)) {
      if (hi - lo > tolMm) purlins.push({ isVertical: g.isVertical, coord: g.coord, lo, hi, offsetMm: g.offsetMm });
    }
  }
  return { ridges: [], purlins: sortLines(purlins) };
}

/**
 * L字の下屋（翼）の母屋を「面」ごとに分ける。面＝同じ壁（highSide・wallCoord）の翼の集まり（leanToMonoLines が線をつなぐ単位）。
 * 線の割付・範囲・つなぎは leanToMonoLines と同じで、全面の lines を合わせて sortLines すると leanToMonoLines の purlins と一致する。
 * 面は wings を番号順に走査して作り、並びは属する翼の最小番号順。線の無い面も lines: [] で返す。
 * @param {object} p leanToMonoLines と同じ
 * @returns {Array<{highSide:string, wallCoord:number, wingIndices:number[], lineIsVertical:boolean,
 *   lines: Array<{isVertical:boolean,coord:number,lo:number,hi:number,offsetMm:number}>}>}
 *   lineIsVertical は left/right の面で true（線の向き。top/bottom は false）。lines は sortLines 済み
 * @throws {RangeError} ピッチ・候補・許容差が不正、wings が不正
 */
export function leanToMonoPlanes({ wings, pitchMm, startOffsetsMm, tolMm }) {
  const groups = leanToPurlinGroups({ wings, pitchMm, startOffsetsMm, tolMm });
  const planes = new Map();
  wings.forEach((w, wi) => {
    const key = `${w.highSide}|${w.wallCoord}`;
    if (!planes.has(key)) {
      planes.set(key, { highSide: w.highSide, wallCoord: w.wallCoord, wingIndices: [], lineIsVertical: !leanFlowsAlongY(w.highSide), lines: [] });
    }
    planes.get(key).wingIndices.push(wi);
  });
  for (const g of groups) {
    const plane = planes.get(`${g.highSide}|${g.wallCoord}`);
    for (const [lo, hi] of mergeRanges(g.segs, GEOM_EPS)) {
      if (hi - lo > tolMm) plane.lines.push({ isVertical: g.isVertical, coord: g.coord, lo, hi, offsetMm: g.offsetMm });
    }
  }
  return [...planes.values()].map(p => ({ ...p, lines: sortLines(p.lines) }));
}

// leanToMonoLines・leanToMonoPlanes の共通部: 入力検査と、線ごとの区間の集まり（highSide・wallCoord つき。翼を番号順に走査した順）
function leanToPurlinGroups({ wings, pitchMm, startOffsetsMm, tolMm }) {
  requireLeanToWings(wings);
  requirePositive(pitchMm, 'pitchMm');
  if (!Array.isArray(startOffsetsMm) || startOffsetsMm.length === 0) {
    throw new RangeError('startOffsetsMm は空でない配列でなければなりません');
  }
  for (const s of startOffsetsMm) requirePositive(s, 'startOffsetsMm の要素');
  requireNonNegative(tolMm, 'tolMm');
  if (wings.length === 0) return [];
  const { offsetsMm } = purlinLayoutFromRidge({ halfSpanMm: Math.max(...wings.map(w => w.depthMm)), pitchMm, startOffsetsMm, tolMm });

  // 向き isVertical・座標 p の線が、翼 wi の部分 f を通る区間（延長は他の翼との比較で自分のものになる区間だけ）
  const segmentsIn = (wi, f, isVertical, p) => {
    const [flowLo, flowHi, alongLo, alongHi] = isVertical ? [f.x1, f.x2, f.y1, f.y2] : [f.y1, f.y2, f.x1, f.x2];
    if (f.entry === 'direct') return p >= flowLo - tolMm && p <= flowHi + tolMm ? [[alongLo, alongHi]] : [];
    if (!(p >= flowLo - tolMm && p < flowHi - tolMm)) return [];
    const [ox, oy, dx, dy] = isVertical ? [p, 0, 0, 1] : [0, p, 1, 0];
    const mine = leanEntryLinear(f, ox, oy, dx, dy);
    const lose = [];
    wings.forEach((u, ui) => {
      if (ui === wi) return;
      for (const g of u.domain) {
        if (g.entry === 'direct') continue;
        const [gFlowLo, gFlowHi, gLo, gHi] = isVertical ? [g.x1, g.x2, g.y1, g.y2] : [g.y1, g.y2, g.x1, g.x2];
        if (!(p >= gFlowLo - tolMm && p < gFlowHi - tolMm)) continue;
        const jlo = Math.max(alongLo, gLo);
        const jhi = Math.min(alongHi, gHi);
        if (jhi - jlo <= 0) continue;
        lose.push(...leanLoseIntervals(jlo, jhi, leanWinInterval(mine, leanEntryLinear(g, ox, oy, dx, dy), ui < wi, tolMm)));
      }
    });
    return subtractIntervals(alongLo, alongHi, lose, tolMm).map(s => [s.lo, s.hi]);
  };

  const groups = new Map();
  wings.forEach((w, wi) => {
    const isVertical = !leanFlowsAlongY(w.highSide);
    const sign = w.highSide === 'top' || w.highSide === 'left' ? 1 : -1;
    for (const o of offsetsMm) {
      if (o >= w.depthMm - tolMm) continue;
      const coord = w.wallCoord + sign * o;
      const key = `${isVertical}|${coord}|${w.highSide}|${w.wallCoord}`;
      if (!groups.has(key)) groups.set(key, { isVertical, coord, offsetMm: o, highSide: w.highSide, wallCoord: w.wallCoord, segs: [] });
      for (const f of w.domain) groups.get(key).segs.push(...segmentsIn(wi, f, isVertical, coord));
    }
  });
  return [...groups.values()];
}

/**
 * L字の下屋（翼）の継ぎ目＝隅木・谷木（斜め線）。2つの翼の延長の部分（入り口が直交する組）が重なる矩形の中で、2つの入り口の辺が
 * 交わる角から 45° に、入り口までの距離が等しい点の軌跡（線分）。他の翼の延長の部分がある所では、その翼の入り口までの距離が
 * 自分たちより小さい区間を除く。両端で2つの翼の壁からの距離が等しい（tolMm 以内）線だけ描く（等しくない＝壁の上端の高さが
 * 合わない組は mismatches に返し、描かない）。壁からの距離が線に沿って増えれば隅木 'hip'、減れば谷木 'valley'。
 * (x1,y1)＝壁からの距離が大きい端（軒側）、(x2,y2)＝小さい端（orthogonalHipDiagonals と同じ約束）。同種別・同直線で接するものは
 * 1本にまとめる。長さ（x の幅）が tolMm 以下は捨てる。並びは kind（hip→valley）・x1・y1・x2・y2 の昇順。
 * 向かい合う壁の翼（入り口が平行）や段違いの壁の翼は継ぎ目を描かない（既知の限界）。
 * @param {object} p
 * @param {Array<object>} p.wings leanToWingsOf の wings
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{diagonals: Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>,
 *   mismatches: Array<{wingA:number, wingB:number, x1:number, y1:number, x2:number, y2:number}>}}
 * @throws {RangeError} 許容差が不正、wings が不正
 */
export function leanToSeams({ wings, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  requireLeanToWings(wings);
  const exts = [];
  wings.forEach((w, wi) => { for (const f of w.domain) if (f.entry !== 'direct') exts.push({ wi, f }); });
  const segs = [];
  const mismatches = [];
  for (let p = 0; p < exts.length; p++) {
    for (let q = p + 1; q < exts.length; q++) {
      if (exts[p].wi === exts[q].wi) continue;
      const horizontalEntry = e => e === 'left' || e === 'right';
      if (horizontalEntry(exts[p].f.entry) === horizontalEntry(exts[q].f.entry)) continue; // 入り口が平行は継ぎ目なし
      const [A, B] = horizontalEntry(exts[p].f.entry) ? [exts[p], exts[q]] : [exts[q], exts[p]];
      const O = { x1: Math.max(A.f.x1, B.f.x1), y1: Math.max(A.f.y1, B.f.y1), x2: Math.min(A.f.x2, B.f.x2), y2: Math.min(A.f.y2, B.f.y2) };
      if (O.x2 - O.x1 <= tolMm || O.y2 - O.y1 <= tolMm) continue;
      const sx = A.f.entry === 'left' ? 1 : -1;
      const sy = B.f.entry === 'top' ? 1 : -1;
      const px = A.f.entry === 'left' ? A.f.x1 : A.f.x2;
      const py = B.f.entry === 'top' ? B.f.y1 : B.f.y2;
      // 点 (px+sx·s, py+sy·s) が矩形 R の中にある s の区間
      const within = R => {
        const [xa, xb] = sx > 0 ? [R.x1 - px, R.x2 - px] : [px - R.x2, px - R.x1];
        const [ya, yb] = sy > 0 ? [R.y1 - py, R.y2 - py] : [py - R.y2, py - R.y1];
        return [Math.max(xa, ya), Math.min(xb, yb)];
      };
      const [lo0, hi] = within(O);
      const lo = Math.max(0, lo0);
      if (hi - lo <= tolMm) continue;
      // 他の翼の延長の部分: 入り口までの距離が s（A・B の距離）より小さい区間は継ぎ目でない
      const lose = [];
      wings.forEach((w, wi) => {
        if (wi === A.wi || wi === B.wi) return;
        for (const g of w.domain) {
          if (g.entry === 'direct') continue;
          const [glo, ghi] = within(g);
          const jlo = Math.max(lo, glo);
          const jhi = Math.min(hi, ghi);
          if (jhi - jlo <= 0) continue;
          const { sigma, beta } = leanEntryLinear(g, px, py, sx, sy);
          // 継ぎ目が有効＝距離 sigma·s+beta ≥ s ⇔ (sigma−1)·s + beta ≥ 0
          const c1 = sigma - 1;
          let valid;
          if (c1 === 0) valid = beta >= -tolMm ? { lo: -Infinity, hi: Infinity } : null;
          else if (c1 < 0) valid = { lo: -Infinity, hi: -beta / c1 };
          else valid = { lo: -beta / c1, hi: Infinity };
          lose.push(...leanLoseIntervals(jlo, jhi, valid));
        }
      });
      const wallA = leanWallLinear(wings[A.wi], px, py, sx, sy);
      const wallB = leanWallLinear(wings[B.wi], px, py, sx, sy);
      for (const piece of subtractIntervals(lo, hi, lose, tolMm)) {
        const at = s => ({ x: px + sx * s, y: py + sy * s });
        const a = at(piece.lo);
        const b = at(piece.hi);
        const gapLo = Math.abs((wallA.sigma * piece.lo + wallA.beta) - (wallB.sigma * piece.lo + wallB.beta));
        const gapHi = Math.abs((wallA.sigma * piece.hi + wallA.beta) - (wallB.sigma * piece.hi + wallB.beta));
        if (gapLo > tolMm || gapHi > tolMm) {
          mismatches.push({ wingA: A.wi, wingB: B.wi, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          continue;
        }
        const kind = wallA.sigma > 0 ? 'hip' : 'valley';
        const [far, near] = kind === 'hip' ? [b, a] : [a, b];
        segs.push({ kind, sx, sy, far, near, key: `${kind}|${sx * sy}|${sx * sy > 0 ? far.x - far.y : far.x + far.y}` });
      }
    }
  }
  // 同種別・同直線で接するものは1本（s の増える向き＝sx·x の増える向きで併合）
  const byKey = new Map();
  for (const s of segs) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  const diagonals = [];
  for (const list of byKey.values()) {
    const { kind, sx, sy } = list[0];
    // 各線分を s の小さい側→大きい側の (u0,u1)（u＝sx·x）にして併合する。軒側＝hip は大きい側、valley は小さい側
    const spans = list.map(s => {
      const [p0, p1] = kind === 'hip' ? [s.near, s.far] : [s.far, s.near]; // s の小さい側→大きい側
      return [sx * p0.x, sx * p1.x];
    });
    const anchor = list[0].far;
    const yAt = x => (sx * sy > 0 ? x - anchor.x + anchor.y : anchor.y + anchor.x - x);
    for (const [u0, u1] of mergeRanges(spans, GEOM_EPS)) {
      const small = { x: sx * u0, y: yAt(sx * u0) };
      const large = { x: sx * u1, y: yAt(sx * u1) };
      const [far, near] = kind === 'hip' ? [large, small] : [small, large];
      diagonals.push({ kind, x1: far.x, y1: far.y, x2: near.x, y2: near.y });
    }
  }
  const kindRank = k => (k === 'hip' ? 0 : 1);
  diagonals.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2);
  return { diagonals, mismatches };
}
