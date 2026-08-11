/**
 * 展開図: 階段部屋の2層帯（設置階＋直上階）・起点面の回転。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 上階（吹抜け部でクリップ）の表現は「上階FL線を重ねて引くだけ」の簡易実装にとどめる
 * （複雑階段の上層クリップ精度はセル粒度で可——.claude/elevation-model.md defer節）。
 */
import { RoomFeature } from '@core';
import { roomBounds } from '../finish/gridCells.js';
import { stairPortEdges } from '../finish/stair/stairGeometry.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { buildSwitchbackSectionPrimitives } from './elevationStairSection.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import {
  DEFAULT_FACE_GAP_MM, CH_DIM_OFFSET_MM, DEFAULT_TRIANGLE_OFFSET_MM, ElevationLineRole, weightForRole,
} from './elevationStyle.js';
import { translatePrimitive, collectGridCLs, appendRoomNameFrame } from './elevationPrimitives.js';

const CORNER_EPS = 1; // mm — stairPortEdges(世界座標)とfaceのaxisCL一致判定の許容差

/**
 * faces（buildRoomFaces の結果。時計回りの1周）を startLabel の面が先頭に来るよう回転する。
 * A→B→C→D の巡回順自体は保つ（配列を単純に回転するだけ）ため、隣接面の隅一致（I2/I6）は
 * 回転後も保たれる。startLabel が見つからない場合はそのまま返す。
 */
export function rotateFacesToStart(faces, startLabel) {
  const idx = faces.findIndex(f => f.label === startLabel);
  if (idx <= 0) return faces;
  return [...faces.slice(idx), ...faces.slice(0, idx)];
}

/**
 * 階段の起点面（登り口＝entryが乗っている面）のラベルを返す。
 * stairPortEdges（世界座標のfootprint境界辺）と、faceのaxisCLの実効値・向き・区間重なりで対応付ける。
 * 対応する面が見つからない場合は faces[0] のラベル（無ければ null）にフォールバックする。
 */
export function stairStartFaceLabel(stair, faces, graph) {
  const edges = stairPortEdges(stair, graph, ['entry']);
  for (const edge of edges) {
    const match = faces.find(f =>
      f.isVertical === edge.isVertical &&
      Math.abs(f.axisCL.effectiveValue - edge.value) < CORNER_EPS &&
      Math.min(f.hi, edge.hi) - Math.max(f.lo, edge.lo) > 0);
    if (match) return match.label;
  }
  return faces[0]?.label ?? null;
}

