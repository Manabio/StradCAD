/**
 * 展開図: 吹抜け（VOID）部屋の2層帯（WP-V1。設置階下階のFLから設置階の天井高さまで、CLを
 * 合わせて描画）。設計意図は .claude/elevation-model.md 参照。
 *
 * 方式:「自階（吹抜けRoom）の面を下へ延長する」——世界座標は全階共通のため、同じ壁中心線＝
 * 同じ世界座標で自動的にCLが揃う。下階の面リストを別に組んで縦に積む必要は無い。ctx.faceOverride
 * （elevationBand.jsのlayoutBandFacesが公開するフック）で各面のfloorSegmentsを下へずらすだけで
 * 実現する（床が下がる・天井は動かない＝ceilAbs=floorDelta+chMmが不変になるよう変換する）。
 * ただし下へ延長してよいのは**下階に同じ壁が実在する区間だけ**（lowerCoverLocal）。
 */
import { roomBounds } from '../finish/gridCells.js';
import { graphList } from '../graphReadScope.js';
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

// 面の軸CLと下階の壁を同一視する世界座標の許容差(mm)。CLは階ごとに別オブジェクトのため、
// idではなく世界座標で突き合わせる（section層のisSightlineShapeと同じ規約）。
const LOWER_AXIS_EPS_MM = 1;
// 分割で生じる極小区間を捨てる下限(mm)。
const MIN_SUB_SEG_MM = 1e-6;

// 世界範囲の配列を昇順に整列・結合する。
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi) last.hi = Math.max(last.hi, r.hi);
    else out.push({ ...r });
  }
  return out;
}

/**
 * face と同じ位置（軸CLの世界座標・向きが一致）の壁が lowerGraph に実在する世界範囲。
 * 吹抜けの2層帯は「自階の面を下へ延長する」方式のため、下階に壁が無い区間まで延長すると
 * 実在しない壁の輪郭が1FLまで描かれてしまう（ユーザー実機指摘2026-08その17と同じ構造の不具合。
 * 階段帯はsection層で層ごとに壁を拾うが、吹抜け帯は面をそのまま引き伸ばすだけだった）。
 * @param {object} face
 * @param {object} lowerGraph
 * @returns {{lo:number,hi:number}[]} 世界座標の範囲（結合済み）
 */
function lowerWallWorldRanges(face, lowerGraph) {
  const axis = face.axisCL?.effectiveValue;
  if (axis == null) return [];
  const ranges = [];
  for (const w of graphList(lowerGraph, 'walls') ?? []) {
    if (!w.isVertical !== !face.isVertical) continue;
    const wAxis = w.axisCL?.effectiveValue;
    if (wAxis == null || Math.abs(wAxis - axis) > LOWER_AXIS_EPS_MM) continue;
    ranges.push({ lo: Math.min(w.coord1, w.coord2), hi: Math.max(w.coord1, w.coord2) });
  }
  return mergeRanges(ranges);
}

/**
 * lowerWallWorldRangesを面のローカルx（0..run）へ写した被覆範囲。
 * world = originWorld + dirSign * localX（snapFaceEndsToCornersの規約）。
 */
function lowerCoverLocal(face, lowerGraph) {
  const world = lowerWallWorldRanges(face, lowerGraph);
  const sign = face.dirSign > 0 ? 1 : -1;
  const local = world.map(r => {
    const a = sign * (r.lo - face.originWorld), b = sign * (r.hi - face.originWorld);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  });
  return mergeRanges(local);
}

/**
 * 1つのfloorSegmentを被覆範囲(cover)で切り分ける。返り値は元の[loX,hiX]を隙間なく覆う
 * 小区間の並び（covered=下階に壁があるので下へ延長してよい区間）。
 */
function splitSegByCover(seg, cover) {
  const cuts = [seg.loX];
  for (const c of cover) {
    if (c.lo > seg.loX && c.lo < seg.hiX) cuts.push(c.lo);
    if (c.hi > seg.loX && c.hi < seg.hiX) cuts.push(c.hi);
  }
  cuts.push(seg.hiX);
  cuts.sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const loX = cuts[i], hiX = cuts[i + 1];
    if (hiX - loX <= MIN_SUB_SEG_MM) continue;
    const mid = (loX + hiX) / 2;
    parts.push({ loX, hiX, covered: cover.some(c => mid > c.lo && mid < c.hi) });
  }
  return parts;
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
    // 下へ延長するのは**下階に同じ壁が実在する区間だけ**（lowerCoverLocal）。壁の無い区間は
    // 設置階の床（2FL）のまま残し、その境界は既存の段差床線の仕組みで縦の折れとして出る
    // ——延長しない＝「下階はこの面では壁が無い（アキ）」という表現。
    faceOverride = (face, i, defaults) => {
      if (!defaults.floorSegments) return null; // 段差見付け面（kind==='step'）は対象外
      const cover = lowerCoverLocal(face, lowerGraph);
      const out = [];
      for (const seg of defaults.floorSegments) {
        for (const part of splitSegByCover(seg, cover)) {
          // hiCLIdは元の区間の右端に達する小区間だけが引き継ぐ（分割で生じた内側の境界は
          // 段差CLではないため、ROW1寸法の分割点にしてはいけない）。
          const hiCLId = part.hiX === seg.hiX ? seg.hiCLId : null;
          out.push(part.covered
            ? { ...seg, loX: part.loX, hiX: part.hiX, hiCLId,
                floorDeltaMm: seg.floorDeltaMm - dropMm, chMm: (seg.chMm ?? defaults.CH) + dropMm }
            : { ...seg, loX: part.loX, hiX: part.hiX, hiCLId });
        }
      }
      return { floorSegments: out };
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
