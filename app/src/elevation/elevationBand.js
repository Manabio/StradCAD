/**
 * 展開図: 部屋1件 → 帯（面を横に並べ、天井高寸法・部屋名枠を付けた1段ぶんのプリミティブ）。
 * 設計意図は .claude/elevation-model.md 参照。
 */
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { buildRoomFaces, faceBoundaryLocalX } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import {
  DEFAULT_FACE_GAP_MM, CH_DIM_OFFSET_MM, DEFAULT_TRIANGLE_OFFSET_MM, BAND_TOP_MARGIN_MM,
} from './elevationStyle.js';
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
 *   nameGapModelMm?:number, triangleOffsetModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   topMarginMm:number}} heightMm/topMarginMmはどちらもbounds.heightそのものではない
 *   （QA A2。elevationLayout.jsのlayoutBandsが読む積み上げ専用の値。詳細は本体コメント参照）。
 */
export function buildRoomBand(room, graph, ctx = {}) {
  const project     = ctx.project ?? null;
  const materialMap  = ctx.materialMap ?? null;
  const gridCLs      = ctx.gridCLs ?? collectGridCLs(graph);
  const gapModelMm   = ctx.gapModelMm ?? DEFAULT_FACE_GAP_MM;
  const nameGapModelMm = ctx.nameGapModelMm; // 未指定はappendRoomNameFrame既定(DEFAULT_NAME_GAP_MM)へ委ねる
  const triOffsetMm = ctx.triangleOffsetModelMm ?? DEFAULT_TRIANGLE_OFFSET_MM;
  const faceLabelAvoidThresholdModelMm = ctx.faceLabelAvoidThresholdModelMm; // 未指定はbuildFaceFigure既定(QA B3)
  const openingTagRowModelMm = ctx.openingTagRowModelMm; // 未指定はbuildFaceFigure既定(QA C1)
  const dimRowGapModelMm     = ctx.dimRowGapModelMm;      // 未指定はbuildFaceFigure既定(QA C1/D2)
  const gridRowGapModelMm    = ctx.gridRowGapModelMm;     // 未指定はbuildFaceFigure既定(QA D1)
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

    // 項目3: 直交壁（隣・次の面）の建具が切断位置にかかる場合の断面描画用。faces.length<2は
    // 自分自身が隣接面になってしまう退化ケースのため対象外にする（通常の閉じたループでは
    // 発生しないが、念のためのガード）。
    const prevFace = faces.length >= 2 ? faces[(i - 1 + faces.length) % faces.length] : null;
    const nextFace = faces.length >= 2 ? faces[(i + 1) % faces.length] : null;
    const faceCtx = {
      graph, project, room, ceilingHeight: CH, materialMap, gridCLs, faceLabelAvoidThresholdModelMm,
      prevFace, nextFace, openingTagRowModelMm, dimRowGapModelMm, gridRowGapModelMm,
    };
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

  // 部屋の実効FL(当該階FLからの相対レベル)ぶん全体を平行移動する。
  // 調整項目6: boundsはfloorOffset適用前（基準。floorOffset=0のときの描画範囲）の座標系で
  // 計算する——適用後の座標から計算すると、帯スロットの上端を帯自身のbounds.minYへ再アンカー
  // する仕組み（elevationLayout.jsのbandContentOriginMm）が一様シフトを常に打ち消してしまい、
  // floorOffsetが床線の見た目位置に一切効かなくなる（この不具合の発見に伴う修正。
  // bounds.minX/maxX/widthはfloorOffsetがy方向のみのシフトのため適用前後で不変）。
  // 段差高さそのものの寸法線は描かない（指示どおり）。
  const rawBounds = figureBounds(primitives);
  const floorOffset = graph.effectiveFloorLevel(room) - graph.floorDatum;
  const shifted = primitives.map(p => translatePrimitive(p, 0, -floorOffset));
  // 調整項目4: 帯の描画範囲の上端（天井線・通り芯突き出しの上）にBAND_TOP_MARGIN_MMぶんの
  // 余白を確保する（minYをさらに上へ広げるだけ。他の辺は変えない）。boundsはbandContentOriginMm
  // の原点計算に使われるため、ここにfloorOffset由来の項を混ぜてはいけない（QA A2: 混ぜると
  // 上のfloorOffset不具合修正と同じ理屈で打ち消し合い、item6の効果が消えてしまう）。
  const bounds = {
    ...rawBounds, minY: rawBounds.minY - BAND_TOP_MARGIN_MM, height: rawBounds.height + BAND_TOP_MARGIN_MM,
  };
  // QA A2: floorOffsetの差だけ隣接帯の実描画間隔が縮み、重なりうる（帯自身がfloorOffsetぶん
  // 上下どちらかへずれるため。boundsはfloorOffset非依存のまま=item6のために動かせない）。
  // 「片側だけ」（例えばheightMmだけ）にMath.abs(floorOffset)を足しても、この帯自身が上へ
  // せり出す方向（floorOffsetが正）は防げない——上端がせり出すのを防ぐには「この帯を置く前に
  // 追加で空ける量」が要り、それはこの帯のheightMmではなく手前の間隔（elevationLayout.jsの
  // layoutBandsが読むtopMarginMm）でしか表現できない（bounds.minYをfloorOffset依存にすると
  // item6の打ち消し問題が再発するため、そちらでは対応できない）。そのため両方を対で確保する:
  //   heightMm    … この帯自身が下（floorOffsetが負）へせり出しても次の帯へ食い込まない
  //   topMarginMm … この帯自身が上（floorOffsetが正）へせり出しても手前の帯に食い込まれない
  // QA B2: 上記2方向は互いに排他（floorOffsetの符号でどちらか一方にしか実際にはせり出さない）
  // ため、両方に一律Math.abs(floorOffset)を足すと使わない側が過剰予約になる（例: floorOffset=-700
  // なら上方向は一切せり出さないのにtopMarginMmも700確保してしまい、実すき間がBAND_GAP_MMより
  // 700広がる＝逆に間延びする）。符号で向きごとに正しい側だけへ加算する。
  const downwardSlackMm = Math.max(0, -floorOffset); // 帯自身が下へせり出す量（floorOffset<0）
  const upwardSlackMm   = Math.max(0, floorOffset);  // 帯自身が上へせり出す量（floorOffset>0）

  return {
    roomId: room.id, roomName: room.name, primitives: shifted, bounds,
    heightMm: bounds.height + downwardSlackMm, widthMm: bounds.width, faceCount: faces.length,
    leftAnchorX, topMarginMm: upwardSlackMm,
  };
}
