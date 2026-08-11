/**
 * 展開図: 部屋1件 → 帯（面を横に並べ、天井高寸法・部屋名枠を付けた1段ぶんのプリミティブ）。
 * 設計意図は .claude/elevation-model.md 参照。
 */
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { DEFAULT_FACE_GAP_MM, CH_DIM_OFFSET_MM, DEFAULT_TRIANGLE_OFFSET_MM } from './elevationStyle.js';
import { translatePrimitive, collectGridCLs, appendRoomNameFrame } from './elevationPrimitives.js';

/**
 * 部屋1件 → 帯（面を横に並べ、部屋名枠・天井高寸法を付ける）。
 * 隣接面は互いの壁中心線（faceBoundaryLocalX）が ctx.gapModelMm だけ離れるよう配置する
 * （ユーザー仕様「隣接展開図の壁中心線同士が実画面で約30mmになるよう配置」。
 * ElevationModeState.init が screenMmToModelMm で換算した値を渡す。未指定時は
 * DEFAULT_FACE_GAP_MM＝倍率決定用の1パス目の仮値）。
 *
 * 部屋名枠の左右留め三角は、preBounds由来の座標ではなく明示的なアンカー
 * （leftAnchorX=天井高寸法線の外側、rightAnchorX=一番右の壁中心線の外側。それぞれ
 * ctx.triangleOffsetModelMmぶん）に置く（項目9）。leftAnchorXは帯の水平初期位置の既定値
 * としても返す（band.leftAnchorX。項目10: 全帯を左三角の位置で揃える。
 * ElevationModeState.faceOffsetFor参照）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {{project?:object, materialMap?:Map, gridCLs?:object[], gapModelMm?:number,
 *   nameGapModelMm?:number, triangleOffsetModelMm?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null}}
 */
export function buildRoomBand(room, graph, ctx = {}) {
  const project     = ctx.project ?? null;
  const materialMap  = ctx.materialMap ?? null;
  const gridCLs      = ctx.gridCLs ?? collectGridCLs(graph);
  const gapModelMm   = ctx.gapModelMm ?? DEFAULT_FACE_GAP_MM;
  const nameGapModelMm = ctx.nameGapModelMm; // 未指定はappendRoomNameFrame既定(DEFAULT_NAME_GAP_MM)へ委ねる
  const triOffsetMm = ctx.triangleOffsetModelMm ?? DEFAULT_TRIANGLE_OFFSET_MM;
  const chInfo       = roomCeilingHeight(graph, room);
  const CH           = chInfo.mm;

  const faces = buildRoomFaces(room, graph);
  const primitives = [];
  let xCursor = 0;
  let prevBoundaryHi = null; // 直前面の壁中心線(hi側)の帯内絶対x
  let chDimX = null; // 天井高寸法線のx（先頭面のみ設定。項目9の左アンカー起点）
  faces.forEach((face, i) => {
    const boundary = faceBoundaryLocalX(face, graph);
    xCursor = i === 0 ? 0 : prevBoundaryHi + gapModelMm - boundary.lo;

    const faceCtx = { graph, project, room, ceilingHeight: CH, materialMap, gridCLs };
    for (const p of buildFaceFigure(face, faceCtx)) primitives.push(translatePrimitive(p, xCursor, 0));
    if (i === 0) {
      chDimX = boundary.lo - CH_DIM_OFFSET_MM;
      primitives.push({
        type: 'dim', dir: 'v', at: chDimX, from: -CH, to: 0, foot: 0, dot: true, label: chInfo.raw,
      });
    }
    prevBoundaryHi = xCursor + boundary.hi;
  });

  const leftAnchorX  = chDimX != null ? chDimX - triOffsetMm : null;
  const rightAnchorX = prevBoundaryHi != null ? prevBoundaryHi + triOffsetMm : null;
  appendRoomNameFrame(primitives, room.name, { nameGapModelMm, leftX: leftAnchorX, rightX: rightAnchorX });

  // 部屋の実効FL(当該階FLからの相対レベル)ぶん全体を平行移動する
  const floorOffset = graph.effectiveFloorLevel(room) - graph.floorDatum;
  const shifted = primitives.map(p => translatePrimitive(p, 0, -floorOffset));
  const bounds = figureBounds(shifted);

  return {
    roomId: room.id, roomName: room.name, primitives: shifted, bounds,
    heightMm: bounds.height, widthMm: bounds.width, faceCount: faces.length,
    leftAnchorX,
  };
}
