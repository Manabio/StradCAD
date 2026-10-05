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
 * orthogonalHipLines（rects＝セル矩形。ステップ C2e-2）で棟木・母屋を導く。矩形でない切妻・片流れは、水下（leanToDrains）を渡さなければ空を返す。
 * 寄棟の隅木・谷木（斜め線）は棟木・母屋とは別の配列で、roofHipDiagonals / orthogonalHipDiagonals（ステップ C2e-2b）。
 * 矩形でない下屋の片流れ（L字）は、壁ごとの翼（leanToWingsOf。ステップ E1a）から流れの向きと辺の種別・水下（drains）を決め、
 * 母屋・棟木・継ぎ目の隅木・谷木は水下への L∞ 距離の場（leanToDrainFraming）で導く。leanToDrains 引数を渡したときだけ返す
 * （渡さなければ空）。小屋梁（woodRoofFraming.js）も同じ場の面（水下ごと）を使う。矩形でない下屋の切妻（腕ごとに棟木）は、
 * 軒とけらばを辺を掃いて決め（gableArmDrainsOf）、その水下を同じ場に渡す（形状は問わない）。
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
 * @param {number} [p.firstLevelMm] 母屋の段の始まり（軒から1本目の母屋までの距離。>0）。母屋の段は firstLevelMm + k*pitchMm
 *   （k=0,1,…）。省略（既定）なら pitchMm＝今までどおり k*pitchMm（k=1,2,…）。L字の下屋の場（leanToDrainFraming）が、
 *   長手方向の翼の軒までの残りを段の始まりに渡す
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{ridges: Array<object>, purlins: Array<object>}}
 * @throws {RangeError} pitchMm・firstLevelMm・tolMm が不正、rects が配列でない、座標が非有限か逆順
 */
