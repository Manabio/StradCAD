// ================================================================
// 建具の壁長さ方向の移動（ドラッグ／「位置」欄）——可動範囲・スナップ・確定値の純関数
//
// 建具の位置は Opening.refOffset（refCL からの中心オフセット）1つで決まり、壁の切り欠き・
// 平面記号・記号丸・展開図はすべてそこから導出される。本モジュールは「中心をどこまで動かせるか」
// （可動範囲）と「ポインタ位置から確定値をどう決めるか」（スナップ→ステップ丸め→クランプ）だけを
// 担い、graph は読むだけで書き換えない（書き換えと undo は openingEdit.js／呼び出し側の責務）。
//
// 座標系: 壁の長さ方向の1次元。値はすべて「中心座標」（Opening.centerCoord と同じ軸）。
// refOffset へは refCL.effectiveValue を引いて換算する（Opening.centerCoord の定義と同じ基準。
// CL偏芯ドラッグ中の実効値を含む）。
//
// 可動範囲の定義（ユーザー裁定 2026-09-14）: ホスト壁の両端・同じ壁上の隣接開口の端・**壁を横切る
// 通り芯と中心線**で挟む（validateOpeningPlacement の「壁範囲内・重なり禁止」＋「CLをまたがない」）。
// 通り芯は壁の切れ目なので元からまたげないが、1本の長い壁を横切る中心線（部屋の間仕切り位置）も
// またげない——建具が間仕切りの芯をまたぐ配置は成立しないため（実機指摘 2026-09-14）。補助線
// （破線）・梁芯は建物の区画ではないので境界にしない。中心線は延長範囲（extent）が壁に届いている
// ものだけ（壁の手前で終わる中心線は無関係）。今すでにまたいでいる旧データのCLは無視する
// （範囲が空になって一切動かせなくなるより、次のドラッグから拘束される方が実用的）。
// 境界の位置はCL値ではなく**そのCL上で境界に突き当たる直交壁の材の面**（建具枠が壁に埋まらない。
// 実機指摘 2026-09-14）。直交壁が無いCLだけCL値で止める。偏芯壁は Wall.materialRange 経由で実位置。
// 「補助線・梁芯はまたげる」はCL自体の話で、そのCL上に実在する直交壁があれば材の面で止める
// （壁は種別を問わず物理的な障害物。QA指摘 2026-09-14 を受けて明文化）。
// 壁をまたぐ移動（refCL/axisCL の付け替え）は別課題。
//
// スナップ候補（同裁定）: 壁を横切るCLへの「中心一致」「端一致」と、隣接開口端・壁端（＝範囲端）
// への「端一致」の3種。またげないCL（通り芯・中心線）への中心一致は範囲外になるため実質は
// 端一致のみが効く（中心一致が効くのは補助線）。CL移動（snap.js findCLMoveSnap）と同じく梁芯は除外。
//
// react-konva / store.js / snap.js / .jsx を静的に引かない（node:test から単体 import 可能に保つ）。
// ================================================================

import { CenterLineType, centerLineKind } from '../core.js';
import { findHostWall, findOpeningsOnWall } from './openingGeometry.js';
// isOpeningBoundaryKind／kindsVisibleIn: core/centerLineKindPolicy.js は ./centerLine.js・
// ./constants.js のみに依存する純モジュール（import ゼロに近い規約）のため、ここから引いても
// react-konva/store.js/snap.js/.jsx を静的に引かない、という本ファイル冒頭の規約は壊れない。
import { isOpeningBoundaryKind, kindsVisibleIn } from '../core/centerLineKindPolicy.js';

/**
 * 壁と直交し、壁を横切る（または壁面に届く）CLか。建具がまたげない境界（通り芯・中心線）の判定。
 * 延長範囲（extentLo/Hi）が無い旧データ・通り芯は全域扱い（横切る）。判定区間は壁の「軸CL〜仕上げ面」
 * （壁材の厚み方向）に±1mmの許容——壁面で終わる中心線（extentLoRef/HiRef が壁参照）は間仕切りが
 * この壁に突き当たる位置なので、またげない境界に数える。
 */
export function clCrossesWall(cl, wall) {
  const crossType = wall.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  if (cl.centerLineType !== crossType) return false;
  if (cl.extentLo == null || cl.extentHi == null) return true;
  const a = wall.axisCL.effectiveValue, b = wall.axisValue;
  const lo = Math.min(a, b) - 1, hi = Math.max(a, b) + 1;
  return cl.extentLo <= hi && cl.extentHi >= lo;
}

