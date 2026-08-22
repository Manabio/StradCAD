/**
 * 展開図: 階段部屋の2層帯（設置階＋直上階）・歩行順面シーケンス（WP-S3）。
 * 設計意図は .claude/elevation-model.md・.claude/stair-model.md 参照。
 *
 * SWITCHBACK（折返し階段）は elevationStairSequence.js の stairFaceSequence が組み立てる
 * 「階段を上っていく順番」の面シーケンスを使う。それ以外（データ不足含む。stairFaceSequenceが
 * nullを返す場合）は従来どおり composeRoomFaces+rotateFacesToStart の面順＋簡易2層枠
 * （上階FL線を重ねて引くだけ）にフォールバックする。
 */
import { RoomFeature } from '@core';
import { roomBounds, worldToCell } from '../finish/gridCells.js';
import { buildCellToRoom, ADJACENT_SAMPLE_EPS } from '../finish/edgeClassify.js';
import { stairPortEdges } from '../finish/stair/stairGeometry.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { buildSwitchbackSectionPrimitives } from './elevationStairSection.js';
import { stairFaceSequence } from './elevationStairSequence.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';
import { translatePrimitive } from './elevationPrimitives.js';
// R1: 面配置ループ・帯確定処理はelevationBand.jsのbuildRoomBandと全域が重複していたため、
// layoutBandFaces（面配置）・finalizeBand（部屋名枠・bounds・floorOffset）へ共通化した
// （elevationBand→elevationStairの逆importは無いため循環しない）。
import { layoutBandFaces, finalizeBand } from './elevationBand.js';
// R: 矩形重なり探索部（findOverlappingVoidRoom内の実装）はelevationVoid.jsのfindOverlappingRoomへ
// 切り出し共有した（elevationVoid.js→elevationStair.jsの逆importは無いため循環しない）。
import { findOverlappingRoom } from './elevationVoid.js';

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

/** stairRoomの footprint と重なる、upperGraph上のSTAIR_VOID/VOID Roomを1つ返す（無ければnull）。 */
function findOverlappingVoidRoom(stairRoom, graph, upperGraph) {
  const stairBounds = roomBounds(stairRoom.cells, graph);
  return findOverlappingRoom(stairBounds, upperGraph,
    r => r.feature === RoomFeature.VOID || r.feature === RoomFeature.STAIR_VOID);
}

/**
 * 設置階上階の天井高さ（roomCeilingHeightの{mm,raw,isFallback}形式）を優先順で解決する（WP-S3）。
 *   (a) stairPortEdges(stair, graph, ['arrival'])の辺中点付近をupperGraphでworldToCell→
 *       所有Room（buildCellToRoom）のroomCeilingHeight。
 *   (b) stairRoomのfootprintと重なる、upperGraph上のVOID/STAIR_VOID Roomのroom CeilingHeight。
 *   (c) upperGraph.defaultCeilingHeight（isFallback:trueとして扱う）。
 * @param {import('@core').Stair|null} stair
 * @param {import('@core').Room} stairRoom
 * @param {object} graph - 設置階のgraph
 * @param {object} upperGraph - 直上階のgraph
 * @returns {{mm:number, raw:string, isFallback:boolean}}
 */
function resolveUpperCeilingHeight(stair, stairRoom, graph, upperGraph) {
  if (stair) {
    const cellToRoom = buildCellToRoom(upperGraph);
    for (const edge of stairPortEdges(stair, graph, ['arrival'])) {
      const mid = (edge.lo + edge.hi) / 2;
      for (const sign of [1, -1]) {
        const probe = sign * ADJACENT_SAMPLE_EPS;
        const px = edge.isVertical ? edge.value + probe : mid;
        const py = edge.isVertical ? mid : edge.value + probe;
        const cell = worldToCell(px, py, upperGraph);
        const room = cell ? cellToRoom.get(cell.key) : null;
        if (room) return roomCeilingHeight(upperGraph, room);
      }
    }
  }
  const overlapRoom = findOverlappingVoidRoom(stairRoom, graph, upperGraph);
  if (overlapRoom) return roomCeilingHeight(upperGraph, overlapRoom);
  const fallback = upperGraph.defaultCeilingHeight;
  return { mm: fallback, raw: String(fallback), isFallback: true };
}