export function orthogonalHipLines({ rects, pitchMm, firstLevelMm, tolMm }) {
  requirePositive(pitchMm, 'pitchMm');
  if (firstLevelMm !== undefined) requirePositive(firstLevelMm, 'firstLevelMm');
  requireNonNegative(tolMm, 'tolMm');
  const field = buildOrthoField(rects, tolMm);
  if (!field) return { ridges: [], purlins: [] };
  const { fits, S } = field;

  // 3. 段の集合。棟木の段 H＝座標の対の差の半分、母屋の段 D＝k*pitchMm（H の値と tolMm 以内なら H の値に寄せる）
  const ridgeLevels = ridgeLevelsOf(field, tolMm);
  const levels = ridgeLevels.map(d => ({ d, ridge: true, purlin: false }));
  const purlinLevelAt = k => (firstLevelMm === undefined ? k * pitchMm : firstLevelMm + (k - 1) * pitchMm); // k=1 が1本目
  for (let k = 1; purlinLevelAt(k) <= S + tolMm; k++) {
    const d = purlinLevelAt(k);
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
 * rects（セル矩形）を検査し、幅と高さが tolMm を超えるものだけ返す（空なら空配列）。
 * @throws {RangeError} rects が配列でない、座標が非有限か逆順
 */
function liveRectsOf(rects, tolMm) {
  if (!Array.isArray(rects)) throw new RangeError('rects は配列でなければなりません');
  rects.forEach((r, i) => {
    for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(r?.[k], `rects[${i}].${k}`);
    if (r.x2 < r.x1 || r.y2 < r.y1) throw new RangeError(`rects[${i}] の座標が逆順です: ${JSON.stringify(r)}`);
  });
  return rects.filter(r => r.x2 - r.x1 > tolMm && r.y2 - r.y1 > tolMm);
}

/**
 * 直交多角形の寄棟の共通の下ごしらえ（orthogonalHipLines・orthogonalHipDiagonals が共用）。rects を検査し、
 * 座標を圧縮した格子・収まり判定・段の候補を返す。使える矩形が無ければ null。
 * @throws {RangeError} rects が配列でない、座標が非有限か逆順
 */
function buildOrthoField(rects, tolMm) {
  const live = liveRectsOf(rects, tolMm);
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
 * @param {Array<object>|null} [p.leanToDrains] L字の下屋の水下（leanToWingsOf／gableArmDrainsOf の drains。rect=null の片流れ・切妻。既定 null）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>}
 * @throws {RangeError} 許容差が不正、rect の座標が非有限か逆順、leanToDrains が不正
 */
export function roofHipDiagonals({ rect, rects = null, shape, leanToDrains = null, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  // 下屋の水下の場の経路（rect=null・水下＝leanToDrainRoute の drains）は水下への距離の場の継ぎ目（隅木・谷木）。形状は問わない
  // （片流れ・切妻・寄棟）。斜め線の入口はここ1つ。ピッチは斜め線に効かない。
  // 水下を寄棟（全辺軒）より先に見る（roofFramingLines と同じ順。壁に接する下屋の寄棟は水下を持つ region）
  if (!rect && Array.isArray(leanToDrains)) {
    return leanToDrainField({ rects, drains: leanToDrains, tolMm }, { diagonals: true }).diagonals;
  }
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
    if (a > pos) parts.push({ lo: pos, hi: a, overhangMm: base, baseMm: base, covered: false });
    parts.push({ lo: a, hi: b, overhangMm: 0, baseMm: base, covered: true });
    pos = b;
  }
  if (edge.hi > pos) parts.push({ lo: pos, hi: edge.hi, overhangMm: base, baseMm: base, covered: false });
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
  const wraps = outlineWrapCorners(args);
  const outline = partLoops.map(parts => {
    const points = [];
    parts.forEach((p, i) => {
      const q = parts[(i + 1) % parts.length];
      if (p.isVertical !== q.isVertical) { // 直交する辺: 2本の線の交点
        const v = p.isVertical ? p : q;
        const h = p.isVertical ? q : p;
        const wrap = wrapAtCorner(wraps, v.coord, h.coord, args.tolMm);
        if (wrap) points.push(...wrapPolyline(wrap)); // 建物の出隅は回り込む（B の線を V の先へ w 延ばして壁の線へ戻る）
        else points.push(shifted(v), shifted(h));
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
    return parts.map(p => ({ isVertical: edge.isVertical, coord: edge.coord, lo: p.lo, hi: p.hi, outward: edge.outward, dir: edge.dir, overhangMm: p.overhangMm, baseMm: p.baseMm, covered: p.covered }));
  }));
}

/**
 * 外形線が建物の出隅を回り込む角（ユーザー指示2026-10-04）。屋根範囲の出隅（凸の角）V で、屋内に接する辺 A（出幅 0）と
 * 出幅 h>0 の辺 B が出会い、V の対角（A の向こう側かつ B の向こう側）が屋内でない（＝V が建物の出隅）とき、B を平行移動した線を
 * V の先へ w だけ延ばし、直角に折って B の線（建物の外壁の線）まで戻る。w＝A が屋内に接していなければ持つ出幅（A の種別の出幅）。
 * ただし B の線に沿って V の先に屋内が A 側に続く長さ（外壁がある長さ）と、対角側（B の外側の出幅の帯）に屋内が現れるまでの長さを
 * 超えない。0 になれば回り込まない（V の対角が屋内＝壁が続く角はこの 0 で今までどおり）。屋内は interiorRects（建物範囲のセル矩形）
 * との重なりで判定する。interiorRects が無い・空なら回り込みなし（今までと同じ）。
 * @param {object} args roofOutline と同じ（interiorRects を持つ）
 * @returns {Array<{x:number,y:number,ux:number,uy:number,sx:number,sy:number,w:number,h:number,aIsPrev:boolean}>}
 *   x,y＝V。(ux,uy)＝V の先（B の線に沿って A の外向き）、(sx,sy)＝B の外向き。h＝B の出幅。aIsPrev＝閉路の進行で A が V の手前か
 */
function outlineWrapCorners(args) {
  const rects = (Array.isArray(args.interiorRects) ? args.interiorRects : [])
    .filter(r => r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite) && r.x2 > r.x1 && r.y2 > r.y1);
  if (rects.length === 0) return [];
  const tolMm = args.tolMm;
  const wraps = [];
  for (const parts of outlinePartLoops(args, true)) {
    parts.forEach((p, i) => {
      const q = parts[(i + 1) % parts.length];
      if (p.isVertical === q.isVertical || p.covered === q.covered) return;
      const a = p.covered ? p : q; // 屋内に接する辺（出幅 0）
      const b = p.covered ? q : p; // 出幅のある辺
      if (!(a.baseMm > 0) || !(b.overhangMm > 0)) return;
      // 凸の角か: 閉路の進行で p は V で終わり q は V から始まる。V から見た各辺の伸びる向きと、屋根のある側（外向きの反対）が一致
      const vert = p.isVertical ? p : q;
      const hor = p.isVertical ? q : p;
      const dv = p.isVertical ? -p.dir : q.dir;
      const dh = p.isVertical ? q.dir : -p.dir;
      if (vert.outward !== -dh || hor.outward !== -dv) return;
      const x = vert.coord;
      const y = hor.coord;
      const uSign = a.outward;
      const sSign = b.outward;
      // 各セル矩形を V 原点の (u, s) 座標（u＝B の線に沿って V の先・s＝B の外向き）の範囲にする
      const ranges = rects.map(r => {
        const [ua, ub] = b.isVertical ? [(r.y1 - y) * uSign, (r.y2 - y) * uSign] : [(r.x1 - x) * uSign, (r.x2 - x) * uSign];
        const [sa, sb] = b.isVertical ? [(r.x1 - x) * sSign, (r.x2 - x) * sSign] : [(r.y1 - y) * sSign, (r.y2 - y) * sSign];
        return { u1: Math.min(ua, ub), u2: Math.max(ua, ub), s1: Math.min(sa, sb), s2: Math.max(sa, sb) };
      });
      // 外壁が続く長さ: B の線（s=0）に A 側（s<0）から接する屋内セルを、u=0 から連続する分だけ
      const abut = ranges.filter(r => Math.abs(r.s2) <= tolMm && r.s1 < -tolMm);
      let reach = 0;
      for (let moved = true; moved;) {
        moved = false;
        for (const r of abut) if (r.u1 <= reach + tolMm && r.u2 > reach) { reach = r.u2; moved = true; }
      }
      // 対角側に屋内が現れるまでの長さ: B の外側の出幅の帯（0<s<h）に重なる屋内セルの、V の先（u>0）の最も手前
      const inBand = ranges.filter(r => r.s2 > tolMm && r.s1 < b.overhangMm - tolMm && r.u2 > tolMm);
      const diagonal = Math.min(Infinity, ...inBand.map(r => Math.max(r.u1, 0)));
      const w = Math.min(a.baseMm, reach, diagonal);
      if (!(w > tolMm)) return;
      wraps.push({
        x, y, w, h: b.overhangMm, aIsPrev: p.covered,
        ux: b.isVertical ? 0 : uSign, uy: b.isVertical ? uSign : 0,
        sx: b.isVertical ? sSign : 0, sy: b.isVertical ? 0 : sSign,
      });
    });
  }
  return wraps;
}

/** 角 (x,y) の回り込み（無ければ undefined）。 */
function wrapAtCorner(wraps, x, y, tolMm) {
  return wraps.find(c => Math.abs(c.x - x) <= tolMm && Math.abs(c.y - y) <= tolMm);
}

/** 回り込みの3点（x,y の並び）。V・W1（V の先 w）・W2（W1 から B の外向きへ h）。閉路の進行で A が手前なら V→W1→W2、後ろなら逆。 */
function wrapPolyline(c) {
  const { v, w1, w2 } = wrapPoints(c);
  return c.aIsPrev ? [...v, ...w1, ...w2] : [...w2, ...w1, ...v];
}

function wrapPoints(c) {
  const v = [c.x, c.y];
  const w1 = [c.x + c.ux * c.w, c.y + c.uy * c.w];
  const w2 = [w1[0] + c.sx * c.h, w1[1] + c.sy * c.h];
  return { v, w1, w2 };
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
  const wraps = outlineWrapCorners(args);
  const wrapBetween = (a, b) => {
    if (a.isVertical === b.isVertical) return undefined;
    const v = a.isVertical ? a : b;
    const h = a.isVertical ? b : a;
    return wrapAtCorner(wraps, v.coord, h.coord, args.tolMm);
  };
  for (const parts of outlinePartLoops(args, true)) {
    const n = parts.length;
    // 線分（from→to）の列。部分ごとの線（移した直線の上）と、出幅の変わる同一直線上の段差の小辺を進行順に並べる。隣り合う線分は端が接する
    const segs = [];
    parts.forEach((p, i) => {
      const prev = parts[(i + n - 1) % n];
      const next = parts[(i + 1) % n];
      const across = outlineShifted(p);
      const pt = (along, at = across) => (p.isVertical ? [at, along] : [along, at]);
      // 建物の出隅の回り込み（roofOutline と同じ角）。出幅のある辺 B は V の先 W1 まで延び、W1 から B の線（V の側）へ戻る
      const wrapStart = wrapBetween(prev, p);
      const wrapEnd = wrapBetween(p, next);
      const alongOfW1 = c => (p.isVertical ? c.y + c.uy * c.w : c.x + c.ux * c.w);
      // 端の along 座標: 隣が直交する辺なら隣の移した線の位置（頂点）、同じ直線上の続きなら部分自身の端
      const startAlong = wrapStart && !p.covered ? alongOfW1(wrapStart)
        : prev.isVertical !== p.isVertical ? outlineShifted(prev) : (p.dir > 0 ? p.lo : p.hi);
      const endAlong = wrapEnd && !p.covered ? alongOfW1(wrapEnd)
        : next.isVertical !== p.isVertical ? outlineShifted(next) : (p.dir > 0 ? p.hi : p.lo);
      segs.push({ from: pt(startAlong), to: pt(endAlong), drawn: !p.covered });
      if (wrapEnd) { // B から A へ（B が手前）: 戻りの線（描く）と壁の線の上の部分（描かない）。A から B へは逆の順
        const { v, w1, w2 } = wrapPoints(wrapEnd);
        if (p.covered) segs.push({ from: v, to: w1, drawn: false }, { from: w1, to: w2, drawn: true });
        else segs.push({ from: w2, to: w1, drawn: true }, { from: w1, to: v, drawn: false });
      }
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

/**
 * 下屋の外周の梁のうち、軒の側の梁がけらばの側の梁との出隅で勝ち、けらばの出幅ぶん外形線まで延びる角（伏図の描画だけ。
 * ユーザー指示2026-10-04「軒の出にかかる垂木を支えるため、胴差は勝ちで妻側まで伸ばす」）。region の edges（roofOutline の辺の部分）の
 * うち、軒（出幅>0）の部分とけらば（出幅>0）の部分が屋根範囲の出隅（凸の角）で出会う点だけ。
 * 辺の種別: 矩形は roofEdgeKind、L字の下屋（leanToDrains を持つ region）は水下（leanToDrains）が軒・出幅>0 のそれ以外がけらば。
 * 矩形でない寄棟（rect も leanToDrains も無い）・寄棟（全辺が軒）は []。軒と軒の角・入隅・壁（出幅 0）との角・出幅 0 のけらばは対象外
 * （出幅 0 のけらばは壁と区別できないので長手勝ちのまま）。
 * @param {object} region leanToFramingRegions の region（edges・rect・shape・ridgeIsVertical・highSide・leanToDrains）
 * @param {number} tolMm 許容差（>=0）
 * @returns {Array<{x:number, y:number, eaveIsVertical:boolean, extendMm:number}>}
 *   x,y＝角（軒の梁とけらばの梁の芯が出会う点）。eaveIsVertical＝軒の辺の向き（x=一定＝true）。extendMm＝けらばの出幅
 * @throws {RangeError} tolMm が不正、edges の値が不正、矩形で形状が小屋組を持たない（roofEdgeKind）
 */
export function eaveBeamCorners(region, tolMm) {
  requireNonNegative(tolMm, 'tolMm');
  const edges = requireOutlineEdges(region?.edges).filter(e => e.overhangMm > 0);
  if (edges.length === 0) return [];
  const drains = region.leanToDrains ?? null;
  const isEave = e => {
    if (drains) {
      const mid = (e.lo + e.hi) / 2;
      return drains.some(d => d.isVertical === e.isVertical && d.outward === e.outward && Math.abs(d.coord - e.coord) <= tolMm
        && d.lo - tolMm <= mid && mid <= d.hi + tolMm);
    }
    if (!region.rect) return true; // 矩形でない寄棟など（全辺が軒＝けらばが無い）
    return roofEdgeKind({ shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide, isVertical: e.isVertical }) === 'eave';
  };
  const eaves = edges.filter(isEave);
  const gables = edges.filter(e => !eaves.includes(e));
  const out = [];
  for (const a of eaves) {
    for (const b of gables) {
      if (a.isVertical === b.isVertical) continue;
      const x = a.isVertical ? a.coord : b.coord; // 軒の辺は垂直なら x=a.coord・けらばの辺は水平 y=b.coord（逆も同じ）
      const y = a.isVertical ? b.coord : a.coord;
      const alongA = a.isVertical ? y : x;
      const alongB = a.isVertical ? x : y;
      // 角は両方の辺の端。端から辺の本体へ向かう向き（lo の端なら +1）と、相手の外向きが逆なら凸の角
      const bodyA = Math.abs(alongA - a.lo) <= tolMm ? 1 : Math.abs(alongA - a.hi) <= tolMm ? -1 : 0;
      const bodyB = Math.abs(alongB - b.lo) <= tolMm ? 1 : Math.abs(alongB - b.hi) <= tolMm ? -1 : 0;
      if (bodyA === 0 || bodyB === 0 || b.outward !== -bodyA || a.outward !== -bodyB) continue;
      if (out.some(c => c.eaveIsVertical === a.isVertical && Math.abs(c.x - x) <= tolMm && Math.abs(c.y - y) <= tolMm)) continue;
      out.push({ x, y, eaveIsVertical: a.isVertical, extendMm: b.overhangMm });
    }
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
 * @param {Array<object>|null} [p.leanToDrains] L字の下屋の水下（leanToWingsOf／gableArmDrainsOf の drains。rect=null・片流れか切妻のときだけ使う。
 *   渡さなければ今まで通り＝空）。母屋・棟木は水下への L∞ 距離の場（leanToDrainFraming）で、段は水下から
 *   r + k×purlinPitchMm（r＝長手方向の翼の奥行 leanToPurlinDepthMm に purlinLayoutFromRidge を当てた軒までの残り）
 * @param {number|null} [p.leanToPurlinDepthMm] 長手方向の翼の奥行き（leanToWingsOf の longDepthMm。leanToDrains を渡すとき必須）
 * @param {number} p.purlinPitchMm 母屋のピッチ（>0。例 910）
 * @param {number[]} p.purlinStartOffsetsMm 母屋の1本目の位置（棟木から）の候補（空でない。各 >0。例 [455, 910]）
 * @param {number} p.tolMm 許容差（>=0。例 CL_OVERLAP_TOL_MM）
 * @returns {{ridges: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>, purlins: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}}
 * @throws {RangeError} ピッチ・許容差が不正、rect の座標が非有限か逆順、片流れで highSide が不正
 */
export function roofFramingLines({ rect, rects = null, shape, ridgeIsVertical, highSide = null, leanToDrains = null, leanToPurlinDepthMm = null, purlinPitchMm, purlinStartOffsetsMm, tolMm }) {
  requirePositive(purlinPitchMm, 'purlinPitchMm');
  if (!Array.isArray(purlinStartOffsetsMm) || purlinStartOffsetsMm.length === 0) {
    throw new RangeError('purlinStartOffsetsMm は空でない配列でなければなりません');
  }
  for (const s of purlinStartOffsetsMm) requirePositive(s, 'purlinStartOffsetsMm の要素');
  requireNonNegative(tolMm, 'tolMm');
  const layout = { pitchMm: purlinPitchMm, startOffsetsMm: purlinStartOffsetsMm, tolMm };
  const empty = { ridges: [], purlins: [] };
  if (!rect) {
    // 下屋の水下の場の経路（rect=null・leanToDrains あり。形状は問わない。片流れ・切妻・寄棟）: 水下への L∞ 距離の場の母屋・棟木。
    // 母屋の段は全ての面で同じ r + k×ピッチ（r＝leanToPurlinDepthMm に purlinLayoutFromRidge を当てた、軒までの残り）。
    // **寄棟（全辺軒の矩形でない寄棟）より先に見る**: 壁に接する下屋の寄棟は水下（壁を除いた外周）を持つ region で、全辺を軒とみなす
    // orthogonalHipLines へ流すと壁へ下る面ができてしまう（2026-10-05 裁定）
    if (Array.isArray(leanToDrains)) {
      requirePositive(leanToPurlinDepthMm, 'leanToPurlinDepthMm');
      const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: leanToPurlinDepthMm, ...layout });
      const { ridges, purlins } = leanToDrainField({ rects, drains: leanToDrains, pitchMm: purlinPitchMm, firstLevelMm: eaveGapMm, tolMm }, { lines: true });
      return { ridges, purlins };
    }
    // 矩形でない寄棟（rect=null・rects＝セル矩形・水下なし＝主屋根）だけ orthogonalHipLines。矩形かどうかは呼び出し側（region）が保証する。
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

// 棟木はピッチ・割付に依存しない（座標の対の差・短手の半分で決まる）。非木造には rules.framing が無くピッチを渡せないので、
// 棟木だけを要る平面の表示（roofRidgeLines）は固定値で roofFramingLines を呼ぶ。値が効かないことは roofFramingPlan.test.js が固定する。
const RIDGE_ONLY_PITCH_MM = 910;
const RIDGE_ONLY_START_OFFSETS_MM = Object.freeze([455, 910]);

/**
 * 棟木の線だけ（平面の表示用。ステップ1）。roofFramingLines の ridges と同じ結果で、切妻（rect）・寄棟（rect か rects）のときだけ
 * 返す。ほかに、L字の下屋の片流れ・切妻（rect=null・leanToDrains あり）は向かい合う水下の棟木（無ければ空）。矩形の片流れ・陸屋根・
 * 棟違い・未知の形状は空（片流れは highSide 無しでも例外にしない）。引数の意味は roofFramingLines と同じ。
 * @param {object} p
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} p.rect
 * @param {Array<object>|null} [p.rects]
 * @param {string} p.shape RoofShape の値
 * @param {boolean} [p.ridgeIsVertical] 切妻の棟が y 方向か
 * @param {Array<object>|null} [p.leanToDrains] L字の下屋の水下（leanToWingsOf の drains）
 * @param {number|null} [p.leanToPurlinDepthMm] 長手方向の翼の奥行き（leanToDrains を渡すとき必須）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}
 * @throws {RangeError} 許容差が不正、rect の座標が非有限か逆順
 */
export function roofRidgeLines({ rect, rects = null, shape, ridgeIsVertical, leanToDrains = null, leanToPurlinDepthMm = null, tolMm }) {
  // L字（矩形でない）の下屋の片流れ・切妻は、向かい合う水下があるときだけ棟木が出る（水下への距離の場。伏図と同じ線）。
  // 棟木は段の始まり・ピッチに依らないので、ピッチ・候補は固定値でよい（leanToPurlinDepthMm は入口の検査のために要る）
  const leanTo = !rect && Array.isArray(leanToDrains);
  if (shape !== RoofShape.GABLE && shape !== RoofShape.HIP && !leanTo) return [];
  return roofFramingLines({
    rect, rects, shape, ridgeIsVertical, leanToDrains, leanToPurlinDepthMm,
    purlinPitchMm: RIDGE_ONLY_PITCH_MM, purlinStartOffsetsMm: RIDGE_ONLY_START_OFFSETS_MM, tolMm,
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
// 壁のある側。翼は流れの向きと辺の種別・水下（軒の辺のうち流れの先のもの）を決めるためだけに使い、面・継ぎ目・母屋は
// 水下への L∞ 距離の場（leanToDrainFraming）で決める。

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
 *  6. kindZones＝屋根範囲の外周の辺を、辺の部分ごとに軒（eave）かけらば（gable）に分けたもの。内側のセルを（直接または
 *     延長で）含む翼のどれかの流れが辺と直交（縦の流れで横の辺・横の流れで縦の辺。壁と平行）なら軒、全ての翼の流れと平行なら
 *     けらば（所有者の流れでは決めない）。取り残しのセルの辺は軒。全辺を隙間なく覆う（roofOutline の kindZones に渡す）。
 *     drains＝外周の辺の部分のうち、内側のセルを含む翼のどれかの流れの向きと外向きが辺の外向きと一致するもの（水下。
 *     辺ごとに連続する部分を1本にしたもの。{isVertical, coord, lo, hi, outward}）。面・継ぎ目・母屋は水下への L∞ 距離の場
 *     （leanToDrainFraming）で決め、翼は流れの向きと辺の種別・水下を決めるためだけに使う。longDepthMm＝母屋の段の基準
 *     （長手方向の翼の奥行き。leanToLongDepthOf）。
 * 翼＝{highSide, wallCoord, wallEdge:{isVertical,coord,lo,hi,outward}（翼が接する壁の辺の部分）, depthMm, rect, domain}。
 * domain＝{x1,y1,x2,y2,entry}。最初の1つが entry:'direct'（rect そのもの）、以降は延長の部分（流れ方向の行ごとに、翼の端から
 * 止まる所までを1つの矩形にし、同じ範囲で隣り合う行は1つにまとめる。入り口の辺は 'left'＝x1・'right'＝x2・'top'＝y1・'bottom'＝y2）。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形（幅か高さが tolMm 以下は無視。空なら空）
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>} p.contacts 屋内に接する区間
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{wings: Array<object>, unassigned: Array<{x1:number,y1:number,x2:number,y2:number}>,
 *   kindZones: Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1,kind:'eave'|'gable'}>,
 *   drains: Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>, longDepthMm: number|null}}
 *   翼が無い（使える矩形が無い）ときは drains=[]・longDepthMm=null
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
  if (loops.length === 0) return { wings: [], unassigned: [], kindZones: [], drains: [], longDepthMm: null };
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

  // 6. 辺の種別と水下。辺の部分（格子の単位）ごとに、内側のセルを（直接または延長で）含む翼の集まりを見る。
  //    種別: どれかの翼の壁と平行（＝流れと直交）なら軒、全ての翼の流れと平行ならけらば。翼が無い（取り残し）は軒。
  //    水下: どれかの翼の流れの向き・外向きが辺の外向きと一致する部分（その翼の流れの先の辺）。
  const kindZones = [];
  const drains = [];
  for (const e of edges) {
    const alongArr = e.isVertical ? ys : xs;
    const acrossArr = e.isVertical ? xs : ys;
    const ci = nearestIndexOf(acrossArr, e.coord);
    const inner = e.outward < 0 ? ci : ci - 1; // 内側のセルの across 方向の添字
    const parts = [];
    const drainParts = [];
    for (let l = 0; l + 1 < alongArr.length; l++) {
      const a = alongArr[l];
      const b = alongArr[l + 1];
      if (a < e.lo - tolMm || b > e.hi + tolMm) continue;
      const [i, j] = e.isVertical ? [inner, l] : [l, inner];
      const owners = [...(direct[j][i] >= 0 ? [direct[j][i]] : []), ...ext[j][i]];
      const wallParallel = owners.some(o => e.isVertical !== leanFlowsAlongY(wings[o].highSide)); // 流れと直交する辺（壁と平行）
      parts.push({ lo: a, hi: b, kind: owners.length === 0 || wallParallel ? 'eave' : 'gable' });
      if (owners.some(o => { const f = leanFlowEdge(wings[o].highSide); return f.isVertical === e.isVertical && f.outward === e.outward; })) {
        drainParts.push([a, b]);
      }
    }
    const joined = [];
    for (const p of parts) {
      const last = joined[joined.length - 1];
      if (last && last.kind === p.kind) last.hi = p.hi;
      else joined.push({ ...p });
    }
    for (const p of joined) kindZones.push({ isVertical: e.isVertical, coord: e.coord, lo: p.lo, hi: p.hi, outward: e.outward, kind: p.kind });
    for (const [lo, hi] of mergeRanges(drainParts, tolMm)) drains.push({ isVertical: e.isVertical, coord: e.coord, lo, hi, outward: e.outward });
  }
  return { wings, unassigned, kindZones, drains, longDepthMm: leanToLongDepthOf(wings, drains, tolMm) };
}

/** 翼の流れの先の辺（水下になる辺）の向きと外向き。left の翼は +x へ流れる＝外側が +x の縦の辺。 */
function leanFlowEdge(highSide) {
  return { isVertical: !leanFlowsAlongY(highSide), outward: highSide === 'top' || highSide === 'left' ? 1 : -1 };
}

/**
 * 母屋の段（水下からの距離）の基準になる「長手方向の翼」の奥行き。水下（同じ向き・同じ直線で接するものをまとめた軒の辺）が
 * 最も長い側へ流れる翼のうち、壁の区間が最も長いもの（同長は番号が小さい翼）の depthMm。最も長い水下が同長で複数あれば
 * （差が tolMm 以内）、そのどれかへ流れる翼を全部候補にして同じ順で選ぶ。水下が無い（翼はあるのに水下が出ない。通常は
 * 起きない）ときは最大奥行き。翼が無ければ null。
 */
function leanToLongDepthOf(wings, drains, tolMm) {
  if (wings.length === 0) return null;
  const merged = mergeDrainEdges(drains, tolMm);
  const maxDepth = Math.max(...wings.map(w => w.depthMm));
  if (merged.length === 0) return maxDepth;
  const longest = merged.filter(d => (merged[0].hi - merged[0].lo) - (d.hi - d.lo) <= tolMm); // mergeDrainEdges は長い順
  const matches = wings.map((w, index) => ({ w, index })).filter(({ w }) => {
    const f = leanFlowEdge(w.highSide);
    const r = w.rect;
    const far = { left: r.x2, right: r.x1, top: r.y2, bottom: r.y1 }[w.highSide]; // 流れの先の辺の座標
    return longest.some(head => {
      if (f.isVertical !== head.isVertical || f.outward !== head.outward || Math.abs(far - head.coord) > tolMm) return false;
      return w.domain.some(f2 => {
        const [lo, hi] = head.isVertical ? [f2.y1, f2.y2] : [f2.x1, f2.x2];
        return Math.min(hi, head.hi) - Math.max(lo, head.lo) > tolMm;
      });
    });
  });
  if (matches.length === 0) return maxDepth;
  const wallLen = w => w.wallEdge.hi - w.wallEdge.lo;
  matches.sort((p, q) => {
    const diff = wallLen(q.w) - wallLen(p.w);
    return (Math.abs(diff) > tolMm ? diff : 0) || p.index - q.index;
  });
  return matches[0].w.depthMm;
}

/**
 * L字（矩形でない）の切妻の下屋の軒とけらば（純関数。腕ごとに棟木）。屋根範囲の外周を、まっすぐな辺（穴の辺も）ごとに、
 * 辺の幅いっぱいのまま内側へ平行に掃き、一部でも外周に当たるまでの距離 L（その辺を一辺とする最大の矩形の奥行き）を求める。
 * 辺がけらば（腕の端）になるのは、両端の角がどちらも出隅（凸）で、かつ辺の長さ w に対し L > w + tolMm のときだけ。それ以外は軒（水下）。
 * 入隅（凹）の角に接する辺（腕の内側の辺）は L が長くても必ず軒。同じ長さ（L＝w）も軒＝正方形の腕はけらばを持たない。穴の辺は
 * 角が屋根範囲から見て入隅なので必ず軒。
 * 壁（屋内に接する辺）も同じ規則で分類する（軒になった壁・けらばになった壁とも、水下から除くのは呼び出し側＝leanToDrainRoute。
 * 2026-10-05 裁定: 壁へ下る面は作らない）。
 * 棟木・母屋・隅木・谷木・面は、この水下を leanToDrainFraming（水下への L∞ 距離の場）に渡して求める。
 * 矩形を渡すと、長辺（w が大きい側）が軒・短辺がけらば、正方形は4辺とも軒（呼び出し側は矩形には使わない）。
 * 長手方向の腕＝けらばの辺のうち掃いた深さ L が最大のもの（差が tolMm 以内は同じ。同じなら幅 w が広い方）の幅の半分が
 * longHalfSpanMm（母屋の段の基準 leanToPurlinDepthMm）。けらばが無い（すべて軒）形・使える矩形が無い形は longHalfSpanMm=null
 * （呼び出し側は region を作らず、外形線だけの補完 region にする）。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形（幅か高さが tolMm 以下は無視。空なら空の結果）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{drains: Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>,
 *   kindZones: Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1,kind:'eave'|'gable'}>, longHalfSpanMm: number|null,
 *   longArmRect: {x1:number,y1:number,x2:number,y2:number}|null}}
 *   drains＝軒の辺（leanToDrainFraming に渡せる形）、kindZones＝全辺（roofOutline の kindZones に渡す）、
 *   longArmRect＝長手方向の腕の矩形（longHalfSpanMm を決めたけらばの辺の幅いっぱいを、掃いた深さまで。けらばが無ければ null）
 * @throws {RangeError} tolMm が不正、rects が配列でない・座標が非有限か逆順
 */
export function gableArmDrainsOf({ rects, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  const field = buildOrthoField(rects, tolMm); // rects の検査もここ
  if (!field) return { drains: [], kindZones: [], longHalfSpanMm: null, longArmRect: null };
  const { xs, ys, cellFilled } = field;
  const drains = [];
  const kindZones = [];
  let longest = null; // 長手方向の腕＝けらばのうち L 最大（同じなら w が広い）
  for (const e of orthogonalBoundaryLoops({ rects, tolMm }).flat()) {
    const along = e.isVertical ? ys : xs;
    const across = e.isVertical ? xs : ys;
    const l0 = nearestIndexOf(along, e.lo);
    const l1 = nearestIndexOf(along, e.hi);
    const ci = nearestIndexOf(across, e.coord);
    const step = -e.outward; // 内側へ
    const filledAt = (l, s) => (e.isVertical ? cellFilled(s, l) : cellFilled(l, s));
    let s = step > 0 ? ci : ci - 1;
    let last = null;
    while (s >= 0 && s + 1 < across.length) {
      let allFilled = true;
      for (let l = l0; l < l1 && allFilled; l++) allFilled = filledAt(l, s);
      if (!allFilled) break;
      last = s;
      s += step;
    }
    const far = last === null ? e.coord : across[step > 0 ? last + 1 : last];
    const sweptMm = Math.abs(far - e.coord);
    const widthMm = e.hi - e.lo;
    // 腕の端は両端の角がどちらも出隅（凸）の辺だけ。端で辺が途切れる位置の内側のセルが塗られていれば、その角は入隅（凹）
    const reflexLo = l0 > 0 && filledAt(l0 - 1, step > 0 ? ci : ci - 1);
    const reflexHi = l1 < along.length - 1 && filledAt(l1, step > 0 ? ci : ci - 1);
    const kind = !reflexLo && !reflexHi && sweptMm > widthMm + tolMm ? 'gable' : 'eave';
    kindZones.push({ isVertical: e.isVertical, coord: e.coord, lo: e.lo, hi: e.hi, outward: e.outward, kind });
    if (kind === 'eave') {
      drains.push({ isVertical: e.isVertical, coord: e.coord, lo: e.lo, hi: e.hi, outward: e.outward });
    } else if (longest === null || sweptMm > longest.sweptMm + tolMm || (Math.abs(sweptMm - longest.sweptMm) <= tolMm && widthMm > longest.widthMm)) {
      const [c1, c2] = [Math.min(e.coord, far), Math.max(e.coord, far)];
      longest = { sweptMm, widthMm, rect: e.isVertical ? { x1: c1, y1: e.lo, x2: c2, y2: e.hi } : { x1: e.lo, y1: c1, x2: e.hi, y2: c2 } };
    }
  }
  return { drains, kindZones, longHalfSpanMm: longest === null ? null : longest.widthMm / 2, longArmRect: longest === null ? null : longest.rect };
}

// ---- L字の下屋: 水下への L∞ 距離の場（母屋・棟木・隅木・谷木・面。翼は流れの向きと辺の種別・水下を決めるだけ） ----
// 屋根面の高さ＝勾配×D(p)。D(p)＝点 p から水下（軒の辺のうち翼の流れの先のもの）までの L∞ 距離。出隅では低い方・入隅では高い方の
// 面＝「最も近い水下」で面が一意に決まり、隅木・谷木は2つの水下までの距離が等しい点の軌跡、向かい合う水下があれば棟木も出る。
// 寄棟の場（orthogonalHipLines・orthogonalHipDiagonals）の一般化: 寄棟は全辺が水下、L字の片流れは水下だけ。

/** 水下の辺の並び順の位（上0・下1・左2・右3。上＝外側が -y の横の辺）。 */
const drainSideRank = d => (d.isVertical ? 2 : 0) + (d.outward > 0 ? 1 : 0);

/** 水下の辺の配列の検査。 */
function requireDrains(drains) {
  if (!Array.isArray(drains)) throw new RangeError('drains は配列でなければなりません');
  drains.forEach((d, i) => {
    if (typeof d?.isVertical !== 'boolean') throw new RangeError(`drains[${i}].isVertical が不正です: ${d?.isVertical}`);
    for (const k of ['coord', 'lo', 'hi']) requireFinite(d[k], `drains[${i}].${k}`);
    if (d.hi < d.lo) throw new RangeError(`drains[${i}] の lo が hi より大きい: ${d.lo} > ${d.hi}`);
    if (d.outward !== 1 && d.outward !== -1) throw new RangeError(`drains[${i}].outward が不正です: ${d.outward}`);
  });
}

/**
 * 水下を、同じ向き・同じ外向き・同じ直線（coord が tolMm 以内）で隙間 tolMm 以下のもの同士まとめる（長さ tolMm 以下は捨てる）。
 * 並びは 長さの大きい順（差が tolMm 以内は同長）→ 上・下・左・右 → coord → lo。
 */
function mergeDrainEdges(drains, tolMm) {
  const groups = [];
  for (const d of [...drains].sort((a, b) => Number(a.isVertical) - Number(b.isVertical) || a.outward - b.outward || a.coord - b.coord)) {
    const g = groups.find(x => x.isVertical === d.isVertical && x.outward === d.outward && Math.abs(x.coord - d.coord) <= tolMm);
    if (g) g.ranges.push([d.lo, d.hi]);
    else groups.push({ isVertical: d.isVertical, outward: d.outward, coord: d.coord, ranges: [[d.lo, d.hi]] });
  }
  const out = [];
  for (const g of groups) {
    for (const [lo, hi] of mergeRanges(g.ranges, tolMm)) {
      if (hi - lo > tolMm) out.push({ isVertical: g.isVertical, coord: g.coord, lo, hi, outward: g.outward });
    }
  }
  return out.sort((a, b) => {
    const diff = (b.hi - b.lo) - (a.hi - a.lo);
    return (Math.abs(diff) > tolMm ? diff : 0) || drainSideRank(a) - drainSideRank(b) || a.coord - b.coord || a.lo - b.lo;
  });
}

/** 場の計算の箱の余白の既定（ピッチを持たない呼び出し＝斜め線だけの入口が使う。値は結果に効かない）。 */
const DRAIN_FIELD_DEFAULT_PITCH_MM = 910;

/**
 * 場の計算用の領域（セル矩形の配列）。屋根範囲の外接矩形を M＝2·max(幅,高さ)＋ピッチ だけ広げた箱から、「各水下の外側の帯」
 * （水下の lo..hi の幅で外向きに、屋根のセルに当たるまで〔無ければ箱の端まで〕）を引いた残りを、圧縮格子の行ごとの連続する
 * セルにまとめたもの。壁・けらば・高い側の辺は領域の内部へ溶け込み（場に影響しない）、水下だけが領域の縁として残る。
 * 帯を屋根のセルで止めるのは、水下が穴（中庭）や凹みに面するとき、帯が向こう側の屋根まで消さないため。
 * M が 2·max より大きいので、箱の端が屋根の中の点の距離（≤ max）に効くことはない。
 * 既知の限界（2026-10-05）: 帯は屋根のセルでしか止まらず、屋内（壁の向こう）は場で通り抜けられる空間として距離を測る。
 * このため L字の切妻・寄棟で、入隅の一部だけが屋内の形・腕の突き出しが腕の幅より短い形は、壁へ下る面・壁の線上から出る谷木が残る。
 */
function drainFieldRects(live, drains, pitchMm, tolMm) {
  const x0 = Math.min(...live.map(r => r.x1));
  const xN = Math.max(...live.map(r => r.x2));
  const y0 = Math.min(...live.map(r => r.y1));
  const yN = Math.max(...live.map(r => r.y2));
  const M = 2 * Math.max(xN - x0, yN - y0) + pitchMm;
  const xs = snapSorted([x0 - M, xN + M, ...live.flatMap(r => [r.x1, r.x2]), ...drains.flatMap(d => (d.isVertical ? [d.coord] : [d.lo, d.hi]))], tolMm);
  const ys = snapSorted([y0 - M, yN + M, ...live.flatMap(r => [r.y1, r.y2]), ...drains.flatMap(d => (d.isVertical ? [d.lo, d.hi] : [d.coord]))], tolMm);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const roof = Array.from({ length: ny }, (_, j) => Array.from({ length: nx }, (_, i) => {
    const mx = midOf(xs, i);
    const my = midOf(ys, j);
    return live.some(r => r.x1 < mx && mx < r.x2 && r.y1 < my && my < r.y2);
  }));
  const band = Array.from({ length: ny }, () => new Array(nx).fill(false));
  for (const d of drains) {
    const across = d.isVertical ? xs : ys;
    const along = d.isVertical ? ys : xs;
    const face = nearestIndexOf(across, d.coord);
    for (let l = 0; l + 1 < along.length; l++) {
      const m = midOf(along, l);
      if (m < d.lo || m > d.hi) continue;
      for (let s = d.outward > 0 ? face : face - 1; s >= 0 && s + 1 < across.length; s += d.outward) {
        const [i, j] = d.isVertical ? [s, l] : [l, s];
        if (roof[j][i]) break;
        band[j][i] = true;
      }
    }
  }
  const out = [];
  for (let j = 0; j < ny; j++) {
    let start = -1;
    for (let i = 0; i <= nx; i++) {
      const open = i < nx && !band[j][i];
      if (open && start < 0) start = i;
      if (!open && start >= 0) {
        out.push({ x1: xs[start], y1: ys[j], x2: xs[i], y2: ys[j + 1] });
        start = -1;
      }
    }
  }
  return out;
}

/** 線 line（{isVertical, coord, lo, hi}）を屋根範囲 live の中の区間にし、屋根範囲の水下でない外周の辺の上に乗る区間を除く。 */
function clipLineToRoof(line, live, wallEdges, tolMm) {
  const ranges = [];
  for (const r of live) {
    const [crossLo, crossHi, alongLo, alongHi] = line.isVertical ? [r.x1, r.x2, r.y1, r.y2] : [r.y1, r.y2, r.x1, r.x2];
    if (line.coord < crossLo - tolMm || line.coord > crossHi + tolMm) continue;
    const lo = Math.max(line.lo, alongLo);
    const hi = Math.min(line.hi, alongHi);
    if (hi - lo > tolMm) ranges.push([lo, hi]);
  }
  const onWall = wallEdges.filter(e => e.isVertical === line.isVertical && Math.abs(e.coord - line.coord) <= tolMm);
  return mergeRanges(ranges, tolMm).flatMap(([lo, hi]) => subtractIntervals(lo, hi, onWall, tolMm)).map(s => ({ ...line, lo: s.lo, hi: s.hi }));
}

/** 斜め線 d（45°。軒側 (x1,y1)→上端 (x2,y2)）を屋根範囲 live の中の部分にする（向きは保つ。x の幅が tolMm 以下は捨てる）。 */
function clipDiagonalToRoof(d, live, tolMm) {
  const sx = Math.sign(d.x2 - d.x1);
  const sy = Math.sign(d.y2 - d.y1);
  const len = Math.abs(d.x2 - d.x1); // 45° なので x と y の幅は等しい。軒側からの距離 s で測る（点＝(x1+sx·s, y1+sy·s)）
  const ranges = [];
  for (const r of live) {
    let s0 = 0;
    let s1 = len;
    for (const [p, sign, lo, hi] of [[d.x1, sx, r.x1, r.x2], [d.y1, sy, r.y1, r.y2]]) {
      const a = (lo - p) / sign;
      const b = (hi - p) / sign;
      s0 = Math.max(s0, Math.min(a, b));
      s1 = Math.min(s1, Math.max(a, b));
    }
    if (s1 > s0) ranges.push([s0, s1]);
  }
  return mergeRanges(ranges, GEOM_EPS)
    .filter(([lo, hi]) => hi - lo > tolMm)
    .map(([lo, hi]) => ({ ...d, x1: d.x1 + sx * lo, y1: d.y1 + sy * lo, x2: d.x1 + sx * hi, y2: d.y1 + sy * hi }));
}

/**
 * 場の計算の本体（leanToDrainFraming・roofHipDiagonals・roofFramingLines の共通）。wants で要る結果だけ求める。
 * @returns {{ridges: Array<object>, purlins: Array<object>, diagonals: Array<object>, faces: Array<object>}}
 */
function leanToDrainField({ rects, drains, pitchMm, firstLevelMm, tolMm }, wants) {
  requireNonNegative(tolMm, 'tolMm');
  requireDrains(drains);
  const live = liveRectsOf(rects, tolMm);
  const merged = mergeDrainEdges(drains, tolMm);
  const empty = { ridges: [], purlins: [], diagonals: [], faces: [] };
  if (live.length === 0 || merged.length === 0) return empty;
  const field = drainFieldRects(live, merged, pitchMm ?? DRAIN_FIELD_DEFAULT_PITCH_MM, tolMm);
  const out = { ...empty };

  if (wants.lines) {
    // 水下でない外周の辺（壁・けらば・高い側の辺。穴の辺も）の上に乗る母屋・棟木の切れ端は捨てる
    const wallEdges = orthogonalBoundaryLoops({ rects: live, tolMm }).flat().flatMap(e => {
      const covered = merged.filter(d => d.isVertical === e.isVertical && d.outward === e.outward && Math.abs(d.coord - e.coord) <= tolMm);
      return subtractIntervals(e.lo, e.hi, covered, tolMm).map(s => ({ isVertical: e.isVertical, coord: e.coord, lo: s.lo, hi: s.hi }));
    });
    const raw = orthogonalHipLines({ rects: field, pitchMm, firstLevelMm, tolMm });
    out.ridges = sortLines(raw.ridges.flatMap(l => clipLineToRoof(l, live, wallEdges, tolMm)));
    out.purlins = sortLines(raw.purlins.flatMap(l => clipLineToRoof(l, live, wallEdges, tolMm)));
    // 面＝水下1本につき1つ。母屋・棟木は中点から最も近い水下（L∞）の面に属させる。同点（2つの水下から等距離）のときは
    // 線の向きと水下の向きが一致する面を優先し、それでも同じなら番号の小さい水下が先
    const distTo = (d, x, y) => {
      const [across, along] = d.isVertical ? [x, y] : [y, x];
      return Math.max(Math.abs(across - d.coord), d.lo - along, along - d.hi, 0);
    };
    const faces = merged.map(drain => ({ drain, lineIsVertical: drain.isVertical, lines: [] }));
    for (const l of [...out.purlins, ...out.ridges]) {
      const [mx, my] = l.isVertical ? [l.coord, (l.lo + l.hi) / 2] : [(l.lo + l.hi) / 2, l.coord];
      const aligned = k => faces[k].drain.isVertical === l.isVertical;
      let best = 0;
      let bestDist = distTo(faces[0].drain, mx, my);
      for (let k = 1; k < faces.length; k++) {
        const d = distTo(faces[k].drain, mx, my);
        if (d < bestDist - tolMm || (Math.abs(d - bestDist) <= tolMm && !aligned(best) && aligned(k))) { best = k; bestDist = d; }
      }
      faces[best].lines.push(l);
    }
    for (const f of faces) f.lines = sortLines(f.lines);
    out.faces = faces;
  }
  if (wants.diagonals) {
    const kindRank = k => (k === 'hip' ? 0 : 1);
    out.diagonals = orthogonalHipDiagonals({ rects: field, tolMm })
      .flatMap(d => clipDiagonalToRoof(d, live, tolMm))
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2);
  }
  return out;
}

/**
 * L字の下屋（矩形でない片流れ）の棟木・母屋・隅木・谷木・面を、水下への L∞ 距離の場で求める（純関数。ステップ1）。
 *  1. 水下を、同じ向き・同じ直線で接するもの同士でまとめる。
 *  2. 計算用の領域 ＝ 屋根範囲の外接矩形を広げた箱 − 各水下の外側の帯（drainFieldRects）。壁・けらばは領域に溶け込む。
 *  3. その領域で orthogonalHipLines（母屋の段は firstLevelMm + k·pitchMm）と orthogonalHipDiagonals を呼び、屋根範囲（rects）で切り抜く。
 *  4. 母屋・棟木の切れ端のうち、水下でない外周の辺（壁など）の上に乗るものは捨てる。
 *  5. 面＝まとめた水下1本につき1つ。母屋は中点から最も近い水下の面に属させる。
 * 隅木・谷木の (x1,y1)＝軒側の端、(x2,y2)＝上端（orthogonalHipDiagonals と同じ約束）。斜め線は屋根範囲の中の部分だけ
 * （壁を越えた先は切る）。軒先の角までの延長は extendDiagonalsToOutline が行う。
 * 面の並び＝水下の長さの大きい順（差が tolMm 以内は同長）→ 上・下・左・右 → 座標順。面の lines は母屋と棟木（levelMm が
 * 母屋の段と重なる位置は母屋でなく棟木になるので、小屋梁が支えるために棟木も面に入れる）を合わせて sortLines 済み。
 * 水下から等距離の線は、線の向きと水下の向きが一致する面を優先する。
 * lineIsVertical は水下の向き（縦の水下の面の母屋は縦線）。水下の端が屋根の辺の途中で終わる形では、端の外側の三角（端から
 * 45°の斜め線の向こう）の母屋が水下と直交する向きの線になり、その面の lines に混ざる。
 * 水下が空・使える矩形が無いときは全て空（例外にしない）。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形（幅か高さが tolMm 以下は無視）
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>} p.drains 水下の辺（leanToWingsOf の drains）
 * @param {number} p.pitchMm 母屋のピッチ（>0。例 910）
 * @param {number} [p.firstLevelMm] 母屋の段の始まり（水下から1本目の母屋までの距離。>0。省略＝pitchMm）。長手方向の翼の
 *   purlinLayoutFromRidge の eaveGapMm を渡す（全ての面が同じ段を使う）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{ridges: Array<object>, purlins: Array<object>, diagonals: Array<{kind:'hip'|'valley', x1:number, y1:number, x2:number, y2:number}>,
 *   faces: Array<{drain: object, lineIsVertical: boolean, lines: Array<object>}>}}
 *   ridges・purlins の線は {isVertical, coord, lo, hi, levelMm（水下からの距離）}。屋根範囲の中の区間
 * @throws {RangeError} ピッチ・段の始まり・許容差が不正、rects が配列でない・座標が非有限か逆順、drains が配列でない・値が不正
 */
export function leanToDrainFraming({ rects, drains, pitchMm, firstLevelMm, tolMm }) {
  requirePositive(pitchMm, 'pitchMm');
  if (firstLevelMm !== undefined) requirePositive(firstLevelMm, 'firstLevelMm');
  return leanToDrainField({ rects, drains, pitchMm, firstLevelMm, tolMm }, { lines: true, diagonals: true });
}

// ---- 下屋の水下の振り分け（2026-10-05 裁定: 下屋は壁へ下る面を作らない） ----
// 一般則: 下屋の水下＝形状が決める軒の辺（片流れ＝高い側の反対／切妻＝棟と平行な2辺・L字は gableArmDrainsOf の軒／寄棟＝全辺）から、
// 屋内に接する部分（zeroZones）を除いたもの。振り分けは leanToDrainRoute に集め、region の導出（roofFramingRegions.js）は結果に従うだけ。

/**
 * 水下 drains から zeroZones（屋内に接する区間）を除く。drains の並びごとに { drain, status, parts }:
 * status＝'none'（除かれる部分が tolMm 以下。parts＝[drain そのもの]）／'partial'（一部。parts＝残った区間の drain）／
 * 'full'（全部。parts＝[]）。
 */
function trimDrainsByZones(drains, zeroZones, tolMm) {
  return drains.map(drain => {
    const zones = zeroZones
      .filter(z => z.isVertical === drain.isVertical && z.outward === drain.outward && Math.abs(z.coord - drain.coord) <= tolMm)
      .map(z => ({ lo: z.lo, hi: z.hi }));
    const kept = subtractIntervals(drain.lo, drain.hi, zones, tolMm);
    const keptMm = kept.reduce((sum, s) => sum + (s.hi - s.lo), 0);
    if (drain.hi - drain.lo - keptMm <= tolMm) return { drain, status: 'none', parts: [drain] };
    if (kept.length === 0) return { drain, status: 'full', parts: [] };
    return { drain, status: 'partial', parts: kept.map(s => ({ ...drain, lo: s.lo, hi: s.hi })) };
  });
}

/**
 * 水下の場（leanToDrainFraming と同じ領域）で、点が rects の中（閉区間）にあるものについての「最も近い水下までの L∞ 距離 D」の最大値。
 * D(p)＝p を中心とする正方形（半辺 d）が場の領域に収まる最大の d。収まるかは d について単調で、E_d（収まる中心の集合）の境界は
 * 場の座標 ±d の上にあるので、「E_d と rects が交わるか」は座標 {c, c±d} の格子点で厳密に判定でき、d は二分探索する。
 * 水下が空・使える矩形が無いときは 0。
 * @param {Array<object>} live 屋根範囲のセル矩形（liveRectsOf 済み）
 * @param {Array<object>} merged mergeDrainEdges 済みの水下
 * @param {Array<object>} within 点を探す範囲の矩形群（屋根範囲との共通部分で探す）
 */
function maxDrainDistanceMm(live, merged, within, tolMm) {
  if (live.length === 0 || merged.length === 0) return 0;
  const field = buildOrthoField(drainFieldRects(live, merged, DRAIN_FIELD_DEFAULT_PITCH_MM, tolMm), tolMm);
  if (!field) return 0;
  const { xs, ys, fits, S } = field;
  const inside = (rs, x, y) => rs.some(r => r.x1 - GEOM_EPS <= x && x <= r.x2 + GEOM_EPS && r.y1 - GEOM_EPS <= y && y <= r.y2 + GEOM_EPS);
  const reachable = d => {
    const X = dedupeSorted([...xs, ...xs.map(v => v + d), ...xs.map(v => v - d)].sort((a, b) => a - b));
    const Y = dedupeSorted([...ys, ...ys.map(v => v + d), ...ys.map(v => v - d)].sort((a, b) => a - b));
    return X.some(x => Y.some(y => inside(within, x, y) && inside(live, x, y) && fits(x, y, d)));
  };
  if (!reachable(0)) return 0;
  let lo = 0;
  let hi = S;
  for (let i = 0; i < 60 && hi - lo > 1e-7; i++) {
    const mid = (lo + hi) / 2;
    if (reachable(mid)) lo = mid; else hi = mid;
  }
  return Math.round(lo * 1e4) / 1e4;
}

/** 水下の場の経路の結果（leanToDrainRoute の kind:'field'）。 */
const fieldRoute = (shape, drains, purlinDepthMm, kindZones, extra = {}) => ({ kind: 'field', shape, drains, purlinDepthMm, kindZones, ...extra });
const NO_ROUTE = Object.freeze({ kind: 'none' });

/** 辺の部分ごとの種別（全辺が同じ種別の屋根範囲＝矩形用。kindOf(edge) が 'eave'|'gable'）。 */
const kindZonesOfEdges = (edges, kindOf) => edges.map(e => ({
  isVertical: e.isVertical, coord: e.coord, lo: e.lo, hi: e.hi, outward: e.outward, kind: kindOf(e),
}));

/**
 * 下屋の水下の振り分け（純関数。2026-10-05 裁定「下屋は壁へ下る面を作らない」。平面と伏図が同じ結果を使う）。
 * 水下＝形状が決める軒の辺から、屋内に接する部分（zeroZones。壁）を除いたもの。主屋根は屋内に接する辺が無いので通さない。
 *
 * 結果の kind:
 *  - 'rect':  今までの矩形の経路（rectGableLines・rectMonoLines・rectHipLines）。{ kind, shape, highSide（片流れだけ）}。
 *             shape は region.shape（切妻→片流れへの読み替えがあるので入力の shape と違うことがある）
 *  - 'field': 水下の場の経路（leanToDrainFraming）。{ kind, shape, drains, purlinDepthMm（母屋の段の基準。purlinLayoutFromRidge の
 *             halfSpanMm）, kindZones（外形線の辺の部分ごとの種別。roofOutline に渡す）, wings・unassigned（L字の片流れだけ）}
 *  - 'none':  小屋組を持たない（外形線だけ）。陸屋根・棟違い・使える矩形が無い・水下が空（全周が壁・向かい合う壁の間）・
 *             けらばが無い L字の切妻・翼が作れない L字の片流れ
 *
 * 既知の限界: 水下の場（drainFieldRects）は屋内を通り抜けて距離を測るため、L字の切妻・寄棟（入隅の一部だけが屋内・腕の突き出しが
 * 腕の幅より短い形）では、水下から壁を除いても壁へ下る面・壁の線上から出る谷木が残ることがある（矩形・L字の片流れは起きない）。
 * 振り分け:
 *  - 矩形の片流れ: 低い側（高い側の反対）が壁に接さない→rect。全部壁→自動の高い側（autoHighSide）へ読み替える（それも全部壁なら none）。
 *    一部だけ壁→field（shape:MONO。purlinDepthMm＝流れ方向の奥行き）
 *  - 矩形の切妻: 棟と平行な2辺のうち、どちらも壁に接さない→rect。片方が全部壁→片流れ（高い側＝壁の側）として振り分け直す（他方が壁に接さなければ rect の片流れ、一部だけ壁なら片流れの field）。
 *    両方全部壁→none。それ以外（一部だけ壁）→field（shape:GABLE。purlinDepthMm＝短手の半分）
 *  - 矩形の寄棟: 壁に接さない→rect。全周が壁→none。それ以外→field（shape:HIP。purlinDepthMm＝水下の場の D の最大値）
 *  - L字の片流れ: leanToWingsOf の水下から壁を除いて field（purlinDepthMm＝longDepthMm）
 *  - L字の切妻: gableArmDrainsOf の軒から壁を除いて field（壁が無ければ purlinDepthMm＝longHalfSpanMm、壁を除いたときは
 *    長手方向の腕の矩形の中の D の最大値）
 *  - L字の寄棟（明示）: 全辺から壁を除いて field（壁が無ければ purlinDepthMm＝切妻と同じ longHalfSpanMm、壁を除いたときは
 *    長手方向の腕の矩形の中の D の最大値。腕が無ければ屋根範囲全体）
 * @param {object} p
 * @param {string} p.shape RoofShape の値（実効値）
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} [p.rect] 屋根範囲が矩形ならその矩形、そうでなければ null
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形（矩形のときは [rect] でよい）
 * @param {boolean|null} [p.ridgeIsVertical] 矩形の切妻の棟が y 方向か（boolean でなければ長手）
 * @param {string|null} [p.highSide] 矩形の片流れの高い側（実効値。明示値→自動）
 * @param {string|null} [p.autoHighSide] 明示値を無視した自動の高い側（resolveRoofHighSide(null, …)。低い側が全部壁のときの読み替え先）
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>} [p.zeroZones] 屋内に接する区間（壁）
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {{kind:'rect', shape:string, highSide:string|null}|{kind:'field', shape:string, drains:Array<object>, purlinDepthMm:number,
 *   kindZones:Array<object>, wings?:Array<object>, unassigned?:Array<object>}|{kind:'none'}}
 * @throws {RangeError} 許容差・rects・zeroZones が不正、矩形の片流れで highSide が不正
 */
export function leanToDrainRoute({ shape, rect = null, rects, ridgeIsVertical = null, highSide = null, autoHighSide = null, zeroZones = [], tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  if (!Array.isArray(zeroZones)) throw new RangeError('zeroZones は配列でなければなりません');
  zeroZones.forEach((z, i) => {
    if (typeof z?.isVertical !== 'boolean') throw new RangeError(`zeroZones[${i}].isVertical が不正です: ${z?.isVertical}`);
    for (const k of ['coord', 'lo', 'hi']) requireFinite(z[k], `zeroZones[${i}].${k}`);
    if (z.outward !== 1 && z.outward !== -1) throw new RangeError(`zeroZones[${i}].outward が不正です: ${z.outward}`);
  });
  const live = liveRectsOf(rects, tolMm);
  if (live.length === 0) return NO_ROUTE;
  if (shape !== RoofShape.MONO && shape !== RoofShape.GABLE && shape !== RoofShape.HIP) return NO_ROUTE;
  const edges = orthogonalBoundaryLoops({ rects: live, tolMm }).flat()
    .map(({ isVertical, coord, lo, hi, outward }) => ({ isVertical, coord, lo, hi, outward })); // 水下の形（dir は持たない）
  const collect = trimmed => trimmed.flatMap(t => t.parts);
  const allRemoved = trimmed => trimmed.every(t => t.status === 'full');
  const nothingRemoved = trimmed => trimmed.every(t => t.status === 'none');

  if (rect) {
    const { x1, y1, x2, y2 } = rect;
    if (shape === RoofShape.MONO) {
      const sideOk = s => HIGH_SIDES.includes(s);
      if (!sideOk(highSide)) throw new RangeError(`片流れの highSide が不正です: ${highSide}`);
      // 高い側 hs の水下＝反対の辺。外側が coord の +方向なのは top・left が高い側のときの bottom・right
      const trimFor = hs => trimDrainsByZones(edges.filter(e => e.isVertical === (hs === 'left' || hs === 'right')
        && e.outward === (hs === 'top' || hs === 'left' ? 1 : -1)), zeroZones, tolMm);
      let hs = highSide;
      let trimmed = trimFor(hs);
      if (allRemoved(trimmed)) { // 低い側が全部壁: 自動の高い側（壁の側）へ読み替える（保存値は残す＝ここでは入力を変えない）
        if (!sideOk(autoHighSide) || autoHighSide === hs) return NO_ROUTE;
        hs = autoHighSide;
        trimmed = trimFor(hs);
        if (allRemoved(trimmed)) return NO_ROUTE; // 向かい合う壁の間
      }
      if (nothingRemoved(trimmed)) return { kind: 'rect', shape: RoofShape.MONO, highSide: hs };
      const flowDepth = hs === 'top' || hs === 'bottom' ? y2 - y1 : x2 - x1;
      const eaveIsVertical = hs === 'left' || hs === 'right'; // roofEdgeKind と同じ: 流れと直交する辺（高い側とその反対）が軒
      return fieldRoute(RoofShape.MONO, collect(trimmed), flowDepth, kindZonesOfEdges(edges, e => (e.isVertical === eaveIsVertical ? 'eave' : 'gable')));
    }
    if (shape === RoofShape.GABLE) {
      const rv = typeof ridgeIsVertical === 'boolean' ? ridgeIsVertical : roofRidgeIsVertical(rect, tolMm);
      const trimmed = trimDrainsByZones(edges.filter(e => e.isVertical === rv), zeroZones, tolMm); // 棟と平行な2辺（軒）
      if (allRemoved(trimmed)) return NO_ROUTE; // 向かい合う壁の間
      if (nothingRemoved(trimmed)) return { kind: 'rect', shape: RoofShape.GABLE, highSide: null };
      const wall = trimmed.find(t => t.status === 'full');
      if (wall) { // 棟木が壁と平行: 壁を水上にした片流れ（もう片方が一部だけ壁なら片流れの field。片流れを指定したときと同じ結果）
        const side = leanSideOfEdge(wall.drain.isVertical, wall.drain.outward);
        return leanToDrainRoute({ shape: RoofShape.MONO, rect, rects, highSide: side, autoHighSide: side, zeroZones, tolMm });
      }
      const halfSpan = (rv ? x2 - x1 : y2 - y1) / 2;
      return fieldRoute(RoofShape.GABLE, collect(trimmed), halfSpan, kindZonesOfEdges(edges, e => (e.isVertical === rv ? 'eave' : 'gable')));
    }
    // 寄棟: 全辺が軒
    const trimmed = trimDrainsByZones(edges, zeroZones, tolMm);
    if (nothingRemoved(trimmed)) return { kind: 'rect', shape: RoofShape.HIP, highSide: null };
    if (allRemoved(trimmed)) return NO_ROUTE;
    const drains = collect(trimmed);
    return fieldRoute(RoofShape.HIP, drains, maxDrainDistanceMm(live, mergeDrainEdges(drains, tolMm), live, tolMm), kindZonesOfEdges(edges, () => 'eave'));
  }

  // 矩形でない（L字などの）屋根範囲
  if (shape === RoofShape.MONO) {
    const w = leanToWingsOf({ rects: live, contacts: zeroZones, tolMm });
    if (w.wings.length === 0 || w.longDepthMm === null) return NO_ROUTE;
    const trimmed = trimDrainsByZones(w.drains, zeroZones, tolMm);
    if (trimmed.length === 0 || allRemoved(trimmed)) return NO_ROUTE;
    return fieldRoute(RoofShape.MONO, collect(trimmed), w.longDepthMm, w.kindZones, { wings: w.wings, unassigned: w.unassigned });
  }
  const arm = gableArmDrainsOf({ rects: live, tolMm });
  if (shape === RoofShape.GABLE) {
    if (arm.drains.length === 0 || arm.longHalfSpanMm === null) return NO_ROUTE; // けらばの無い形（外形線だけ）
    const trimmed = trimDrainsByZones(arm.drains, zeroZones, tolMm);
    if (allRemoved(trimmed)) return NO_ROUTE;
    const drains = collect(trimmed);
    // 壁を除かないときは今までの基準（長手方向の腕の半スパン）。除いたときは腕の矩形の中の D の最大値（片流れと同じ「軒までの残り」の基準）
    const depth = nothingRemoved(trimmed) ? arm.longHalfSpanMm : maxDrainDistanceMm(live, mergeDrainEdges(drains, tolMm), [arm.longArmRect], tolMm);
    return fieldRoute(RoofShape.GABLE, drains, depth, arm.kindZones);
  }
  // 明示の寄棟（L字）: 全辺が軒（腕の端も軒）。壁を除いた外周が水下
  const trimmed = trimDrainsByZones(edges, zeroZones, tolMm);
  if (allRemoved(trimmed)) return NO_ROUTE;
  const drains = collect(trimmed);
  // 壁を除かないとき（屋内に接さない）は切妻と同じ基準（長手方向の腕の半スパン。腕の矩形の中の D は接合部で他の腕の棟の高さが混ざる）。
  // 壁を除いたときは腕の矩形（無ければ屋根範囲全体）の中の D の最大値
  const depth = nothingRemoved(trimmed) && arm.longHalfSpanMm !== null
    ? arm.longHalfSpanMm
    : maxDrainDistanceMm(live, mergeDrainEdges(drains, tolMm), arm.longArmRect ? [arm.longArmRect] : live, tolMm);
  return fieldRoute(RoofShape.HIP, drains, depth, kindZonesOfEdges(edges, () => 'eave'));
}

// ---- 水下ごとの面の基準点（平面の傾斜ラベル用。ステップ3） ----

/** 水下の流れの向き（水下の外向き）。上下左右の4つ（y 下向き正。top＝y が小さい側）。 */
function drainFlowOf(d) {
  if (d.isVertical) return d.outward > 0 ? 'right' : 'left';
  return d.outward > 0 ? 'down' : 'up';
}

/** 水下 d の座標系（along＝水下に沿う座標・across＝水下から内向き n の距離 u）で見た矩形の範囲。 */
function drainAxes(d) {
  return d.isVertical
    ? { acrossLo: 'x1', acrossHi: 'x2', alongLo: 'y1', alongHi: 'y2' }
    : { acrossLo: 'y1', acrossHi: 'y2', alongLo: 'x1', alongHi: 'x2' };
}

/** 点 m（水下の上の along 座標）から内向きに屋根範囲 live を最初に出るまでの距離。 */
function drainDepthAt(d, m, live, tolMm) {
  const ax = drainAxes(d);
  const n = -d.outward;
  const spans = live.filter(r => r[ax.alongLo] <= m && m <= r[ax.alongHi]).map(r => (n > 0
    ? [r[ax.acrossLo] - d.coord, r[ax.acrossHi] - d.coord]
    : [d.coord - r[ax.acrossHi], d.coord - r[ax.acrossLo]]));
  let reach = 0;
  for (let moved = true; moved;) {
    moved = false;
    for (const [u1, u2] of spans) {
      if (u1 <= reach + tolMm && u2 > reach) { reach = u2; moved = true; }
    }
  }
  return reach;
}

/** 箱 box（{x1,y1,x2,y2}）が矩形群 field の和に完全に含まれるか（圧縮座標の各セルの中点で調べる）。 */
function boxCoveredBy(box, field) {
  const cuts = (lo, hi, values) => [lo, hi, ...values.filter(v => v > lo && v < hi)].sort((a, b) => a - b);
  const xs = cuts(box.x1, box.x2, field.flatMap(r => [r.x1, r.x2]));
  const ys = cuts(box.y1, box.y2, field.flatMap(r => [r.y1, r.y2]));
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const mx = (xs[i] + xs[i + 1]) / 2;
      const my = (ys[j] + ys[j + 1]) / 2;
      if (xs[i + 1] - xs[i] <= 0 || ys[j + 1] - ys[j] <= 0) continue;
      if (!field.some(r => r.x1 < mx && mx < r.x2 && r.y1 < my && my < r.y2)) return false;
    }
  }
  return true;
}

/**
 * 水下 d の上の点 m から、場の定義域 field に収まる最大の正方形（水下に沿って m±s・内向きに 0..2s）の s。
 * 収まるかは s について単調（小さい正方形は大きい正方形に含まれる）で、境目は定義域の矩形の座標で決まるので、
 * 候補の s（m からの along の距離・水下からの across の距離の半分）を昇順に二分探索して厳密な値を求める。
 */
function drainRunAt(d, m, field) {
  const ax = drainAxes(d);
  const n = -d.outward;
  const boxOf = s => {
    const [a1, a2] = n > 0 ? [d.coord, d.coord + 2 * s] : [d.coord - 2 * s, d.coord];
    return d.isVertical ? { x1: a1, x2: a2, y1: m - s, y2: m + s } : { x1: m - s, x2: m + s, y1: a1, y2: a2 };
  };
  const cands = [...new Set([
    ...field.flatMap(r => [r[ax.alongLo], r[ax.alongHi]]).map(c => Math.abs(c - m)),
    ...field.flatMap(r => [r[ax.acrossLo], r[ax.acrossHi]]).map(c => Math.abs(c - d.coord) / 2),
  ].filter(s => s > 0))].sort((a, b) => a - b);
  let lo = 0; // 収まる候補の個数（先頭から連続）
  let hi = cands.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxCoveredBy(boxOf(cands[mid]), field)) lo = mid + 1; else hi = mid;
  }
  return lo === 0 ? 0 : cands[lo - 1];
}

/**
 * 水下ごとの面（水下1本につき1つ。leanToDrainFraming の faces と同じ並び＝mergeDrainEdges 後の水下の順）の基準点。
 * 傾斜の文字・矢印を置く点。形状によらない（寄棟・切妻・片流れ・L字とも、水下の集合だけから決まる）。
 *  - run: 水下の上の点 m から内向きに正方形（水下に沿って m±s・内向きに 0..2s）を置いたとき、場の定義域（leanToDrainFraming と同じ
 *    drainFieldRects。水下の外側の帯を除いたもの）に収まる最大の s。
 *  - depth: m から内向きに屋根範囲を最初に出るまでの距離。
 *  - 基準点＝m から内向きに min(run, depth)/2 の点（depth で止めないと、水下から遠い面で建物の中へ出る）。
 *  - m の候補: 水下を屋根範囲・他の水下の座標で区切った小区間の中点と、水下の中点。min(run, depth) が最大の候補、
 *    同じ（tolMm 以内）なら水下の中点に近い方（さらに同じなら along の小さい方）。
 * 水下が空・使える矩形が無いときは []。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>} p.drains 水下の辺
 * @param {number} p.tolMm 許容差（>=0）
 * @returns {Array<{drainIndex:number, drain:{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}, anchor:{x:number,y:number}, flow:'up'|'down'|'left'|'right'}>}
 * @throws {RangeError} 許容差が不正、rects が配列でない・座標が非有限か逆順、drains が配列でない・値が不正
 */
export function drainFaceAnchors({ rects, drains, tolMm }) {
  requireNonNegative(tolMm, 'tolMm');
  requireDrains(drains);
  const live = liveRectsOf(rects, tolMm);
  const merged = mergeDrainEdges(drains, tolMm);
  if (live.length === 0 || merged.length === 0) return [];
  const field = drainFieldRects(live, merged, DRAIN_FIELD_DEFAULT_PITCH_MM, tolMm);
  return merged.map((drain, drainIndex) => {
    const ax = drainAxes(drain);
    const n = -drain.outward;
    const cuts = [drain.lo, drain.hi, ...live.flatMap(r => [r[ax.alongLo], r[ax.alongHi]]),
      ...merged.flatMap(d => (d.isVertical === drain.isVertical ? [d.lo, d.hi] : [d.coord]))]
      .filter(v => v > drain.lo + tolMm && v < drain.hi - tolMm).sort((a, b) => a - b);
    const bounds = [drain.lo, ...cuts, drain.hi].filter((v, i, a) => i === 0 || v - a[i - 1] > tolMm);
    const middle = (drain.lo + drain.hi) / 2;
    // 水下の中点が屋根範囲のセルの境目に乗ると、隣の行の奥行き・run が混ざって基準点が屋根範囲の縁へ出る（奥行きの違う L字）。
    // 境目に乗る中点は候補から外す（小区間の中点は必ずセルの内部。小区間は1つ以上あるので候補は残る）
    const middleOnEdge = live.some(r => Math.abs(r[ax.alongLo] - middle) <= tolMm || Math.abs(r[ax.alongHi] - middle) <= tolMm);
    const cands = [...(middleOnEdge ? [] : [middle]), ...bounds.slice(1).map((v, i) => (bounds[i] + v) / 2)];
    let best = null;
    for (const m of cands) {
      const reach = Math.min(drainRunAt(drain, m, field), drainDepthAt(drain, m, live, tolMm));
      const better = best === null || reach > best.reach + tolMm
        || (Math.abs(reach - best.reach) <= tolMm && (Math.abs(m - middle) < Math.abs(best.m - middle) - tolMm
          || (Math.abs(Math.abs(m - middle) - Math.abs(best.m - middle)) <= tolMm && m < best.m)));
      if (better) best = { m, reach };
    }
    const across = drain.coord + (n * best.reach) / 2;
    return { drainIndex, drain: { ...drain }, anchor: drain.isVertical ? { x: across, y: best.m } : { x: best.m, y: across }, flow: drainFlowOf(drain) };
  });
}
