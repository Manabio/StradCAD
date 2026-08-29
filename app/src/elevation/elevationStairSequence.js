/**
 * 展開図: 階段の歩行順面シーケンス（WP-S2→WP-E5→WP-E5b→WP-E6でエンジン化・タイプ拡張）。
 * 設計意図は .claude/elevation-model.md・.claude/stair-model.md 参照。純モジュール
 * （store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 *
 * WP-E5/E5b: SWITCHBACK専用の切断定義表・エンジン化については `section/cuts/switchbackCuts.js`
 * のヘッダコメント参照（面の分類・往復間の壁の検出・断面パラメータ解決の委譲先）。
 * WP-E6: タイプ別ディスパッチを追加した——SWITCHBACK→`switchbackCuts`（従来どおり手組みの
 * entries組み立て＋contentForCut）、STRAIGHT/STRAIGHT_LANDING→`straightCuts`（§6.2。
 * face/floorSegments/ceilingProfileの算出もエンジン汎用の`buildSectionFigure`にそのまま
 * 委ねる——直進階段は往路・復路の二重管理が無い単純な1本道のため）、
 * WINDING/L_TURN/FLARED/OPEN_WELL（扇形レーン。`fanCuts.js`）→常にnull。
 * いずれもnullを返す場合は呼び出し側（elevationStair.jsのbuildStairBand）が従来の
 * composeRoomFaces+rotateFacesToStart のフォールバック経路を使う（フォールバック契約自体は
 * WP-E6でも不変。対象タイプが増えただけ）。
 *
 * 返り値の型は一切変えない（{seqNo,face,floorSegments,ceilingProfile?,chDimSplitAbsYs?,
 * content,skipBaseboard,skipWallLabel,floorSpanX?}[]）。
 *
 * SWITCHBACKのシーケンス（歩行順。各cutの切断線・視線方向・第3層データはswitchbackCuts.js
 * §6.1参照）:
 *   1   踊り場前縁（見返り・全幅）: 往路・復路の踏面梯子線を重ねる（踊り場より下の往路は破線）。
 *   2   W_out1（実際の壁面。上り口端〜踊り場前縁まで）: 往路の断面プロファイル＋踊り場区間の
 *       床・天井断面線＋往復間の壁（実在すれば）の断面。
 *   2.5 レーン境界（往路・復路の間の壁が実在する場合のみ）: 往路側からの断面。
 *   3   W_landing（全幅）: 踊り場の壁。階段の重ね描きなし。
 *   4   W_out2（seq2の鏡像構成）: 復路の断面プロファイル＋往復間の壁の断面。
 *   4.5 レーン境界 復路側（同上）。
 *   5   W_out2の残り区間: 復路の断面を反対側（踊り場が右端）から見た図。
 *
 * STRAIGHT/STRAIGHT_LANDINGのシーケンス（§6.2。straightCuts.js参照）:
 *   1 上り口端（全幅） / 2 W_out1（s=0側の断面プロファイル） /
 *   3 到達端（全幅。STRAIGHT_LANDINGは踊り場壁が実在する場合のみ挿入。無ければ3は到達端のまま）/
 *   （STRAIGHT_LANDINGのみ）4 W_out2（s=1側） / 5 到達端（全幅）。
 */
import { StairType, RoomFeature } from '@core';
import { switchbackCuts } from './section/cuts/switchbackCuts.js';
import { straightCuts } from './section/cuts/straightCuts.js';
import { UNSUPPORTED_FAN_LANE_TYPES, fanLaneCuts } from './section/cuts/fanCuts.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildColumns, buildSectionFigure } from './section/sectionEngine.js';
import { cutDrawRange } from './section/sectionTypes.js';
import {
  emitColumns, emitOpenGapMarks, emitLine, splitGapMarksByStair, dashHorizontalsBehindStair,
  joinToStairProfile, clipStairDetailInSlabBand,
} from './section/sectionEmit.js';
import {
  stairPrimitivesForCut, stairWallGapZones, stairOccluderRects,
} from './section/sectionStair.js';
import { structuralContribution, structuralPrimitivesForCut } from './section/sectionStructure.js';
import { worldToCell, roomBounds } from '../finish/gridCells.js';
import { labelFaces, letterOf } from './elevationFaces.js';
import { collectRunBreaks } from './elevationFloorProfile.js';
import {
  ElevationLineRole, GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM, DEFAULT_WALL_LESS_END_EXTEND_MM,
} from './elevationStyle.js';
import { graphList } from '../graphReadScope.js';

function flatFloorSegments(run, floorDeltaMm, chMm) {
  return [{ loX: 0, hiX: run, floorDeltaMm, chMm }];
}

// 往路（entry→landing）の勾配天井プロファイル。上り口側は1F天井（ceilLowAbs）、踊り場側は
// 上階天井（ceilTopAbs）。かつてupperCeilCapped時は全区間ceilLowAbsで水平にする短絡が
// あったが、ユーザー実機指摘2026-08（「2FL天井断面線は、3500左CLの外へ延長して終わる」）で
// 廃止した（buildLaneFloorAndCeilingのコメント参照）。
function outboundCeilingProfile(run, ceilLowAbs, ceilTopAbs) {
  return [[0, ceilLowAbs], [run, ceilTopAbs]];
}