// 2つのワールド矩形が重なるか（面積0の接触は重なりに含めない）。
function rectsOverlap(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/** stairRoomの footprint と重なる、upperGraph上のSTAIR_VOID/VOID Roomを1つ返す（無ければnull）。 */
function findOverlappingVoidRoom(stairRoom, graph, upperGraph) {
  const stairBounds = roomBounds(stairRoom.cells, graph);
  if (!stairBounds) return null;
  for (const r of upperGraph.rooms) {
    if (r.feature !== RoomFeature.VOID && r.feature !== RoomFeature.STAIR_VOID) continue;
    const b = roomBounds(r.cells, upperGraph);
    if (b && rectsOverlap(stairBounds, b)) return r;
  }
  return null;
}

/**
 * 階段部屋の2層帯（設置階＋直上階。吹抜け部でクリップ）を組み立てる。
 * upperGraph=null（直上階が無い・peek未解決）のときは1層のみ返す。
 *
 * 描画範囲は「設置階の床→設置階の階高→さらに設置階上階の階高まで」の縦2層分にする
 * （項目11）。floorHeight=設置階〜上階（floorHeightAbove(project, graph.plane)）、
 * upperFloorHeight=上階〜そのまた上階（floorHeightAbove(project, upperGraph.plane)）。
 * 上階のそのまた上階が無ければ2層目の高さ情報が無いため1層目までにとどめる。
 * @param {import('@core').Room} stairRoom
 * @param {object} graph - 設置階のgraph
 * @param {object|null} upperGraph - 直上階のgraph（floorSwapManager.peek済み。呼び出し側が解決する）
 * @param {{stair?:object, project?:object, materialMap?:Map, gridCLs?:object[], floorHeight?:number,
 *   gapModelMm?:number, nameGapModelMm?:number, triangleOffsetModelMm?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null}}
 */
export function buildStairBand(stairRoom, graph, upperGraph, ctx = {}) {
  const stair       = ctx.stair ?? [...graph.stairs].find(s => s.roomId === stairRoom.id) ?? null;
  const project     = ctx.project ?? null;
  const materialMap = ctx.materialMap ?? null;
  const gridCLs     = ctx.gridCLs ?? collectGridCLs(graph);
  const gapModelMm  = ctx.gapModelMm ?? DEFAULT_FACE_GAP_MM;
  const nameGapModelMm = ctx.nameGapModelMm; // 未指定はappendRoomNameFrame既定(DEFAULT_NAME_GAP_MM)へ委ねる
  const triOffsetMm = ctx.triangleOffsetModelMm ?? DEFAULT_TRIANGLE_OFFSET_MM;

  let faces = buildRoomFaces(stairRoom, graph);
  if (stair && faces.length > 0) {
    const startLabel = stairStartFaceLabel(stair, faces, graph);
    if (startLabel) faces = rotateFacesToStart(faces, startLabel);
  }

  const chInfo = roomCeilingHeight(graph, stairRoom);
  const CH = chInfo.mm;
  const floorHeight = ctx.floorHeight ?? floorHeightAbove(project, graph.plane);
  // 項目11: 設置階上階のそのまた階高。upperGraphが無い・peek未解決なら不明（1層のみ）。
  const upperFloorHeight = upperGraph ? floorHeightAbove(project, upperGraph.plane) : null;
  const totalStairHeight = floorHeight != null ? floorHeight + (upperFloorHeight ?? 0) : null;

  const primitives = [];
  const faceRuns = [];
  let xCursor = 0;
  let prevBoundaryHi = null; // 直前面の壁中心線(hi側)の帯内絶対x（buildRoomBandと同じ配置規則）
  let chDimX = null; // 天井高寸法線のx（先頭面のみ設定。項目9の左アンカー起点）
  faces.forEach((face, i) => {
    const boundary = faceBoundaryLocalX(face, graph);
    xCursor = i === 0 ? 0 : prevBoundaryHi + gapModelMm - boundary.lo;

    const faceCtx = { graph, project, room: stairRoom, ceilingHeight: CH, materialMap, gridCLs };
    for (const p of buildFaceFigure(face, faceCtx)) primitives.push(translatePrimitive(p, xCursor, 0));
    if (i === 0) {
      chDimX = boundary.lo - CH_DIM_OFFSET_MM;
      primitives.push({
        type: 'dim', dir: 'v', at: chDimX, from: -CH, to: 0, foot: 0, dot: true, label: chInfo.raw,
      });
    }
    faceRuns.push({ face, xCursor });
    prevBoundaryHi = xCursor + boundary.hi;
  });

  // 上階（吹抜け部でクリップ）: 上階FL線（CUT）を重ねて引き、両端縦線をCHから
  // totalStairHeight（2層分の階高）まで延長する簡易表現（項目11）。
  if (upperGraph && floorHeight != null) {
    const upperRoom = findOverlappingVoidRoom(stairRoom, graph, upperGraph);
    if (upperRoom) {
      const upperFaces = buildRoomFaces(upperRoom, upperGraph);
      const cutWeight = weightForRole(ElevationLineRole.CUT);
      for (const { face, xCursor: x0 } of faceRuns) {
        const upperFace = upperFaces.find(f =>
          f.isVertical === face.isVertical && Math.abs(f.axisCL.effectiveValue - face.axisCL.effectiveValue) < CORNER_EPS);
        if (!upperFace) continue;
        primitives.push(translatePrimitive(
          { type: 'line', x1: 0, y1: -floorHeight, x2: face.run, y2: -floorHeight, weight: cutWeight },
          x0, 0,
        ));
        // 両端縦線をCH→totalStairHeightまで延長（2層分の枠を可視化）
        primitives.push(translatePrimitive(
          { type: 'line', x1: 0, y1: -CH, x2: 0, y2: -totalStairHeight, weight: cutWeight }, x0, 0,
        ));
        primitives.push(translatePrimitive(
          { type: 'line', x1: face.run, y1: -CH, x2: face.run, y2: -totalStairHeight, weight: cutWeight }, x0, 0,
        ));
        // 上階のそのまた階高（2層目）が確定していればFL線をもう1本足す
        if (upperFloorHeight != null) {
          primitives.push(translatePrimitive(
            { type: 'line', x1: 0, y1: -totalStairHeight, x2: face.run, y2: -totalStairHeight, weight: cutWeight },
            x0, 0,
          ));
        }
      }
    }
  }

  // 折返し階段（SWITCHBACK）の断面プロファイルを起点面(xCursor=0)に重ねて描く（項目12）。
  for (const p of buildSwitchbackSectionPrimitives(stair, graph, floorHeight)) primitives.push(p);

  const leftAnchorX  = chDimX != null ? chDimX - triOffsetMm : null;
  const rightAnchorX = prevBoundaryHi != null ? prevBoundaryHi + triOffsetMm : null;
  // 部屋名枠＋左右引出線＋留め三角（buildRoomBandと共有。以前は階段帯だけ欠落していた）。
  appendRoomNameFrame(primitives, stairRoom.name, { nameGapModelMm, leftX: leftAnchorX, rightX: rightAnchorX });

  const floorOffset = graph.effectiveFloorLevel(stairRoom) - graph.floorDatum;
  const shifted = primitives.map(p => translatePrimitive(p, 0, -floorOffset));
  const bounds = figureBounds(shifted);

  return {
    roomId: stairRoom.id, roomName: stairRoom.name, primitives: shifted, bounds,
    heightMm: bounds.height, widthMm: bounds.width, faceCount: faces.length,
    leftAnchorX,
  };
}
