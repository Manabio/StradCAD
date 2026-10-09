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
 * 階段の走行方向の位置（上り口辺・踊り場の縁・到達端・側面の口の区画の出口）と段数・区画のセルは、平面の解決値
 * （sectionStair.js straightContribution ← straightPlanLayout。設置階の install 枠）だけから取る。旧実装の
 * 通り芯の枠（roomBounds＋makeFrame の t 比率）と measureStairSpans の区間長 len1/landingLen/len2 からの再計算は
 * 平面の踏面線と食い違うので持たない（.claude/elevation-model.md）。roomBounds＋makeFrame は**面の分類**
 * （classifyFaces。switchbackCuts.js と同じ）にだけ使う。
 * seq1（上り口の壁）は上り口辺 base（install 枠の基端＝壁仕上げ面）に立つ。側面の上り口でも base のまま
 * （区画は seq2/4 のレーン線で切れる。問題.md Q4 の推奨・ユーザー裁定待ち）。到達端の面（seq3/seq5）は end。
 *
 * classifyFaces/buildMidWallFace（switchbackCuts.jsからexport済み。挙動不変のまま再利用）で
 * 面分類・「踊り場壁」相当の実壁検出を行う——SWITCHBACKの「往復間の壁」検出（findMidWall）と
 * 同じ「壁の中心線が特定の世界座標に近く、対象の幅方向スパンと重なる」パターンを、直進階段の
 * 「踊り場を横切る壁（entry/arrival壁と同じ向き）」へ転用する（findLandingWall。§6.2「(踊り場壁)」）。
 * @module
 */
import { StairType } from '@core';
import { roomBounds } from '../../../finish/gridCells.js';
import { makeFrame } from '../../../finish/stair/stairGeometry.js';
import { classifyFaces, buildMidWallFace, reorientFace } from './switchbackCuts.js';
import { straightContribution } from '../sectionStair.js';
import { perpFaceAt } from '../../elevationFaces.js';
import { graphList } from '../../../graphReadScope.js';

// findLandingWall（本ファイル）の許容差(mm)。findMidWall（switchbackCuts.js）と同じ考え方
// （壁厚程度の許容差）で、値も揃えている。
const LANDING_WALL_TOL_MM = 300;

/**
 * wEntry/wLandingと同じ向き（走行方向を横切る）の実壁で、worldValue（走行方向の世界座標。平面の踊り場の手前の縁 land1）に
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
 * 平面の枠が求まらない・面分類が解決できない場合はnull（switchbackCutsと同じフォールバック契約）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, upperGraph?:object, layers:object[]}} opts
 *   layers … 呼び出し側（elevationStair.jsのbuildStairBand）が`buildBandLayers`で1度組んだ層。
 *   **必須**（QA指摘F5: 本番はbuildStairBandが必ず渡すため、opts.upperGraphから作り直す
 *   「第2の入口」は本番に到達しない死コードだった）。配列でなければ既存の失敗系規約
 *   （対象外条件はnullを返す）にならい、他の未確定条件と同じくnullを返す。
 * @returns {{cuts:object[], wEntry:object, wLanding:object, wOut1:object, wOut2:object,
 *   params:object, contribution:object}|null}
 */