// ==== ユーザー実機フィードバック2026-08-23第3弾 項目A ====
// 階段室の上が吹抜け（上階に床が無い）区間では1F天井線・2F床線を描いてはならない
// （天井断面は上階天井まで一気に抜ける）——旧実装はseq2/4のfloorSegments/ceilingProfileを
// 「レーン区間=chMm:ceilLowAbs固定（1F天井）／踊り場区間=ceilTopAbs固定（上階天井）」という
// laneLenOnFace基準の**幾何的な決め打ち**で構築しており、上階に実際にRoom（床）があるか
// 一切確認していなかった——これが原因箇所（本ファイルの旧stairFaceSequence内、
// seq2/4のfloorSegments/ceilingProfile直書き。elevationStair.js側のCH解決やsectionProbe.jsの
// slab/open判定そのものは無関係——sectionProbe.js側は`content`生成にしか使われず、
// floorSegments/ceilingProfile側は完全に別経路の決め打ちだった）。
//
// 修正: face（wOut1/wOut2）に沿って、実際にopts.upperGraph（above層）にRoomがあるかを
// probeCtx.cellToRoomFor（sectionProbe.jsのmakeProbeContextが既に持つメモ化索引。他の壁検出と
// 同じ単一情報源）で1点プローブし、区間ごとに「上階に床がある(hasRoom)＝1F天井高さ(ceilLowAbs)」
// 「無い(吹抜け)＝上階天井(ceilTopAbs)まで抜ける」を判定してfloorSegments/ceilingProfileへ
// 反映する。aboveLayer（role!=='self'の層）が無い場合（opts.upperGraphが未指定。最上階等）は
// 実データが無く判定できないため、既存のlaneLenOnFace基準フォールバックを維持する
// （挙動不変。既存の「upperGraph未指定」テストへの影響を避けるASSUMED判断）。
//
// face（wOut1等。composeRoomFacesの実面）のローカルx→world座標（elevationFigure.jsの
// localXOfの逆写像。face.dirSign/originWorldは同じ規約）。
function worldOfFace(face, localX) {
  return face.originWorld + localX * face.dirSign;
}

// face（走行軸に沿った実壁面）に沿って、aboveLayer.graphに実Room（床）があるかどうかの区間を
// ローカルx（0..face.run。隙間なく・昇順）で返す。aboveLayer未指定はnull（判定不能。呼び出し側は
// 既存のフォールバックへ委ねる）。
function aboveRoomSegmentsOnFace(face, aboveLayer, probeCtx) {
  if (!aboveLayer) return null;
  const cellToRoom = probeCtx.cellToRoomFor(aboveLayer);
  const w0 = worldOfFace(face, 0), w1 = worldOfFace(face, face.run);
  const lo = Math.min(w0, w1), hi = Math.max(w0, w1);
  const breaks = collectRunBreaks(aboveLayer.graph, face.isVertical, lo, hi);
  const segs = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const bLo = breaks[i], bHi = breaks[i + 1];
    if (bHi - bLo < GAP_EPS) continue;
    const mid = (bLo + bHi) / 2;
    // 壁自身の位置ちょうどのプローブは境界セルで所有Roomが不安定なため、室内側
    // （face.inward）へPROBE_EPS_MMだけ逃がす（sectionProbe.jsのprobeOwnerRoomと同じ手法）。
    const faceCoord = face.faceValue + (face.inward ?? 1) * PROBE_EPS_MM;
    const px = face.isVertical ? faceCoord : mid;
    const py = face.isVertical ? mid : faceCoord;
    const cell = worldToCell(px, py, aboveLayer.graph);
    const ownerRoom = cell ? cellToRoom.get(cell.key) : null;
    // VOID/STAIR_VOID（吹抜け・階段吹抜け）featureのRoomは「実床が無い」ことを表現するために
    // Room化されているだけ（CH解決等の都合。elevationStair.jsのfindOverlappingVoidRoomと同じ
    // feature判定）——実床が有ると誤判定しないよう除外する。
    const hasRoom = !!ownerRoom
      && ownerRoom.feature !== RoomFeature.VOID && ownerRoom.feature !== RoomFeature.STAIR_VOID;
    const locA = (bLo - face.originWorld) * face.dirSign;
    const locB = (bHi - face.originWorld) * face.dirSign;
    segs.push({ loX: Math.min(locA, locB), hiX: Math.max(locA, locB), hasRoom });
  }
  segs.sort((a, b) => a.loX - b.loX);
  return segs;
}

// x（ローカル。0..face.run）がaboveSegsのどの区間に属するか（hasRoom）を返す。範囲外はfalse
// （安全側＝吹抜け扱い）。
function hasAboveRoomAtX(aboveSegs, x) {
  const seg = aboveSegs.find(s => x >= s.loX - GAP_EPS && x <= s.hiX + GAP_EPS);
  return seg ? seg.hasRoom : false;
}

// [{loX,hiX,ceilAbs}]（昇順・隙間なし）から、区分線形の天井プロファイル（[[localX,ceilAbsMm],...]。
// elevationFigure.jsのceilAbsAtXが解釈する規約どおり、値が変わる境界は同じxを2点書いて
// 垂直に落とす＝水平段差のステップ関数にする）を組み立てる（項目A共通処理。
// buildLaneFloorAndCeilingのフォールバック経路・above層実測経路の両方から使う）。
function stepCeilingProfile(segs) {
  const points = [];
  for (const { loX, hiX, ceilAbs } of segs) {
    if (points.length === 0) points.push([loX, ceilAbs]);
    else {
      const [, prevAbs] = points[points.length - 1];
      if (Math.abs(prevAbs - ceilAbs) > GAP_EPS) points.push([loX, prevAbs], [loX, ceilAbs]);
    }
    points.push([hiX, ceilAbs]);
  }
  return points;
}

/**
 * レーン側の面（seq2=wOut1／seq4=wOut2）のfloorSegments・ceilingProfileを組み立てる
 * （項目A対応）。floorDeltaSegsはfloorDeltaMm（既存の階段自身の床段差＝レーン=0・
 * 踊り場=landingAbs）の並び（[{loX,hiX,floorDeltaMm,hideFlatLine?}]。昇順・隙間なし。
 * seq2は[レーン,踊り場]の順・seq4は鏡像で[踊り場,レーン]の順になる——どちらの順でも
 * 正しく組み立てられるようfloorDeltaMm===0かどうかだけで判定する）、aboveLayerがあれば
 * 実Room有無で1F天井高さ(ceilLowAbs)／上階天井(ceilTopAbs)を区間ごとに割り当てる。
 * aboveLayer無し時は現行の決め打ち（floorSegmentsはfloorDeltaSegsの区分
 * そのまま。レーン区間=ceilLowAbs・踊り場区間=ceilTopAbs／ceilingProfileは呼び出し側が渡す
 * fallbackCeilingProfileをそのまま使う）のまま（挙動不変のフォールバック——旧seq2/seq4の
 * ceilingProfileは「レーンから踊り場へ向けて勾配で立ち上がる」非対称な式で、floorDeltaSegsの
 * 区分境界だけからは一般化して再現できないため、呼び出し側の既存リテラルをそのまま温存する）。
 * @param {object} face
 * @param {Array<{loX:number, hiX:number, floorDeltaMm:number, hideFlatLine?:boolean}>} floorDeltaSegs
 * @param {{graph:object, floorZMm:number, role:string}|null} aboveLayer
 * @param {ReturnType<typeof makeProbeContext>} probeCtx
 * @param {number} ceilLowAbs
 * @param {number} ceilTopAbs
 * @param {Array<[number,number]>} fallbackCeilingProfile - aboveLayer無し時に使う既存の
 *   ceilingProfileリテラル（挙動不変のため）。
 * @returns {{floorSegments:object[], ceilingProfile:Array<[number,number]>}}
 */
