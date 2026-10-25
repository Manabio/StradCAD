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
import { buildEnclosureCellToRoom, ADJACENT_SAMPLE_EPS } from '../finish/edgeClassify.js';
import { stairPortEdges } from '../finish/stair/stairGeometry.js';
import { floorHeightAbove, stairRiserOf } from '../finish/stair/stairDimensions.js';
import { U_TURN_TYPES, STRAIGHT_TYPES } from '../finish/stair/stairPorts.js';
import { stairSoffitAbove } from './space/stairSoffitCeiling.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { stairRunProfile, resolveSwitchbackParams } from './section/stairSectionProfile.js';
import { stairBandWallFilter } from './section/cuts/switchbackCuts.js';
import { stairFaceSequence, dashLinesInsideRects, removeLinesInsideRects } from './elevationStairSequence.js';
import { ElevationLineRole } from './elevationStyle.js';
import { translatePrimitive, line, polyline } from './elevationPrimitives.js';
// R1: 面配置ループ・帯確定処理はelevationBand.jsのbuildRoomBandと全域が重複していたため、
// layoutBandFaces（面配置）・finalizeBand（部屋名枠・bounds・floorOffset）へ共通化した
// （elevationBand→elevationStairの逆importは無いため循環しない）。
import { layoutBandFaces, finalizeBand } from './elevationBand.js';
// R: 矩形重なり探索部（findOverlappingVoidRoom内の実装）はelevationVoid.jsのfindOverlappingRoomへ
// 切り出し共有した（elevationVoid.js→elevationStair.jsの逆importは無いため循環しない）。
import { findOverlappingRoom } from './elevationVoid.js';
import { buildBandLayers } from './section/sectionBandLayers.js';

const CORNER_EPS = 1; // mm — stairPortEdges(世界座標)とfaceのaxisCL一致判定の許容差

/**
 * 折返し階段（SWITCHBACK）の断面プロファイル一式（往路・踊り場・復路）をローカル座標で返す（項目12。
 * フォールバック経路の帯の組み立て用。区間長・段数・蹴上は section/stairSectionProfile.js の
 * resolveSwitchbackParams、踏面のジグザグは stairRunProfile）。
 * SWITCHBACK以外・floorHeight未確定の場合は空配列（非対応タイプは項目12のスコープ外。
 * WINDING等の回り階段は扇形の段になり同じ直進プロファイルが使えないため今回は対応しない）。
 * 線種: 踏面のジグザグ(見え掛かりの段)=SILHOUETTE、踊り場の床線(区間を画す面)=CUT
 * （ユーザー仕様「切断面=太、見え掛かりの段は中を基本に」の解釈。踊り場は上階側へ抜ける
 * 床の切断とみなしCUT扱いにした）。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {object[]} プリミティブ配列（x=0起点。呼び出し側でxCursor分translateする）
 */
