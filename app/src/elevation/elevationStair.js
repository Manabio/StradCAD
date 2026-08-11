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
import { buildRoomFaces } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { FACE_GAP_MM, CH_DIM_OFFSET_MM, ElevationLineRole, weightForRole } from './elevationStyle.js';
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
 * @param {import('@core').Room} stairRoom
 * @param {object} graph - 設置階のgraph
 * @param {object|null} upperGraph - 直上階のgraph（floorSwapManager.peek済み。呼び出し側が解決する）
 * @param {{stair?:object, project?:object, materialMap?:Map, gridCLs?:object[], floorHeight?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number}}
 */
export function buildStairBand(stairRoom, graph, upperGraph, ctx = {}) {
  const stair       = ctx.stair ?? [...graph.stairs].find(s => s.roomId === stairRoom.id) ?? null;
  const project     = ctx.project ?? null;
  const materialMap = ctx.materialMap ?? null;
  const gridCLs     = ctx.gridCLs ?? collectGridCLs(graph);

  let faces = buildRoomFaces(stairRoom, graph);
  if (stair && faces.length > 0) {
    const startLabel = stairStartFaceLabel(stair, faces, graph);
    if (startLabel) faces = rotateFacesToStart(faces, startLabel);
  }

  const chInfo = roomCeilingHeight(graph, stairRoom);
  const CH = chInfo.mm;
  const floorHeight = ctx.floorHeight ?? floorHeightAbove(project, graph.plane);

  const primitives = [];
  const faceRuns = [];
  let xCursor = 0;
  faces.forEach((face, i) => {
    const faceCtx = { graph, project, room: stairRoom, ceilingHeight: CH, materialMap, gridCLs };
    for (const p of buildFaceFigure(face, faceCtx)) primitives.push(translatePrimitive(p, xCursor, 0));
    if (i === 0) {
      primitives.push({
        type: 'dim', dir: 'v', at: -CH_DIM_OFFSET_MM, from: -CH, to: 0, foot: 0, dot: true, label: chInfo.raw,
      });
    }
    faceRuns.push({ face, xCursor });
    xCursor += face.run + FACE_GAP_MM;
  });

  // 上階（吹抜け部でクリップ）: 上階FL線（CUT）を同じ列位置に重ねて引くだけの簡易表現。
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
      }
    }
  }

  // 部屋名枠＋左右引出線＋留め三角（buildRoomBandと共有。以前は階段帯だけ欠落していた）。
  appendRoomNameFrame(primitives, stairRoom.name);

  const floorOffset = graph.effectiveFloorLevel(stairRoom) - graph.floorDatum;
  const shifted = primitives.map(p => translatePrimitive(p, 0, -floorOffset));
  const bounds = figureBounds(shifted);

  return {
    roomId: stairRoom.id, roomName: stairRoom.name, primitives: shifted, bounds,
    heightMm: bounds.height, widthMm: bounds.width, faceCount: faces.length,
  };
}