/**
 * 建具がまたげないCLか（通り芯・中心線。補助線・梁芯は対象外）。
 * core/centerLineKindPolicy.js OPENING_BOUNDARY_KINDS（原始事実7）経由——可視性
 * （kindsVisibleIn等）とは別軸の独立事実のため専用の表を持つ（同ファイルの当該コメント参照）。
 */
function isBlockingKind(cl) {
  return isOpeningBoundaryKind(centerLineKind(cl));
}

// 建具スナップ対象の種別（openingSnapCandidatesで使う）: 平面系モード（floorplan/finish/opening）
// で可視な種別と同じ（通り芯・中心線・補助線。梁芯は除外）。建具の移動はappModeを問わず同じ関数を
// 通る（interaction/usePointerInteraction.js startOpeningDrag は floorplan/opening 起点にも展開図
// ドラッグにも共通で使われ、本ファイルの関数はappModeを引数に取らない）ため、特定のappModeではなく
// 「平面系で可視な種別」というmode非依存の固定集合として扱う——floorplan/finish/openingの
// VISIBLE_KINDS_BY_MODEはいずれも同じ['struct','center','aux']（centerLineKindPolicy.test.jsで
// 一致を検証済み）なので、代表として kindsVisibleIn('floorplan') を使う。
const OPENING_SNAP_CL_KINDS = kindsVisibleIn('floorplan');

/**
 * 境界（host と同じ軸CL・同じ向きで開口位置を含む全壁＝両室の壁・下地オーナー壁・仕上げ薄壁）の
 * 材の厚み方向区間の合併。1つの境界に壁は複数あるため、host 単体の materialRange では境界の
 * 全厚にならない。該当が無ければ host 自身の materialRange。
 */
function boundaryMaterialRange(host, opening, graph) {
  const c = opening.centerCoord;
  let lo = Infinity, hi = -Infinity;
  for (const w of graph.walls) {
    if (w.isVertical !== host.isVertical || w.axisCL.id !== host.axisCL.id) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (c < wLo || c > wHi) continue;
    lo = Math.min(lo, w.materialRange.lo);
    hi = Math.max(hi, w.materialRange.hi);
  }
  if (lo === Infinity) { const r = host.materialRange; return { lo: r.lo, hi: r.hi }; }
  return { lo, hi };
}

/**
 * 直交CL(cl)上の壁のうち境界に突き当たるもの（スパンが境界の厚み区間 boundary に±1mmで掛かる。
 * 境界のどちら側から突き当たる壁も含む）の材範囲（host の長さ方向座標）の合併。無ければ null。
 * 建具枠が直交壁の材に埋まらないための境界——CL値ではなく材の面で止める。偏芯壁（backingOffset／
 * CL偏芯）は Wall.materialRange が実位置を返すため、そのまま使えば配慮される（実機指摘 2026-09-14）。
 */
export function perpendicularWallMaterial(cl, host, boundary, graph) {
  let lo = Infinity, hi = -Infinity;
  for (const w of graph.walls) {
    if (w.isVertical === host.isVertical || w.axisCL.id !== cl.id) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (wLo > boundary.hi + 1 || wHi < boundary.lo - 1) continue;
    lo = Math.min(lo, w.materialRange.lo);
    hi = Math.max(hi, w.materialRange.hi);
  }
  return lo === Infinity ? null : { lo, hi };
}

/**
 * 中心座標の可動範囲 {min, max}。壁両端・隣接開口端・壁を横切る通り芯/中心線で挟み、開口幅の
 * 半分ずつ内側へ寄せる。隣接開口は「中心が自分より小さい側／大きい側」で振り分ける（重なり禁止
 * のため通常は端で判定しても同じだが、不正データで重なっていても取りこぼさない）。
 * 直交CLは、そのCL上に境界へ突き当たる壁があれば**その材の面**（perpendicularWallMaterial。建具枠が
 * 壁に埋まらない）、無ければ通り芯・中心線に限りCL値を境界にする。いずれも開口の端に対して
 * 「lo端以下／hi端以上」で振り分け、今またいでいるもの（旧データ）は無視する。
 * 収まる余地が無い（min>max。壁長不足・隣接開口に挟まれ過ぎ）場合は null。
 * @returns {{min:number, max:number}|null}
 */