export function straightCuts(stair, faces, graph, opts = {}) {
  if (!stair) return null;
  if (stair.type !== StairType.STRAIGHT && stair.type !== StairType.STRAIGHT_LANDING) return null;
  if (!stair.cells || stair.cells.size === 0) return null;
  const floorHeight = opts.floorHeight;
  if (floorHeight == null) return null;

  // 階段の3D寄与。走行方向の位置・段数・側面の口の区画は平面の解決値（straightContribution が straightPlanLayout から取る）
  const contribution = straightContribution(stair, graph, floorHeight);
  if (!contribution) return null; // 平面の枠が求まらない・区画のセルが番号から拾えない
  const { frame, across, hasLanding, riser, n1 } = contribution;
  const params = { riser, n1, n2: contribution.n2, hasLanding };

  // 面の分類だけは通り芯の枠（実壁・部屋の面のスナップ元）。階段の位置には使わない
  const f = makeFrame(stair, roomBounds(stair.cells, graph));
  const rawFaces = classifyFaces(faces, f);
  if (!rawFaces.wEntry || !rawFaces.wLanding || !rawFaces.wOut1 || !rawFaces.wOut2) return null;

  if (!Array.isArray(opts.layers)) return null; // QA指摘F5: opts.layersは必須（本番は必ず渡す）
  const layers = opts.layers;
  const zRange = { loZ: 0, hiZ: opts.chUpperAbsMm };

  // 幅方向・走行方向の世界座標は平面の解決値（install 枠）。switchbackCuts.jsと同じ導出の意図（W(t,s)座標系から独立）。
  const midAcross = across.mid;
  const acrossLo = Math.min(across.s0, across.s1);
  const acrossHi = Math.max(across.s0, across.s1);

  // QA実機フィードバック修正（switchbackCuts.jsと同根の不具合）: dirSignは部屋のコンパス向き
  // （wEntry.dirSign等・letterOf基準）ではなく、階段自身の歩行方向（幅方向=s=0→s=1、
  // 走行方向=上り口(base)→到達端(end)）が「ローカルx昇順」になるよう独立に導出する
  // （reorientFace。switchbackCuts.js冒頭のコメント参照）。直進階段はseq4もseq2と同じ向き
  // （視線が折り返さないため。§6.2）——wOut2もwOut1と同じseq2DirSignへ正規化する
  // （switchbackCutsの鏡像とは異なる点に注意）。
  const widthDirSign = Math.sign(across.s1 - across.s0) || 1;
  const seq2DirSign = Math.sign(frame.end - frame.base) || 1;
  const wEntry   = reorientFace(rawFaces.wEntry, widthDirSign);
  const wLanding = reorientFace(rawFaces.wLanding, widthDirSign);
  const wOut1    = reorientFace(rawFaces.wOut1, seq2DirSign);
  const wOut2    = reorientFace(rawFaces.wOut2, seq2DirSign);

  // 切断線の両端（lo/hi）は figure 側（sectionFace.js faceFromCut）が直交壁の面へ寄せる値と同じにする（不変条件: 枠がずれると
  // content が面に対して平行移動する）。出入口が側面の直進では、その側の壁が途切れて隅に直交壁が無く、classifyFaces の面は
  // 通り芯の位置（壁厚/2 ぶん外）のままなのに faceFromCut は直交する面の仕上げ面へ寄せる。壁が揃っていれば寄せ済みの値で不変。
  const lineOf = (face, axisValue) => {
    const a = perpFaceAt(faces, face.isVertical, axisValue, face.lo), b = perpFaceAt(faces, face.isVertical, axisValue, face.hi);
    const lo = a ? a.faceValue : face.lo, hi = b ? b.faceValue : face.hi;
    return { isVertical: face.isVertical, axisValue, lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  };

  // ---- seq1/到達端（全幅。§6.2表）----
  // seq1 は上り口辺 base（側面の上り口でも base。区画は seq2/4 のレーン線で切れる）、到達端の面は end。
  const seq1Line = lineOf(wEntry, frame.base);
  const seq1ViewSign = seq2DirSign; // 奥向き(+t)
  const arrivalLine = lineOf(wLanding, frame.end);

  // ---- seq2/4（レーン全長。s=0.5。§6.2表）----
  const laneLine = lineOf(wOut1, midAcross);
  const seq2ViewSign = -(Math.sign(across.s0 - midAcross) || 1); // s=0側
  const seq4ViewSign = Math.sign(across.s1 - midAcross) || 1;    // s=1側
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
    // 旧switchbackのseq2.5/4.5（廃止）と同じ「wallがあれば挿入」パターン）。見つからなければ3項目のまま
    // （視線は折り返さないため全て同方向＝seq4/5のdirSignはseq2と同一のまま変わらない）。
    // 探索の中心・切断線は平面の踊り場の手前の縁 land1（frame 由来）。
    const wallGraph = opts.upperGraph ?? graph; // 往復間の壁と同じ探索対象層規約（switchbackCuts.js参照）
    const landingWall = findLandingWall(wallGraph, wEntry, frame.land1, acrossLo, acrossHi);
    if (landingWall) {
      const landingFace = reorientFace(buildMidWallFace(landingWall, wEntry.inward, acrossLo, acrossHi, faces), widthDirSign);
      const seq3Line = lineOf(wEntry, frame.land1);
      const seq3ViewSign = Math.sign(frame.base - frame.land1) || 1; // 見返り(−t)
      cuts.push({
        seqNo: '3', face: landingFace, line: seq3Line, viewSign: seq3ViewSign, dirSign: wEntry.dirSign,
        layers, zRange, baseFloorZ: contribution.landings[0].z, stairCut: null,
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