function buildLaneFloorAndCeiling(
  face, floorDeltaSegs, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, fallbackCeilingProfile,
) {
  const run = face.run;
  // **最上階キャップ（upperCeilCapped）による「全区間ceilLowAbsで水平」の短絡は廃止した**（ユーザー実機指摘2026-08
  // 「2FL天井断面線は、3500左CLの外へ延長して終わる」）——実機データ（floorHeight=3000・
  // chLower=2400・chUpperAbs=5400・upperCeilCapped=true）で、この短絡が天井プロファイルを
  // フラット2400にし、階段室の上まで1F天井が貫通していた。一方でcontent（レイキャスト）は
  // 同じ面に2F天井(5400)を描いており、**図形とcontentが食い違っていた**。
  // upperCeilCappedは「上階が最上階かつCHが明示指定でない（既定値へフォールバック）」という
  // 弱い条件で立つ推測（設計メモにもASSUMEDと明記）であり、実機の指摘と矛盾する。
  // chUpperAbsMm自体は他の描画で既に使われているため、天井もそれに揃える方が一貫する。
  const aboveSegs = aboveRoomSegmentsOnFace(face, aboveLayer, probeCtx);
  // フォールバック（呼び出し側の勾配天井リテラル）が働く条件は**aboveLayerが無く判定できない
  // ときだけ**。
  // 旧実装は「上階の実Room有無がface全体で一様なら実測を捨ててフォールバックへ戻す」という
  // 短絡も持っていた（コード上も「挙動不変のASSUMED判断」と明記）が、ユーザー実機指摘2026-08
  // 「6」D／B1（「2FL天井断面線は3500左CLの外へ延長して終わる」「B1はDの反転が正解」）で
  // 誤りと判明したため削除した——実機の階段室は往路面の全長にわたって上階に床が無い
  // （全面吹抜け。列ダンプでseq2の全列がwall/cutのみでslab無し）ため一様と判定され、
  // 「測れているのに測定結果を捨てる」動作になっていた。結果、天井が
  // PL[-285,2400 → 0,2400 → 2442.5,5400 → 3442.5,5400]という斜めの勾配になり、
  // 上階天井(5400)の断面線が壁のない端まで届かなかった。
  // 一様でも実測どおり（hasRoom無し＝全区間ceilTopAbsで水平／有り＝全区間ceilLowAbsで水平）に
  // 割り当てるのが正しい。フォールバックの勾配は「判定不能時の作図上の便法」として残す。
  if (!aboveSegs || aboveSegs.length === 0) {
    const floorSegments = floorDeltaSegs.map(s => ({
      ...s, chMm: (s.floorDeltaMm === 0 ? ceilLowAbs : ceilTopAbs) - s.floorDeltaMm,
    }));
    return { floorSegments, ceilingProfile: fallbackCeilingProfile };
  }

  // floorDeltaSegsとaboveSegsの境界を統合し、各ミニ区間へfloorDeltaMm・hasRoomの両方を反映する。
  const breakXs = [...new Set([
    0, run,
    ...floorDeltaSegs.flatMap(s => [s.loX, s.hiX]),
    ...aboveSegs.flatMap(s => [s.loX, s.hiX]),
  ])].sort((a, b) => a - b);

  const floorSegments = [];
  const profileSegs = [];
  for (let i = 0; i + 1 < breakXs.length; i++) {
    const loX = breakXs[i], hiX = breakXs[i + 1];
    if (hiX - loX < GAP_EPS) continue;
    const mid = (loX + hiX) / 2;
    const ownerSeg = floorDeltaSegs.find(s => mid >= s.loX - GAP_EPS && mid <= s.hiX + GAP_EPS);
    const floorDeltaMm = ownerSeg?.floorDeltaMm ?? 0;
    const hasRoom = hasAboveRoomAtX(aboveSegs, mid);
    const ceilAbs = hasRoom ? ceilLowAbs : ceilTopAbs;
    const hideFlatLine = floorDeltaMm === 0 && ownerSeg?.hideFlatLine === true;
    floorSegments.push({
      loX, hiX, floorDeltaMm, chMm: ceilAbs - floorDeltaMm, ...(hideFlatLine ? { hideFlatLine: true } : {}),
    });
    profileSegs.push({ loX, hiX, ceilAbs });
  }
  return { floorSegments, ceilingProfile: stepCeilingProfile(profileSegs) };
}

