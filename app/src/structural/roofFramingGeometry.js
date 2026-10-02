/**
 * 小屋組（棟木・母屋・小屋梁の位置・束）の幾何の純モジュール（ステップ C1。どこからも呼ばない）。
 * graph・store.js・snap.js・.jsx・react・konva を import しない（node:test から単体で import できる）。
 * 定数（母屋ピッチ 910・束の最大間隔 1820・許容差）は引数で受ける（呼び出し側が structureRules.js・
 * core/constants.js の CL_OVERLAP_TOL_MM を渡す。CL_OVERLAP_TOL_MM=0.5mm＝「他CLと同一座標」とみなす距離）。
 *
 * 座標は mm、y 軸は下向きが正。線の表現 Line={isVertical, coord, lo, hi}:
 *   isVertical は既存の梁（StructuralBeam.isVertical）と同じ意味で、true＝y 方向に走る線（x=coord 一定、
 *   y が lo..hi）、false＝x 方向に走る線（y=coord 一定、x が lo..hi）。
 *
 * 屋根範囲は矩形 rect={x1,y1,x2,y2}（x1<x2, y1<y2）だけを扱う（roofFramingLines は矩形専用）。
 * 非矩形（rectOfBounds が null）は空を返す。非矩形の寄棟は後続ステップで別途設計する。
 *
 * 不正入力の扱い:
 *   - 「何も生えない」入力（rect=null・陸屋根・棟違い・未知の形状・幅/高さ 0 の矩形）は空を返す。
 *   - プログラム誤り（ピッチ・許容差が非有限か不正、座標が非有限、x1>x2/y1>y2、lo>hi、
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

// 軒（from）から内側へ pitch ごとの距離 k*pitch（k>=1）。中心（半スパン half）の手前 tol までに限る
// （中心と一致する距離は含めない）。
function offsetsFromEave(half, pitch, tol) {
  const out = [];
  for (let k = 1; k * pitch < half - tol; k++) out.push(k * pitch);
  return out;
}

// ---- 以下 rect* は矩形専用（rect は検証済みの矩形） ----

function rectGableLines(rect, ridgeIsVertical, pitch, tol) {
  const { x1, y1, x2, y2 } = rect;
  const ridges = [];
  const purlins = [];
  if (ridgeIsVertical) { // 棟は y 方向。軒は x1 と x2 の2辺
    ridges.push(vLine((x1 + x2) / 2, y1, y2));
    for (const d of offsetsFromEave((x2 - x1) / 2, pitch, tol)) {
      purlins.push(vLine(x1 + d, y1, y2), vLine(x2 - d, y1, y2));
    }
  } else { // 棟は x 方向。軒は y1 と y2 の2辺
    ridges.push(hLine((y1 + y2) / 2, x1, x2));
    for (const d of offsetsFromEave((y2 - y1) / 2, pitch, tol)) {
      purlins.push(hLine(y1 + d, x1, x2), hLine(y2 - d, x1, x2));
    }
  }
  return { ridges, purlins: sortLines(purlins) };
}

function rectMonoLines(rect, highSide, pitch, tol) {
  if (!HIGH_SIDES.includes(highSide)) {
    throw new RangeError(`片流れの highSide が不正です: ${highSide}`);
  }
  const { x1, y1, x2, y2 } = rect;
  const purlins = [];
  // 低い側の軒から k*pitch。高い側の辺（から tol 以内）には置かない。
  if (highSide === 'top' || highSide === 'bottom') {
    const span = y2 - y1;
    for (let k = 1; k * pitch < span - tol; k++) {
      purlins.push(hLine(highSide === 'top' ? y2 - k * pitch : y1 + k * pitch, x1, x2));
    }
  } else {
    const span = x2 - x1;
    for (let k = 1; k * pitch < span - tol; k++) {
      purlins.push(vLine(highSide === 'left' ? x2 - k * pitch : x1 + k * pitch, y1, y2));
    }
  }
  return { ridges: [], purlins: sortLines(purlins) };
}

function rectHipLines(rect, pitch, tol) {
  const { x1, y1, x2, y2 } = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  const ridges = [];
  if (Math.abs(w - h) > tol) { // 正方形（方形）は棟木なし
    if (w > h) ridges.push(hLine((y1 + y2) / 2, x1 + h / 2, x2 - h / 2));
    else ridges.push(vLine((x1 + x2) / 2, y1 + w / 2, y2 - w / 2));
  }
  const purlins = [];
  for (const d of offsetsFromEave(Math.min(w, h) / 2, pitch, tol)) {
    purlins.push(
      hLine(y1 + d, x1 + d, x2 - d), hLine(y2 - d, x1 + d, x2 - d),
      vLine(x1 + d, y1 + d, y2 - d), vLine(x2 - d, y1 + d, y2 - d),
    );
  }
  return { ridges, purlins: sortLines(purlins) };
}

/**
 * 矩形の屋根の棟木・母屋の線（水平距離で割り付け。勾配は位置に影響しない）。矩形専用。
 *  - 切妻: 棟＝矩形の中央（向きは ridgeIsVertical。未指定なら roofRidgeIsVertical）。母屋は両側の軒から
 *    k*pitch（k>=1）。棟と重なる位置・棟を越える位置には置かない。端は屋根範囲の辺まで。
 *  - 片流れ: 棟木なし。highSide（'top'|'bottom'|'left'|'right'。y 軸が下向き正なので top＝y が小さい辺 y1、
 *    bottom＝y2、left＝x1、right＝x2）が高い側。低い側の軒から k*pitch。高い側の辺そのものには置かない。
 *  - 寄棟: 軒から内側へ d=k*pitch の環（4辺に平行。横線は x1+d..x2-d、縦線は y1+d..y2-d）。中心（短辺/2）に
 *    届く d は置かない。棟木は長辺方向に長さ（長辺−短辺）の線。正方形は棟木なし（方形）。ridgeIsVertical は無視。
 *  - 陸屋根・棟違い・未知の形状・rect=null・幅か高さが tolMm 以下の矩形は空。
 * @param {object} p
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} p.rect
 * @param {string} p.shape RoofShape の値
 * @param {boolean} [p.ridgeIsVertical] 切妻の棟が y 方向か
 * @param {string|null} [p.highSide] 片流れの高い側
 * @param {number} p.purlinPitchMm 母屋ピッチ（>0。例 910）
 * @param {number} p.tolMm 許容差（>=0。例 CL_OVERLAP_TOL_MM）
 * @returns {{ridges: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>, purlins: Array<{isVertical:boolean,coord:number,lo:number,hi:number}>}}
 * @throws {RangeError} ピッチ・許容差が不正、rect の座標が非有限か逆順、片流れで highSide が不正
 */
