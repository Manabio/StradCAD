/**
 * 2.5D断面エンジン: 直進階段（STRAIGHT / STRAIGHT_LANDING）の切断定義表（WP-E6・設計書§6.2）。
 * switchbackCuts.js（WP-E5）と異なり、floorSegments/ceilingProfile/faceの算出はエンジン汎用の
 * buildSectionFigure（sectionEngine.js。faceFromCut/floorSegmentsFromColumns/
 * ceilingProfileFromColumns）にそのまま委ねる——直進階段は往路・復路が並走しない単純な1本道
 * （SWITCHBACKのような「往復間の壁」の二重管理・sloped ceilingの特殊事情が無い）ため、WP-E4で
 * 用意済みの汎用フォールバック（面全幅1区間・floorDeltaMm:0・天井=cut.zRange.hiZの水平線）を
 * そのまま使う（ASSUMED: 階段自体の段差・踊り場のCUT線は`stairCut`経由でcontentへ描かれるため、
 * floorSegments自体が段差を再現しなくても視覚的な破綻はない。実機確認前提の簡易実装として報告）。
 *
 * classifyFaces/buildMidWallFace（switchbackCuts.jsからexport済み。挙動不変のまま再利用）で
 * 面分類・「踊り場壁」相当の実壁検出を行う——SWITCHBACKの「往復間の壁」検出（findMidWall）と
 * 同じ「壁の中心線が特定の世界座標に近く、対象の幅方向スパンと重なる」パターンを、直進階段の
 * 「踊り場を横切る壁（entry/arrival壁と同じ向き）」へ転用する（findLandingWall。§6.2「(踊り場壁)」）。
 * @module
 */
import { StairType } from '@core';
import { roomBounds } from '../../../finish/gridCells.js';
import { makeFrame, MIN_LANDING } from '../../../finish/stair/stairGeometry.js';
import { measureStairSpans } from '../../../finish/stair/stairClassify.js';
import { classifyFaces, buildMidWallFace, reorientFace } from './switchbackCuts.js';
import { graphList } from '../../../graphReadScope.js';

// findLandingWall（本ファイル）の許容差(mm)。findMidWall（switchbackCuts.js）と同じ考え方
// （壁厚程度の許容差）で、値も揃えている。
const LANDING_WALL_TOL_MM = 300;
const DEFAULT_TREAD_MM = 250; // resolveSwitchbackParams（elevationStairSection.js）と同じ既定値

/**
 * 直進階段（STRAIGHT/STRAIGHT_LANDING）の断面計算パラメータを単一ソース化する
 * （resolveSwitchbackParams・elevationStairSection.jsと対になる、直進版）。
 * STRAIGHT: 踊り場なし・単一区間（n1=totalSteps）。
 * STRAIGHT_LANDING: measureStairSpans（実測優先）→sections未指定時は均等2分＋tread合成の
 * フォールバック（resolveSwitchbackParamsと同じ規約）。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number} floorHeight
 * @returns {{totalSteps:number, riser:number, n1:number, n2:number, len1:number,
 *   landingLen:number, len2:number, hasLanding:boolean}}
 */
function resolveStraightParams(stair, graph, floorHeight) {
  const totalSteps = Math.max(2, stair.totalSteps ?? 2);
  const riser = stair.riser ?? floorHeight / totalSteps;
  const tread = stair.tread > 0 ? stair.tread : DEFAULT_TREAD_MM;

  if (stair.type === StairType.STRAIGHT) {
    const len1 = tread * Math.max(1, totalSteps - 1);
    return { totalSteps, riser, n1: totalSteps, n2: 0, len1, landingLen: 0, len2: 0, hasLanding: false };
  }

  const sections = Array.isArray(stair.sections) && stair.sections.length === 3 ? stair.sections : null;
  const n1 = sections ? Math.max(1, sections[0]) : Math.round(totalSteps / 2);
  const n2 = sections ? Math.max(1, sections[2]) : totalSteps - n1;
  const spans = measureStairSpans(stair, graph);
  // landingLen既定値はresolveSwitchbackParams（elevationStairSection.js）と同じ式
  // （Math.max(4*tread, MIN_LANDING)）で揃える。
  const [len1, landingLen, len2] = spans?.lengths ?? [
    tread * Math.max(1, n1 - 1), Math.max(4 * tread, MIN_LANDING), tread * Math.max(1, n2 - 1),
  ];
  return { totalSteps, riser, n1, n2, len1, landingLen, len2, hasLanding: true };
}