export function openingMoveRange(wall, opening, graph) {
  const wallLo = Math.min(wall.coord1, wall.coord2), wallHi = Math.max(wall.coord1, wall.coord2);
  const center = opening.centerCoord;
  let loBound = wallLo, hiBound = wallHi;
  for (const o of findOpeningsOnWall(wall, graph)) {
    if (o.id === opening.id) continue;
    if (o.centerCoord <= center) loBound = Math.max(loBound, o.coord2);
    else                         hiBound = Math.min(hiBound, o.coord1);
  }
  const boundary = boundaryMaterialRange(wall, opening, graph);
  const crossType = wall.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const applyBound = (lo, hi) => {
    if (hi <= opening.coord1)      loBound = Math.max(loBound, hi);
    else if (lo >= opening.coord2) hiBound = Math.min(hiBound, lo);
  };
  for (const cl of graph.centerLines) {
    if (cl.centerLineType !== crossType) continue;
    const mat = perpendicularWallMaterial(cl, wall, boundary, graph);
    if (mat) { applyBound(mat.lo, mat.hi); continue; }
    if (!isBlockingKind(cl) || !clCrossesWall(cl, wall)) continue;
    applyBound(cl.value, cl.value);
  }
  const half = opening.width / 2;
  const min = loBound + half, max = hiBound - half;
  if (!(min <= max)) return null;
  return { min, max };
}

/**
 * refOffset（整数mm）の可動範囲。ホスト壁が引けない（findHostWall が null）場合は null＝制約なし
 * （validateOpeningEdit が幾何検証をスキップするのと同じ割り切り）。収まる余地が無い場合も null。
 * ceil/floor で整数化するため、端の値は常に中心範囲の内側に丸まる（外側には出ない）。
 * @returns {{min:number, max:number}|null}
 */
export function openingRefOffsetRange(opening, graph) {
  const wall = findHostWall(opening, graph);
  if (!wall) return null;
  const range = openingMoveRange(wall, opening, graph);
  if (!range) return null;
  return refOffsetRangeOf(range, opening.refCL.effectiveValue);
}

/** 中心座標の範囲 → refOffset（整数）の範囲。内側へ丸めた結果が空なら null。range=null は null。 */
export function refOffsetRangeOf(range, refValue) {
  if (!range) return null;
  const min = Math.ceil(range.min - refValue), max = Math.floor(range.max - refValue);
  return min > max ? null : { min, max };
}

/** refOffset を範囲へクランプする（range=null は制約なし）。有限でない値はそのまま返す。 */
export function clampRefOffset(refOffset, range) {
  if (!range || !Number.isFinite(refOffset)) return refOffset;
  return Math.min(Math.max(refOffset, range.min), range.max);
}

/**
 * スナップ候補（中心座標）の一覧。範囲内のものだけを返す。
 *  - 'cl-center': 壁を横切るCL（壁が縦なら水平CL、横なら垂直CL。梁芯除外）に開口中心を合わせる
 *  - 'cl-edge'  : 同CLに開口の端（lo端／hi端）を合わせる
 *  - 'range-end': 範囲端（壁端・隣接開口端に開口の端が接する位置。edge=-1: lo端が接する／+1: hi端）
 * 同じ中心座標に複数候補があっても重複除去はしない（最近傍選択に影響しないため）。
 * @param {object} wall
 * @param {object} opening
 * @param {object} graph
 * @param {{min:number,max:number}} range - openingMoveRange の結果
 * @returns {{value:number, kind:'cl-center'|'cl-edge'|'range-end', cl?:object, edge?:-1|1}[]}
 */
export function openingSnapCandidates(wall, opening, graph, range) {
  const out = [];
  const inRange = v => v >= range.min - 1e-6 && v <= range.max + 1e-6;
  const push = (value, kind, extra) => { if (inRange(value)) out.push({ value, kind, ...extra }); };
  const crossType = wall.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const half = opening.width / 2;
  for (const cl of graph.centerLines) {
    if (cl.centerLineType !== crossType) continue;
    if (!OPENING_SNAP_CL_KINDS.includes(centerLineKind(cl))) continue;
    const v = cl.value;
    push(v,        'cl-center', { cl });
    push(v + half, 'cl-edge',   { cl });
    push(v - half, 'cl-edge',   { cl });
  }
  push(range.min, 'range-end', { edge: -1 });
  push(range.max, 'range-end', { edge: 1 });
  return out;
}

/**
 * スナップ成立時にインジケータを置く「長さ方向の座標」。CL系は CL の位置（中心一致でも端一致でも
 * 吸着した線そのもの）、範囲端は接している開口の端（壁端・隣接開口端）。呼び出し側が壁の
 * axisValue と組み合わせてワールド座標にする。
 */
