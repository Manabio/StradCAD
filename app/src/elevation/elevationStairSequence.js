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
import { emitColumns, emitOpenGapMarks, emitLine } from './section/sectionEmit.js';
import { stairPrimitivesForCut, stairWallGapZones } from './section/sectionStair.js';
import { structuralContribution, structuralPrimitivesForCut } from './section/sectionStructure.js';
import { worldToCell } from '../finish/gridCells.js';
import { labelFaces } from './elevationFaces.js';
import { collectRunBreaks } from './elevationFloorProfile.js';
import { ElevationLineRole, GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from './elevationStyle.js';

function flatFloorSegments(run, floorDeltaMm, chMm) {
  return [{ loX: 0, hiX: run, floorDeltaMm, chMm }];
}

// 往路（entry→landing）の勾配天井プロファイル。upperCeilCappedなら往路上はceilLowAbsで水平のまま
// （リード裁定の解釈で、最上階キャップ時の踊り場側との段差の縦線は本WPでは描画しない。
// .claude/elevation-model.mdの階段帯節・完了条件の「逸脱＋理由」参照）。
function outboundCeilingProfile(run, ceilLowAbs, ceilTopAbs, upperCeilCapped) {
  return upperCeilCapped
    ? [[0, ceilLowAbs], [run, ceilLowAbs]]
    : [[0, ceilLowAbs], [run, ceilTopAbs]];
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
 * aboveLayer無し・upperCeilCapped時は現行の決め打ち（floorSegmentsはfloorDeltaSegsの区分
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
 * @param {boolean} upperCeilCapped
 * @param {Array<[number,number]>} fallbackCeilingProfile - aboveLayer無し時に使う既存の
 *   ceilingProfileリテラル（挙動不変のため）。
 * @returns {{floorSegments:object[], ceilingProfile:Array<[number,number]>}}
 */
function buildLaneFloorAndCeiling(
  face, floorDeltaSegs, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, upperCeilCapped, fallbackCeilingProfile,
) {
  const run = face.run;
  if (upperCeilCapped) {
    // 最上階キャップ時は現行どおり全区間ceilLowAbsで水平（不変。ASSUMED: 項目Aは
    // 「above層の実Room有無」の話であり、最上階（above層自体が存在しない）は対象外）。
    return {
      floorSegments: floorDeltaSegs.map(s => ({ ...s, chMm: ceilLowAbs - s.floorDeltaMm })),
      ceilingProfile: [[0, ceilLowAbs], [run, ceilLowAbs]],
    };
  }
  const aboveSegs = aboveRoomSegmentsOnFace(face, aboveLayer, probeCtx);
  // フォールバック（挙動不変）が働く条件: aboveLayer未指定（判定不能）、または上階の実Room有無が
  // face全体で一様（全区間hasRoom同じ値）——一様な場合は「レーン/踊り場のどちらかにだけ床が
  // ある」という項目Aが対象とする区別自体が発生しないため、既存の勾配天井（旧「QA修正1」で
  // 検証済みの、全面吹抜けの階段室を正面ドア付近=通常天井高さ→奥の吹抜け=上階天井高さへ
  // 徐々に開けていく作図表現）をそのまま使う（挙動不変。既存テスト
  // 「往路面の天井は勾配のCUT polyline」参照）。項目Aが対象とするのは「上階の床が階段室の
  // 一部（例: 踊り場の真上）にだけある」という非一様なケースに限る。
  const isUniform = aboveSegs && aboveSegs.length > 0
    && aboveSegs.every(s => s.hasRoom === aboveSegs[0].hasRoom);
  if (!aboveSegs || aboveSegs.length === 0 || isUniform) {
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

  const topLine = emitLine(cut, wallLoX, topZ, wallHiX, topZ, ElevationLineRole.CUT);

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
  return [...remaining, topLine, ...xMark];
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

function contentForCut(cut, probeCtx) {
  if (!cut) return [];
  const columns = buildColumns(cut, probeCtx);
  const emitCtx = { ceilZ: cut.zRange?.hiZ };
  const wallContent = [...emitColumns(columns, cut, emitCtx), ...emitOpenGapMarks(columns, cut, emitCtx)];
  const stairContent = stairPrimitivesForCut(cut.stairCut ?? null, cut, columns);
  // WP-C: 構造梁（踊り場受け梁等）の加算寄与。stairContentと独立の別レイヤのため、
  // clipWallFloorEdgeUnderZigzag（階段ジグザグの向こうの壁縁除去）の対象には含めない。
  const structuralContent = structuralPrimitivesForCut(structuralContribution(cut.layers), cut, columns);
  return [...clipWallFloorEdgeUnderZigzag(wallContent, stairContent), ...stairContent, ...structuralContent];
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
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number, upperCeilCapped?:boolean}} opts
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

  const {
    cuts, wEntry, wLanding, wOut1, wOut2, underFloorZ,
    ceilTopAbs, ceilLowAbs, upperCeilCapped, contribution, kneeDrop,
  } = cutTable;
  const { landingLen } = cutTable.params;
  const floorHeight = opts.floorHeight;
  const hasCut = seqNo => cuts.some(c => c.seqNo === seqNo);
  const cutOf = seqNo => cuts.find(c => c.seqNo === seqNo);

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
      ...kneeWallCapContent(contentForCut(cutOf('1'), probeCtx), cutOf('1'), kneeDrop, floorHeight, ceilTopAbs),
      ...wallGapXMarks(cutOf('1'), contribution, ceilLowAbs),
    ],
    skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 2: W_out1（実際の壁面。クリップ廃止） ----
  const outFace2 = wOut1;
  {
    const laneLenOnFace = Math.max(0, outFace2.run - landingLen);
    // QA実機フィードバック修正: レーン区間(floorDeltaMm:0)の床線(z=0)は、段鼻の断面
    // ジグザグ(stairCutのcontent)が既にその区間の輪郭を表しているため、床の水平線が
    // ジグザグの下を素通りして踊り場側の隅まで貫通してしまう（「階段設置階FLは階段断面
    // に出会ったらそこが終点」）——hideFlatLine:trueでこの区間だけ床線を描かない
    // （elevationFigure.jsのbuildFaceFigure参照。段差縦線・注記等の他の処理は不変）。
    const floorDeltaSegs2 = laneLenOnFace > 0
      ? [
          { loX: 0, hiX: laneLenOnFace, floorDeltaMm: 0, hideFlatLine: true },
          { loX: laneLenOnFace, hiX: outFace2.run, floorDeltaMm: underFloorZ },
        ]
      : [{ loX: 0, hiX: outFace2.run, floorDeltaMm: underFloorZ }];
    // 項目A: floorSegments/ceilingProfileはbuildLaneFloorAndCeiling（above層の実Room有無）で
    // 決める——laneLenOnFace境界だけの決め打ちだった旧実装を置き換える。fallbackCeilingProfile2
    // はaboveLayer未指定時に使う旧来のリテラル（挙動不変）。
    const fallbackCeilingProfile2 = upperCeilCapped
      ? [[0, ceilLowAbs], [outFace2.run, ceilLowAbs]]
      : laneLenOnFace > 0
        ? [[0, ceilLowAbs], [laneLenOnFace, ceilTopAbs], [outFace2.run, ceilTopAbs]]
        : [[0, ceilTopAbs], [outFace2.run, ceilTopAbs]];
    const { floorSegments: floorSegments2, ceilingProfile: ceilingProfile2 } = buildLaneFloorAndCeiling(
      outFace2, floorDeltaSegs2, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, upperCeilCapped, fallbackCeilingProfile2);
    entries.push({
      seqNo: '2', face: outFace2,
      floorSegments: floorSegments2,
      ceilingProfile: ceilingProfile2,
      content: contentForCut(cutOf('2'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 2.5: レーン境界 往路側（midWallがあれば） ----
  if (hasCut('2.5')) {
    const midOutFace = cutOf('2.5').face;
    entries.push({
      seqNo: '2.5', face: midOutFace,
      floorSegments: flatFloorSegments(midOutFace.run, 0, ceilLowAbs),
      ceilingProfile: outboundCeilingProfile(midOutFace.run, ceilLowAbs, ceilTopAbs, upperCeilCapped),
      content: contentForCut(cutOf('2.5'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 3: W_landing（全幅。階段の重ね描きなし） ----
  entries.push({
    seqNo: '3', face: wLanding,
    floorSegments: flatFloorSegments(wLanding.run, underFloorZ, ceilTopAbs - underFloorZ),
    content: contentForCut(cutOf('3'), probeCtx), skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 4: W_out2（seq2の鏡像構成） ----
  const outFace4 = wOut2;
  {
    const laneLenOnFace4 = Math.max(0, outFace4.run - landingLen);
    const landingHi4 = outFace4.run - laneLenOnFace4;
    // QA実機フィードバック修正: seq2と同じ理由でレーン区間の床線を描かない（seq4は
    // 踊り場が左・レーンが右の鏡像構成のため、こちらは第2区間がレーンにあたる）。
    const floorDeltaSegs4 = landingHi4 < outFace4.run
      ? [
          { loX: 0, hiX: landingHi4, floorDeltaMm: underFloorZ },
          { loX: landingHi4, hiX: outFace4.run, floorDeltaMm: 0, hideFlatLine: true },
        ]
      : [{ loX: 0, hiX: outFace4.run, floorDeltaMm: underFloorZ }];
    // 項目A: seq2と同じくbuildLaneFloorAndCeilingで決める（fallbackCeilingProfile4は
    // aboveLayer未指定時に使う旧来のリテラル。挙動不変）。
    const fallbackCeilingProfile4 = upperCeilCapped
      ? [[0, ceilLowAbs], [outFace4.run, ceilLowAbs]]
      : landingHi4 < outFace4.run
        ? [[0, ceilTopAbs], [landingHi4, ceilTopAbs], [outFace4.run, ceilLowAbs]]
        : [[0, ceilTopAbs], [outFace4.run, ceilTopAbs]];
    const { floorSegments: floorSegments4, ceilingProfile: ceilingProfile4 } = buildLaneFloorAndCeiling(
      outFace4, floorDeltaSegs4, aboveLayer, probeCtx, ceilLowAbs, ceilTopAbs, upperCeilCapped, fallbackCeilingProfile4);
    entries.push({
      seqNo: '4', face: outFace4,
      floorSegments: floorSegments4,
      ceilingProfile: ceilingProfile4,
      content: contentForCut(cutOf('4'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 4.5: レーン境界 復路側（あれば。踊り場が左端） ----
  if (hasCut('4.5')) {
    const midRetFace = cutOf('4.5').face;
    entries.push({
      seqNo: '4.5', face: midRetFace,
      floorSegments: flatFloorSegments(midRetFace.run, underFloorZ, ceilTopAbs - underFloorZ),
      content: contentForCut(cutOf('4.5'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 5: 復路断面を反対側から見た図（踊り場が右端） ----
  {
    const outFace5 = cutOf('5').face;
    entries.push({
      seqNo: '5', face: outFace5,
      floorSegments: flatFloorSegments(outFace5.run, underFloorZ, ceilTopAbs - underFloorZ),
      content: contentForCut(cutOf('5'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // 展開記号の採番（ユーザー実機指摘2026-08「階段は、のぼり方で作図順が決まるので、展開記号は
  // ケースバイケース」）: 各面のletterは既に`reorientFace`が歩行方向基準のdirSignから引き直して
  // いる（`letterForDirSign`）。ここでは**歩行順に**同letterの連番を振り直す——部屋のface配列で
  // 採番済みのlabel（コンパス順のB1/B2…）をそのまま使うと、reorient後のletterと食い違ううえ
  // 並び順とも合わないため。labelFacesは「letterごとの出現順」で採番する既存の純関数をそのまま使う。
  const relabeled = labelFaces(entries.map(e => e.face));
  return entries.map((e, i) => ({ ...e, face: relabeled[i] }));
}