/**
 * wEntry/wLandingと同じ向き（走行方向を横切る）の実壁で、worldValue（走行方向の世界座標）に
 * 近く、幅方向スパン[acrossLo,acrossHi]と重なるものを返す（findMidWallの転用。§6.2「踊り場壁」）。
 * 該当なし（多くの実際の直進+踊り場階段はここに壁を持たない——踊り場は単なる平坦部）はnull。
 * @returns {import('@core').Wall|null}
 */
function findLandingWall(wallGraph, wEntry, worldValue, acrossLo, acrossHi) {
  if (!wEntry || !wallGraph) return null;
  for (const w of graphList(wallGraph, 'walls') ?? []) {
    if (w.isVertical !== wEntry.isVertical) continue;
    if (Math.abs(w.axisCL.effectiveValue - worldValue) > LANDING_WALL_TOL_MM) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (wHi <= acrossLo || wLo >= acrossHi) continue;
    return w;
  }
  return null;
}

/**
 * 直進階段（STRAIGHT/STRAIGHT_LANDING）の切断定義表（§6.2）を組み立てる。対象外タイプ
 * （SWITCHBACK/WINDING/L_TURN/FLARED/OPEN_WELL）・stair.cellsが空・floorHeight未確定・
 * 面分類が解決できない場合はnull（switchbackCutsと同じフォールバック契約）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, upperGraph?:object}} opts
 * @returns {{cuts:object[], wEntry:object, wLanding:object, wOut1:object, wOut2:object,
 *   params:object, contribution:object}|null}
 */
