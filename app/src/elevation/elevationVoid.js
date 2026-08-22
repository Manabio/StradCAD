/**
 * 展開図: 吹抜け（VOID）部屋の2層帯（WP-V1。設置階下階のFLから設置階の天井高さまで、CLを
 * 合わせて描画）。設計意図は .claude/elevation-model.md 参照。
 *
 * 方式:「自階（吹抜けRoom）の面を下へ延長する」——世界座標は全階共通のため、同じ壁中心線＝
 * 同じ世界座標で自動的にCLが揃う。下階の面リストを別に組んで縦に積む必要は無い。ctx.faceOverride
 * （elevationBand.jsのlayoutBandFacesが公開するフック）で各面のfloorSegmentsを下へずらすだけで
 * 実現する（床が下がる・天井は動かない＝ceilAbs=floorDelta+chMmが不変になるよう変換する）。
 */
import { roomBounds } from '../finish/gridCells.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { layoutBandFaces, finalizeBand } from './elevationBand.js';

// 2つのワールド矩形が重なるか（面積0の接触は重なりに含めない）。
// elevationStair.jsのfindOverlappingVoidRoomと同じ実装（R: 矩形重なり探索部を共有ヘルパへ切り出し）。
function rectsOverlap(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/**
 * bounds（世界矩形）と重なる predicate 該当Roomを targetGraph から1つ返す（無ければnull）。
 * elevationStair.js の findOverlappingVoidRoom（階段の直上階VOID/STAIR_VOID探索）と、本ファイルの
 * 吹抜け下階の対応Room探索の両方が共有する（R: 矩形重なり探索部の切り出し）。
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} bounds
 * @param {object} targetGraph
 * @param {(room:import('@core').Room) => boolean} predicate
 * @returns {import('@core').Room|null}
 */
export function findOverlappingRoom(bounds, targetGraph, predicate) {
  if (!bounds) return null;
  for (const r of targetGraph.rooms) {
    if (!predicate(r)) continue;
    const b = roomBounds(r.cells, targetGraph);
    if (b && rectsOverlap(bounds, b)) return r;
  }
  return null;
}

/**
 * 吹抜けRoom（voidRoom）と footprint が重なる、lowerGraph上の通常部屋（feature===null）を
 * 1つ返す（無ければnull）。
 */
function findLowerRoom(voidRoom, graph, lowerGraph) {
  const bounds = roomBounds(voidRoom.cells, graph);
  return findOverlappingRoom(bounds, lowerGraph, r => r.feature == null);
}

/**
 * 吹抜け部屋の帯（設置階下階のFLから設置階の天井高さまでの2層帯。CLを合わせて描画）。
 * lowerGraph・ctx.floorHeightBelowMm のどちらかが無ければ drop なしの1層帯（buildRoomBand相当・
 * heightUnits:1）を返す（例外は投げない）。
 * @param {import('@core').Room} voidRoom
 * @param {object} graph - 設置階のgraph
 * @param {object|null} lowerGraph - 直下階のgraph（floorSwapManager.peek済み。呼び出し側が解決する）
 * @param {{floorHeightBelowMm?:number|null, project?:object, materialMap?:Map, gridCLs?:object[],
 *   gapModelMm?:number, nameGapModelMm?:number, triangleOffsetModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number, wallLessEndExtendModelMm?:number,
 *   scale?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   topMarginMm:number, heightUnits:number, unitHeightMm:number}}
 */
export function buildVoidBand(voidRoom, graph, lowerGraph, ctx = {}) {
  const faces = composeRoomFaces(voidRoom, graph);
  const floorHeightBelowMm = ctx.floorHeightBelowMm ?? null;
  const hasLower = lowerGraph != null && floorHeightBelowMm != null;

  let faceOverride;
  let dropMm = 0;
  if (hasLower) {
    const lowerRoom = findLowerRoom(voidRoom, graph, lowerGraph);
    const flDiffMm = lowerRoom
      ? lowerGraph.effectiveFloorLevel(lowerRoom) - lowerGraph.floorDatum
      : 0;
    // QA修正: 下階Roomの沈み床（flDiffMmが大きく負）でfloorHeightBelowMm+flDiffMmが0以下になりうる。
    // 物理的に「設置階下階のFLが設置階のFL以上」という値は2層表現として意味を持たないため、
    // 0でクランプする（クランプせず負値のまま使うと、床が天井より上に来る空白の2層帯になる）。
    dropMm = Math.max(0, floorHeightBelowMm + flDiffMm);
    // ceilAbs = floorDelta + chMm が不変（天井は動かず床だけ下がる）。
    faceOverride = (face, i, defaults) => {
      if (!defaults.floorSegments) return null; // 段差見付け面（kind==='step'）は対象外
      return {
        floorSegments: defaults.floorSegments.map(seg => ({
          ...seg,
          floorDeltaMm: seg.floorDeltaMm - dropMm,
          chMm: (seg.chMm ?? defaults.CH) + dropMm,
        })),
      };
    };
  }

  const { primitives, chDimX, prevBoundaryHi } = layoutBandFaces(voidRoom, graph, faces, { ...ctx, faceOverride });
  return finalizeBand(voidRoom, graph, primitives, {
    faceCount: faces.length, chDimX, prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
    // QA修正: dropMmが0にクランプされた（下階FL差で相殺された）場合は実質1層と同じ表現のため
    // heightUnits=1にする（hasLowerだけを見ると2層予約されたままになってしまう）。
    heightUnits: hasLower && dropMm > 0 ? 2 : 1,
  });
}
