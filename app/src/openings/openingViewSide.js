// ================================================================
// 建具の組込み姿図を「見る側」に合わせて描くための判定（純関数）。
//
// 姿図の開き線は「扉＝開く側から・窓＝室外から」見た線種を正準とする（openingElevationFigure.js）。
// 展開図・立面図は壁のどちら側から見るかが面ごとに決まるため、建具が見る側へ手前に開くか（true）、
// 向こうへ開くか（false）を返し、姿図が開き線の線種（手前＝実線／向こう＝一点鎖線）を決める。
// 判定できない機構・入力は null（＝従来の正準図）。例外は投げない。
// ================================================================

import { HINGED_MECHANISMS, OpeningMechanism } from './openingCatalog.js';
import { swingOpenPerpDir } from './openingPlanSymbolGeometry.js';
import { findHostWall, exteriorSideDir } from './openingGeometry.js';

// 吊元を持たず、壁の室外側／室内側へ決まって開く窓（開く向きは壁の室外側の向きから決まる）。
const OUTWARD_HINGELESS = new Set([
  OpeningMechanism.PROJECT_OUT,
  OpeningMechanism.TILT_OUT,
  OpeningMechanism.AWNING_MULTI,
]);
const INWARD_HINGELESS = new Set([OpeningMechanism.TILT]);

// 両方向へ開く（手前とも向こうとも言えない）蝶番系。
const BOTH_WAYS = new Set([OpeningMechanism.FREE, OpeningMechanism.FREE_DOUBLE]);

const isPerp = v => v === 1 || v === -1;

/**
 * 建具が見る側へ手前に開くか。
 * @param {{isVertical:boolean, hingeSide:number, swingSide:number}} opening
 * @param {string} mechanism - OpeningMechanism の値
 * @param {{viewerPerp:number, exteriorPerp?:number|null, entry?:object|null}} sides
 *   viewerPerp: 見る側の壁面の方向（壁に直交する軸の ±1。展開図＝face.inward・立面図＝segment.outwardSign）。
 *   exteriorPerp: 壁の室外側の方向（±1。外壁でなければ null）。吊元を持たない窓だけが使う。
 * @returns {boolean|null} true＝手前に開く／false＝向こうへ開く／null＝判定しない
 */
export function openingOpensTowardViewer(opening, mechanism, { viewerPerp, exteriorPerp = null, entry = null } = {}) {
  if (!opening || !isPerp(viewerPerp)) return null;
  if (BOTH_WAYS.has(mechanism)) return null;
  if (HINGED_MECHANISMS.has(mechanism)) {
    const { isVertical, hingeSide, swingSide } = opening;
    if (!isPerp(hingeSide) || !isPerp(swingSide)) return null;
    // 平面記号と同じ関数（両開き系の実効吊元を含む）。entry は両袖の判定（FIRE_DOOR の fireLeaves 等）に使い、
    // 無いときは機構既定の扱い。
    const openPerp = swingOpenPerpDir(!!isVertical, hingeSide, swingSide, mechanism, entry);
    return isPerp(openPerp) ? openPerp === viewerPerp : null;
  }
  const outward = OUTWARD_HINGELESS.has(mechanism);
  if (!outward && !INWARD_HINGELESS.has(mechanism)) return null;
  if (!isPerp(exteriorPerp)) return null;
  const openDir = outward ? exteriorPerp : -exteriorPerp;
  return openDir === viewerPerp;
}

/**
 * 展開図用: 建具が乗る壁の室外側の方向（±1）。外壁でない（間仕切り）・ホスト壁が無い・吊元を持たない窓以外は null。
 * 平面記号の openingExteriorDir と違い、屋内境界でも host.faceDir へは落とさない（室外が無ければ null）。
 */
export function openingExteriorPerp(opening, mechanism, graph) {
  if (!OUTWARD_HINGELESS.has(mechanism) && !INWARD_HINGELESS.has(mechanism)) return null;
  const host = graph ? findHostWall(opening, graph) : null;
  if (!host) return null;
  const dir = exteriorSideDir(host, graph, opening.centerCoord);
  return isPerp(dir) ? dir : null;
}