// cut(SectionCut) → content（WP-E5b: §4「内部フロー」のcontent生成部分のみをここで組み立てる。
// face/floorSegments/ceilingProfileはswitchbackCuts供給の現行方式のまま——本関数はcontentだけを
// 返す。cutがnull（例: seq3。§6.1表「階段寄与: なし」）はstairPrimitivesForCutにnullを渡す
// （contribution=null契約で空配列を返す）。
// QA実機フィードバック修正: 階段の断面ジグザグ(stairPrimitivesForCutが返すpolyline)が占める
// x範囲では、その向こうに見える壁の輪郭線（emitColumnsが一般規則で描く見えがかり壁の
// z=0=設置階FL位置の縁）は、実際には階段自体（段板・ささら）に隠れて見えないはず
// （「設置階FLは階段断面に出会ったらそこが終点」の一般化）。一般規則のレイキャスト
// （probeColumn/emitColumns）は階段自体の占有形状を知らず、壁の見えがかりだけで塞ぎ判定する
// ため、この重なりだけは切断定義の出力側で後処理として取り除く。
// 実機フィードバック第3弾D: 「ささらの外側(壁側)〜壁」×「z=0〜1F天井(ceilLowAbs)」の矩形に
// アキX（踊り場線=cut.baseFloorZで上下分割: 上=一点鎖線(center)・下=破線。emitOpenGapMarksと
// 同じ様式）を明示的に生成する——stairWallGapZones（sectionStair.js）が返すゾーンは
// 「階段の構造(stair.cells由来)が室の全幅まで届かない」帯で、通常のraycast(probeColumn)は
// 壁・部屋の有無だけで判定するため自動検出できない（コーディネーター裁定）。
// ceilLowAbs（1F天井。sectionStair.js側は知らない値のため、ここで受け取って合成する）。
// 実機フィードバック第3弾F: 往復間の壁が2F腰壁（kneeDrop.knee指定）の場合、seq1では一般規則
// （'cut'kind＝両端の縦線2本のみ・水平の上端線は無し）ではなく「上端水平線のみ・両端縦線なし」
// の腰壁表現に差し替える。腰壁の上（上端〜2F天井）と横（腰壁の無い側＝隣接する既存のアキX）を
// つないだL字アキに一点鎖線Xを1組で描く——既存のemitOpenGapMarks（連結成分のX化）と同じ
// 「対角頂点を結ぶ」考え方を、post-hoc（content側で隣接する既存アキXを探して合成）で流用する
// （ASSUMED: sectionStair.js/sectionEmit.js側の生のcolumns情報はcontentForCutの外へ出てこない
// ため、生のbands同士の厳密な連結計算ではなく、既に生成済みの2Fアキ相当のX(dash:'center'・
// z範囲がtopZ〜ceilTopAbsと重なるもの)をx方向の隣接で探して吸収する形にした）。
export function kneeWallCapContent(content, cut, kneeDrop, floorHeight, ceilTopAbs) {
  if (!kneeDrop?.knee) return content;
  const topZ = floorHeight + kneeDrop.knee.topHeight;

  // 往復間の壁の'cut'kind両端縦線（z=floorHeight〜topZちょうどの縦線2本）を検出して除去する。
  const wallEdges = content.filter(p =>
    p.type === 'line' && p.x1 === p.x2 &&
    Math.abs(Math.min(p.y1, p.y2) - (-topZ)) < GAP_EPS && Math.abs(Math.max(p.y1, p.y2) - (-floorHeight)) < GAP_EPS);
  if (wallEdges.length === 0) return content; // 該当する壁縁が無ければ何もしない（防御的）
  const wallXs = [...new Set(wallEdges.map(p => p.x1))].sort((a, b) => a - b);
  const wallLoX = wallXs[0], wallHiX = wallXs[wallXs.length - 1];
  const rest = content.filter(p => !wallEdges.includes(p));

  // 天端のCUT水平線はここでは描かない: `emitColumns`の`cutWallTopEdges`が「見えている天井より
  // 下で終わる切断壁」の天端を壁ごとに1本描くようになったため（ユーザー実機指摘2026-08「6」D）。
  // ここでも描くと同じ線が2本になる（seq1の既存テスト「上端水平線が1本」で検出される）。
  // 本関数に残る役割は「'cut'両端縦線の除去」と「腰壁の上＋横のL字アキの合成」の2つ。

  // 腰壁の上(topZ〜ceilTopAbs)〜横（腰壁の無い側）のL字アキ: 既存のアキX（dash:'center'の
  // 対角線ペア）のうちz範囲が[topZ,ceilTopAbs]と重なり、x範囲が壁の左右いずれかに隣接する
  // ものを探し、壁の上のアキと合成して1組のXへ描き直す（無ければ壁の上だけで1組描く）。
  const centerDiagonalPairs = groupDiagonalPairs(rest.filter(p =>
    p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.dash === 'center'));
  let mergedLoX = wallLoX, mergedHiX = wallHiX;
  let mergedZLo = topZ, mergedZHi = ceilTopAbs;
  const absorbed = [];
  for (const pair of centerDiagonalPairs) {
    const xs = pair.flatMap(p => [p.x1, p.x2]);
    const ys = pair.flatMap(p => [p.y1, p.y2]);
    const pLoX = Math.min(...xs), pHiX = Math.max(...xs);
    const pZLo = -Math.max(...ys), pZHi = -Math.min(...ys);
    const zOverlaps = pZLo < mergedZHi - GAP_EPS && pZHi > mergedZLo - GAP_EPS;
    const xAdjacent = Math.abs(pHiX - mergedLoX) < GAP_EPS || Math.abs(pLoX - mergedHiX) < GAP_EPS;
    if (zOverlaps && xAdjacent) {
      mergedLoX = Math.min(mergedLoX, pLoX); mergedHiX = Math.max(mergedHiX, pHiX);
      mergedZLo = Math.min(mergedZLo, pZLo); mergedZHi = Math.max(mergedZHi, pZHi);
      absorbed.push(...pair);
    }
  }
  const remaining = rest.filter(p => !absorbed.includes(p));
  const xMark = [
    emitLine(cut, mergedLoX, mergedZLo, mergedHiX, mergedZHi, ElevationLineRole.DETAIL, { dash: 'center' }),
    emitLine(cut, mergedLoX, mergedZHi, mergedHiX, mergedZLo, ElevationLineRole.DETAIL, { dash: 'center' }),
  ];
  return [...remaining, ...xMark];
}

// dash:'center'の対角線配列を2本ずつ(X字1組)にまとめる（emitOpenGapMarksは常に2本1組で
// 連続して積むため、単純に配列の並び順でペアリングする）。
function groupDiagonalPairs(diagonals) {
  const pairs = [];
  for (let i = 0; i + 1 < diagonals.length; i += 2) pairs.push([diagonals[i], diagonals[i + 1]]);
  return pairs;
}

function wallGapXMarks(cut, contribution, ceilLowAbs) {
  const zones = stairWallGapZones(contribution, cut);
  if (zones.length === 0) return [];
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const prims = [];
  for (const { loX, hiX } of zones) {
    if (ceilLowAbs > baseFloorZ + GAP_EPS) {
      prims.push(emitLine(cut, loX, baseFloorZ, hiX, ceilLowAbs, ElevationLineRole.DETAIL, { dash: 'center' }));
      prims.push(emitLine(cut, loX, ceilLowAbs, hiX, baseFloorZ, ElevationLineRole.DETAIL, { dash: 'center' }));
    }
    if (baseFloorZ > GAP_EPS) {
      prims.push(emitLine(cut, loX, 0, hiX, baseFloorZ, ElevationLineRole.DETAIL));
      prims.push(emitLine(cut, loX, baseFloorZ, hiX, 0, ElevationLineRole.DETAIL));
    }
  }
  return prims;
}

