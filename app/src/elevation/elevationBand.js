/**
 * 展開図: 部屋1件 → 帯（面を横に並べ、天井高寸法・部屋名枠を付けた1段ぶんのプリミティブ）。
 * 設計意図は .claude/elevation-model.md 参照。
 */
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { buildRoomFaces } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { FACE_GAP_MM, CH_DIM_OFFSET_MM } from './elevationStyle.js';
import { translatePrimitive, collectGridCLs, appendRoomNameFrame } from './elevationPrimitives.js';

/**
 * 部屋1件 → 帯（面を横に並べ、部屋名枠・天井高寸法を付ける）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {{project?:object, materialMap?:Map, gridCLs?:object[]}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number}}
 */
export function buildRoomBand(room, graph, ctx = {}) {
  const project     = ctx.project ?? null;
  const materialMap  = ctx.materialMap ?? null;
  const gridCLs      = ctx.gridCLs ?? collectGridCLs(graph);
  const chInfo       = roomCeilingHeight(graph, room);
  const CH           = chInfo.mm;

  const faces = buildRoomFaces(room, graph);
  const primitives = [];
  let xCursor = 0;
  faces.forEach((face, i) => {
    const faceCtx = { graph, project, room, ceilingHeight: CH, materialMap, gridCLs };
    for (const p of buildFaceFigure(face, faceCtx)) primitives.push(translatePrimitive(p, xCursor, 0));
    if (i === 0) {
      primitives.push({
        type: 'dim', dir: 'v', at: -CH_DIM_OFFSET_MM, from: -CH, to: 0, foot: 0, dot: true, label: chInfo.raw,
      });
    }
    xCursor += face.run + FACE_GAP_MM;
  });

  appendRoomNameFrame(primitives, room.name);

  // 部屋の実効FL(当該階FLからの相対レベル)ぶん全体を平行移動する
  const floorOffset = graph.effectiveFloorLevel(room) - graph.floorDatum;
  const shifted = primitives.map(p => translatePrimitive(p, 0, -floorOffset));
  const bounds = figureBounds(shifted);

  return {
    roomId: room.id, roomName: room.name, primitives: shifted, bounds,
    heightMm: bounds.height, widthMm: bounds.width, faceCount: faces.length,
  };
}