export function straightCuts(stair, faces, graph, opts = {}) {
  if (!stair) return null;
  if (stair.type !== StairType.STRAIGHT && stair.type !== StairType.STRAIGHT_LANDING) return null;
  if (!stair.cells || stair.cells.size === 0) return null;
  const floorHeight = opts.floorHeight;
  if (floorHeight == null) return null;

  const params = resolveStraightParams(stair, graph, floorHeight);
  const { totalSteps, riser, hasLanding, n1, n2, len1, landingLen, len2 } = params;

  const b = roomBounds(stair.cells, graph);
  const f = makeFrame(stair, b);
  const rawFaces = classifyFaces(faces, f);
  if (!rawFaces.wEntry || !rawFaces.wLanding || !rawFaces.wOut1 || !rawFaces.wOut2) return null;

  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  if (opts.upperGraph) layers.push({ graph: opts.upperGraph, floorZMm: floorHeight, role: 'above' });
  const zRange = { loZ: 0, hiZ: opts.chUpperAbsMm };

  // acrossCoordAt/travelCoordAt: switchbackCuts.jsと同じ導出（W(t,s)座標系から独立に再導出）。
  const acrossCoordAt = s => { const p = f.pt(0, s); return f.vertical ? p.x : p.y; };
  const travelCoordAt = t => { const p = f.pt(t, 0.5); return f.vertical ? p.y : p.x; };
  const midAcross = acrossCoordAt(0.5);
  const acrossLo = Math.min(acrossCoordAt(0), acrossCoordAt(1));
  const acrossHi = Math.max(acrossCoordAt(0), acrossCoordAt(1));

  // QA実機フィードバック修正（switchbackCuts.jsと同根の不具合）: dirSignは部屋のコンパス向き
  // （wEntry.dirSign等・letterOf基準）ではなく、階段自身の歩行方向（幅方向=s=0→s=1、
  // 走行方向=上り口(t=0)→到達端(t=1)）が「ローカルx昇順」になるよう独立に導出する
  // （reorientFace。switchbackCuts.js冒頭のコメント参照）。直進階段はseq4もseq2と同じ向き
  // （視線が折り返さないため。§6.2）——wOut2もwOut1と同じseq2DirSignへ正規化する
  // （switchbackCutsの鏡像とは異なる点に注意）。
  const widthDirSign = Math.sign(acrossCoordAt(1) - acrossCoordAt(0)) || 1;
  const seq2DirSign = Math.sign(travelCoordAt(1) - travelCoordAt(0)) || 1;
  const wEntry   = reorientFace(rawFaces.wEntry, widthDirSign);
  const wLanding = reorientFace(rawFaces.wLanding, widthDirSign);
  const wOut1    = reorientFace(rawFaces.wOut1, seq2DirSign);
  const wOut2    = reorientFace(rawFaces.wOut2, seq2DirSign);

  // ---- 第3層（Flight/Landing。sectionStair.jsの型と同じ形。§5.7・§6.2）----
  // 直進階段は往路・復路が並走しないため、switchbackCuts.jsのような「同じ世界run区間を
  // 逆向きに歩く」補正が不要——各区間は世界座標でも重複しない単純な区分線形になる。
  let contribution, landingWorld = null;
  if (hasLanding) {
    const totalLen = len1 + landingLen + len2;
    const tRun1 = len1 / totalLen, tRun2 = (len1 + landingLen) / totalLen;
    const coordAt0 = travelCoordAt(0), coordAtRun1 = travelCoordAt(tRun1),
      coordAtRun2 = travelCoordAt(tRun2), coordAt1 = travelCoordAt(1);
    const landingZ = n1 * riser;
    const flight1 = {
      isVertical: f.vertical, runLo: Math.min(coordAt0, coordAtRun1), runHi: Math.max(coordAt0, coordAtRun1),
      travelSign: coordAtRun1 >= coordAt0 ? 1 : -1, acrossLo, acrossHi,
      baseZ: 0, riserMm: riser, steps: n1, lengthMm: len1,
    };
    const landing = {
      runLo: Math.min(coordAtRun1, coordAtRun2), runHi: Math.max(coordAtRun1, coordAtRun2),
      acrossLo, acrossHi, z: landingZ,
    };
    const flight2 = {
      isVertical: f.vertical, runLo: Math.min(coordAtRun2, coordAt1), runHi: Math.max(coordAtRun2, coordAt1),
      travelSign: coordAt1 >= coordAtRun2 ? 1 : -1, acrossLo, acrossHi,
      baseZ: landingZ, riserMm: riser, steps: n2, lengthMm: len2,
    };
    contribution = { flights: [flight1, flight2], landings: [landing], structure: stair.structure ?? null };
    landingWorld = coordAtRun1;
  } else {
    const coordAt0 = travelCoordAt(0), coordAt1 = travelCoordAt(1);
    const flight = {
      isVertical: f.vertical, runLo: Math.min(coordAt0, coordAt1), runHi: Math.max(coordAt0, coordAt1),
      travelSign: coordAt1 >= coordAt0 ? 1 : -1, acrossLo, acrossHi,
      baseZ: 0, riserMm: riser, steps: totalSteps, lengthMm: len1,
    };
    contribution = { flights: [flight], landings: [], structure: stair.structure ?? null };
  }

  // ---- seq1/到達端（全幅。§6.2表）----
  const seq1Line = { isVertical: wEntry.isVertical, axisValue: travelCoordAt(0), lo: wEntry.lo, hi: wEntry.hi };
  const seq1ViewSign = Math.sign(travelCoordAt(1) - travelCoordAt(0)) || 1; // 奥向き(+t)
  const arrivalLine = { isVertical: wLanding.isVertical, axisValue: travelCoordAt(1), lo: wLanding.lo, hi: wLanding.hi };

  // ---- seq2/4（レーン全長。s=0.5。§6.2表）----
  const laneLine = { isVertical: wOut1.isVertical, axisValue: midAcross, lo: wOut1.lo, hi: wOut1.hi };
  const seq2ViewSign = -(Math.sign(acrossCoordAt(0) - midAcross) || 1); // s=0側
  const seq4ViewSign = Math.sign(acrossCoordAt(1) - midAcross) || 1;    // s=1側
  // seq2DirSignは上でreorientFace用に導出済み（wOut1/wOut2は既にその向きへ再正規化されている
  // ため、wOut1.dirSign===wOut2.dirSign===seq2DirSignが構築上常に成り立つ）。

  const cuts = [
    {
      seqNo: '1', face: wEntry, line: seq1Line, viewSign: seq1ViewSign, dirSign: wEntry.dirSign,
      layers, zRange, baseFloorZ: 0, stairCut: contribution,
    },
    {
      seqNo: '2', face: wOut1, line: laneLine, viewSign: seq2ViewSign, dirSign: seq2DirSign,
      layers, zRange, baseFloorZ: 0, stairCut: contribution,
    },
  ];

  if (hasLanding) {
    // 踊り場壁（seq3。§6.2「STRAIGHT_LANDINGはseq[1,2,3(踊り場壁),4,5]」）: 実壁が見つかった
    // 場合のみ挿入する（多くの実際の踊り場は単なる平坦部で壁を持たないため。switchbackCutsの
    // seq2.5/4.5と同じ「wallがあれば挿入」パターン）。見つからなければ3項目のまま
    // （視線は折り返さないため全て同方向＝seq4/5のdirSignはseq2と同一のまま変わらない）。
    const wallGraph = opts.upperGraph ?? graph; // 往復間の壁と同じ探索対象層規約（switchbackCuts.js参照）
    const landingWall = findLandingWall(wallGraph, wEntry, landingWorld, acrossLo, acrossHi);
    if (landingWall) {
      const landingFace = reorientFace(buildMidWallFace(landingWall, wEntry.inward, acrossLo, acrossHi, faces), widthDirSign);
      const seq3Line = { isVertical: wEntry.isVertical, axisValue: landingWorld, lo: wEntry.lo, hi: wEntry.hi };
      const seq3ViewSign = Math.sign(travelCoordAt(0) - landingWorld) || 1; // 見返り(−t)
      cuts.push({
        seqNo: '3', face: landingFace, line: seq3Line, viewSign: seq3ViewSign, dirSign: wEntry.dirSign,
        layers, zRange, baseFloorZ: n1 * riser, stairCut: null,
      });
    }
    cuts.push({
      seqNo: '4', face: wOut2, line: laneLine, viewSign: seq4ViewSign, dirSign: seq2DirSign,
      layers, zRange, baseFloorZ: 0, stairCut: contribution,
    });
    cuts.push({
      seqNo: '5', face: wLanding, line: arrivalLine, viewSign: seq1ViewSign, dirSign: wLanding.dirSign,
      layers, zRange, baseFloorZ: floorHeight, stairCut: null,
    });
  } else {
    cuts.push({
      seqNo: '3', face: wLanding, line: arrivalLine, viewSign: seq1ViewSign, dirSign: wLanding.dirSign,
      layers, zRange, baseFloorZ: floorHeight, stairCut: null,
    });
    cuts.push({
      seqNo: '4', face: wOut2, line: laneLine, viewSign: seq4ViewSign, dirSign: seq2DirSign,
      layers, zRange, baseFloorZ: 0, stairCut: contribution,
    });
  }

  return { cuts, wEntry, wLanding, wOut1, wOut2, params, contribution };
}