function clipWallFloorEdgeUnderZigzag(wallContent, stairContent) {
  const zigzagXRanges = stairContent
    .filter(p => p.type === 'polyline')
    .map(p => ({
      lo: Math.min(...p.points.map(pt => pt[0])),
      hi: Math.max(...p.points.map(pt => pt[0])),
    }));
  if (zigzagXRanges.length === 0) return wallContent;
  return wallContent.filter(p => {
    if (p.type !== 'line' || p.y1 !== p.y2 || p.y1 !== 0) return true; // 設置階FL(z=0)の水平線のみ対象
    const xLo = Math.min(p.x1, p.x2), xHi = Math.max(p.x1, p.x2);
    return !zigzagXRanges.some(r => xLo < r.hi - GAP_EPS && xHi > r.lo + GAP_EPS);
  });
}

/**
 * 壁のない端部（face.hasWallAtLocal0/Runがfalse）の外側へ、レイキャストの探査範囲を
 * endExtendMmぶん広げたcutのクローンを返す（ユーザー裁定2026-08 A案）。
 * 面の端で切れている壁・床スラブ・天井は「そこで終わる」のではなく面の外へ続いており、
 * その取り合い（腰壁の外側面・隣室の1F天井断面・2FL床断面）を作図するには外側の実データが要る
 * ——旧案の「出来上がった水平線プリミティブを後から引き伸ばす」では、外側面の位置（＝壁厚）が
 * そもそも探査されていないため腰壁のZ字プロファイルを作れなかった（列ダンプで確認）。
 * cut.line.lo/hi自体は変えない＝x=0の起点（cutOriginWorld）が動かないため既存座標はずれない。
 * ローカルx=0側／run側のどちらがworldのlo側かはdirSignで決まる。
 */
function withProbeExtension(cut, endExtendMm, bandRoomBounds = null) {
  const openLo = cut.face?.hasWallAtLocal0 === false;
  const openHi = cut.face?.hasWallAtLocalRun === false;
  const localLoIsWorldLo = cut.dirSign > 0;
  const extend = !!endExtendMm && (openLo || openHi);
  // bandRoom: 見えがかり壁の探索を帯自身の部屋の広がりに限る（sectionProbe.jsのwithinViewRoom）。
  return { ...cut, bandRoomBounds, line: !extend ? cut.line : { ...cut.line,
    probeExtendLoMm: (localLoIsWorldLo ? openLo : openHi) ? endExtendMm : 0,
    probeExtendHiMm: (localLoIsWorldLo ? openHi : openLo) ? endExtendMm : 0 } };
}

function contentForCut(cut, probeCtx, endExtendMm = 0, bandRoomBounds = null, zRef = null) {
  if (!cut) return [];
  // 拡張済みcut（探査延長＋帯の部屋の包絡矩形つき）はレイキャストだけでなく構造材の判定でも使う
  // ——「室内を空中で横断する梁の見えがかり」がbandRoomBoundsを見るため（sectionStructure.js）。
  const pcut = withProbeExtension(cut, endExtendMm, bandRoomBounds);
  const columns = buildColumns(pcut, probeCtx);
  // openEndLo/Hi: この面の端に壁が無い（壁面がその先へ続く）なら、描画範囲の端に凹み側面線を
  // 出さない（ユーザー実機指摘2026-08「3500左CLにエッジはない」。sectionEmit.js参照）。
  // cut.face（switchbackCuts.jsが各cutへ載せる面記述子）のhasWallAtLocal0/Runがそのまま
  // ローカルx=0/run側の端に対応する（cut.dirSignとfaceのdirSignはreorientFaceで揃えてある）。
  const emitCtx = {
    ceilZ: cut.zRange?.hiZ,
    openEndLo: cut.face?.hasWallAtLocal0 === false,
    openEndHi: cut.face?.hasWallAtLocalRun === false,
  };
  // アキのバツは、手前に階段が描かれる区間だけ破線へ落とす（ユーザー実機指摘2026-08「6」C
  // 「但し、階段に隠れる部分は破線」）。隠れる範囲はプリミティブからの逆算ではなくflight自身の
  // 見付け矩形（stairOccluderRects）から求める。
  // 階段の見付けシルエット（手前に実体がある範囲）。アキのバツ・見えがかり水平線の
  // どちらの破線判定にも同じ集合を使う。
  const occluders = stairOccluderRects(cut.stairCut ?? null, cut);
  const gapMarks = splitGapMarksByStair(emitOpenGapMarks(columns, cut, emitCtx), occluders);
  // 見えがかりの水平線のうち階段の背後に入る区間は破線（同指摘「その先は袋階段に隠れて
  // 見えなくなるが、アキ・バツのために破線で右側壁断面線まで」）。
  const wallContent = [
    ...dashHorizontalsBehindStair(
      emitColumns(columns, cut, emitCtx), occluders),
    ...gapMarks,
  ];
  // 下ささらの見えがかりは下階天井〜上階床の帯（床構造の中）でカットする
  // （ユーザー実機指摘2026-08「6」D2。sectionEmit.js参照）。
  const stairContent = zRef
    ? clipStairDetailInSlabBand(
        stairPrimitivesForCut(cut.stairCut ?? null, cut, columns), zRef.ceilLowAbs, zRef.floorHeight)
    : stairPrimitivesForCut(cut.stairCut ?? null, cut, columns);
  // WP-C: 構造梁（踊り場受け梁等）の加算寄与。stairContentと独立の別レイヤのため、
  // clipWallFloorEdgeUnderZigzag（階段ジグザグの向こうの壁縁除去）の対象には含めない。
  const structuralContent = structuralPrimitivesForCut(structuralContribution(cut.layers), pcut, columns);
  // 階段の断面プロファイルとの取り合い（ユーザー実機指摘2026-08「6」D2。sectionEmit.js参照）。
  const joined = zRef
    ? joinToStairProfile(wallContent, stairContent, pcut,
      { ...zRef, drawLo: cutDrawRange(pcut).lo, drawHi: cutDrawRange(pcut).hi })
    : wallContent;
  return [...clipWallFloorEdgeUnderZigzag(joined, stairContent), ...stairContent, ...structuralContent];
}