/**
 * 階段部屋の2層帯（設置階＋直上階）を組み立てる。
 * upperGraph=null（直上階が無い・peek未解決）のときは1層のみ返す。
 *
 * SWITCHBACK＋stair.cellsあり＋floorHeight/CH_upperが解決できた場合は
 * elevationStairSequence.jsのstairFaceSequenceが返す「階段を上っていく順番」の面シーケンスを
 * 使う（WP-S3）。それ以外はフォールバック（従来どおりcomposeRoomFaces+rotateFacesToStartの
 * 面順＋簡易2層枠）——上端は「設置階上階の天井高さ」（CH_upper。上階のそのまた階高ではない。
 * 旧「2層目のFL線」概念は廃止）まで。
 * @param {import('@core').Room} stairRoom
 * @param {object} graph - 設置階のgraph
 * @param {object|null} upperGraph - 直上階のgraph（floorSwapManager.peek済み。呼び出し側が解決する）
 * @param {{stair?:object, project?:object, materialMap?:Map, gridCLs?:object[], floorHeight?:number,
 *   gapModelMm?:number, nameGapModelMm?:number, triangleOffsetModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   heightUnits:number}}
 */
export function buildStairBand(stairRoom, graph, upperGraph, ctx = {}) {
  const stair   = ctx.stair ?? [...graph.stairs].find(s => s.roomId === stairRoom.id) ?? null;
  const project = ctx.project ?? null; // floorHeightAbove算出用（layoutBandFaces内とは別に、ここでも要る）
  const floorHeight = ctx.floorHeight ?? floorHeightAbove(project, graph.plane);

  // CH_upper解決: upperGraph・floorHeightの両方が確定していなければ2層表現自体を行わない
  // （従来の「upperGraph=null/floorHeight未確定は1層のみ」と同じガード）。
  let chUpperAbsMm = null;
  let upperCeilCapped = false;
  if (upperGraph && floorHeight != null) {
    const chUpperInfo = resolveUpperCeilingHeight(stair, stairRoom, graph, upperGraph);
    chUpperAbsMm = floorHeight + chUpperInfo.mm;
    // 最上階キャップ: 設置階上階が最上階（さらに上の階が無い）かつ、上階側Roomの天井高さが
    // 明示指定でない（isFallback===true。既定値へのフォールバック＝実質未指定）場合。
    // QA注記6: floorHeightAbove(project, ...)はproject===nullでもnull（最上階と同一視）を返す
    // ため、project未指定の呼び出し（単体テスト等）は常に「最上階扱い」になる。本番の呼び出し
    // （App.jsx/ElevationModeState.js経由）は必ずproject（現在のPlanGraphの所属project）を渡す
    // 前提のため、この同一視は実害が無い——ここでの分岐追加は不要（呼び出し側の契約で担保する）。
    upperCeilCapped = floorHeightAbove(project, upperGraph.plane) === null && chUpperInfo.isFallback === true;
  }

  const composedFaces = composeRoomFaces(stairRoom, graph);
  const sequence = (stair && composedFaces.length > 0 && chUpperAbsMm != null)
    ? stairFaceSequence(stair, composedFaces, graph, {
        floorHeight, chUpperAbsMm, chLowerMm: roomCeilingHeight(graph, stairRoom).mm, upperCeilCapped,
        upperGraph,
      })
    : null;

  const primitives = [];
  let chDimX, prevBoundaryHi, faceCount;

  if (sequence) {
    // WP-S3: 歩行順面シーケンス経路。各entryのfaceをlayoutBandFacesへ渡し、ctx.faceOverrideで
    // floorSegments/ceilingProfile/skipBaseboard/skipWallLabelを面indexごとに差し込む。
    // ladders/section/ささら等の追加プリミティブ（entry.content）は各面のxCursorへtranslateして積む。
    const seqFaces = sequence.map(e => e.face);
    const layout = layoutBandFaces(stairRoom, graph, seqFaces, {
      ...ctx,
      faceOverride: (face, i) => ({
        floorSegments: sequence[i].floorSegments,
        ceilingProfile: sequence[i].ceilingProfile,
        // ユーザー明示指示（「2FL 寸法線はここで分ける」）: seq1（常にi===0=帯先頭面）が
        // chDimSplitAbsYsを持てば、elevationBand.jsのlayoutBandFacesがそれを見て左CH寸法を
        // 分割する（elevationBand.jsのchDimSplitAbsYsフック参照）。他entryは未設定=現行1本のまま。
        chDimSplitAbsYs: sequence[i].chDimSplitAbsYs,
        skipBaseboard: true, skipWallLabel: true,
      }),
    });
    for (const p of layout.primitives) primitives.push(p);
    layout.faceRuns.forEach(({ xCursor }, i) => {
      for (const p of sequence[i].content) primitives.push(translatePrimitive(p, xCursor, 0));
    });
    chDimX = layout.chDimX; prevBoundaryHi = layout.prevBoundaryHi;
    faceCount = sequence.length;
  } else {
    // フォールバック経路: 従来どおりcomposeRoomFaces+rotateFacesToStartの面順。
    let faces = composedFaces;
    if (stair && faces.length > 0) {
      const startLabel = stairStartFaceLabel(stair, faces, graph);
      if (startLabel) faces = rotateFacesToStart(faces, startLabel);
    }
    const layout = layoutBandFaces(stairRoom, graph, faces, ctx);
    for (const p of layout.primitives) primitives.push(p);
    chDimX = layout.chDimX; prevBoundaryHi = layout.prevBoundaryHi;
    faceCount = faces.length;

    // 上階（吹抜け部でクリップ）: 上階FL線（CUT）を重ねて引き、両端縦線をCHから
    // chUpperAbsMm（設置階上階の天井高さの絶対高さ）まで延長する簡易表現。
    // 旧「上階のそのまた階高までの2層目FL線」は廃止——上端は常に上階天井まで。
    if (upperGraph && floorHeight != null && chUpperAbsMm != null) {
      const upperRoom = findOverlappingVoidRoom(stairRoom, graph, upperGraph);
      if (upperRoom) {
        const upperFaces = composeRoomFaces(upperRoom, upperGraph);
        const cutWeight = weightForRole(ElevationLineRole.CUT);
        for (const { face, xCursor: x0 } of layout.faceRuns) {
          const upperFace = upperFaces.find(f =>
            f.isVertical === face.isVertical && Math.abs(f.axisCL.effectiveValue - face.axisCL.effectiveValue) < CORNER_EPS);
          if (!upperFace) continue;
          primitives.push(translatePrimitive(
            { type: 'line', x1: 0, y1: -floorHeight, x2: face.run, y2: -floorHeight, weight: cutWeight },
            x0, 0,
          ));
          primitives.push(translatePrimitive(
            { type: 'line', x1: 0, y1: -layout.CH, x2: 0, y2: -chUpperAbsMm, weight: cutWeight }, x0, 0,
          ));
          primitives.push(translatePrimitive(
            { type: 'line', x1: face.run, y1: -layout.CH, x2: face.run, y2: -chUpperAbsMm, weight: cutWeight }, x0, 0,
          ));
        }
      }
    }

    // 折返し階段（SWITCHBACK）の断面プロファイルを起点面(xCursor=0)に重ねて描く（項目12。
    // SWITCHBACKでは新経路=stairFaceSequenceが断面を担うため、フォールバック経路のみで呼ぶ）。
    for (const p of buildSwitchbackSectionPrimitives(stair, graph, floorHeight)) primitives.push(p);
  }

  const heightUnits = (upperGraph && floorHeight != null && chUpperAbsMm != null) ? 2 : 1;

  // R1: 部屋名枠＋左右引出線＋留め三角・bounds・floorOffset平行移動はelevationBand.jsの
  // finalizeBandへ共通化（buildRoomBandと共有。以前は階段帯だけappendRoomNameFrameが欠落していた）。
  return finalizeBand(stairRoom, graph, primitives, {
    faceCount, chDimX, prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
    heightUnits,
  });
}
