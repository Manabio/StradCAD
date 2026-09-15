// 平面詳細LODの壁下地材（間柱断面）の並べ方。純モジュール（react-konva・store.js・.jsx を静的に引かない）。
//
// ShapesLayer.jsx が持っていた判断（下地帯の端の正規化・柱壁に取られた区間の除外・450固定ピッチ）を
// ここへ移し、主構造ルールの選択子 `studLayout`（structural/structureRules.js）で分岐する:
//  - 'fixedPitch'      … 壁の始端（spanLo）から WALL_BACKING_PITCH 固定ピッチ・見かけ幅 WALL_STUD_WIDTH（従来）。
//  - 'betweenColumns'  … 壁上の柱で区切った各面（2点間）を studPositions（455等分割付）で割り付け、面の
//                        両端は柱面から studColumnClearanceMm(10) を空けて端部材を立てる（在来木造。
//                        woodFraming.js の wallRunFaces / faceStudPositions）。材厚は studDepthMm(30)。
// 呼び出し側（wallDrawPlan.js buildWallDrawPlan）が壁ごとの区間・柱区間・ルールを渡し、ここは
// 「どの位置に材を描くか」だけを返す。
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { wallRunFaces, faceStudPositions } from '../structural/woodFraming.js';

// 壁下地（間柱）のピッチ表現(mm)。固定ピッチ割付（在来木造以外）でのみ使用。
export const WALL_BACKING_PITCH = 450;
// 壁下地の角材を通り芯方向に描く際の見かけ幅(mm)。実材の長手方向寸法は壁データに
// 持たないため、間柱の標準的な厚み（□-90×45 の 45 側）を描画上の固定値として使う（固定ピッチ割付）。
export const WALL_STUD_WIDTH = 45;

/**
 * 下地スタッドを並べる長さ方向の区間。開口で分かれた `segments` のうち物理端（spanLo/spanHi）に接する端だけを
 * 領域が正規化した下地の端（`backingSpan`。取り合う相手の内側線まで延長／短縮・端部の回り込み反映済み）へ
 * 置き換え、開口の縁はそのまま（planWallRegion.js の下地矩形と同じ規則）。柱壁に取られた区間（`studCuts`。
 * columnWallCuts の canRemoveBacking）は落とす（ユーザー指示2026-08「不要になった壁下地材は削除」）。
 * @param {{segments:Array<[number,number]>, spanLo:number, spanHi:number, backingSpan:[number,number]}} plan
 * @param {Array<[number,number]>} [studCuts]
 * @returns {Array<[number,number]>}
 */
export function studSegments({ segments, spanLo, spanHi, backingSpan }, studCuts = []) {
  const extended = segments
    .map(([a, b]) => [a <= spanLo ? backingSpan[0] : a, b >= spanHi ? backingSpan[1] : b])
    .filter(([a, b]) => b > a);
  return studCuts.length === 0 ? extended : extended.flatMap(([a, b]) => subtractIntervals(a, b, studCuts));
}

/** 固定ピッチ割付（従来）: 壁の始端 `spanLo` を基準に pitch ごと、材が区間に収まる位置だけ。 */
export function fixedPitchStudCenters(segments, spanLo, pitch = WALL_BACKING_PITCH, width = WALL_STUD_WIDTH) {
  const half = width / 2;
  const out = [];
  for (const [a, b] of segments) {
    let p = spanLo + Math.ceil((a - spanLo) / pitch) * pitch;
    if (p - half < a) p += pitch;
    for (; p + half <= b; p += pitch) out.push(p);
  }
  return out;
}

/**
 * 柱間の面割付（在来木造）: 各区間を壁上の柱区間で面に分け、面ごとに faceStudPositions を面の始端へ足す。
 * @param {Array<[number,number]>} segments
 * @param {Array<[number,number]>} columnIntervals - 壁上の柱の長さ方向の区間
 * @param {{pitchMm:number, depthMm:number, clearanceMm:number}} spec
 * @returns {number[]}
 */
export function betweenColumnsStudCenters(segments, columnIntervals, spec) {
  const out = [];
  for (const [a, b] of segments) {
    for (const face of wallRunFaces(a, b, columnIntervals)) {
      for (const p of faceStudPositions(face.hi - face.lo, face, spec)) out.push(face.lo + p);
    }
  }
  return out;
}

/**
 * 壁1本の下地材の描画位置（長さ方向の中心）と材厚を、主構造ルールの選択子で解く。
 * @param {object} plan - resolveWallLines の結果（segments/spanLo/spanHi/backingSpan）
 * @param {{layout:string, backing:object|null, columnIntervals:Array<[number,number]>, studCuts:Array<[number,number]>}} deps
 *   layout: rules.studLayout／backing: rules.backing（'betweenColumns' の値。無ければ固定ピッチへ）
 * @returns {{centers:number[], depth:number}|null} 並べる区間が無ければ null
 */
export function resolveWallStuds(plan, { layout, backing = null, columnIntervals = [], studCuts = [] }) {
  if (!plan?.backingSpan) return null;
  const segments = studSegments(plan, studCuts);
  if (segments.length === 0) return null;
  if (layout === 'betweenColumns' && backing) {
    const spec = { pitchMm: backing.studPitchMm, depthMm: backing.studDepthMm, clearanceMm: backing.studColumnClearanceMm };
    return { centers: betweenColumnsStudCenters(segments, columnIntervals, spec), depth: backing.studDepthMm };
  }
  return { centers: fixedPitchStudCenters(segments, plan.spanLo), depth: WALL_STUD_WIDTH };
}

/**
 * 壁上に立つ柱の、壁の長さ方向の区間。柱の矩形（finish/columnWrap.js bareColumnRect）のうち厚み方向の範囲が
 * 壁の下地帯と重なるものだけ。柱の位置に材は立たず、柱面が面の端になる。
 * @param {{isVertical:boolean, backingRange:{lo:number,hi:number}}} wall
 * @param {Array<{xLo:number,xHi:number,yLo:number,yHi:number}>} columnRects
 * @returns {Array<[number,number]>}
 */
export function columnIntervalsOnWall(wall, columnRects) {
  const band = wall.backingRange;
  if (!band) return [];
  const out = [];
  for (const r of columnRects) {
    const [acrossLo, acrossHi, alongLo, alongHi] = wall.isVertical
      ? [r.xLo, r.xHi, r.yLo, r.yHi] : [r.yLo, r.yHi, r.xLo, r.xHi];
    if (acrossLo < band.hi && acrossHi > band.lo) out.push([alongLo, alongHi]);
  }
  return out;
}