/**
 * STRAIGHT/STRAIGHT_LANDING（§6.2・WP-E6）の歩行順面シーケンス。straightCutsが返す各cutを
 * そのままbuildSectionFigure（sectionEngine.js。face/floorSegments/ceilingProfileの算出も
 * エンジン汎用の経路に委ねる。straightCuts.jsヘッダコメント参照）へ渡すだけ——SWITCHBACKの
 * ような手組みのfloorSegments/ceilingProfile算出（往路・復路二重管理の特殊事情）が無いため。
 * straightCutsがnullを返す条件（対象外タイプ・cells空・floorHeight未確定・面分類不能）は
 * そのままstairFaceSequenceのnull契約へ延長する。
 * @returns {ReturnType<typeof stairFaceSequence>}
 */
function buildStraightFaceSequence(stair, faces, graph, opts) {
  const table = straightCuts(stair, faces, graph, opts);
  if (!table) return null;
  const probeCtx = makeProbeContext(table.cuts[0].layers);
  return table.cuts.map(cut =>
    buildSectionFigure(cut, probeCtx, { wallFaces: faces, ceilZ: cut.zRange?.hiZ }));
}

/**
 * 階段の歩行順面シーケンスを組み立てる（WP-E6: タイプ別ディスパッチ。ファイル冒頭コメント参照）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number}} opts
 *   chUpperAbsMm … 上階天井の絶対高さ（floorHeight+CH_upper。呼び出し側で計算済みの値をそのまま使う）。
 *   chLowerMm … 設置階の天井高さ（CH。絶対高さそのもの＝設置階FL=0基準）。
 * @returns {Array<{seqNo:string, face:object, floorSegments:object[], ceilingProfile?:Array<[number,number]>,
 *   content:object[], skipBaseboard:true, skipWallLabel:true, floorSpanX?:object}>|null}
 */