export function snapIndicatorAlong(candidate, halfWidth) {
  if (candidate.kind === 'range-end') return candidate.value + (candidate.edge ?? 0) * halfWidth;
  return candidate.cl ? candidate.cl.value : candidate.value;
}

/**
 * スナップ候補の優先ティア（小さいほど優先）。通り芯(struct) → 中心線・補助線 → 範囲端。
 * 実データでは通り芯が壁端のすぐ内側（数十mm）を横切ることが多く、範囲端候補や100mmピッチの
 * 中心線候補が同じ閾値内に密集する。「最も近い候補」だけで選ぶと通り芯が特別扱いされず、
 * ドラッグ中に通り芯で止まって見えない（実機指摘 2026-09-14）。範囲端はスナップしなくても
 * クランプで到達できるため最下位でよい。
 */
function candidateTier(c) {
  if (c.kind === 'range-end') return 2;
  return c.cl && centerLineKind(c.cl) === 'struct' ? 0 : 1;
}

/**
 * ポインタ位置（中心座標の生値）から確定する refOffset を決める。
 *  1. 閾値(thresholdMm)以内の候補のうち、ティア（candidateTier: 通り芯 → 中心線・補助線 → 範囲端）が
 *     最上位のものの中で最も近いものにスナップ
 *  2. 無ければ refCL 基準でステップ丸め（CL移動の roundAbsToStep と同じ「表示倍率に応じた刻み」。
 *     stepMm は呼び出し側が renderer/clMoveMath.js calcStep で求めて渡す。0以下なら整数丸め）
 *  3. 範囲（中心座標の range＝openingMoveRange の結果。null は制約なし）を refOffset の整数範囲へ
 *     換算してクランプ
 * スナップ時も refOffset は整数へ丸める（CL値が非整数のときは最大0.5mmずれるが、位置欄が整数
 * 規約のため。範囲端は ceil/floor 済みの整数範囲でクランプされるので外側には出ない）。
 * rawCenter が有限でなければ null（呼び出し側は無視する。CL移動の NaN 防御と同じ）。
 * @param {number} rawCenter
 * @param {{refValue:number, range:{min:number,max:number}|null, candidates?:{value:number,kind:string}[],
 *          thresholdMm?:number, stepMm?:number}} opts
 * @returns {{refOffset:number, snapped:boolean, candidate:object|null}|null}
 */
export function resolveOpeningRefOffset(rawCenter, { refValue, range, candidates = [], thresholdMm = 0, stepMm = 1 }) {
  if (!Number.isFinite(rawCenter)) return null;
  const offRange = refOffsetRangeOf(range, refValue);
  let best = null, bestTier = Infinity, bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c.value - rawCenter);
    if (d >= thresholdMm) continue;
    const tier = candidateTier(c);
    if (tier < bestTier || (tier === bestTier && d < bestDist)) { bestTier = tier; bestDist = d; best = c; }
  }
  let refOffset;
  if (best) {
    refOffset = Math.round(best.value - refValue);
  } else {
    const rel = rawCenter - refValue;
    refOffset = stepMm > 0 ? Math.round(rel / stepMm) * stepMm : Math.round(rel);
  }
  refOffset = clampRefOffset(refOffset, offRange);
  return { refOffset, snapped: !!best, candidate: best };
}

// ---- 展開図ドラッグの座標換算（interaction/usePointerInteraction.js と renderer/ElevationLayer.jsx が共有）----
// 面の向き dirSign（elevationFigure.js localXOf: localX = (world - originWorld) * dirSign）の符号判断を
// 1箇所に集める——フックとレンダラに2回現れると片方だけ直して逆走する。

/**
 * 押下点からの画面x移動を壁長さ方向（世界座標）の位置へ。scale は展開図の px/mm（ElevationModeState.scale）。
 * 画面右へ動かす＝帯ローカルxが増える＝世界座標は dirSign 方向へ増える。
 */
export function elevationDragAlong({ downCenter, downClientX, clientX, scale, dirSign }) {
  return downCenter + dirSign * (clientX - downClientX) / scale;
}

/** 確定した新しい中心（世界座標）から、プレビューで建具のプリミティブをずらす帯ローカルx量(mm)。 */
export function previewDxLocalMm(newCenter, downCenter, dirSign) {
  return (newCenter - downCenter) * dirSign;
}