export function roofFramingLines({ rect, shape, ridgeIsVertical, highSide = null, purlinPitchMm, tolMm }) {
  requirePositive(purlinPitchMm, 'purlinPitchMm');
  requireNonNegative(tolMm, 'tolMm');
  const empty = { ridges: [], purlins: [] };
  if (!rect) return empty;
  for (const k of ['x1', 'y1', 'x2', 'y2']) requireFinite(rect[k], `rect.${k}`);
  if (rect.x2 < rect.x1 || rect.y2 < rect.y1) {
    throw new RangeError(`rect の座標が逆順です: ${JSON.stringify(rect)}`);
  }
  if (rect.x2 - rect.x1 <= tolMm || rect.y2 - rect.y1 <= tolMm) return empty;

  // 形状の分岐はここだけ（矩形専用の rect* を呼ぶ）。
  const vertical = typeof ridgeIsVertical === 'boolean' ? ridgeIsVertical : roofRidgeIsVertical(rect, tolMm);
  switch (shape) {
    case RoofShape.GABLE: return rectGableLines(rect, vertical, purlinPitchMm, tolMm);
    case RoofShape.MONO: return rectMonoLines(rect, highSide, purlinPitchMm, tolMm);
    case RoofShape.HIP: return rectHipLines(rect, purlinPitchMm, tolMm);
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