export function stairFaceSequence(stair, faces, graph, opts = {}) {
  if (stair && (stair.type === StairType.STRAIGHT || stair.type === StairType.STRAIGHT_LANDING)) {
    return buildStraightFaceSequence(stair, faces, graph, opts);
  }
  if (stair && UNSUPPORTED_FAN_LANE_TYPES.includes(stair.type)) {
    return fanLaneCuts(stair); // 常にnull（扇形レーン未対応。fanCuts.js参照）
  }

  const cutTable = switchbackCuts(stair, faces, graph, opts);
  if (!cutTable) return null; // フォールバック契約: switchbackCutsのnull条件をそのまま延長する

  // wOut1/wOut2は**取り出さない**——面の選択はcuts表が唯一の情報源で、ここで独自に選び直すと
  // 「その切断が見ている面」との食い違いが再発する（ユーザー明示指示2026-08その11。seq2/seq4参照）。
  const {
    cuts, wEntry, wLanding, underFloorZ, hasRoomUnder,
    ceilTopAbs, ceilLowAbs, contribution, kneeDrop,
  } = cutTable;
  const { landingLen } = cutTable.params;
  const floorHeight = opts.floorHeight;
  const hasCut = seqNo => cuts.some(c => c.seqNo === seqNo);
  const cutOf = seqNo => cuts.find(c => c.seqNo === seqNo);
  // 壁のない端部の延長量（content側。図形側elevationFigure.jsのdrawnX0/drawnXRunと同じ値を使い、
  // 同じ端で線の長さを揃える）。倍率決定の1パス目は未指定＝既定の仮値（elevationStyle.js）。
  const endExtendMm = opts.wallLessEndExtendModelMm ?? DEFAULT_WALL_LESS_END_EXTEND_MM;
  // 帯自身の部屋（階段室）。見えがかり壁の探索範囲をこの部屋の広がりに限る
  // （sectionProbe.jsのwithinViewRoom。ユーザー実機指摘2026-08「6」C・裁定A案）。
  const bandRoom = (graphList(graph, 'rooms') ?? []).find(r => r.id === stair.roomId) ?? null;
  // 包絡矩形は世界座標の箱なので**自階graphで一度だけ**求め、全レイヤーで使う。
  const bandRoomBounds = bandRoom ? roomBounds(bandRoom.cells, graph) : null;
  // 往復間の壁の芯を一点鎖線で示す（ユーザー実機指摘2026-08「6」C「1500の一点鎖線が出ていない」）。
  // この壁は切断線から見て**面の裏側**へ伸びるため、elevationFigure.jsの直交壁検出
  // （室内側へ突出する袖壁が対象）に掛からず、一点鎖線の源が1つも無かった。
  // 面に直交し、かつ芯が面の範囲内にある面にだけ載せる（面と平行なB/D側には出ない）。
  const midWall = cutTable.wall ?? null;
  const midWallCLXs = face => {
    if (!midWall || !face || midWall.isVertical === face.isVertical) return undefined;
    const x = (midWall.axisCL.effectiveValue - face.originWorld) * face.dirSign;
    return (x > GAP_EPS && x < face.run - GAP_EPS) ? [x] : undefined;
  };

  // WP-E5b: content生成はエンジン経由（makeProbeContext→cutごとにcontentForCut）。
  // 全cutが同一のlayers参照を共有する（switchbackCuts.js参照）ため、probeCtxは1回だけ作る。
  const probeCtx = makeProbeContext(cuts[0].layers);
  // 項目A: above層（role!=='self'）があれば実Room有無で1F天井高さ/上階天井を判定する
  // （buildLaneFloorAndCeiling）。無ければフォールバック（挙動不変）。
  const aboveLayer = cuts[0].layers.find(l => l.role !== 'self') ?? null;

  const entries = [];

  // ---- 1: 踊り場前縁（見返り・全幅） ----
  entries.push({
    seqNo: '1', face: wEntry,
    floorSegments: flatFloorSegments(wEntry.run, underFloorZ, ceilTopAbs - underFloorZ),
    chDimSplitAbsYs: [floorHeight],
    // 実機フィードバック第3弾D: ささらの外側(壁側)〜壁の空きにアキXを足す（wallGapXMarks参照）。
    // 実機フィードバック第3弾F: 往復間の壁が2F腰壁（kneeDrop.knee）なら両端縦線を上端水平線
    // へ差し替え、腰壁の上＋横のL字アキに一点鎖線Xを合成する（kneeWallCapContent参照）。
    content: [
      ...kneeWallCapContent(contentForCut(cutOf('1'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), cutOf('1'), kneeDrop, floorHeight, ceilTopAbs),
      ...wallGapXMarks(cutOf('1'), contribution, ceilLowAbs),
    ],
    skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 2: 往路レーンから見る面（往復レーンの境界＝中心1） ----
  // ユーザー明示指示2026-08その11「A,B,C,Dの抽出と、順番決めロジックがごっちゃになっている」
  // 「展開の向きは絶対。後から順番」: **面は切断定義表（switchbackCuts.js）が持つ「その切断が
  // 見ている面」をそのまま使う**——ここで`wOut1`（＝視線の背後の壁）を独自に選び直していたため、
  // 図の向きと面の幾何が食い違い、面由来の寸法・向こう側判定が反対側を向いていた
  // （実機「6」D1が、向こうに壁の無いはずの面で1500+2000に割れた）。
  const outFace2 = cutOf('2').face;
  {
    const laneLenOnFace = Math.max(0, outFace2.run - landingLen);
    // QA実機フィードバック修正: レーン区間(floorDeltaMm:0)の床線(z=0)は、段鼻の断面
    // ジグザグ(stairCutのcontent)が既にその区間の輪郭を表しているため、床の水平線が
    // ジグザグの下を素通りして踊り場側の隅まで貫通してしまう（「階段設置階FLは階段断面
    // に出会ったらそこが終点」）——hideFlatLine:trueでこの区間だけ床線を描かない
    // （elevationFigure.jsのbuildFaceFigure参照。段差縦線・注記等の他の処理は不変）。
    const floorDeltaSegs2 = laneLenOnFace > 0
      ? [
          { loX: 0, hiX: laneLenOnFace, floorDeltaMm: 0, hideFlatLine: hasRoomUnder },
          { loX: laneLenOnFace, hiX: outFace2.run, floorDeltaMm: underFloorZ },
        ]
      : [{ loX: 0, hiX: outFace2.run, floorDeltaMm: underFloorZ }];
    // 項目A: floorSegments/ceilingProfileはbuildLaneFloorAndCeiling（above層の実Room有無）で
    // 決める——laneLenOnFace境界だけの決め打ちだった旧実装を置き換える。fallbackCeilingProfile2
    // はaboveLayer未指定時に使う旧来のリテラル（挙動不変）。
    // 最上階キャップの分岐は廃止（buildLaneFloorAndCeiling参照）。フォールバックも常に
    // 「上り口側=1F天井 → 奥の吹抜け=上階天井」の形にする。
    const fallbackCeilingProfile2 = laneLenOnFace > 0
        ? [[0, ceilLowAbs], [laneLenOnFace, ceilTopAbs], [outFace2.run, ceilTopAbs]]
        : [[0, ceilTopAbs], [outFace2.run, ceilTopAbs]];
    const { floorSegments: floorSegments2, ceilingProfile: ceilingProfile2 } = buildLaneFloorAndCeiling(
      outFace2, floorDeltaSegs2, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, fallbackCeilingProfile2);
    entries.push({
      seqNo: '2', face: outFace2,
      floorSegments: floorSegments2,
      ceilingProfile: ceilingProfile2,
      content: contentForCut(cutOf('2'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 2.5: レーン境界 往路側（midWallがあれば） ----
  if (hasCut('2.5')) {
    const midOutFace = cutOf('2.5').face;
    entries.push({
      seqNo: '2.5', face: midOutFace,
      floorSegments: flatFloorSegments(midOutFace.run, 0, ceilLowAbs),
      ceilingProfile: outboundCeilingProfile(midOutFace.run, ceilLowAbs, ceilTopAbs),
      content: contentForCut(cutOf('2.5'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 3: W_landing（全幅。階段の重ね描きなし） ----
  entries.push({
    seqNo: '3', face: wLanding,
    floorSegments: flatFloorSegments(wLanding.run, underFloorZ, ceilTopAbs - underFloorZ),
    content: contentForCut(cutOf('3'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 4: 往路外側の壁を復路側から見る面（seq2の鏡像構成） ----
  // seq2と同じく、面は切断定義表が持つ「その切断が見ている面」を使う（上のコメント参照）。
  const outFace4 = cutOf('4').face;
  {
    const laneLenOnFace4 = Math.max(0, outFace4.run - landingLen);
    const landingHi4 = outFace4.run - laneLenOnFace4;
    // QA実機フィードバック修正: seq2と同じ理由でレーン区間の床線を描かない（seq4は
    // 踊り場が左・レーンが右の鏡像構成のため、こちらは第2区間がレーンにあたる）。
    const floorDeltaSegs4 = landingHi4 < outFace4.run
      ? [
          { loX: 0, hiX: landingHi4, floorDeltaMm: underFloorZ },
          { loX: landingHi4, hiX: outFace4.run, floorDeltaMm: 0, hideFlatLine: hasRoomUnder },
        ]
      : [{ loX: 0, hiX: outFace4.run, floorDeltaMm: underFloorZ }];
    // 項目A: seq2と同じくbuildLaneFloorAndCeilingで決める（fallbackCeilingProfile4は
    // aboveLayer未指定時に使う旧来のリテラル。挙動不変）。
    const fallbackCeilingProfile4 = landingHi4 < outFace4.run
        ? [[0, ceilTopAbs], [landingHi4, ceilTopAbs], [outFace4.run, ceilLowAbs]]
        : [[0, ceilTopAbs], [outFace4.run, ceilTopAbs]];
    const { floorSegments: floorSegments4, ceilingProfile: ceilingProfile4 } = buildLaneFloorAndCeiling(
      outFace4, floorDeltaSegs4, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, fallbackCeilingProfile4);
    entries.push({
      seqNo: '4', face: outFace4,
      floorSegments: floorSegments4,
      ceilingProfile: ceilingProfile4,
      content: contentForCut(cutOf('4'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 4.5: レーン境界 復路側（あれば。踊り場が左端） ----
  if (hasCut('4.5')) {
    const midRetFace = cutOf('4.5').face;
    entries.push({
      seqNo: '4.5', face: midRetFace,
      floorSegments: flatFloorSegments(midRetFace.run, underFloorZ, ceilTopAbs - underFloorZ),
      content: contentForCut(cutOf('4.5'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 5: 復路断面を反対側から見た図（踊り場が右端） ----
  {
    const outFace5 = cutOf('5').face;
    entries.push({
      seqNo: '5', face: outFace5,
      floorSegments: flatFloorSegments(outFace5.run, underFloorZ, ceilTopAbs - underFloorZ),
      content: contentForCut(cutOf('5'), probeCtx, endExtendMm, bandRoomBounds, { ceilLowAbs, floorHeight }), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // 展開記号（ユーザー実機指摘2026-08「階段は、のぼり方で作図順が決まるので、展開記号は
  // ケースバイケース」「「6」B2：Dが正解。先のDは往路階段で切断して…このDは、復路階段で切断して、
  // 「5」D1と同面の壁を見ている」）:
  // **記号は切断の「視線の向き」だけで決まる**——`cut.viewSign`は視線が向く世界方向
  // （`isSightlineShape`の契約: 見えがかり候補は line から+viewSign側にある）なので、
  // 面の規約（`letterOf(isVertical, inward)`。inwardは視線と逆向き）へは`-viewSign`を渡す。
  // 旧実装は`reorientFace`が倒したdirSignから引いていたが、**dirSignは歩行方向で決まる作図順**
  // であって視線ではない——実機で seq2 と seq5 は同じ towardS1（＝同じ向きを見る）なのに
  // dirSignが違うため別記号になっていた（ユーザー指摘: どちらもD）。seq4だけが towardS0＝逆向きで
  // B になる（前ラウンドのご指摘とも一致）。
  // labelは歩行順に採番し直す（`labelFaces`。部屋のコンパス順の連番を持ち込まない）。
  const relabeled = labelFaces(entries.map(e => {
    const cut = cutOf(e.seqNo);
    if (!cut?.line) return e.face;
    return { ...e.face, letter: letterOf(cut.line.isVertical, -cut.viewSign) };
  }));
  const chDimChains = stairChDimChains(entries, {
    landingAbs: cutTable.landingAbs, hasRoomUnder, chLowerMm: ceilLowAbs, floorHeight, chUpperAbsMm: ceilTopAbs,
  });
  return entries.map((e, i) => ({
    ...e, face: relabeled[i],
    // 往復間の壁の芯（一点鎖線のみ。寸法の鎖は分割しない）。elevationStair.jsのfaceOverride経由で
    // buildFaceFigureのextraCenterLineXsへ渡る。
    extraCenterLineXs: midWallCLXs(relabeled[i]),
    chDimChains: chDimChains[i],
  }));
}

// 面の左右の端で「踊り場スラブが切れる」のはどちら側か。
//   - 幅方向に横断する面（seq1=上り口・seq3=踊り場の壁）は面の全長で踊り場を横切る＝両端とも踊り場側。
//   - 走行方向の面（seq2/2.5/5は上り口が左・踊り場が右、seq4/4.5はその鏡像）は片側だけ。
// 走行方向の面のもう一方の端（上り口側）は、壁の向こうの通常の部屋の断面（1F天井・2FL）が現れる。
const LANDING_END_BY_SEQ = { '1': 'both', '2': 'right', '2.5': 'right', '3': 'both', '4': 'left', '4.5': 'left', '5': 'right' };

/**
 * 階段帯の高さ寸法（CH寸法）の鎖を面ごと・左右の端ごとに決める（ユーザー明示指示2026-08その12）。
 *
 * 規則:
 *   - 寸法は「床断面・踊り場断面・天井断面のいずれかから、いずれかまで」を1本とする。
 *   - 端ごとに断面のプロファイルが決まる。踊り場スラブが切れる端は
 *     `[1FL→踊り場][踊り場→上階天井]`（階段下に部屋があるときは踊り場より下は別室なので
 *     `[踊り場→上階天井]`の1本）、切れない端は壁の向こうの通常断面
 *     `[1FL→1F天井][2FL→2F天井]`。
 *   - **帯の左から端を順に見て、前の端とプロファイルが変わったときだけ記入する**
 *     （「前の展開断面と高さが変わる場合、新たな断面間寸法を記入」）。先頭の端は必ず記入する。
 * 実機「6」: C左=踊り場側(記入)→C右=同じ(なし)→D1左=通常(記入)→D1右=踊り場側(記入)→
 * A左/A右/B左=同じ(なし)→B右=通常(記入)→D2左=同じ(なし)→D2右=踊り場側(記入)。
 * @param {Array<{seqNo:string}>} entries
 * @param {{landingAbs:number, hasRoomUnder:boolean, chLowerMm:number, floorHeight:number, chUpperAbsMm:number}} h
 * @returns {Array<{left:Array<[number,number]>|null, right:Array<[number,number]>|null}>}
 */
export function stairChDimChains(entries, h) {
  // 踊り場側の端の断面。階段下に部屋があるときは踊り場より下は別室のため帯の床が踊り場になり、
  // 上の断面は2FL・2F天井（ユーザー明示指示「2FL 寸法線はここで分ける」＝既存の受け入れ済み挙動）。
  // 部屋が無ければ1FLから踊り場・踊り場から2F天井（今回の指示）。
  const landing = h.hasRoomUnder
    ? [[h.landingAbs, h.floorHeight], [h.floorHeight, h.chUpperAbsMm]]
    : [[0, h.landingAbs], [h.landingAbs, h.chUpperAbsMm]];
  const normal = [[0, h.chLowerMm], [h.floorHeight, h.chUpperAbsMm]];
  const valid = chain => chain.filter(([lo, hi]) => hi - lo > GAP_EPS);
  const key = chain => JSON.stringify(chain);

  const out = [];
  let prevKey = null;
  for (const e of entries) {
    const side = LANDING_END_BY_SEQ[e.seqNo] ?? 'both';
    const leftChain  = valid(side === 'left'  || side === 'both' ? landing : normal);
    const rightChain = valid(side === 'right' || side === 'both' ? landing : normal);
    const left  = key(leftChain)  !== prevKey ? leftChain  : null;
    prevKey = key(leftChain);
    const right = key(rightChain) !== prevKey ? rightChain : null;
    prevKey = key(rightChain);
    out.push({ left, right });
  }
  return out;
}