export function buildSwitchbackSectionPrimitives(stair, graph, floorHeight) {
  const params = resolveSwitchbackParams(stair, graph, floorHeight);
  if (!params) return [];
  const { n1, n2, riser, len1, landingLen, len2 } = params;

  const prims = [];

  const run1 = stairRunProfile(n1, riser, len1, 0, 0, 1);
  prims.push(polyline(run1.points, ElevationLineRole.SILHOUETTE));

  const landingY = run1.endY;
  const landingX2 = run1.endX + landingLen;
  prims.push(line(run1.endX, landingY, landingX2, landingY, ElevationLineRole.CUT));

  const run2 = stairRunProfile(n2, riser, len2, landingX2, landingY, 1);
  prims.push(polyline(run2.points, ElevationLineRole.SILHOUETTE));

  return prims;
}

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
    const cellToRoom = buildEnclosureCellToRoom(upperGraph);
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
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number, lowerGraph?:object|null}} [ctx]
 *   lowerGraph … 直下階のgraph（peek済み）。下階の階段の吹抜けの上の列の断面線に使う（無ければ従来どおり）。
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
  if (upperGraph && floorHeight != null) {
    chUpperAbsMm = floorHeight + resolveUpperCeilingHeight(stair, stairRoom, graph, upperGraph).mm;
  }
  // 【廃止】最上階キャップ（upperCeilCapped）: 「上階が最上階かつ上階CHが非明示(isFallback)なら
  // 往路上の天井をceilLowAbsで水平にキャップする」という分岐を持っていたが、成立条件が弱い推測
  // （設計メモにもASSUMEDと明記）で、実機（「6」D。floorHeight=3000/chLower=2400/chUpper絶対5400）
  // では階段室の上まで1F天井が貫通し、同じ面のcontent（レイキャストが描く2F天井5400）と食い違って
  // いた。ユーザー実機指摘2026-08「2FL天井断面線は、3500左CLの外へ延長して終わる」により削除。
  // 天井は常にchUpperAbsMmに揃える（他の描画も既にchUpperAbsMmを使っており、そちらと一貫する）。

  // 壁の無い辺の面（上り口・下り口）は**幾何の入力としてだけ**要る（switchbackCutsのwEntryが
  // レーン範囲の算出に使う）。描画に回す面リストからは落とす——壁が無いところに壁面の展開を
  // 描かない、という原則は階段帯のフォールバック経路でも同じ（ユーザー実機指摘2026-08
  // 「展開描画において平面照合なしで描画する経路がないか」）。
  // wallFilter（展開図一般化§5.12 D2-1是正）: 階段室自身の空気ボリュームと階段下部屋を隔てる
  // 2a壁は、断面エンジンの候補収集（isHiddenWall）と同じ判断で「この帯では実体として数えない」
  // ——面リスト構築（buildRoomFaces内の壁検出・realWallAtCornerの隅探査）にも同じ述語を通す
  // （さもないと、階段室自身が壁を持たない辺で隣接部屋の2a壁を「隅に実壁がある」と誤検出する）。
  const wallFilter = stairBandWallFilter(stair, graph);
  const composedFaces = composeRoomFaces(stairRoom, graph, { keepWallLessFaces: true, wallFilter });
  const drawableFaces = composedFaces.filter(f => f.kind === 'step' || f.hasRealWall !== false);
  // 層スタックはbuildBandLayers（Phase 7）で1度だけ組み、cut表（switchbackCuts/straightCuts）へ
  // opts.layers経由で渡す——upperGraph・floorHeightの両方が非nullのときだけabove層を積む
  // （chUpperAbsMmはこの条件のときだけ解決されるため、下のheightUnits=layers.lengthと
  // 同じ条件になる）。
  // QA指摘F3: floorHeightが非有限（NaN。null/undefinedではないため上のガードは通過する）だと、
  // buildBandLayers内部のNumber.isFinite判定でabove層の追加自体が打ち切られ1層へ退避する
  // （旧実装はfloorZMm:NaNの層をそのまま2層目に混入させていた）。実データではfloorHeightは
  // floorHeightAbove/Below（plane.elevationの差）から来るため非有限にはならず、この分岐差は
  // 到達しない（ASSUMED: 実データでの発生は未確認）。
  const layers = buildBandLayers(graph,
    upperGraph && floorHeight != null ? { above: [{ graph: upperGraph, floorHeightMm: floorHeight }] } : {});
  // 階段の裏面（E5）: 上階に続きの木造階段（U字系・直進系）があれば、階段室の天井は階段の裏面（傾斜天井）。自階の層に
  // layer.stairSoffit として載せ（spaceModel.js cellAt が層スタックの天井を決める）、同じ供給源を stairFaceSequence へも渡す
  // （体裁の ceilingProfile とエンジンの cut.ceilClip を同じ節列から作る）。自階の階段（下階側）の型は U 字系・直進系だけ
  // （L_TURN 等の帯は stairFaceSequence が歩行順面を持たない）。上階側の型の絞りは stairUndersideSurface（L_TURN 等は null）。
  // 直進系は applyStairSoffitToCut の applied.ends（CH 寸法の鎖 stairChDimChains 用）を使わない: 直進系は鎖を通らず先頭面の左に
  // 部屋の CH を 1 本描き、それは裏面の上り口の高さと一致する（Q3）。
  const stairSoffit = stair && (U_TURN_TYPES.has(stair.type) || STRAIGHT_TYPES.has(stair.type)) && upperGraph && floorHeight != null
    ? stairSoffitAbove({
        stair, graph, upperGraph, floorHeightMm: floorHeight, riserOf: s => stairRiserOf(s, project, upperGraph.plane),
        aboveGraph: ctx.upperUpperGraph ?? null, // N+2（到達辺の上階）。呼び元が渡すまでは null＝Q3
      })
    : null;
  if (stairSoffit) {
    const selfLayer = layers.find(l => l.role === 'self');
    if (selfLayer) selfLayer.stairSoffit = { roomId: stair.roomId, soffit: stairSoffit };
  }
  const sequence = (stair && composedFaces.length > 0 && chUpperAbsMm != null)
    ? stairFaceSequence(stair, composedFaces, graph, {
        floorHeight, chUpperAbsMm, chLowerMm: roomCeilingHeight(graph, stairRoom).mm,
        upperGraph, layers, stairSoffit,
        // 直下階（下階の階段の吹抜けの上では自分の断面線より下を描かない。section/lowerStairVoid.js）。無ければ従来どおり
        lowerGraph: ctx.lowerGraph ?? null,
        lowerFloorHeightMm: ctx.lowerGraph && project ? floorHeightAbove(project, ctx.lowerGraph.plane) : null,
        // content側の「壁のない端部」延長量。図形側（layoutBandFaces→buildFaceFigure）へ渡すのと
        // 同じctxの値をそのまま使い、同じ端で図形とcontentの線の長さを揃える。
        wallLessEndExtendModelMm: ctx.wallLessEndExtendModelMm,
      })
    : null;

  const primitives = [];
  const memberEdgesX = []; // 梁・柱の端で割れた共線の線を finalizeBand が戻す印（面の列の分割。帯の x）
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
        // 天井断面線の隙間（床〜天井まで 1 本の断面の隔て板の範囲。天井断面は壁の中へ出っ張らない。elevationFigure.js）
        ceilingProfileGaps: sequence[i].ceilingProfileGaps,
        // その面の断面線（下側の輪郭。ユーザー明示指示2026-09「断面線の外は描画しない」）。
        // 図形側では面端の縦線の下端に使う（床線・段差縦線はflatLineSpanX経由で自動追従）。
        floorProfile: sequence[i].floorProfile,
        // ユーザー明示指示（「2FL 寸法線はここで分ける」）: seq1（常にi===0=帯先頭面）が
        // chDimSplitAbsYsを持てば、elevationBand.jsのlayoutBandFacesがそれを見て左CH寸法を
        // 分割する（elevationBand.jsのchDimSplitAbsYsフック参照）。他entryは未設定=現行1本のまま。
        chDimSplitAbsYs: sequence[i].chDimSplitAbsYs,
        // 階段の高さ寸法（ユーザー明示指示2026-08その12）: 面の左右の端ごとの寸法の鎖。
        // stairChDimChainsが「端のプロファイルが前の端から変わったときだけ記入」まで決めており、
        // layoutBandFacesは渡されたものをそのまま描く（既定の先頭面CH寸法・継ぎ目判定は無効化）。
        chDimChains: sequence[i].chDimChains,
        // 往復間の壁の芯の一点鎖線（ユーザー実機指摘2026-08「6」C。elevationFigure.js参照）。
        extraCenterLineXs: sequence[i].extraCenterLineXs,
        // 上階の平面が自階の面の端より外へ続く量と、その上階のFL（ユーザー裁定2026-09「「6」D2」）。
        // content側の壁エッジと同じ探査窓から出た値（elevationStairSequence.jsのupperOverhangOf）。
        upperOverhang: sequence[i].upperOverhang,
        upperFloorZ: sequence[i].upperFloorZ,
        // はり出しの外端に立つ切断壁（上階の腰壁）の向こう側の面（ユーザー裁定2026-09「「6」C」）。
        // これも同じ探査の結果（columns）から出た値で、図側は壁を引き直さない。
        upperFloorCutEnds: sequence[i].upperFloorCutEnds,
        // 上階FL断面線を許す端（上階の床が実在する端だけ）。上部吹抜けを持つ部屋帯と共通の
        // gate（elevationFaces.jsのupperFloorEndsOf）——はり出し量は上階の壁しか見ないため、
        // 上階が吹抜けのまま境界に腰壁だけ立つ端では床の無い位置に2FL線が出てしまう。
        upperFloorEnds: sequence[i].upperFloorEnds,
        skipBaseboard: true, skipWallLabel: true,
      }),
    });
    // 切断面の後ろを隠す flight の矩形（entry.occludedRects。seq1 の往路）に入る図側の線（床線・面端の縦線。帯の y≤0 の太線・中線）
    // は細線破線にする（ユーザー指示 2026-10-15「X1 の壁断面線は隔て板左側の階段断面まで。そこから下は細線、破線」「1FL の太線は誤り。
    // 細線破線が正解」）。矩形は面ローカル→帯の x へ平行移動して当てる。
    const occluded = layout.faceRuns.flatMap(({ xCursor }, i) =>
      (sequence[i].occludedRects ?? []).map(r => ({ ...r, xLo: r.xLo + xCursor, xHi: r.xHi + xCursor })));
    const figurePrims = occluded.length === 0 ? layout.primitives : layout.primitives.map(p =>
      (p.type === 'line' && !p.dash && p.weight !== 'thin' && p.y1 <= 0 && p.y2 <= 0) ? dashLinesInsideRects([p], occluded, { inclusive: true }) : [p]).flat();
    for (const p of figurePrims) primitives.push(p);
    layout.faceRuns.forEach(({ xCursor }, i) => {
      for (const p of sequence[i].content) primitives.push(translatePrimitive(p, xCursor, 0));
    });
    // 壁内の梁が壁の面から出て見える断面の、その壁の面に立つ縦線（図側の面端の縦線を含む帯に集まった全ての線）を梁の z 範囲で分ける
    // （ユーザー裁定 2026-10-23・QA 4 回目。finalizeBand の dedupe の前: 中線と太線が同じ端点で 1 本に畳まれる）。矩形は面ローカル→帯の x へ平行移動。
    const wallCuts = layout.faceRuns.flatMap(({ xCursor }, i) => (sequence[i].wallLineCuts ?? []).map(r => ({
      ...r, xLo: r.xLo + xCursor, xHi: r.xHi + xCursor, xs: r.xs.map(x => x + xCursor) })));
    if (wallCuts.length > 0) {
      const cut = removeLinesInsideRects(primitives, wallCuts);
      primitives.length = 0;
      for (const p of cut) primitives.push(p);
    }
    memberEdgesX.push(...layout.faceRuns.flatMap(({ xCursor }, i) => (sequence[i].memberEdgesX ?? []).map(x => x + xCursor)));
    chDimX = layout.chDimX; prevBoundaryHi = layout.prevBoundaryHi;
    faceCount = sequence.length;
  } else {
    // フォールバック経路: 従来どおりcomposeRoomFaces+rotateFacesToStartの面順。
    let faces = drawableFaces;
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
        for (const { face, xCursor: x0 } of layout.faceRuns) {
          const upperFace = upperFaces.find(f =>
            f.isVertical === face.isVertical && Math.abs(f.axisCL.effectiveValue - face.axisCL.effectiveValue) < CORNER_EPS);
          if (!upperFace) continue;
          primitives.push(translatePrimitive(
            line(0, -floorHeight, face.run, -floorHeight, ElevationLineRole.CUT),
            x0, 0,
          ));
          primitives.push(translatePrimitive(
            line(0, -layout.CH, 0, -chUpperAbsMm, ElevationLineRole.CUT), x0, 0,
          ));
          primitives.push(translatePrimitive(
            line(face.run, -layout.CH, face.run, -chUpperAbsMm, ElevationLineRole.CUT), x0, 0,
          ));
        }
      }
    }

    // 折返し階段（SWITCHBACK）の断面プロファイルを起点面(xCursor=0)に重ねて描く（項目12。
    // SWITCHBACKでは新経路=stairFaceSequenceが断面を担うため、フォールバック経路のみで呼ぶ）。
    for (const p of buildSwitchbackSectionPrimitives(stair, graph, floorHeight)) primitives.push(p);
  }

  // heightUnits（Phase 7b-1）: layers.lengthへ統一——上のlayersと同じ条件（upperGraph・
  // floorHeightの両方が非null）でabove層が積まれ、それがそのまま「2層帯か1層帯か」になる。
  const heightUnits = layers.length;

  // R1: 部屋名枠＋左右引出線＋留め三角・bounds・floorOffset平行移動はelevationBand.jsの
  // finalizeBandへ共通化（buildRoomBandと共有。以前は階段帯だけappendRoomNameFrameが欠落していた）。
  return finalizeBand(stairRoom, graph, primitives, {
    faceCount, chDimX, prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
    heightUnits, memberEdgesX,
  });
}
