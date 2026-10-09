/**
 * 2.5D断面エンジン: stairContribution / stairPrimitivesForCut（第3層。WP-E3→WP-E5bで統合）。
 * 設計意図はarchitect承認済みの実装指示書§4末尾参照。elevationStairSequence.js（switchbackCuts.js
 * 経由でcut.stairCutとして渡された値を消費）から呼ばれる。
 *
 * 既存部品を転用する（§5.7）: stairRunProfile・stringerPrimitives（elevationStairSection.js。
 * 挙動不変のまま呼ぶ）・resolveUTurnSectionParams（蹴上高の供給源）・uTurnPlanLayout
 * （finish/stair/stairGeometry.js。平面の枠。flip/upDirection吸収済み）。梯子（正面視の水平線）は
 * treadLadderLinesを使わずemitLine経由で組み立てる（§5.6最終フィルタ・baseFloorZ以下の
 * 明示的な破線指定を両立させるため。WP-E5b）。対象はU字系（SWITCHBACK/WINDING。
 * resolveUTurnSectionParamsがU字系以外null）。
 *
 * h(t)は関数で持たず区分線形のFlight[]で表す（設計書§4のコメントどおり。既存部品の前提形）。
 * stairContributionの往路・復路・踊り場の走行方向の位置は、平面の解決値（uTurnPlanLayout。設置階の
 * install 枠）から取る（旧実装は CL 区間長 len1/len2 から makeFrame の t 軸で再計算しており、平面の線と
 * 一定量ずれていた）。runLengthMmは実測flight.lengthMmを単一情報源にする。
 * ASSUMED（設計書に明記が無いため以下の解釈を採用。§9のとおり階段fixture経由の単体テストで
 * 直接検証する）:
 *   - 「レーン縦断」（cut.lineが往路・復路レーンの伸びる方向と同じ向きで、かつそのレーン幅の
 *     内側を通る）→ 段鼻のジグザグ（SILHOUETTE polyline。stairRunProfile）。
 *   - 「横切る」（cut.lineがレーンと直交し、cut.axisValueがそのレーンのrun範囲内）→
 *     正面視の梯子（DETAIL。steps=そのレーンの全段数。位置に応じた部分段数ではなく全段——
 *     seq1「往路=正面梯子(下)／復路=正面梯子(上)」と同じ、レーン全体を正面から見る構図）。
 *   - 踊り場も同じレーン縦断条件（往路・復路と同じrun範囲・全幅）でCUT水平線1本。
 *   - ささら（STEEL限定。鉄骨階段の「ささら桁」——出典:
 *     http://kentiku-kouzou.jp/struc-sasara.html）: 段部はささらの横に付く（横付け）のが一般的
 *     という記載どおり、段部（ジグザグ）はささらに隠れるものとして側面視では描かない。
 *     レーン縦断（側面視）は生成したジグザグ点列ごとにstringerPrimitives（DETAIL＝見えがかりの
 *     細線）を適用し、ジグザグ本体は描かない。レーンを横切る（正面視）はflightStringerFrontPrimitives
 *     で12mm厚×せい300mmの矩形断面をCUT（太線）で描く——ユーザー指示「ささらの見えかがりは
 *     細線、断面は太線」対応。
 *   - WP-E5b: どの切断（seqNo）がどちらのレーン(flight)を描くかは、cut.line/viewSign/dirSignの
 *     幾何だけからは（seq2/2.5とseq4/4.5/5が同一のレーン境界線を共有するため）一意に決まらない
 *     ——switchbackCuts.js側がcut.stairCutへ渡すcontributionをflights=[outbound]/[inbound]の
 *     いずれかへ事前に絞り込むことで解決する（本ファイル側のisLengthwiseCut/flightLadder等の
 *     判定ロジックは変更していない）。
 *
 * WP-A2（1層1ユニット化。architect承認済み実装指示書§3）: stairContributionの返り値に
 * unit（StairUnit。板厚・桁成・アンカー高さの単一情報源）とlanding.frame.edges（踊り場矩形の
 * 外周4辺。front=レーンに接する側／back=反対／side=走行軸に平行な残り2辺）を追加した。
 * ユーザー裁定2026-08-23: 踊り場桁枠のせい(landingFrameDepthMm)は250ではなく300（ささらと
 * 同値。elevationStairSection.jsのSTEEL_LANDING_FRAME_DEPTH_MM）。生成対象もSTEEL限定から
 * STEEL・RC（hasLandingFrame）へ拡張——ささら本体（isSteel限定）は変更しない。
 * ASSUMED（設計書に明記が無いため以下の解釈を採用。stairLanding.test.js/sectionStair.test.jsの
 * 意味論アサーションで直接検証する）:
 *   - landing.frame.edgesの前後判定は finish/stair/stairLanding.js の landingEdgeCLs と同じ
 *     frontIsLo（踊り場開始位置=coordAtRunがrunLo側に来ているか）を再利用する——CL id版
 *     （stairLanding.js。WP-B2の踊り場受け梁向け）と世界座標版（本ファイル。展開図の作図向け）は
 *     同じ幾何判定を2箇所で独立に持つ（互いに依存しない別レイヤの別消費者のため）。
 *   - landingFramePrimitives: 各辺は「cutの見る向き」に応じてbroadside（辺の長さ方向を正面から
 *     見る＝せいlandingFrameDepthMmの帯。DETAIL）かend-on（辺を真上から見下ろす＝12mm厚×
 *     landingFrameDepthMmの断面矩形。CUT）のいずれかで描かれる——flightのisLengthwiseCut/
 *     crossesFlightと同じ「cut.line.isVertical が entityIsVertical と一致=lengthwise、
 *     不一致=crosses」の一般規則を踊り場全体（landing.runLo/runHi・acrossLo/acrossHi）に対して
 *     適用し、lengthwise側でside辺=broadside・front/back辺=end-on、crosses側でfront/back辺=
 *     broadside・side辺=end-onに割り当てる（§3.2表の物理的な意味：走行軸に平行な辺は側面視で
 *     長手が見え、走行軸に直交する辺は正面視で長手が見える）。side辺のbroadsideは上端
 *     （踊り場床線）をlandingCutPrimitivesが既に描画済みのため重複させず、下端水平線＋両端縦線
 *     のみ追加する。front/back辺のbroadsideは上端・下端の帯輪郭2線のみ（端の縦線は踊り場床CUT
 *     線と同様、視覚的な閉じた輪郭までは持たせない——floor CUT線と同じ「柱状範囲を覆えば足りる」
 *     という既存方針を踏襲）。
 *   - clipStringerToAnchors: ジグザグ点列（stairRunProfileの出力）の最初・最後の点のyだけを
 *     flight.baseZ・flight.baseZ+steps×riserMmへ強制的に揃え、それ以外の点もこの範囲へ
 *     クランプする（「水平カット」＝z方向の範囲外を許さない、という設計書§8 AMBIGUITY Fの
 *     文言をそのまま実装したもの）。現行のstairRunProfileは既にこの範囲ちょうどで始まり・
 *     終わるよう構築されているため、既存フィクスチャでの見た目は変化しない（挙動不変）——
 *     本関数はstairRunProfile側の実装詳細に依存せず「ささらの点列は必ずFLで水平に終わる」
 *     という契約を明示的・独立にテスト可能にする防御的な実装であり、追加で必要という
 *     stringerPrimitives側のオフセット（せいdepthMm下げた輪郭が端部でFLを越えて突き出す
 *     可能性）そのものの補正は行わない（対症療法の範囲がstairRunProfileの入力点列に限られる
 *     ことをASSUMEDとして明記。設計書の文言レベルでは対応済みだが、視覚的な突き出し自体の
 *     解消は別途defer）。
 */
import { StairType, StructuralMaterialType, DEFAULT_BASEBOARD_HEIGHT } from '@core';
import { uTurnPlanLayout, straightPlanLayout, LANE_GAP } from '../../finish/stair/stairGeometry.js';
import { U_TURN_TYPES } from '../../finish/stair/stairPorts.js';
import { sliceTurnCells } from './turnCellSlices.js';
import { stairTreadFootprints } from '../../finish/stair/stairTreads.js';
import {
  resolveUTurnSectionParams, stairRunProfile, stringerPrimitives, stringerBandGeometry, WOOD_TREAD_THICKNESS_MM,
  STEEL_STRINGER_DEPTH_MM, STEEL_STRINGER_THICKNESS_MM, STEEL_LANDING_FRAME_DEPTH_MM,
} from '../elevationStairSection.js';
import { ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { parseBaseboardHeightMm } from '../elevationFigure.js';
import { localXOf, cutDrawRange, solidRectsOf, rectsToFaceLocal } from './sectionTypes.js';
import { emitLine, isStringer } from './sectionEmit.js';
import { mergeFloorProfiles } from '../elevationFloorProfile.js';
import { clipPrimitivesToXRange, subtractRectsFromPrimitives } from '../elevationPrimitives.js';

/**
 * 切断線(axisValue)が flight・踊り場の走行範囲の端にあるとき「境界上は両側を含む」ための走行方向の許容幅(mm)。
 * seq1 は往路側の前縁 frontA(往路 flight の端・延長矩形の始まり・柱の面)に置くので、sub-micron の誤差
 * （GAP_EPS=1e-6）で含む/含まないが反転しないようにする。±1e-3 のずれで出力が変わらないことをテストで固定している。
 */
export const STAIR_RUN_TOL_MM = 0.5;

/**
 * @typedef {{isVertical:boolean, runLo:number, runHi:number, travelSign:1|-1,
 *   acrossLo:number, acrossHi:number, baseZ:number, riserMm:number, steps:number,
 *   lengthMm:number, underSteps?:number, overSteps?:number, entryRunMm?:number}} Flight
 *   直進部だけ（側面の口に取りつく区画〔上り口 e 段・到達口 a 段〕は含まない。区画は zoneCells を切断線で切った Landing）。
 *   entryRunMm は直進系の往路だけ（上り口が側面のとき、基端から flight の始端までの走行長。crossesFlight が基端側へ広げる）。
 *   overSteps は最後の flight だけ（到達口の区画の段数 a）。underSteps と対称で、正面視の梯子の上端（上階の床の段鼻）まで本数を足す（幾何は持たない）。
 *   underSteps は往路だけ（上り口の区画の段数 e）。区画の段は直進部の足元の下に続くので、レーンを正面から見る見付け（梯子・遮蔽矩形・
 *   ささら端面）と、flight より手前の走行座標の高さ（flightNoseZAt）だけが使う。幾何（走行方向の位置・段鼻列）は一切持たない。
 * @typedef {{isVertical:boolean, axisWorld:number, spanLo:number, spanHi:number,
 *   kind:'front'|'back'|'side'}} LandingFrameEdge
 * @typedef {{runLo:number, runHi:number, acrossLo:number, acrossHi:number, z:number,
 *   frame:{edges:LandingFrameEdge[]}, isVertical?:boolean, turnStep?:number,
 *   edgeRiser?:{run:number, outerZ:number}}} Landing
 *   isVertical/turnStep は平面のセルを切ったスライス（WINDING の回転部・側面の口の取りつき区画）だけが持つ（走行軸の向き・
 *   段数字。桁枠 edges は空）。edgeRiser は区画の外縁（上り口辺 baseA・到達辺 baseB）に接するスライスだけが持つ、外側の高さ
 *   outerZ との段差（縦線 1 本。landingStepRisers が描く）。
 * @typedef {{structure:string|null, stringerThicknessMm:number, stringerDepthMm:number,
 *   landingFrameDepthMm:number, baseboardHeightMm:number, anchorZs:number[]}} StairUnit
 */

/**
 * 階段（U字系＝SWITCHBACK/WINDING）の3D寄与を、タイプ非依存の区分線形モデル（Flight[]・Landing[]）で返す。
 * WINDING は回転部を平面の段の多角形（turnCells）で持ち、切断線ごとに段付きの踊り場（Landing。turnCellSlices.js）へ切り、復路の
 * baseZ は回転部の最後の段の高さ（折返しは踊り場1枚で従来どおり）。
 * U字系以外・floorHeight未確定・stair.cellsから設置枠が求まらない場合はnull
 * （resolveUTurnSectionParamsとuTurnPlanLayoutのnull契約をそのまま延長）。
 * 走行方向の位置（往路・復路の端、踊り場の前縁・奥）は平面の解決値 uTurnPlanLayout だけから取り、
 * CL 区間長から再計算しない（平面の線と展開図の蹴上を一致させる。elevation-model.md）。
 * isVertical=走行軸の向き、frame={frontA,front,back}=往路側の前縁・復路側の前縁・踊り場の奥（走行軸の世界座標）。
 * 側面の口に取りつく区間（上り口の区画 e 段・到達口の区画 a 段）も回転部と同じく平面のセル（stairTreadFootprints の install。
 * 番号は uTurnPlanLayout の entryNumbers/arrivalNumbers）を zoneCells として持ち、切断線ごとに withCutLandings が切る
 * （往路 flight は直進部 startA〜frontA の n1 段、復路 flight は front〜startB の n2 段）。取りつき段 0（平場）は矩形のセル
 * （上り口は z=0、到達口は上階の床の高さ）。出入口が走行端なら区画は無い。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {{flights:Flight[], landings:Landing[], structure:string|null, unit:StairUnit,
 *   isVertical:boolean, turnCellCount:number, turnCells:{poly:number[], z:number, number:number}[],
 *   zoneCells:{entry:{poly:number[], z:number, number:number}[], arrival:{poly:number[], z:number, number:number}[]},
 *   zoneEdge:{entry:{run:number, outerZ:number}|null, arrival:{run:number, outerZ:number}|null},
 *   forwardSign:1|-1, frame:{frontA:number, front:number, back:number}}|null}
 */
export function stairContribution(stair, graph, floorHeight) {
  if (!stair || !U_TURN_TYPES.has(stair.type)) return null;
  const params = resolveUTurnSectionParams(stair, graph, floorHeight);
  if (!params) return null;
  const { riser } = params;
  const isWinding = stair.type === StairType.WINDING;

  // 走行方向の位置は平面（設置階の install 枠）の解決値だけから取る（uTurnPlanLayout）。CL 区間長
  // （params.len1 等）から再計算しない——再計算すると隔て壁の柱・壁の仕上げ面に合わせた平面の線と
  // 展開図の蹴上が一定量ずれる（ユーザー裁定 2026-10-09「展開図の階段位置を平面に揃える」）。
  // 段数（n1/n2/e/w）も平面側の値、蹴上高 riser だけ従来どおり階高から（resolveUTurnSectionParams）。
  const layout = uTurnPlanLayout(stair, graph);
  if (!layout) return null;
  const { vertical, run, across, entryTurnSteps, arrivalTurnSteps, entryNumbers, arrivalNumbers, turnCells } = layout;
  const { n1, n2 } = layout;
  // 幅方向: 外縁は平面の値（壁の面）、内縁はレーン中央 s=0.5（across.mid）のまま。鉄骨のあき（LANE_GAP）は
  // 従来どおり ladderAcrossRange が梯子の幅から引く（ここで引くと二重になる）。
  // 往路(outbound)=s=0側、復路=s=1側（flip は makeFrame が吸収済みで across.s0/s1 の世界座標に出る）。
  const acrossMid = across.mid;

  // 段板の厚み: 木造階段（stair.structure===WOOD。展開が他でも分岐している単位）だけ30（在来木造の
  // 仕様。ユーザー指示2026-10-07）。鉄骨・RCは0＝従来の斜めの蹴上。
  const treadThicknessMm = stair.structure === StructuralMaterialType.WOOD ? WOOD_TREAD_THICKNESS_MM : 0;

  // 往路: 直進部の始端 startA（上り口が側面なら区画の出口 exitA。走行端なら上り口辺 baseA と同じ）〜往路側の前縁 frontA の n1 段。
  // 側面の上り口に取りつく区画（entryTurnSteps 段）の蹴上は往路の手前に積まれる（stairLanding.js landingZ と同じ規約）ので、
  // 直進部の足元は e×蹴上（区画の最後のセルの天端）。区画そのものは zoneCells.entry（下で作る）を切断線で切った Landing。
  // 踊り場が浅く柱の面が奥(back)を越えるときは前縁を back に揃える（前後が逆転して階段室の外へ出ないように。
  // 復路の始点・踊り場の矩形・frame が同じ揃えた値を使う）。
  const fwd = Math.sign(run.back - run.baseA) || 1;
  const clampFwd = v => ((v - run.back) * fwd > 0 ? run.back : v);
  const frontC = clampFwd(run.front), frontAC = clampFwd(run.frontA);
  // 隔て板の柱があるとき、段板の断面(CUT)の内縁は梯子のレーン中央ではなく隔て板の面（往路 sA・復路 sB）で止める
  const treadAcross = (a, b) => (layout.hasColumn ? { treadAcrossLo: Math.min(a, b), treadAcrossHi: Math.max(a, b) } : {});
  const outbound = {
    isVertical: vertical,
    runLo: Math.min(run.startA, run.frontA), runHi: Math.max(run.startA, run.frontA),
    travelSign: run.frontA >= run.startA ? 1 : -1,
    acrossLo: Math.min(across.s0, acrossMid), acrossHi: Math.max(across.s0, acrossMid),
    baseZ: entryTurnSteps * riser, riserMm: riser, steps: n1, lengthMm: Math.abs(run.frontA - run.startA),
    nosingMm: stair.nosing ?? 0, treadThicknessMm,
    ...(entryTurnSteps > 0 ? { underSteps: entryTurnSteps } : {}),
    ...treadAcross(across.s0, across.sA),
  };
  const landingZ = (n1 + entryTurnSteps) * riser;
  // 復路: 復路側の前縁 front から直進部の終端 startB（到達側。到達口が側面なら区画の出口）へ、往路と逆向きに歩く。
  // 到達口の区画（arrivalTurnSteps 段）は zoneCells.arrival を切断線で切った Landing。
  const inbound = {
    isVertical: vertical,
    runLo: Math.min(frontC, run.startB), runHi: Math.max(frontC, run.startB),
    travelSign: run.startB >= frontC ? 1 : -1,
    acrossLo: Math.min(across.s1, acrossMid), acrossHi: Math.max(across.s1, acrossMid),
    // 復路の足元＝回転部の最後の段の高さ。折返し（turnCells=1）は踊り場の高さそのもの。
    baseZ: landingZ + (turnCells - 1) * riser, riserMm: riser, steps: n2, lengthMm: Math.abs(run.startB - frontC),
    nosingMm: stair.nosing ?? 0, treadThicknessMm,
    ...(arrivalTurnSteps > 0 ? { overSteps: arrivalTurnSteps } : {}),
    ...treadAcross(across.sB, across.s1),
  };

  // 踊り場（回転部）の世界矩形。走行方向は front〜back・幅方向は全幅 s0〜s1（壁の面）。
  // 往路側の前縁が復路側より手前（frontA≠front。木造の隔て板の柱）なら、往路側だけ frontA〜front の
  // 延長矩形を同じ高さで足す（桁枠は持たない）。
  const landing = {
    runLo: Math.min(frontC, run.back), runHi: Math.max(frontC, run.back),
    acrossLo: Math.min(across.s0, across.s1), acrossHi: Math.max(across.s0, across.s1), z: landingZ,
  };
  // WP-A2: frontIsLo（踊り場開始位置=front が runLo 側か）は stairLanding.js の landingEdgeCLs と同じ判定の意味。
  const frontIsLo = frontC <= run.back;
  landing.frame = { edges: landingFrameEdges(landing, vertical, frontIsLo) };
  // 平面の段の多角形（stairTreadFootprints の install。回転部・側面の口の取りつき区画で共有。1 回だけ呼ぶ）
  const footprints = isWinding || entryNumbers || arrivalNumbers
    ? stairTreadFootprints(stair, graph, { riser, insetView: 'install' }) : [];
  // 取りつき区画のセル（上り口 e 個・到達口 a 個）と平場（段 0）の矩形、区画の外縁。番号の範囲は uTurnPlanLayout が供給する。
  // 区画の外縁（上り口辺 baseA・到達辺 baseB）の外側の高さは、上り口の外が床（0）、到達口の外が上階の床。
  // 既知の別件: 両口とも側面＋隔て板の柱がある構成で、平面の上り口セルと到達口セルが x 1000..1057.5 で重なる（平面側の既存挙動、T1 では直さない）。
  const topFloorZ = layout.totalSteps * riser;
  const zones = portZoneCells(footprints, vertical, topFloorZ, layout.totalSteps, {
    entry: { numbers: entryNumbers, steps: entryTurnSteps, on: layout.entryPort !== 'end', rect: [run.baseA, run.exitA, across.s0, across.sA], edgeRun: run.baseA },
    arrival: { numbers: arrivalNumbers, steps: arrivalTurnSteps, on: layout.arrivalPort !== 'end', rect: [run.startB, run.baseB, across.sB, across.s1], edgeRun: run.baseB },
  });
  if (!zones) return null;
  const { zoneCells, zoneEdge } = zones;
  let landings;
  let turnCellPolys = null;
  if (isWinding) {
    // WINDING: 回転部は平面の段の多角形（扇形セル。stairTreadFootprints の install）を持ち、切断線ごとに
    // withCutLandings が切って段付きの踊り場（Landing）にする（turnCellSlices.js）。桁枠は持たない。
    // z は段の天端（landingZ＋(段番号−最初の回転段)×蹴上）。件数が回転部のマス数と違えば null。
    const first = layout.firstTurnNumber;
    turnCellPolys = footprints
      .filter(c => c.number >= first && c.number < first + turnCells)
      .map(({ poly, number }) => ({ poly, number, z: landingZ + (number - first) * riser }));
    if (turnCellPolys.length !== turnCells) return null;
    landings = [];
  } else {
    landings = [landing];
    if (Math.abs(frontAC - frontC) > GAP_EPS) {
      landings.push({
        runLo: Math.min(frontAC, frontC), runHi: Math.max(frontAC, frontC),
        acrossLo: Math.min(across.s0, across.sA), acrossHi: Math.max(across.s0, across.sA), z: landingZ,
        isVertical: vertical, frame: { edges: [] },
      });
    }
  }

  // ユーザー実機フィードバック2026-08-23「踊り場断面上に巾木同寸」対応: 階段Room
  // （stair.roomId。graph.roomMap）のRoomFinish.baseboardHeightをparseBaseboardHeightMm
  // （elevationFigure.js。"h=<数値>"表記のみ解釈）で読む。未設定・解釈不能ならASSUMED既定値
  // としてDEFAULT_BASEBOARD_HEIGHT（@core。新規Room作成時の既定値と同じ'h=60'）を使う——
  // 「未設定なら既定値を決め報告する」という指示への対応（報告: 既定60mm採用）。
  const stairRoom = stair.roomId ? graph.roomMap?.get(stair.roomId) ?? null : null;
  const baseboardHeightMm =
    parseBaseboardHeightMm(stairRoom?.finish?.baseboardHeight) ??
    parseBaseboardHeightMm(DEFAULT_BASEBOARD_HEIGHT) ?? 60;

  const unit = {
    structure: stair.structure ?? null,
    stringerThicknessMm: STEEL_STRINGER_THICKNESS_MM,
    stringerDepthMm: STEEL_STRINGER_DEPTH_MM,
    landingFrameDepthMm: STEEL_LANDING_FRAME_DEPTH_MM,
    baseboardHeightMm,
    anchorZs: [...new Set([0, floorHeight, landingZ])].sort((a, b) => a - b),
  };

  return {
    flights: [outbound, inbound], landings, structure: stair.structure ?? null, unit,
    // 走行軸の向き・回転部のマス数・走行軸上の前縁/奥（切断線の位置決めに使う。switchbackCuts.js）
    // turnCellCount＝回転部のマス数 w、turnCells＝WINDING の回転部の多角形（折返しは空）、forwardSign＝回転部の奥(+t)の走行軸上の符号
    isVertical: vertical, turnCellCount: turnCells, turnCells: turnCellPolys ?? [], forwardSign: fwd,
    // zoneCells＝側面の口の取りつき区画のセル（上り口・到達口。平場は矩形）、zoneEdge＝区画の外縁の位置と外側の高さ
    zoneCells, zoneEdge,
    frame: { frontA: frontAC, front: frontC, back: run.back },
  };
}

/**
 * 側面の口の取りつき区画のセル（上り口 e 個・到達口 a 個）と、段 0（平場）の矩形のセル、区画の外縁（edgeRun）の外側の高さを返す
 * （U 字系の stairContribution と直進系の straightContribution が共有）。セルは footprints（stairTreadFootprints の install）から
 * 番号の範囲（entryNumbers/arrivalNumbers。平面の layout が供給）で拾い、段 n の天端は n×蹴上（topZ）。件数が蹴上数と違えば null。
 * 取りつき段 0 の側面の口: セルが無いので矩形のセルを作る。上り口は床（z=0）、到達口は上階の床の高さ（最後の蹴上が乗る平場）。
 * 到達辺の縦線＝最終蹴上（最後のセルの天端→上階床）。到達口が側面の実データが無く合成テストだけで決めた暫定規則
 * （問題.md Q2/Q3・2026-10-09）。上階スラブの小口と重なる見込み。目視裁定待ち。
 * @param {{number:number, poly:number[], topZ:number}[]} footprints
 * @param {boolean} vertical 走行軸が縦（y）か
 * @param {number} topFloorZ 上階の床の高さ（総蹴上数×蹴上）
 * @param {number} flatNumber 到達口の平場の矩形に付ける番号（総蹴上数）
 * @param {{entry:object, arrival:object}} zones 各口 { numbers:{from,to}|null, steps, on（側面か）, rect:[run0, run1, across0, across1], edgeRun }
 */
function portZoneCells(footprints, vertical, topFloorZ, flatNumber, { entry, arrival }) {
  const rectPoly = (r0, r1, a0, a1) => (vertical ? [a0, r0, a1, r0, a1, r1, a0, r1] : [r0, a0, r1, a0, r1, a1, r0, a1]);
  const cellsOf = (z) => (z.numbers
    ? footprints.filter(c => c.number >= z.numbers.from && c.number <= z.numbers.to).map(({ poly, number, topZ }) => ({ poly, number, z: topZ }))
    : []);
  const entryCells = cellsOf(entry), arrivalCells = cellsOf(arrival);
  if (entryCells.length !== entry.steps || arrivalCells.length !== arrival.steps) return null;
  const addFlat = (cells, z, flatZ, number) => {
    const [r0, r1, a0, a1] = z.rect;
    if (z.on && z.steps === 0 && Math.abs(r1 - r0) > GAP_EPS) cells.push({ poly: rectPoly(r0, r1, a0, a1), z: flatZ, number });
  };
  addFlat(entryCells, entry, 0, 0);
  addFlat(arrivalCells, arrival, topFloorZ, flatNumber);
  return {
    zoneCells: { entry: entryCells, arrival: arrivalCells },
    zoneEdge: {
      entry: entryCells.length ? { run: entry.edgeRun, outerZ: 0 } : null,
      arrival: arrivalCells.length ? { run: arrival.edgeRun, outerZ: topFloorZ } : null,
    },
  };
}

/**
 * 直進系（STRAIGHT/STRAIGHT_LANDING）階段の3D寄与を、U字系と同じ区分線形モデル（Flight[]・Landing[]）で返す。
 * 走行方向の位置は平面の解決値 straightPlanLayout（設置階の install 枠）だけから取り、CL 区間長（measureStairSpans の len1/landingLen/len2）や
 * 通り芯の枠から再計算しない（平面の線と展開図の蹴上を一致させる。elevation-model.md）。側面の口（上り口 e 段・到達口 a 段）の区画は
 * 平面のセル（stairTreadFootprints の install。番号は layout の entryNumbers/arrivalNumbers）を zoneCells として持ち、切断線ごとに
 * withCutLandings が切る（直進部の flight は区画を含まない）。平場（段 0）は矩形のセル。出入口が走行端なら区画は無い。
 * flight: STRAIGHT は start1〜exitA の n1 段（足元は e×蹴上）、STRAIGHT_LANDING は start1〜land1 の n1 段・踊り場（z=(e+n1)×蹴上）・
 * land2〜exitA の n2 段。上り口が側面なら flight1 は entryRunMm（区画の長さ）だけ手前まで正面視（crossesFlight）の対象にする
 * （seq1 は上り口辺 base に立つ。ユーザー裁定待ち Q4 の推奨）。
 * 構造別の部材（unit・段板厚・蹴込）は持たない（従来どおり。U字系の stairContribution とは別）。
 * 直進系でない・floorHeight 未確定・平面の枠が求まらない・区画のセルが番号の範囲から拾えない場合は null。
 * @param {import('@core').Stair} stair
 * @param {object} graph 設置階の graph
 * @param {number|null} floorHeight 設置階〜上階の階高(mm)
 */
export function straightContribution(stair, graph, floorHeight) {
  if (!stair || floorHeight == null) return null;
  const layout = straightPlanLayout(stair, graph);
  if (!layout) return null;
  const { vertical, run, across, hasLanding, n1, n2, entryNumbers, arrivalNumbers } = layout;
  const e = layout.entryTurnSteps, a = layout.arrivalTurnSteps;
  const riser = stair.riser ?? floorHeight / Math.max(2, stair.totalSteps ?? 2);
  const acrossLo = Math.min(across.s0, across.s1), acrossHi = Math.max(across.s0, across.s1);
  const flightOf = (from, to, baseZ, steps, extra = {}) => ({
    isVertical: vertical, runLo: Math.min(from, to), runHi: Math.max(from, to), travelSign: to >= from ? 1 : -1,
    acrossLo, acrossHi, baseZ, riserMm: riser, steps, lengthMm: Math.abs(to - from), ...extra,
  });
  const entryRunMm = Math.abs(run.start1 - run.base);
  const first = flightOf(run.start1, hasLanding ? run.land1 : run.exitA, e * riser, n1, {
    ...(e > 0 ? { underSteps: e } : {}),
    ...(!hasLanding && a > 0 ? { overSteps: a } : {}),
    ...(entryRunMm > GAP_EPS ? { entryRunMm } : {}),
  });
  let flights, landings;
  if (hasLanding) {
    const landingZ = (n1 + e) * riser;
    landings = [{ runLo: Math.min(run.land1, run.land2), runHi: Math.max(run.land1, run.land2), acrossLo, acrossHi, z: landingZ }];
    flights = [first, flightOf(run.land2, run.exitA, landingZ, n2, a > 0 ? { overSteps: a } : {})];
  } else {
    landings = [];
    flights = [first];
  }
  const footprints = entryNumbers || arrivalNumbers ? stairTreadFootprints(stair, graph, { riser, insetView: 'install' }) : [];
  const topFloorZ = layout.totalSteps * riser;
  const zones = portZoneCells(footprints, vertical, topFloorZ, layout.totalSteps, {
    entry: { numbers: entryNumbers, steps: e, on: layout.entryPort === 'side', rect: [run.base, run.exitE, across.s0, across.s1], edgeRun: run.base },
    arrival: { numbers: arrivalNumbers, steps: a, on: layout.arrivalPort === 'side', rect: [run.exitA, run.end, across.s0, across.s1], edgeRun: run.end },
  });
  if (!zones) return null;
  return {
    flights, landings, structure: stair.structure ?? null,
    isVertical: vertical, forwardSign: Math.sign(run.end - run.base) || 1,
    zoneCells: zones.zoneCells, zoneEdge: zones.zoneEdge,
    // 切断定義表（straightCuts.js）が切断線を置く走行軸上の位置と幅方向の範囲（平面の解決値）
    frame: { base: run.base, land1: run.land1, land2: run.land2, exitA: run.exitA, end: run.end },
    across: { s0: across.s0, s1: across.s1, mid: across.mid },
    riser, n1, n2, hasLanding,
  };
}

// 踊り場矩形(runLo/runHi×acrossLo/acrossHi)の外周4辺を世界座標(axisWorld)で表す（WP-A2）。
// stairLanding.jsのlandingEdgeCLs（CL id版）と同じ幾何（front=frontIsLo側のrun辺・back=反対・
// side=幅方向の残り2辺）だが、こちらはCLへ解決せず数値のままstairPrimitivesForCutの断面
// プリミティブ生成に使う。
function landingFrameEdges(landing, vertical, frontIsLo) {
  const sideLo = { isVertical: vertical, axisWorld: landing.acrossLo, spanLo: landing.runLo, spanHi: landing.runHi, kind: 'side' };
  const sideHi = { isVertical: vertical, axisWorld: landing.acrossHi, spanLo: landing.runLo, spanHi: landing.runHi, kind: 'side' };
  const runLoEdge = {
    isVertical: !vertical, axisWorld: landing.runLo, spanLo: landing.acrossLo, spanHi: landing.acrossHi,
    kind: frontIsLo ? 'front' : 'back',
  };
  const runHiEdge = {
    isVertical: !vertical, axisWorld: landing.runHi, spanLo: landing.acrossLo, spanHi: landing.acrossHi,
    kind: frontIsLo ? 'back' : 'front',
  };
  return [runLoEdge, runHiEdge, sideLo, sideHi];
}

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

// 「他レーン（見えがかりで奥に見えるレーン）」のささらが壁で遮られるか（WP-2026-08-23実機
// フィードバック「往路と復路の間に壁が無ければ復路直進部のささらが見える／壁があれば遮る」
// 対応）。[runLo,runHi]（対象flightの走行区間）と重なるcolumnsのbandsのうち、cut.lineから
// secondaryFlight自身の手前側の縁（acrossLo/acrossHiのうちcut.lineに近い方）までの距離
// 以内にある見えがかり壁（'wall'。band.distMm<=requiredDistMm）または縦断された壁
// （'cutAlong'。切断線自体の上＝距離0扱い）があれば遮られているとみなす——距離で絞らないと
// secondaryFlight自身より遠い部屋の外壁（isSightlineShapeは切断線と平行な壁を広く拾う）まで
// 「遮る壁」に誤検出してしまう（回帰: 実機フィードバック対応の初版で発見）。columnsは既に
// オクルージョン優先順位（sectionProbe.js）で「その位置で最も手前にある実体」だけを保持して
// いるため、往復間の壁が実在すればここに現れ、無ければ現れない。z範囲はSTRINGER_VISIBILITY_
// Z_HI_MM（ささらが視覚的に問題になる高さの目安）までに限定する（ASSUMED: 天井付近だけに
// 存在する無関係な壁面まで「遮る」と誤判定しないための上限）。
const STRINGER_VISIBILITY_Z_HI_MM = 2000;
function isBlockedByWall(columns, cut, secondaryFlight) {
  const nearWorld =
    Math.abs(secondaryFlight.acrossLo - cut.line.axisValue) <= Math.abs(secondaryFlight.acrossHi - cut.line.axisValue)
      ? secondaryFlight.acrossLo : secondaryFlight.acrossHi;
  const requiredDistMm = Math.abs(nearWorld - cut.line.axisValue);
  const relevant = (columns ?? []).filter(c => rangesOverlap(c.worldLo, c.worldHi, secondaryFlight.runLo, secondaryFlight.runHi));
  for (const c of relevant) {
    for (const band of c.bands ?? []) {
      if (band.z0 >= STRINGER_VISIBILITY_Z_HI_MM) continue;
      if (band.kind === 'cutAlong') return true; // 切断線上＝距離0。常に手前
      if (band.kind === 'wall' && band.distMm <= requiredDistMm + GAP_EPS) return true;
    }
  }
  return false;
}

// cut.lineが対象（レーン・踊り場）を「縦断」しているか（向きが一致・幅の内側・run範囲が重なる）。
// export: 展開図一般化Phase 6b-1のstairFaceHitsが同じ判定を再利用する。
export function isLengthwiseCut(entityIsVertical, entityAcrossLo, entityAcrossHi, entityRunLo, entityRunHi, cut) {
  return cut.line.isVertical === entityIsVertical &&
    cut.line.axisValue >= entityAcrossLo - GAP_EPS && cut.line.axisValue <= entityAcrossHi + GAP_EPS &&
    rangesOverlap(cut.line.lo, cut.line.hi, entityRunLo, entityRunHi);
}

// columns のうち、世界run座標が[runLo,runHi]と重なるものだけのローカルx範囲（Math.min/max）。
// 該当なしはnull。QA実機フィードバック修正: 列がrunLo/runHiより広い世界範囲を持つ場合
// （往路・復路レーンの間に壁もCL区切りも無く、collectCutBreaksが列を分割しない構成——
// 往復間に壁の無い実機の折返し階段で頻出）、旧実装は列のx0/x1をそのまま返していたため、
// 往路・復路のどちらの梯子も同じ（列全体の）x範囲になり、レーン間で左右に分かれず全幅に
// 重なって描かれていた。列の世界範囲を[runLo,runHi]でクランプしてからlocalXOfでローカルxへ
// 変換することで、列が分割されていなくても梯子・踊り場CUT線がそのFlight/Landing自身の
// 幅(acrossLo/acrossHi・runLo/runHi)だけに収まるようにする。
function columnsXRangeOverlapping(columns, cut, runLo, runHi) {
  const relevant = columns.filter(c => rangesOverlap(c.worldLo, c.worldHi, runLo, runHi));
  if (relevant.length === 0) return null;
  const xs = relevant.flatMap(c => {
    const wLo = Math.max(c.worldLo, runLo), wHi = Math.min(c.worldHi, runHi);
    return [localXOf(cut, wLo), localXOf(cut, wHi)];
  });
  // **outerBoundは渡さない**——踊り場CUT線・梯子・ささら正面視矩形は面の真の描画範囲
  // （cutDrawRange）までで閉じる。上階のはり出しぶん広げるのは階段自身が2FLへ到達する終端
  // （fullColumnsXRange）だけ（展開図一般化Phase 6b-2「一体設計」。.claude/elevation-redesign.md§5.12）。
  return clampToDrawRange(cut, { loX: Math.min(...xs), hiX: Math.max(...xs) });
}

// columns全体（この切断の描画される全ローカルx範囲=[0,face.run]相当）のMath.min/max。columnsが
// 空ならクランプ無し（[-Infinity,Infinity]）、面の描画範囲と交わらなければnull（=非描画）。
// outerBound（既定undefined＝現行完全同値）: stairDrawRangeのouterBoundへそのまま渡す。
// **階段自身の幾何（踏面CUT・段鼻・ささら）が面端の外まで伸びてよい唯一の理由**＝上階の平面が
// 面端より外へ続く（upperOverhangOf）終端（展開図一般化Phase 6b-2「一体設計」）。
function fullColumnsXRange(columns, cut, outerBound) {
  if (!columns || columns.length === 0) return { loX: -Infinity, hiX: Infinity };
  const xs = columns.flatMap(c => [c.x0, c.x1]);
  return clampToDrawRange(cut, { loX: Math.min(...xs), hiX: Math.max(...xs) }, outerBound);
}

// 列の範囲は**面の描画範囲を超えうる**——層ごとに面の端が違う多層帯では、上階の平面が続く側に
// 面の外の列が立つ（sectionContent.jsのlayerRunWindows）。階段の作図（段鼻ジグザグ・梯子・
// ささら断面）が面の外へ伸びてよいかは列ではなく`stairDrawRange`が決める（面の外に断面を描かない、
// の単一情報源）ため、列由来のx範囲は必ずここを通す。窓が無い切断・outerBound省略では列の範囲が
// 描画範囲に一致するため、クランプは素通り＝従来と完全同値。
// **交わりが空なら非描画（null）**——その部品は描画範囲の外にしか無い。元のrangeを返すと
// 「面の外に断面を描かない」の単一情報源を無視して描いてしまう。呼び出し側は既に
// nullを「描かない」（空配列・continue）として扱う契約になっている。
function clampToDrawRange(cut, range, outerBound) {
  const draw = stairDrawRange(cut, outerBound);
  const loX = Math.max(range.loX, draw.lo), hiX = Math.min(range.hiX, draw.hi);
  return hiX < loX ? null : { loX, hiX };
}

/**
 * 階段自身の幾何（踏面CUT・段鼻・ささら見えがかり・桁枠）の描画範囲。`cutDrawRange`（面の真の
 * 境界＋壁のない端部の体裁延長）を、`outerBound`（はり出しの外端の**面ローカルx・絶対値**）が
 * それより外まで伸びているときだけ、そこまで広げる——階段が2FLへ到達する終端は、上階の床の
 * はり出しと同じ終点で閉じる必要があるため（展開図一般化Phase 6b-2「一体設計」。
 * .claude/elevation-redesign.md§5.12「一体設計（architect 2026-09-12）」）。
 *
 * QA是正（2026-09-12 その6）: `outerBound`を**増分**（cutDrawRangeからの加算量）として受け取る
 * 実装は、`upperOverhangOf`側の基準（`wallLessEndAt`補正済みの`baseLo/baseHi`。壁のない端部かつ
 * 上階のはり出しがある構成では`cutDrawRange`自身の基準＝常に`probeExtendLoMm/HiMm`込みと一致
 * しない）とズレ、二重計上/過小計上になりうる。**絶対値で受け取りMath.min/maxで比較する**ことで、
 * `cutDrawRange`と同じ`localXOf`変換から出す限り基準の取り方に依存しない単一の比較になる。
 * `outerBound`省略時・該当フィールドがnullのときはそちら側を広げない（＝`cutDrawRange`そのもの。
 * 現行完全同値）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{lo?:number|null, hi?:number|null}} [outerBound] - はり出しの外端の面ローカルx絶対値
 *   （loは小さいほど外、hiは大きいほど外。cutDrawRangeより内側の値を渡しても広げない方向には
 *   効かない——Math.min/maxが現在の範囲より外側の値だけを採用する）。
 * @returns {{lo:number, hi:number}}
 */
export function stairDrawRange(cut, outerBound) {
  const draw = cutDrawRange(cut);
  const lo = outerBound?.lo != null ? Math.min(draw.lo, outerBound.lo) : draw.lo;
  const hi = outerBound?.hi != null ? Math.max(draw.hi, outerBound.hi) : draw.hi;
  return { lo, hi };
}

// flightの段鼻ジグザグ点列を、cutのローカルx軸へ投影して求める（isLengthwiseCutのゲート無し。
// runLengthMmは実測flight.lengthMm（無ければrunHi-runLoへフォールバック。§9 WP-E5b修正:
// coordAt由来のrunHi-runLoは往路・復路で一致しない場合があるため、実測長を単一情報源にする）。
// 点列のxはcolumns全体の範囲へクランプする（WP-E5b発見: stairContributionのrunLo/runHi
// （roomBounds由来・生の室境界）とcut.line.lo/hi（wOut1.lo/hi・壁仕上げ面へスナップ済み）は
// 半壁厚ぶんズレることがあり、面のローカル範囲[0,run]をわずかに超える点が出ることがあるため
// （回帰: 「浅い階段室」テスト参照）。
// WP-2026-08-23実機修正: 「他レーン（見えがかりで奥に見えるレーン）」のささらを描くには、
// そのレーンの幾何自体はcut.lineの縦断対象ではなくても、同じ走行方向を歩くジグザグ点列を
// 同じローカルx軸上に投影する必要がある——flight.travelSign/cut.dirSignだけがローカルx方向を
// 決めるため、flight自身がcut.lineの内側にあるかどうかとは無関係に計算できる（ゲート無しに
// した理由）。
function computeFlightZigzagPoints(flight, cut, columns, outerBound) {
  return computeFlightProfile(flight, cut, columns, outerBound).points;
}


// ユーザー実機指摘2026-08「直進部の斜めささらと踊り場ささら（上下共）は、トリム結合して取り合う」:
// flightのどちらの端が踊り場に接するかを返す（stairRunProfileの点列は歩行順なので、
// 段鼻列の先頭=flight.baseZ・末尾=baseZ+steps*riser）。往路は末尾が踊り場、復路は先頭が踊り場。
// 接する端だけを、踊り場桁枠の下端（＝上端+桁成）の水平線でトリムする。
function landingMitreOpts(flight, allLandings, unit) {
  const D = unit?.landingFrameDepthMm;
  // 回り階段の回転部のスライス（turnStep）は桁枠を持たない＝取り合う相手の桁枠が無いのでトリムしない。
  const landings = (allLandings ?? []).filter(l => l.turnStep == null);
  if (D == null || !landings.length) return {};
  const startZ = flight.baseZ;
  const endZ = flight.baseZ + flight.steps * flight.riserMm;
  const at = z => landings.find(l => Math.abs(l.z - z) < GAP_EPS) ?? null;
  const s = at(startZ), e = at(endZ);
  // トリム端の上端が届くべき高さ＝踊り場桁枠の上端（踊り場床+巾木）。ユーザー明示指示
  // 2026-08その15「「6」D1: 復路のささら上見えがかりは踊り場のささら上まで／下見えがかりは
  // 踊り場の左側ささら下端まで」——復路は最初の段鼻が踊り場より1リザー上にあるため、
  // 段鼻列だけで帯を作ると桁枠に1リザーぶん届かない。勾配に沿ってここまで伸ばす
  // （下端はミトレで「上端+せい」へ寄るので、上端を合わせれば下端も桁枠の下端に揃う）。
  const lift = unit?.baseboardHeightMm ?? 0;
  return {
    mitreDepthMm: D, mitreStart: !!s, mitreEnd: !!e,
    mitreStartTopY: s ? -(s.z + lift) : undefined,
    mitreEndTopY: e ? -(e.z + lift) : undefined,
  };
}


// トリム結合の下端側: この切断で描かれる斜めささらのうち、この踊り場に接する側の
// 下端の角（ミトレ済み）のローカルxを返す。踊り場桁枠の下端はここから描き始める
// （それより手前は斜めささらの下端が外形）。ささらは鉄骨のみのため呼び出し側でSTEEL限定。
function landingSideMitreX(contribution, landing, cut, columns) {
  const unit = contribution.unit;
  if (!unit?.landingFrameDepthMm) return null;
  for (const flight of contribution.flights ?? []) {
    if (!isLengthwiseCut(flight.isVertical, flight.acrossLo, flight.acrossHi, flight.runLo, flight.runHi, cut)) continue;
    const startZ = flight.baseZ;
    const endZ = flight.baseZ + flight.steps * flight.riserMm;
    const atStart = Math.abs(landing.z - startZ) < GAP_EPS;
    const atEnd = Math.abs(landing.z - endZ) < GAP_EPS;
    if (!atStart && !atEnd) continue;
    const band = stringerBandGeometry(computeFlightProfile(flight, cut, columns).noses, STEEL_STRINGER_DEPTH_MM, {
      baseboardMm: unit.baseboardHeightMm ?? 0,
      mitreDepthMm: unit.landingFrameDepthMm, mitreStart: atStart, mitreEnd: atEnd,
    });
    if (!band) continue;
    return atEnd ? band.bottom[1][0] : band.bottom[0][0];
  }
  return null;
}


// ---- 見えがかりのレイキャスト: 手前のレーンのささらによる遮蔽（ユーザー明示指示2026-08その16
// 「「6」D1: 復路ささら下、踊り場側は、往路ささら上まで／復路ささらは、往路ささらより奥にある」）----
// 切断は往路レーンの中を通り、視線の手前には**往路レーンのささら**（レーン境界側）がある。
// その上端より下は、ささら本体（せい300の帯）と、その先の踊り場桁枠に隠れて復路のささらは見えない。
// 遮蔽の外形は「往路ささらの上端線」——その端から先（踊り場側）は端点の高さで水平に延長する。
// 往路ささらの上端は既にミトレで踊り場桁枠の上端へ揃えてあるので、この水平延長がそのまま
// 踊り場桁枠の上端の外形になる（単一の折れ線として扱える）。
// 旧実装は`isBlockedByWall`（往復間の壁の有無）しか見ておらず、手前のささら自身による遮蔽を
// 判定していなかったため、復路のささら下端が往路ささらを突き抜けて踊り場まで描かれていた。

// 遮蔽外形のxにおける高さ（線分の外側は端点のyで水平に延長）。
function occluderYAt(seg, x) {
  const [[ax, ay], [bx, by]] = seg;
  const [loX, loY, hiX, hiY] = ax <= bx ? [ax, ay, bx, by] : [bx, by, ax, ay];
  if (x <= loX) return loY;
  if (x >= hiX) return hiY;
  return loY + (x - loX) * (hiY - loY) / (hiX - loX);
}

// 折れ線を「遮蔽外形より上（yは上向き負なのでy<=外形y）」の区間だけへ切る。
// 外形の折れ点（線分の両端x）で一旦分割してから解くことで、区間内は両方とも1次になり交点が閉形式で解ける。
function clipPolylineAboveOccluder(points, seg) {
  if (!seg || points.length < 2) return [points];
  const breaks = [seg[0][0], seg[1][0]].sort((a, b) => a - b);
  const above = p => p[1] - occluderYAt(seg, p[0]) <= GAP_EPS;
  const paths = [];
  let cur = null;
  const push = p => { if (!cur) cur = []; if (cur.length === 0 || Math.hypot(p[0] - cur[cur.length - 1][0], p[1] - cur[cur.length - 1][1]) > GAP_EPS) cur.push(p); };
  const end = () => { if (cur && cur.length >= 2) paths.push(cur); cur = null; };
  for (let i = 0; i + 1 < points.length; i++) {
    // 外形の折れ点で分割した小区間ごとに処理する
    const [p, q] = [points[i], points[i + 1]];
    const ts = [0, 1];
    for (const bx of breaks) {
      const dx = q[0] - p[0];
      if (Math.abs(dx) < GAP_EPS) continue;
      const t = (bx - p[0]) / dx;
      if (t > GAP_EPS && t < 1 - GAP_EPS) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    const at = t => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    for (let k = 0; k + 1 < ts.length; k++) {
      const a = at(ts[k]), b = at(ts[k + 1]);
      const av = above(a), bv = above(b);
      if (av && bv) { push(a); push(b); continue; }
      if (!av && !bv) { end(); continue; }
      // 交点: 区間内では点のyも外形のyも1次なので、差の線形補間で解ける
      const da = a[1] - occluderYAt(seg, a[0]), db = b[1] - occluderYAt(seg, b[0]);
      const t = da / (da - db);
      const x = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (av) { push(a); push(x); end(); } else { end(); push(x); push(b); }
    }
  }
  end();
  return paths;
}

// ジグザグ点列と段鼻列をまとめて返す（同じクランプを両方へ適用する単一実装）。段鼻は
// ささらの上端線の起点——点列のindexの偶奇からは拾えない（蹴込>0で刻みが変わる）ため、
// stairRunProfileが返す明示的な段鼻列をそのまま持ち回る。
// outerBound（既定undefined→fullColumnsXRangeがcutDrawRangeのまま扱う）: stairPrimitivesForCut
// のopts.outerBound（面ローカルx絶対値。QA是正2026-09-12その6で増分から絶対値へ変更）。
// 最終段の鼻が面端の外（上階のはり出しぶん）へ残るかはこのクランプ幅で決まる
// （展開図一般化Phase 6b-2「一体設計」）。
// opts.surfaceOnly: 段板の厚みを無視した歩行面の輪郭（床プロファイル stairCutFloorProfile 用。
// 下面の切欠きを床線に混ぜない）。
// クランプ前の点列・段鼻列（computeFlightProfile と踊り場の床の端 landingFloorSpanX の単一供給源）。
function flightRunProfile(flight, cut, opts = {}) {
  const worldStart = flight.travelSign > 0 ? flight.runLo : flight.runHi;
  const localDir = flight.travelSign * cut.dirSign; // ローカルx方向の歩行方向
  const startX = localXOf(cut, worldStart);
  const runLengthMm = flight.lengthMm ?? (flight.runHi - flight.runLo);
  return { ...stairRunProfile(
    flight.steps, flight.riserMm, runLengthMm, startX, -flight.baseZ, localDir, flight.nosingMm ?? 0,
    { treadThicknessMm: opts.surfaceOnly ? 0 : flight.treadThicknessMm ?? 0 }), startX };
}

function computeFlightProfile(flight, cut, columns, outerBound, opts = {}) {
  const { points, noses } = flightRunProfile(flight, cut, opts);
  const range = fullColumnsXRange(columns, cut, outerBound);
  if (!range) return { points: [], noses: [] }; // 列が面の描画範囲と交わらない＝この面には描かない
  const { loX, hiX } = range;
  const clamp = ([x, y]) => [Math.min(hiX, Math.max(loX, x)), y];
  // 段鼻列（noses）は**クランプしない**。ささらの帯（stringerBandGeometry）は「最初と最後の段鼻を
  // 結ぶ直線」から作るため、面の描画範囲へクランプした段鼻を渡すと、flightが面の外へ続く構成
  // （階段下の部屋の帯＝実機「13」D。flightの両端が面の端の外にある）で端点だけxが寄って
  // **勾配が断面の段鼻列と違う帯**になる（ユーザー実機指摘2026-09-14「見え掛かりが断面と不一致」
  // の一因）。帯・ミトレ交点・遮蔽外形はクランプ前の段鼻から作り、面の外はstairPrimitivesForCut
  // 出口のx終端クリップ（clipPrimitivesToXRange）に任せる。ジグザグ本体（points）だけは従来どおり
  // クランプする（面端で蹴上を立てる既存の見え方を保つ）。クランプ済みの段鼻列は持たない
  // ——同じ原始データの2つ目の供給源を作らないため（QA指摘2026-09-14）。
  return { points: points.map(clamp), noses };
}

// レーン縦断: 段鼻のジグザグ本体（SILHOUETTE。WOOD向け。isLengthwiseCutで縦断対象かを判定）。
function flightZigzagPrimitives(flight, cut, columns, outerBound) {
  if (!isLengthwiseCut(flight.isVertical, flight.acrossLo, flight.acrossHi, flight.runLo, flight.runHi, cut)) return [];
  const clamped = computeFlightZigzagPoints(flight, cut, columns, outerBound);
  if (clamped.length < 2) return []; // 面の描画範囲と交わらない（clampToDrawRangeが空）＝描かない
  return [{ type: 'polyline', points: clamped, weight: weightForRole(ElevationLineRole.SILHOUETTE) }];
}

// 鉄骨ささら階段の往路・復路間の空き（QA実機フィードバック: 平面同様、往路と復路の間は
// LANE_GAP=100mmあける）を梯子の横幅にのみ反映する——flightZigzagPrimitives/isLengthwiseCutの
// 判定はflight.acrossLo/acrossHiそのものを使う（変更するとseq2/seq4等のcut.line.axisValueが
// ちょうどレーン境界midAcrossにある一般規則の「縦断」判定自体が壊れる）ため、梯子の幅だけの
// 別軸として計算する。trueAcrossLo/Hi（部屋の実際の外縁。全flights/landingsの最小・最大）と
// 一致しない側＝レーン同士が接する内側の境界だけをgap/2ぶん狭める。
// export: 展開図一般化Phase 6b-1のstairFaceHitsが同じ幅を再利用する。
export function ladderAcrossRange(flight, trueAcrossLo, trueAcrossHi, gapMm) {
  const half = gapMm / 2;
  const acrossLo = flight.acrossLo > trueAcrossLo + GAP_EPS ? flight.acrossLo + half : flight.acrossLo;
  const acrossHi = flight.acrossHi < trueAcrossHi - GAP_EPS ? flight.acrossHi - half : flight.acrossHi;
  return { acrossLo, acrossHi };
}

// レーンを横切る: 正面視の梯子（DETAIL。全段=steps）。flight.baseZがcut.baseFloorZより低い
// （＝見返りの基準床より下の区間）なら破線にする（WP-E5b: seq1「踊り場より下の往路踏面は
// 破線」の一般化。emitLineの§5.6最終フィルタと役割は重なるが、往路全体を一律破線にする
// 既存仕様に合わせここでも明示指定する——両者が重複適用されても結果は変わらない）。
// ladderAcross省略時はflight自身のacrossLo/Hiを使う（既存挙動。木造・単一Flight等）。
function flightLadderPrimitives(flight, cut, columns, ladderAcross, treadSection = true) {
  if (!crossesFlight(flight, cut)) return [];
  // 横切るcutのcolumnsは（cut.lineに沿って）幅方向(across)のx区間である——flightのacrossLo/Hi
  // （走行方向ではなく）と重なる列だけに絞る（run方向で絞るflightZigzag/landingCutとは軸が違う）。
  const { acrossLo, acrossHi } = ladderAcross ?? flight;
  const range = columnsXRangeOverlapping(columns, cut, acrossLo, acrossHi);
  if (!range) return [];
  const { loX, hiX } = range;
  const frontZ0 = frontBaseZ(flight);
  const dashed = frontZ0 < (cut.baseFloorZ ?? 0) - GAP_EPS;
  const steps = Math.max(0, Math.round(flight.steps)) + (flight.underSteps ?? 0) + (flight.overSteps ?? 0);
  const prims = [];
  // 切断線が flight の**内部**（端から STAIR_RUN_TOL_MM より奥）にあるとき、その位置の段板は実際に切られている
  // （seq1 の frontA で復路の初段を切る。S2a QA 裁定(a)）。段板の天端に CUT を出す（木造は段板厚の矩形、
  // それ以外は天端の線。鉄骨のささらの断面は flightStringerFrontPrimitives が従来どおり描く）。
  // 端ちょうど（境界）の flight は従来どおり梯子だけ。
  const interior = treadSection && cut.line.axisValue > flight.runLo + STAIR_RUN_TOL_MM && cut.line.axisValue < flight.runHi - STAIR_RUN_TOL_MM;
  const cutZ = interior ? flightTreadZAt(flight, cut.line.axisValue) : null;
  // **基準床より下から始まる区間は足元（k=0＝その区間の床。実機の1FL）も描く**
  // （ユーザー明示指示2026-09「「6」C: 1FLも破線描画」）——踏面だけだと最下段の下に線が無く、
  // 区間の床がどこかが図に出ない。基準床から始まる区間（k=0＝帯自身の床＝踊り場）は
  // 既に床断面線（太線）が引かれているので足さない。
  for (let k = dashed ? 0 : 1; k <= steps; k++) {
    const z = frontZ0 + k * flight.riserMm;
    if (cutZ != null && Math.abs(z - cutZ) < 1e-6) continue; // 切られている段板の天端は下の CUT で描く
    prims.push(emitLine(cut, loX, z, hiX, z, ElevationLineRole.DETAIL, dashed ? { dash: 'dashed' } : {}));
  }
  if (cutZ != null) {
    // 段板の幅方向の範囲: 隔て板の柱があるときは隔て板の面(flight.treadAcrossLo/Hi。往路 sA・復路 sB)で止める
    // （梯子は内縁＝レーン中央のままで、太線が隔て板の断面の中へ入らないようにする）。柱なしは梯子と同じ。
    const tr = flight.treadAcrossLo != null
      ? columnsXRangeOverlapping(columns, cut, flight.treadAcrossLo, flight.treadAcrossHi)
      : { loX, hiX };
    const t = Math.max(0, Math.min(flight.treadThicknessMm ?? 0, flight.riserMm - 1));
    const opt = { neverDowngrade: true };
    if (tr) {
      prims.push(emitLine(cut, tr.loX, cutZ, tr.hiX, cutZ, ElevationLineRole.CUT, opt));
      if (t > 0) {
        prims.push(emitLine(cut, tr.loX, cutZ - t, tr.hiX, cutZ - t, ElevationLineRole.CUT, opt));
        prims.push(emitLine(cut, tr.loX, cutZ - t, tr.loX, cutZ, ElevationLineRole.CUT, opt));
        prims.push(emitLine(cut, tr.hiX, cutZ - t, tr.hiX, cutZ, ElevationLineRole.CUT, opt));
      }
    }
  }
  return prims;
}

/**
 * この切断で**手前に階段が描かれる**領域（正面視＝レーンを横切る切断でのflightの見付け範囲）を
 * 矩形で返す（ユーザー実機指摘2026-08「6」C「階段に隠れる部分は破線」）。
 * アキのバツ（`emitOpenGapMarks`の対角線）のうちこの矩形に入る区間だけを破線へ落とすために使う
 * ——プリミティブから領域を逆算するのではなく、flight自身の見付け幅（梯子と同じ`ladderAcrossRange`
 * 調整済み）と昇り切り高さ（baseZ〜baseZ+steps*riserMm）というモデルの値から直接組み立てる。
 * レーン縦断（側面視）の切断は対象外——その場合レーンは切断線の中を通っており「手前に見える
 * 階段」ではないため（`crossesFlight`がfalse）。
 * @param {ReturnType<typeof stairContribution>|null} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>}
 */
/**
 * 往路・復路レーンの間の空き（LANE_GAP=100）のローカルx範囲。踊り場桁枠の下端をここだけに
 * 絞るのに使う（ユーザー実機指摘2026-08「6」C「踊り場のささら下端は、内側の100の部分のみ」）。
 * レーンが2本無い・内側が定まらない構成はnull（呼び出し側は従来どおり全幅）。
 */
function laneGapLocalX(contribution, cut, trueAcrossLo, trueAcrossHi, isSteel) {
  const crossing = (contribution.flights ?? []).filter(f => crossesFlight(f, cut));
  if (crossing.length < 2) return null;
  const inners = [];
  for (const flight of crossing) {
    const side = innerAcrossWorld(flight, trueAcrossLo, trueAcrossHi);
    if (!side) return null;
    const across = isSteel ? ladderAcrossRange(flight, trueAcrossLo, trueAcrossHi, LANE_GAP) : flight;
    inners.push(localXOf(cut, side === 'lo' ? across.acrossLo : across.acrossHi));
  }
  const loX = Math.min(...inners), hiX = Math.max(...inners);
  return hiX - loX > GAP_EPS ? { loX, hiX } : null;
}

/**
 * この切断で**手前に実体として描かれる階段**の見付け矩形（正面視のシルエット）。
 * アキのバツ・見えがかりの水平線のうち、この範囲に入る区間を破線にするのに使う
 * （ユーザー実機指摘2026-08「6」C「階段に隠れる部分は破線」＋撤回後の再指示
 * 「想定したバツに対して描画面+所定距離までレイキャストして、隠れた部分を破線にする」）。
 * 内訳:
 *   - 各flight（レーンを横切る＝正面視の切断のみ）: 見付け幅（梯子と同じ`ladderAcrossRange`
 *     調整済み。STEEL時）× 昇り切り高さ（`baseZ`〜`baseZ+steps*riserMm`）。
 *   - 各landing: 桁枠の帯（`landing.z-landingFrameDepthMm`〜`landing.z`）を全幅で。
 * *却下した規則*: 「内側のささらより右（z全域）」を対角線ごとに割り当てる案——ユーザーが
 * 「バツも破線範囲は、何かの基準線の左右では決まらない」として撤回した。深さ方向の限定
 * （「描画面+所定距離まで」）は、階段のflightが帯自身の部屋（`bandRoom`）の中にしか存在せず
 * 描画面より手前であることが構成上保証されるため、追加の判定を持たない（ASSUMED）。
 *
 * 本番参照ゼロ。`stairFaceOccluderRects`（`elevationStairSequence.js`）との突き合わせテスト
 * （`sectionStair.test.js`）専用の参照実装として残す（Phase 6b-2 段A）。
 */
export function stairOccluderRects(contribution, cut) {
  if (!contribution || !cut?.line) return [];
  contribution = withCutLandings(contribution, cut);
  const isSteel = contribution.structure === StructuralMaterialType.STEEL;
  const acrossExtents = [...(contribution.flights ?? []), ...(contribution.landings ?? [])];
  if (acrossExtents.length === 0) return [];
  const trueAcrossLo = Math.min(...acrossExtents.map(e => e.acrossLo));
  const trueAcrossHi = Math.max(...acrossExtents.map(e => e.acrossHi));
  const rects = (contribution.flights ?? []).filter(f => crossesFlight(f, cut)).map(flight => {
    const across = isSteel ? ladderAcrossRange(flight, trueAcrossLo, trueAcrossHi, LANE_GAP) : flight;
    const a = localXOf(cut, across.acrossLo), b = localXOf(cut, across.acrossHi);
    return {
      xLo: Math.min(a, b), xHi: Math.max(a, b),
      zLo: frontBaseZ(flight), zHi: flight.baseZ + flight.steps * flight.riserMm,
    };
  });
  const depth = contribution.unit?.landingFrameDepthMm ?? 0;
  if (depth > 0) {
    for (const landing of contribution.landings ?? []) {
      const a = localXOf(cut, landing.acrossLo), b = localXOf(cut, landing.acrossHi);
      rects.push({
        xLo: Math.min(a, b), xHi: Math.max(a, b), zLo: landing.z - depth, zHi: landing.z,
      });
    }
  }
  return rects;
}

/**
 * ヒット列（展開図一般化Phase 6b-1。設計`.claude/elevation-redesign.md`§5.3(b)）向けの階段の
 * 占有面。`stairOccluderRects`と**完全に同じ判定・同じ形状**（正面視＝`crossesFlight`の段板占有・
 * 踊り場桁枠）、内側ささらの見えがかりは`innerStringerGeometry`（`innerStringerSilhouette`が
 * 描画へ変換する直前の幾何と**共通の単一情報源**。QA是正2026-09: 以前は独自に`isLengthwiseCut`
 * （側面視）を条件にしており、本番の`crossesFlight`（正面視）と定義上排他だったため、本番が線を
 * 描く切断ではヒットが出ず、描かない切断で出るという逆転が起きていた——13.stq/11.stqのような
 * 非STEEL構成でなくとも、STEEL構成であっても本番の描画とヒットが噛み合わない状態だった）を使い、
 * 往路/復路の識別（`side`）と深度（`depthNearMm`/`depthFarMm`/`atCutPlane`）を添えて返す——
 * `section/sectionHits.js`の`probeColumnHits`がこれを`kind:'stairFace'`のSurfaceHitへ変換する
 * （本Phaseでは`visibleBandsOf`の選択には参加しない。載せるだけ）。
 * **`innerStringerSilhouette`（本番）は変更せず、`stairOccluderRects`は参照実装として据え置く**——
 * アキのバツ・見えがかり線の破線化という既存の出力契約を壊さないため、同じ判定を共有関数
 * （`innerStringerGeometry`）・
 * 同じ述語（`crossesFlight`）から導きつつ、描画とヒット化は別関数のままにした
 * （突き合わせテスト: `sectionStair.test.js`「stairOccluderRectsと一致」「innerStringerSilhouetteと
 * 一致」参照。S6単一情報源）。
 *
 * 深度（QA是正2026-09・要件C）: `SurfaceHit`は`depthNearMm`（視線方向の最も手前）・
 * `depthFarMm`（最も奥）・`atCutPlane`（`depthNearMm:0`が実測値ではなく切断平面への接触を
 * 意味することの明示。ファイル冒頭`SurfaceHit`の型ドキュメント参照）を持つ。
 * - 正面視（`crossesFlight`）の段板・内側ささら: `depthNearMm:0, atCutPlane:true`。
 *   switchbackCutsのseq1は`cut.line.axisValue`（=往路側の前縁 frontA）が往路flightの
 *   runLo/runHiの境界そのものと一致する構成のため、切断平面は文字通りその境界に立っている
 *   （復路側は frontA が復路flightの内側になりうる。S2a 以降）。
 *   `depthFarMm`はそのflightの走り長さ（`lengthMm`。無ければ`runHi-runLo`）——flight自体が
 *   その奥行きぶん切断平面から奥（踊り場と反対側）へ伸びる実体のため。
 * - 踊り場桁枠: `depthNearMm:0, depthFarMm:0, atCutPlane:true`——`stairOccluderRects`と同じく
 *   cut向きに関わらず無条件で積む既存挙動のままで、桁枠自体は「走り長さ」に相当する奥行きの
 *   モデルを持たない（せい=`landingFrameDepthMm`はz方向の厚みであり視線方向の奥行きではない）。
 *
 * 斜めの踏面ジグザグ（側面視で実際に切られる自レーン自身の段鼻プロファイル。
 * `computeFlightZigzagPoints`）は**本関数の対象外**（Phase 6b-1のスコープ外・6b-2で選択に
 * 参加させる段と合わせて設計する——ASSUMED）。
 * @param {object|null} contribution - `cut.stairCut`
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {Array<{side:'outbound'|'inbound'|null, part:'tread'|'landingFrame'|'stringer',
 *   xLo:number, xHi:number, z0:number, z1:number,
 *   depthNearMm:number, depthFarMm:number, atCutPlane:boolean}>}
 */
export function stairFaceHits(contribution, cut) {
  if (!contribution || !cut?.line) return [];
  contribution = withCutLandings(contribution, cut);
  const isSteel = contribution.structure === StructuralMaterialType.STEEL;
  const acrossExtents = [...(contribution.flights ?? []), ...(contribution.landings ?? [])];
  if (acrossExtents.length === 0) return [];
  const trueAcrossLo = Math.min(...acrossExtents.map(e => e.acrossLo));
  const trueAcrossHi = Math.max(...acrossExtents.map(e => e.acrossHi));
  const hits = [];

  (contribution.flights ?? []).forEach((flight, idx) => {
    const side = idx === 0 ? 'outbound' : 'inbound';
    const depthFarMm = flight.lengthMm ?? Math.abs(flight.runHi - flight.runLo);
    if (crossesFlight(flight, cut)) {
      const across = isSteel ? ladderAcrossRange(flight, trueAcrossLo, trueAcrossHi, LANE_GAP) : flight;
      const a = localXOf(cut, across.acrossLo), b = localXOf(cut, across.acrossHi);
      hits.push({
        side, part: 'tread', xLo: Math.min(a, b), xHi: Math.max(a, b),
        z0: frontBaseZ(flight), z1: flight.baseZ + flight.steps * flight.riserMm,
        depthNearMm: 0, depthFarMm, atCutPlane: true,
      });
    }
    // 内側ささらの見えがかり: 判定・形状は本番`innerStringerSilhouette`と共通の
    // `innerStringerGeometry`（=`crossesFlight`＋baseZゲート＋innerAcrossWorld）から導く
    // （QA是正2026-09・要件A。以前の`isLengthwiseCut`は本番と排他で誤りだった）。
    if (isSteel) {
      const ladderAcross = ladderAcrossRange(flight, trueAcrossLo, trueAcrossHi, LANE_GAP);
      const geo = innerStringerGeometry(flight, cut, ladderAcross, trueAcrossLo, trueAcrossHi);
      if (geo) {
        hits.push({
          side, part: 'stringer', xLo: geo.x, xHi: geo.x, z0: geo.z0, z1: geo.z1,
          depthNearMm: 0, depthFarMm, atCutPlane: true,
        });
      }
    }
  });

  const frameDepthMm = contribution.unit?.landingFrameDepthMm ?? 0;
  if (frameDepthMm > 0) {
    for (const landing of contribution.landings ?? []) {
      const a = localXOf(cut, landing.acrossLo), b = localXOf(cut, landing.acrossHi);
      hits.push({
        side: null, part: 'landingFrame', xLo: Math.min(a, b), xHi: Math.max(a, b),
        z0: landing.z - frameDepthMm, z1: landing.z,
        depthNearMm: 0, depthFarMm: 0, atCutPlane: true,
      });
    }
  }
  return hits;
}

/**
 * `stairFaceHits`（占有面のヒット列。Phase 6b-1）から遮蔽矩形
 * （`splitGapMarksByStair`/`dashHorizontalsBehindStair`が破線化判定に使う`{xLo,xHi,zLo,zHi}`）を
 * 組み立てる（展開図一般化Phase 6b-2 段A。設計`.claude/elevation-redesign.md`§5.11 C-3）。
 *
 * 対象は`part:'tread'|'landingFrame'`だけ——`stringer`（内側ささらの見えがかり線）は
 * `xLo===xHi`（幅0の縦線）で、遮蔽矩形として面積を持たない（`segmentInsideRect`は退化した
 * 矩形を常に非交差として扱うため含めても実害は無いが、「遮蔽物＝手前に実体として描かれる階段」
 * という定義上、幅0の線は意味を持たないため明示的に除外する）。
 *
 * `stairFaceHits`のtread/landingFrameは`stairOccluderRects`と同じ判定（`crossesFlight`）・
 * 同じ形状から生成される（突き合わせテスト`sectionStair.test.js`「stairOccluderRectsと一致」で
 * 保証済み）ため、本関数の出力は常に`stairOccluderRects(contribution, cut)`と同じ集合になる
 * （出力不変。Phase 6b-2段Aのゲート）。
 * @param {object|null} contribution - `cut.stairCut`
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>}
 */
export function stairFaceOccluderRects(contribution, cut) {
  return stairFaceHits(contribution, cut)
    .filter(h => h.part !== 'stringer')
    .map(h => ({ xLo: h.xLo, xHi: h.xHi, zLo: h.z0, zHi: h.z1 }));
}

// cut.lineがflightを横切っているか（flightLadderPrimitivesと同じ判定。ささら正面視・梯子で共有。
// 境界上は両側を含む: 切断線が flight の端（runLo/runHi）から STAIR_RUN_TOL_MM 以内なら横切るとみなす。
// seq1 の切断線は往路側の前縁 frontA（往路の終端）に置くので、この含みに依存する。
// export: 展開図一般化Phase 6b-1のstairFaceHitsが同じ判定を再利用する）。
export function crossesFlight(flight, cut) {
  // entryRunMm＝上り口が側面の直進系で、flight の始端より手前（基端 base 〜 区画の出口）の長さ。基端に立つ正面視（seq1）も
  // この flight を正面から見る（区画の段は underSteps で足元の下に続く）。始端側（走行の手前）だけ広げる
  const ext = flight.entryRunMm ?? 0;
  const lo = flight.runLo - (flight.travelSign < 0 ? 0 : ext), hi = flight.runHi + (flight.travelSign < 0 ? ext : 0);
  return cut.line.isVertical !== flight.isVertical &&
    cut.line.axisValue >= lo - STAIR_RUN_TOL_MM && cut.line.axisValue <= hi + STAIR_RUN_TOL_MM;
}

/**
 * flightの**段鼻を結ぶ勾配線**上で、走行方向の世界座標runCoordにおける高さ(絶対z)を返す。
 * 正面視（レーンを横切る切断）のささら断面の基準高さと、階段下の部屋の帯が重ねる
 * 「上を通る階段の高さ」の細線（elevationBand.js）が**両方ここを呼ぶ単一情報源**。
 *
 * 段鼻の並びは断面（stairRunProfile。踏面ピッチ＝区間長÷(段数−1)、最初の段鼻は区間の
 * 始端でbaseZ+riser）と同じ規約で置く——始端(d=0)でz=baseZ+riser、終端(d=区間長)で
 * z=baseZ+steps×riser。区間の外は端の高さでクランプする。
 *
 * 旧実装（`flightElevationAt`／elevationBand.jsの`stairZAtRun`）は「始端でbaseZ・終端で
 * baseZ+steps×riser」の線形補間で、断面の段鼻列より始端側ほど低く（最大1リザー）ずれていた
 * ——実機「13」A（階段下の部屋の、階段を横切る面）で階段の高さの細線が踊り場高さ(1500)に出て、
 * 隣のBの断面が壁と取り合う高さ（最初の段鼻=1636）と食い違った（ユーザー実機指摘2026-09-14）。
 * 段数・踏面数（stairRunProfile側）には触れず、高さの問い合わせだけを断面と同じ規約へ揃える。
 * @param {Flight} flight
 * @param {number} runCoord - 走行方向の世界座標
 * @returns {number} 絶対z(mm)
 */
export function flightNoseZAt(flight, runCoord) {
  // 上り口の区画（underSteps）がある往路で、flight の始端より手前（区画の中・階段の外）の走行座標は、階段の最初の段の天端
  //（区画の段は直進部の足元の下に続く。区画の中の高さは段ごとに違うが、その下に部屋が来ることは無いので最初の段で代表する）。
  if (flight.underSteps > 0) {
    const worldStart = flight.travelSign > 0 ? flight.runLo : flight.runHi;
    if ((runCoord - worldStart) * flight.travelSign < 0) return frontBaseZ(flight) + flight.riserMm;
  }
  return flight.baseZ + flight.riserMm * (1 + flightStepParam(flight, runCoord));
}

// 正面視（見付け）で見える flight の足元の高さ。上り口の区画の段（underSteps）は直進部の足元の下に続く。
function frontBaseZ(flight) {
  return flight.baseZ - (flight.underSteps ?? 0) * flight.riserMm;
}

/**
 * flight 上の走行座標 runCoord に立つ段板（その位置を踏面とする段）の天端の絶対z。
 * 段鼻 i（始端から i×踏面ピッチ）から次の蹴上の足元までが段 i の踏面なので、段鼻の連続値 `flightStepParam` の
 * 切り捨てが段の番号になる（`flightNoseZAt` は勾配線上の連続値）。区間の外は端の段にクランプ。
 */
export function flightTreadZAt(flight, runCoord) {
  const steps = Math.max(1, Math.round(flight.steps));
  const i = Math.min(Math.floor(flightStepParam(flight, runCoord) + 1e-9), steps - 1);
  return flight.baseZ + flight.riserMm * (1 + i);
}

function flightStepParam(flight, runCoord) {
  const worldStart = flight.travelSign > 0 ? flight.runLo : flight.runHi;
  const runLengthMm = flight.lengthMm ?? Math.abs(flight.runHi - flight.runLo);
  const d = Math.min(Math.max((runCoord - worldStart) * flight.travelSign, 0), runLengthMm);
  const steps = Math.max(1, Math.round(flight.steps));
  // stairRunProfileと同じ踏面ピッチ（区間長÷(段数−1)）。1段の区間は段鼻が1つ＝一定高さ。
  return steps > 1 && runLengthMm > 0 ? d / (runLengthMm / (steps - 1)) : 0;
}

// ささらの正面視断面（CUT矩形。厚さthicknessMm×せいdepthMm）を1本のx位置に対して作る。
// z1(上端)からdepthMmぶん下げたz0(下端)までの矩形を4本のCUT線（emitLine経由）で表す。
// 実機フィードバック第3弾C（リード裁定でemitLineの契約変更を承認済み）: CUT断面
// （ささら12×300矩形・踊り場桁断面の見返り矩形）はbaseFloorZより下でも太線実線のまま
// （neverDowngrade:true）——降格（細破線）が残るのは踏面梯子(正面視)と壁断面の見えがかりだけ、
// という線種裁定のため。
function stringerRectLines(cut, xLo, xHi, zTop, depthMm) {
  // **面の描画範囲の外にある断面矩形は描かない**（ユーザー実機指摘2026-08「6」。踊り場桁枠・
  // ささらの断面が面の外（例: 面が0..2885なのにx=-57.5..-45.5やx=2942.5..2954.5、seq2では
  // x=3500..3512）に出ていた。梁の断面と同じ規則＝sectionTypes.jsのcutDrawRangeが単一情報源）。
  // 完全に範囲外のときだけ落とす（端に接する・一部だけかかる矩形は従来どおり描く）。
  const draw = cutDrawRange(cut);
  if (Math.max(xLo, xHi) < draw.lo - GAP_EPS || Math.min(xLo, xHi) > draw.hi + GAP_EPS) return [];
  const zBot = zTop - depthMm;
  const opts = { neverDowngrade: true };
  return [
    emitLine(cut, xLo, zBot, xLo, zTop, ElevationLineRole.CUT, opts),
    emitLine(cut, xHi, zBot, xHi, zTop, ElevationLineRole.CUT, opts),
    emitLine(cut, xLo, zTop, xHi, zTop, ElevationLineRole.CUT, opts),
    emitLine(cut, xLo, zBot, xHi, zBot, ElevationLineRole.CUT, opts),
  ];
}

// レーンを横切る（正面視）: ささらの断面矩形を両側（acrossLo側・acrossHi側）に描く（STEEL限定。
// ユーザー指示「断面は太線」対応）。ladderAcrossはflightLadderPrimitivesと同じLANE_GAP調整済み
// 幅（columnsXRangeOverlappingでlocal x範囲へ変換）を再利用する——見返りの梯子と同じ横幅に揃える。
function flightStringerFrontPrimitives(flight, cut, columns, ladderAcross, depthMm, thicknessMm, baseboardMm = 0) {
  if (!crossesFlight(flight, cut)) return [];
  const { acrossLo, acrossHi } = ladderAcross ?? flight;
  const range = columnsXRangeOverlapping(columns, cut, acrossLo, acrossHi);
  if (!range) return [];
  const { loX, hiX } = range;
  // 上端は段鼻の高さそのものではなく**巾木高さぶん上**（ユーザー実機指摘2026-08「6」C
  // 「両側のささら断面上端高さは、踊り場面+巾木」。既定の裁定「ささらの上端は踏面先端で
  // 巾木同寸」＝側面視のstringerBandGeometryと同じ基準を正面視の断面矩形にも揃える）。
  const zTop = flightNoseZAt(flight, cut.line.axisValue) + baseboardMm;
  return [
    ...stringerRectLines(cut, loX, loX + thicknessMm, zTop, depthMm),
    ...stringerRectLines(cut, hiX - thicknessMm, hiX, zTop, depthMm),
  ];
}

// 実機フィードバック第3弾E: flightがcut.baseFloorZより下まで達する見返り（正面視。crossesFlight）
// では、そのレーンのささらの端面（acrossLo/acrossHi。LANE_GAP考慮済みladderAcross）を
// z=flight.baseZ〜min(cut.baseFloorZ, flight.baseZ+steps*riserMm)（＝「踊り場より下」の範囲）の
// 縦線で描く——emitLineの通常の§5.6最終フィルタにより両端ともbaseFloorZ以下となるため、
// 自動的にDETAIL+dashed(細破線)になる（neverDowngrade指定は不要。Cの裁定どおり
// 「降格が残るのは踏面梯子(正面視)と壁断面の見えがかり」の踏面梯子側の一部として扱う）。
// STEEL限定（ささら自体がSTEEL限定のため。呼び出し側でisSteelガード）。
// flight.baseZ>=baseFloorZ（例: seq1のinbound。踊り場より下に一切かからない）なら空配列
// （「往路梯子」限定という実機指示は、この条件だけで自然に満たされる——outboundはbaseZ=0<
// landingAbs=baseFloorZなので該当し、inboundはbaseZ=landingAbsで非該当になる）。
// QA是正（2026-09-12 その2）: acrossLo/acrossHiは壁centerline（グリッドCL）基準で、壁の内側面
// （cutDrawRangeの基準）より半壁厚ぶん外側に出ることがある（実機と同じ構成。
// elevationStairSequence.test.jsの「往路ささらの端面」テスト参照）——`localXOf`の直組みで
// cutDrawRangeの外に出た点を出口の終端クリップに渡すと、**代替の線が無いまま消える**
// （`cutDrawRange`のヘッダが名指しする「面の外に断面を描かない」対象そのもので、消すのではなく
// 描画範囲の端へ**クランプ**して残すのが単一情報源化として正しい——端面の縦線は「境界のどこかに
// ささらの端がある」という情報を持つため、位置が多少寄っても消してはいけない）。
function stringerEndCapPrimitives(flight, cut, ladderAcross, outerBound) {
  if (!crossesFlight(flight, cut)) return [];
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const z0 = frontBaseZ(flight);
  if (!(z0 < baseFloorZ - GAP_EPS)) return [];
  const topZ = Math.min(baseFloorZ, flight.baseZ + flight.steps * flight.riserMm);
  const { acrossLo, acrossHi } = ladderAcross ?? flight;
  const draw = stairDrawRange(cut, outerBound);
  const clampX = x => Math.min(draw.hi, Math.max(draw.lo, x));
  const xLo = clampX(localXOf(cut, acrossLo)), xHi = clampX(localXOf(cut, acrossHi));
  return [
    emitLine(cut, xLo, z0, xLo, topZ, ElevationLineRole.DETAIL),
    emitLine(cut, xHi, z0, xHi, topZ, ElevationLineRole.DETAIL),
  ];
}

/**
 * flightの「内側」（平面で折返し階段を見たときの内側＝もう一方のレーンに接する側。
 * ユーザー実機指摘2026-08「6」C「梯子状の壁断面のない方の端」）のacross世界座標。
 * 部屋の実外縁(trueAcrossLo/Hi)と一致しない側が内側——`ladderAcrossRange`がLANE_GAPを
 * 片側だけ詰めるのと同じ判定基準（単一情報源）。両端とも外縁なら内側は無い（null）。
 * export: 展開図一般化Phase 6b-1のstairFaceHitsが同じ判定を再利用する。
 */
export function innerAcrossWorld(flight, trueAcrossLo, trueAcrossHi) {
  if (flight.acrossLo > trueAcrossLo + GAP_EPS) return 'lo';
  if (flight.acrossHi < trueAcrossHi - GAP_EPS) return 'hi';
  return null;
}

/**
 * 内側のささらの見えがかり（正面視の縦線1本。ユーザー実機指摘2026-08「6」C
 * 「往路が1FLから踊り場まで、復路は踊り場断面から2FLまで」）の**幾何**（対象か否かの判定と
 * x/z0/z1）だけを返す純関数。`innerStringerSilhouette`（本番の描画）と`stairFaceHits`
 * （展開図一般化Phase 6b-1のヒット化。QA是正2026-09）が**両方ここを呼ぶ単一情報源**——
 * 以前は`stairFaceHits`側が独自に`isLengthwiseCut`（側面視）で条件を組んでおり、本番の
 * `crossesFlight`（正面視）と**定義上排他**になっていた（QA指摘A: 本番が線を描く切断では
 * ヒットが出ず、描かない切断で出る、という逆転が起きていた）。
 *
 * 既存の`stringerEndCapPrimitives`（第3弾E）は「踊り場より下まで達するレーン」限定で両端に
 * 端面の細破線を描くもので、踊り場**より上**の復路には一切出なかった——そちらの契約は変えず、
 * ここでは端面規則の対象外（baseZ>=baseFloorZ）のレーンについて内側の縦線だけを補う。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {{x:number, worldX:number, z0:number, z1:number}|null} worldXはlocalXOf変換前の
 *   世界座標（`stairFaceHits`の深度計算がcut.line.axisValueとの差を取るのに使う）。
 */
function innerStringerGeometry(flight, cut, ladderAcross, trueAcrossLo, trueAcrossHi) {
  if (!crossesFlight(flight, cut)) return null;
  if (frontBaseZ(flight) < (cut.baseFloorZ ?? 0) - GAP_EPS) return null; // 端面規則(第3弾E)の担当
  const side = innerAcrossWorld(flight, trueAcrossLo, trueAcrossHi);
  if (!side) return null;
  const across = ladderAcross ?? flight;
  const worldX = side === 'lo' ? across.acrossLo : across.acrossHi;
  return { x: localXOf(cut, worldX), worldX, z0: frontBaseZ(flight), z1: flight.baseZ + flight.steps * flight.riserMm };
}

function innerStringerSilhouette(flight, cut, ladderAcross, trueAcrossLo, trueAcrossHi) {
  const geo = innerStringerGeometry(flight, cut, ladderAcross, trueAcrossLo, trueAcrossHi);
  if (!geo) return [];
  return [emitLine(cut, geo.x, geo.z0, geo.x, geo.z1, ElevationLineRole.DETAIL, { neverDowngrade: true })];
}

// 踊り場のレーン縦断: 床のCUT水平線1本（columns中、踊り場のrun範囲と重なる列のx範囲のみ）。
// 実機フィードバック第3弾C: 踊り場床CUT線もCUT断面のためneverDowngrade:true
// （baseFloorZより下でも太線実線のまま。stringerRectLines冒頭コメント参照）。
/**
 * 踊り場の床（縦断）のローカルx範囲 {loX,hiX}。踊り場から**登り出す**flight（flight.baseZ==landing.z。
 * 折返し階段の復路）がこの切断を縦断するとき、その1段目の蹴込板の足元（stairRunProfile の先頭点＝
 * 段鼻の位置から蹴込ぶん奥）まで床を延ばす——踊り場の床は段鼻の下にも続き、蹴込板の足元で終わる
 * （延ばさないと蹴込ぶんの隙間が空く。蹴込0なら足元＝段鼻で従来と同一）。
 * 足元は列の範囲（fullColumnsXRange。computeFlightProfile と同じ扱い）で挟んでから延ばす。
 * SWITCHBACK（flight 2本）ではbaseZ条件なしでも結果は同じ＝将来の多段踊り場のための保険。
 * 範囲が無い（列と交わらない・幅0）ときはnull。
 */
function landingFloorSpanX(landing, flights, cut, columns, spanLo, spanHi) {
  const range = columns ? columnsXRangeOverlapping(columns, cut, spanLo, spanHi) : null;
  const xs = range ? [range.loX, range.hiX] : [localXOf(cut, spanLo), localXOf(cut, spanHi)];
  let loX = Math.min(...xs), hiX = Math.max(...xs);
  if (hiX - loX <= GAP_EPS) return null;
  const edgeA = localXOf(cut, landing.runLo), edgeB = localXOf(cut, landing.runHi);
  const edgeLo = Math.min(edgeA, edgeB), edgeHi = Math.max(edgeA, edgeB);
  for (const flight of flights ?? []) {
    if (Math.abs(flight.baseZ - landing.z) > GAP_EPS) continue;
    if (!isLengthwiseCut(flight.isVertical, flight.acrossLo, flight.acrossHi, flight.runLo, flight.runHi, cut)) continue;
    const { points, startX } = flightRunProfile(flight, cut, { surfaceOnly: true });
    const colRange = fullColumnsXRange(columns, cut);
    const footX = colRange ? Math.min(colRange.hiX, Math.max(colRange.loX, points[0][0])) : points[0][0];
    if (Math.abs(startX - edgeLo) <= GAP_EPS) loX = Math.min(loX, footX);
    else if (Math.abs(startX - edgeHi) <= GAP_EPS) hiX = Math.max(hiX, footX);
  }
  return { loX, hiX };
}

function landingCutPrimitives(landing, flights, stairIsVertical, cut, columns) {
  const lengthwise = isLengthwiseCut(
    stairIsVertical, landing.acrossLo, landing.acrossHi, landing.runLo, landing.runHi, cut);
  // 正面視（レーンを横切る切断＝seq1の踊り場前縁）でも踊り場の床は切断されている
  // （ユーザー実機指摘2026-08「6」C「踊り場断面線を太線に」）。旧実装はlengthwiseのときしか
  // 描かず、正面視では踊り場桁枠のfront/back辺の**帯の上端**（DETAIL細線）が踊り場床の高さに
  // 見えているだけだった。x範囲は走行方向ではなく**across（壁から壁までの全幅）**で取る
  // （同指摘「踊場床断面と壁との取り合い…幅」）。
  const crossing = !lengthwise && cut.line.isVertical !== stairIsVertical
    && cut.line.axisValue >= landing.runLo - STAIR_RUN_TOL_MM && cut.line.axisValue <= landing.runHi + STAIR_RUN_TOL_MM;
  if (!lengthwise && !crossing) return [];
  const [spanLo, spanHi] = lengthwise
    ? [landing.runLo, landing.runHi]
    : [landing.acrossLo, landing.acrossHi];
  const range = lengthwise
    ? landingFloorSpanX(landing, flights, cut, columns, spanLo, spanHi)
    : columnsXRangeOverlapping(columns, cut, spanLo, spanHi);
  if (!range) return [];
  return [emitLine(cut, range.loX, landing.z, range.hiX, landing.z, ElevationLineRole.CUT, { neverDowngrade: true })];
}

/**
 * 段付きの踊り場（回り階段の回転部・側面の口の取りつき区画を切断線で切った Landing。turnCellSlices.js）の隣り合う2枚の間の蹴上を、
 * CUTの縦線で返す。外縁（上り口辺・到達辺）に接するスライス（edgeRiser）は外側の高さとの段差を縦線で足す。
 * 隣り合う＝高さが GAP_EPS を超えて違い、かつ縁を共有する2枚:
 *   - 切断が両方を縦断する（側面視）… 走行方向の共有辺の位置に z_a→z_b の縦線。
 *   - 切断が走行軸に直交して両方を横切る（正面視）… 幅方向の共有辺（レーン境界）の位置に縦線。
 * 折返し（踊り場1枚）・高さの同じ踊り場・縁を共有しない踊り場は引かない（0本）。
 * 縦線は面の描画範囲（stairDrawRange）の外に出さない。床の輪郭そのもの（段状）は
 * stairCutFloorProfile の max 合成が受け持つ。
 * @param {Landing[]|undefined} landings
 * @param {boolean} stairIsVertical
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {object[]}
 */
export function landingStepRisers(landings, stairIsVertical, cut) {
  const ls = landings ?? [];
  const prims = [];
  const draw = stairDrawRange(cut);
  const near = (p, q) => Math.abs(p - q) <= GAP_EPS;
  const lengthwiseOf = l => isLengthwiseCut(stairIsVertical, l.acrossLo, l.acrossHi, l.runLo, l.runHi, cut);
  const crossingOf = l => cut.line.isVertical !== stairIsVertical &&
    cut.line.axisValue >= l.runLo - STAIR_RUN_TOL_MM && cut.line.axisValue <= l.runHi + STAIR_RUN_TOL_MM;
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i], b = ls[j];
      if (Math.abs(a.z - b.z) <= GAP_EPS) continue;
      let edge = null; // 共有辺の世界座標
      if (lengthwiseOf(a) && lengthwiseOf(b)) {
        if (near(a.runHi, b.runLo)) edge = a.runHi;
        else if (near(b.runHi, a.runLo)) edge = a.runLo;
      } else if (crossingOf(a) && crossingOf(b)) {
        if (near(a.acrossHi, b.acrossLo)) edge = a.acrossHi;
        else if (near(b.acrossHi, a.acrossLo)) edge = a.acrossLo;
      }
      if (edge == null) continue;
      const x = localXOf(cut, edge);
      if (x < draw.lo - GAP_EPS || x > draw.hi + GAP_EPS) continue;
      prims.push(emitLine(cut, x, a.z, x, b.z, ElevationLineRole.CUT, { neverDowngrade: true }));
    }
  }
  // 側面の口の取りつき区画の外縁（上り口辺・到達辺）: 外側の高さ（床・上階の床）との段差。
  for (const l of ls) {
    if (!l.edgeRiser || !lengthwiseOf(l)) continue;
    const x = localXOf(cut, l.edgeRiser.run);
    if (x < draw.lo - GAP_EPS || x > draw.hi + GAP_EPS) continue;
    prims.push(emitLine(cut, x, l.edgeRiser.outerZ, x, l.z, ElevationLineRole.CUT, { neverDowngrade: true }));
  }
  return prims;
}

/**
 * ジグザグ点列（stairRunProfileの出力。ささらの側面視輪郭=stringerPrimitivesの入力）の端部を、
 * flightのbaseZ・baseZ+steps×riserMm（登り口FL・下り口FL）へ水平カットする（WP-A2。設計書
 * §8 AMBIGUITY F）。全ての点のyをこの範囲へクランプし、最初・最後の点は範囲の境界ちょうどへ
 * 強制的に揃える。points が空・1点以下ならそのまま返す（例外を投げない）。
 * @param {Array<[number,number]>} points
 * @param {StairUnit} unit - 未使用（将来のunit依存パラメータ拡張に備えたシグネチャ。設計書§3.3）
 * @param {Flight} flight
 * @returns {Array<[number,number]>}
 */
export function clipStringerToAnchors(points, unit, flight) {
  if (!points || points.length < 2 || !flight) return points ?? [];
  const { yLo, yHi } = flightZBounds(flight);
  const clipped = points.map(([x, y]) => [x, Math.min(yHi, Math.max(yLo, y))]);
  clipped[0] = [clipped[0][0], yHi];
  clipped[clipped.length - 1] = [clipped[clipped.length - 1][0], yLo];
  return clipped;
}

/**
 * flightの登り口FL(baseZ)〜下り口FL(baseZ+steps×riserMm)をローカルy(=-z)範囲へ変換する
 * （clipStringerToAnchors・stringerPrimitivesのz方向クリップで共有する単一情報源。
 * 実機フィードバック第3弾B）。
 * @param {Flight} flight
 * @returns {{yLo:number, yHi:number}}
 */
function flightZBounds(flight) {
  // -0を避ける（baseZ=0の典型ケースでstairRunProfile側の生の0と型的に一致させ、
  // JSON比較等での余計な差分を防ぐ）。
  const yHi = flight.baseZ === 0 ? 0 : -flight.baseZ;                                   // 登り口FL（下端）のローカルy
  const yLo = -(flight.baseZ + flight.steps * flight.riserMm) || 0; // 下り口FL（上端）のローカルy
  return { yLo, yHi };
}

// 踊り場桁枠（landingFramePrimitives）の生成対象判定（ユーザー裁定2026-08-23＝WP-A2§3.2の
// STEEL限定から拡張。対象＝鉄骨階段（ささら桁と同時に持つ）とRC造階段（受け梁のコンクリート
// 桁枠を表す）。ささら本体（stringerPrimitives・flightStringerFrontPrimitives等）は
// STEEL限定のまま変更しない——RC階段はプレート状のささらを持たないため対象外）。
function hasLandingFrame(structure) {
  return structure === StructuralMaterialType.STEEL || structure === StructuralMaterialType.RC;
}

/**
 * 踊り場の桁枠（front/back/side桁）を描く。生成対象はhasLandingFrame（STEEL・RC限定。
 * ユーザー裁定2026-08-23でWP-A2§3.2のSTEEL限定から拡張）。cutが踊り場をレーン縦断する
 * か（isLengthwiseCut。側面視seq2/4/5相当）・横切るか（crossesFlightと同型。正面視seq1/3相当）
 * で各辺の描き方を切り替える。ファイル冒頭のASSUMEDコメント参照。structure(STEEL/RC以外)・
 * landing.frame.edges未設定は空配列（例外なし）。
 * @param {Landing} landing
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {StairUnit} unit
 * @returns {object[]}
 */
export function landingFramePrimitives(landing, cut, columns, unit, mitreX = null, laneGapX = null) {
  const edges = landing?.frame?.edges;
  if (!edges || edges.length === 0 || !hasLandingFrame(unit?.structure)) return [];
  const stairIsVertical = edges.find(e => e.kind === 'side')?.isVertical;
  if (stairIsVertical == null) return [];

  const lengthwise = isLengthwiseCut(stairIsVertical, landing.acrossLo, landing.acrossHi, landing.runLo, landing.runHi, cut);
  const crossing = !lengthwise && cut.line.isVertical !== stairIsVertical &&
    cut.line.axisValue >= landing.runLo - STAIR_RUN_TOL_MM && cut.line.axisValue <= landing.runHi + STAIR_RUN_TOL_MM;
  if (!lengthwise && !crossing) return [];

  const prims = [];
  // ユーザー実機フィードバック2026-08-23「ささらの線は踊り場回りも一続き」対応: side辺
  // （走行軸に平行＝直進部のささらと同じ位置関係で連続する辺）の帯は、front/back辺の
  // landing.z基準（床断面線そのもの）ではなく「踊り場床断面線+巾木高さ」を上端基準にし、
  // せいunit.landingFrameDepthMm(=300)ぶん下げた線を下端にする（§実施2「巾木高さ＋300」）。
  // front側（flight側。frontEdge.axisWorldの位置）の端には縦閉じ線を出さない——直進部の
  // ささら（stringerPrimitives）自身がその位置に輪郭を持つため、続けて描くことで見た目上
  // 連続した1本の帯に見える（ユーザー指示「端部の縦閉じ線は踊り場側では出さない」）。
  const frontEdge = edges.find(e => e.kind === 'front');
  const frontX = frontEdge ? localXOf(cut, frontEdge.axisWorld) : null;
  const sideTop = landing.z + (unit.baseboardHeightMm ?? 0);
  const sideBot = sideTop - unit.landingFrameDepthMm;
  for (const edge of edges) {
    const isSide = edge.kind === 'side';
    const broadside = (lengthwise && isSide) || (crossing && !isSide);
    if (broadside) {
      const range = columnsXRangeOverlapping(columns, cut, edge.spanLo, edge.spanHi);
      if (!range) continue;
      const { loX, hiX } = range;
      // 実機フィードバック第3弾C: 踊り場桁枠のbroadside帯（side/front/back辺いずれも）は
      // 直進部のささら見えがかりと同じ「ささらの見えがかり帯」扱いのためneverDowngrade:true
      // （baseFloorZより下でも細線実線のまま。降格が残るのは踏面梯子(正面視)と壁断面の
      // 見えがかりだけ、という線種裁定）。
      if (isSide) {
        // side辺: 上端(踊り場床断面線+巾木高さ)・下端(上端-landingFrameDepthMm)の水平線
        // （§実施2）。踊り場床断面線自体(landing.z)はlandingCutPrimitivesが既にCUTで描画
        // 済みのため重複させない。front（flight）側の端には縦線を出さない（続き扱い）。
        prims.push(emitLine(cut, loX, sideTop, hiX, sideTop, ElevationLineRole.DETAIL, { neverDowngrade: true }));
        // トリム結合の下端側（ユーザー実機指摘2026-08）: 斜めささらの下端は法線オフセット・
        // 桁枠の下端は鉛直せいのため交差角が付く。斜め側は既に交点までミトレ済み
        // （landingMitreOpts→stringerBandGeometry）なので、桁枠側もその交点から描き始める
        // ——交点までの区間は斜めささらの下端が外形になっており、そこへ桁枠の下端も引くと
        // 帯の内側に線が1本余る。交点は同じ`stringerBandGeometry`から取る（単一情報源）。
        // ミトレ結合の下端側: 交点(mitreX)までは斜めささらの下端が外形になっているので、桁枠側は
        // **交点から見て階段と反対側**だけを描く。旧実装は常に[mitreX, hiX]を描いており、階段が
        // hi側にある構成（実機「6」B）では踊り場のほぼ全長が消えていた——交点は階段側の端の近くに
        // 来るので、mitreXがどちらの端に近いかで描く側を決める（ユーザー実機指摘2026-08「6」B
        // 「踊り場の下ささら見えがかりが描画されていない」）。
        let botLo = loX, botHi = hiX;
        if (mitreX != null) {
          const m = Math.max(loX, Math.min(hiX, mitreX));
          if (Math.abs(m - hiX) < Math.abs(m - loX)) botHi = m; else botLo = m;
        }
        if (botHi - botLo > GAP_EPS) {
          prims.push(emitLine(cut, botLo, sideBot, botHi, sideBot, ElevationLineRole.DETAIL, { neverDowngrade: true }));
        }
        const isFrontX = (x) => frontX != null && Math.abs(x - frontX) < GAP_EPS;
        if (!isFrontX(loX)) prims.push(emitLine(cut, loX, sideTop, loX, sideBot, ElevationLineRole.DETAIL, { neverDowngrade: true }));
        if (!isFrontX(hiX)) prims.push(emitLine(cut, hiX, sideTop, hiX, sideBot, ElevationLineRole.DETAIL, { neverDowngrade: true }));
      } else {
        // front/back辺: せいlandingFrameDepthMmの帯輪郭。上端(zTop===landing.z)は
        // `landingCutPrimitives`が踊り場床の断面線としてCUTで描くので**ここでは描かない**
        // （ユーザー実機指摘2026-08「6」C「踊り場断面線を太線に」。side辺と同じ扱いに揃えた）。
        // 下端は**往路・復路レーンの間の空き（LANE_GAP=100）に見える部分だけ**（同指摘
        // 「踊り場のささら下端は、内側の100の部分のみ。あとは、不要。過去指示、間違いのため修正」）
        // ——それ以外の区間はレーンのささら・踏面の裏に隠れて見えない。laneGapX未指定
        // （レーンが1本＝間の空きが無い構成）は従来どおり全幅。
        // 上端は**踊り場床の断面線(landing.z)ではなく「踊り場面+巾木」(sideTop)**——桁枠はささらの
        // 続きで、上端の基準は側面視の裁定「ささらの上端は踏面先端で巾木同寸」と同じ
        // （ユーザー実機指摘2026-08「6」A「上下にささらの見えがかり（横線2本）」。踊り場床の
        // 断面線はlandingCutPrimitivesがCUTで別に描くので、重複ではなく上下2本になる）。
        prims.push(emitLine(cut, loX, sideTop, hiX, sideTop, ElevationLineRole.DETAIL, { neverDowngrade: true }));
        const botLo2 = laneGapX ? Math.max(loX, laneGapX.loX) : loX;
        const botHi2 = laneGapX ? Math.min(hiX, laneGapX.hiX) : hiX;
        if (botHi2 - botLo2 > GAP_EPS) {
          prims.push(emitLine(cut, botLo2, sideBot, botHi2, sideBot, ElevationLineRole.DETAIL, { neverDowngrade: true }));
        }
      }
    } else if (edge.kind === 'front') {
      // ユーザー明示指示2026-08その15「踊り場と階段取り合い部にささら断面は描画不要」
      // （「6」D1・Bで確認）: front辺は踊り場が直進部と取り合う辺そのもの。折返し階段の
      // 内側の踊り場ささらは往路・復路の間（100）だけにあり、直進部のささらが来るこの位置には
      // 踊り場側のささらが無い——断面（12mm厚×せい300のCUT矩形）を描かない。
      // 直進部のささら自身がこの位置に輪郭を持つため、取り合いは既に表現されている。
      continue;
    } else {
      // end-on（見返り）: 12mm厚×landingFrameDepthMmの断面矩形をCUTで描く。
      // 桁枠の辺は**部屋の通り芯（landing.acrossLo/Hi）上**にあるため、面の端（壁の仕上げ面）より
      // 外へ出ることがある——その場合は面の内側へ寄せて壁と取り合わせる（ユーザー実機指摘2026-08
      // 「6」A「その左右壁との取り合いに（折返し階段外回りの）ささら断面」。旧実装では面の外に
      // 落ちて`stringerRectLines`の描画範囲チェックで丸ごと消えていた）。
      const t = unit.stringerThicknessMm;
      const draw = cutDrawRange(cut);
      const x = localXOf(cut, edge.axisWorld);
      let recLo = Math.min(x, x + t), recHi = Math.max(x, x + t);
      if (recLo < draw.lo - GAP_EPS) { recLo = draw.lo; recHi = draw.lo + t; }
      if (recHi > draw.hi + GAP_EPS) { recHi = draw.hi; recLo = draw.hi - t; }
      prims.push(...stringerRectLines(cut, recLo, recHi, sideTop, unit.landingFrameDepthMm));
    }
  }
  return prims;
}

/**
 * 切断線ごとに、WINDING の回転部（contribution.turnCells＝平面の段の多角形）と側面の口の取りつき区画
 * （contribution.zoneCells＝上り口・到達口のセル）をその線で切った Landing を landings へ足した寄与を返す
 * （turnCellSlices.js）。公開の入口（stairPrimitivesForCut・stairCutFloorProfile・stairFaceHits・stairOccluderRects）が
 * 先頭で呼ぶ。切るセルが無い（折返しで口が走行端・STRAIGHT 系）・切断線が無いときは寄与そのまま。同じ寄与に二重に足さない
 * よう、足した結果には cutSliced を立てて冪等にする。
 * @param {object} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 */
export function withCutLandings(contribution, cut) {
  if (!contribution || contribution.cutSliced || !cut?.line) return contribution;
  const turnCells = contribution.turnCells ?? [];
  const { entry: entryCells = [], arrival: arrivalCells = [] } = contribution.zoneCells ?? {};
  if (!turnCells.length && !entryCells.length && !arrivalCells.length) return contribution;
  const isVertical = stairAxisIsVertical(contribution, cut);
  const fwd = contribution.forwardSign ?? 1;
  // 回転部・上り口の区画・到達口の区画は互いに離れた領域なので、頂点の寄せ先（sliceTurnCells の EDGE_SNAP_MM）は領域ごとに選ぶ
  const sliceOf = (cells) => (cells.length ? sliceTurnCells(cells, cut.line, isVertical, fwd) : []);
  // 区画の外縁（上り口辺・到達辺）に端が接するスライスは、外側の高さとの段差（縦線）を持つ（レーンを縦断する切断のみ）
  const lengthwise = cut.line.isVertical === isVertical;
  const withEdge = (slices, edge) => (edge && lengthwise
    ? slices.map(s => (Math.abs(s.z - edge.outerZ) > GAP_EPS
      && (Math.abs(s.runLo - edge.run) <= STAIR_RUN_TOL_MM || Math.abs(s.runHi - edge.run) <= STAIR_RUN_TOL_MM)
      ? { ...s, edgeRiser: { run: edge.run, outerZ: edge.outerZ } } : s))
    : slices);
  const slices = [
    ...sliceOf(turnCells),
    ...withEdge(sliceOf(entryCells), contribution.zoneEdge?.entry),
    ...withEdge(sliceOf(arrivalCells), contribution.zoneEdge?.arrival),
  ];
  return { ...contribution, landings: [...(contribution.landings ?? []), ...slices], cutSliced: true };
}

/**
 * 階段の走行軸の向き（isVertical）。contribution.isVertical（stairContribution が返す）が最優先。無ければ
 * flightsが空でも（seq3は踊り場だけを受け取る）踊り場から取る:
 * flights[0] → landings[0].isVertical（桁枠を持たない回り階段の回転部のスライス） → landings[0] の side 辺 →
 * 最後の退避として切断線自身の向き。stairPrimitivesForCut と stairCutFloorProfile が共有する。
 * @param {{flights?:Flight[], landings?:Landing[]}} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {boolean}
 */
export function stairAxisIsVertical(contribution, cut) {
  return contribution.isVertical
    ?? contribution.flights?.[0]?.isVertical
    ?? contribution.landings?.[0]?.isVertical
    ?? contribution.landings?.[0]?.frame?.edges?.find(e => e.kind === 'side')?.isVertical
    ?? cut.line.isVertical;
}

/**
 * この切断（cut）の**断面線（下側の輪郭）**のうち、**階段が受け持つ部分**をFloorProfile
 * （elevationFloorProfile.jsのtypedef。`[[localX, absZ]]`・x昇順・範囲外は端点値を保持）で返す。
 * contributionがnull、または縦断する寄与が1つも無ければnull（＝この面の断面線に階段は現れない）。
 *
 * 対象は**cut.lineが縦断している**flight・landingだけ（`isLengthwiseCut`）——横切る（正面視）
 * レーンはそもそも切っていない＝断面線ではない。`secondaryFlights`（往復間に壁が無いときだけ
 * 見える隣レーンのささら）も**見えがかり**であって断面線ではないので含めない。正面視の踊り場も
 * 含めない——その面の帯の床が既にlanding.zそのもので、二重に足しても輪郭は変わらないため。
 * @param {{flights?:Flight[], landings?:Landing[], unit?:StairUnit}|null} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn[]|null} [columns] - 省略時はx範囲の
 *   クランプ無し（fullColumnsXRange(null)が±Infinityを返すためcomputeFlightProfileはそのまま呼べる）
 * @returns {Array<[number,number]>|null}
 */
export function stairCutFloorProfile(contribution, cut, columns = null) {
  if (!contribution) return null;
  contribution = withCutLandings(contribution, cut);
  const parts = [];
  for (const flight of contribution.flights ?? []) {
    if (!isLengthwiseCut(flight.isVertical, flight.acrossLo, flight.acrossHi, flight.runLo, flight.runHi, cut)) continue;
    const points = clipStringerToAnchors(
      computeFlightProfile(flight, cut, columns, undefined, { surfaceOnly: true }).points, contribution.unit, flight);
    if (!points || points.length < 2) continue;
    // 図座標y=-z。`|| 0`は-0を避ける（baseZ=0の典型ケース。flightZBoundsと同じ理由）。
    const pts = points.map(([x, y]) => [x, -y || 0]).sort((a, b) => a[0] - b[0]);
    // **両端はアンカー（登り口FL・下り口FL）の高さで閉じる**——段鼻の出のぶん点列はx方向に
    // 単調ではなく（段鼻が一段下の蹴込みより出る）、素直にx昇順へ並べると最も外側のxに来るのは
    // 段鼻＝1リザーぶん高い点になる。FloorProfileは範囲外で端点値を保持する規約なので、
    // そのままでは階段の外（踊り場の床断面線・その先の壁断面）まで1リザーぶん高く切ってしまう。
    const baseZ = flight.baseZ, topZ = flight.baseZ + flight.steps * flight.riserMm;
    const baseAtLoX = points[0][0] < points[points.length - 1][0]; // clipStringerToAnchors: 先頭=登り口FL
    pts[0] = [pts[0][0], baseAtLoX ? baseZ : topZ];
    pts[pts.length - 1] = [pts[pts.length - 1][0], baseAtLoX ? topZ : baseZ];
    parts.push(pts);
  }
  // 踊り場の向き（走行軸）はstairPrimitivesForCutと同じ導出（flightsが空でも踊り場から取る）。
  const stairIsVertical = stairAxisIsVertical(contribution, cut);
  for (const landing of contribution.landings ?? []) {
    if (!isLengthwiseCut(stairIsVertical, landing.acrossLo, landing.acrossHi, landing.runLo, landing.runHi, cut)) continue;
    const span = landingFloorSpanX(landing, contribution.flights, cut, columns, landing.runLo, landing.runHi);
    if (!span) continue;
    const { loX, hiX } = span;
    parts.push([[loX, landing.z], [hiX, landing.z]]);
  }
  if (parts.length === 0) return null;
  return parts.reduce((acc, p) => (acc ? mergeFloorProfiles(acc, p) : p), null);
}

/**
 * stairContribution の結果を、1つの切断（cut）・その列配列（columns。x範囲の決定にのみ使う——
 * 塞ぎ判定等は行わない）に対する断面プリミティブへ変換する。
 * @param {{flights:Flight[], landings:Landing[], structure:string|null, unit?:StairUnit, secondaryFlights?:Flight[]}|null} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {{includeLadder?:boolean, includeStringerSightline?:boolean, outerBound?:{lo?:number,hi?:number}}} [opts]
 *   includeLadder=false で正面視の梯子（踏面の水平線）を出さない（ユーザー明示指示2026-09
 *   「梯子の件: 階段下は描画しない」。階段下の部屋の展開は階段を**下から**見るため、踏面を
 *   正面から見た梯子は見えない）。
 *   treadSection=false で、横断の切断線が flight の内部にあるときの段板の断面(CUT)を出さない
 *   （既定は出す。階段下の部屋の帯は階段が上を通る見えがかりなので false）。
 *   includeStringerSightline=false でレーン側面視のささらの見えがかりを出さない（同指示
 *   「「13」B: ささら（下）は、B面壁の向こう側なので見えない」）。
 *   stringerSightlineLowerOnly=true でささらの帯のうち**下端の輪郭だけ**を描く（同指示
 *   「「13」D: 階段断面のささら（上）は、部屋の向こう側なので描画不要」。階段下から見上げる面では
 *   ささらの上端線は踏面の裏＝部屋の外にある）。既定はいずれも従来どおり。
 *   outerBound（任意。既定undefined＝現行完全同値）… 階段自身の幾何の描画範囲（`stairDrawRange`）
 *   を`cutDrawRange`より外まで広げる、はり出しの外端の**面ローカルx絶対値**（増分ではない。
 *   QA是正2026-09-12その6）。呼び出し側（`elevationStairSequence.js`の`contentForCut`）が
 *   `upperOverhangOf`の結果（`stairOverhangOuter`）をそのまま渡す——階段が2FLへ到達する終端を、
 *   上階の床のはり出しと同じ終点まで許す（展開図一般化Phase 6b-2「一体設計」。
 *   .claude/elevation-redesign.md§5.12）。
 *   階段自身の幾何（DETAIL polylineのささらの見えがかり。`isStringer`）は、「断面内部は
 *   描かない」の一般判定（展開図一般化Phase 6b-2 設計(d)。ユーザー裁定2026-09-13）で
 *   x終端クリップの直前にクリップする——旧`opts.slabBand`+`clipStairDetailInSlabBand`
 *   （下階天井〜上階床の固定z帯だけを外部から指定してカットする特例）は、階段下に部屋が
 *   無い場合に指定した一般ルールの特例に過ぎなかったため、この一般判定に置き換えて削除した
 *   （P3。診断・裁定の経緯は`.claude/elevation-redesign.md`§5.12参照）。
 *   一般ルール: 囲む実体＝`slab ∪ cut ∪ cutAlong`（`sectionTypes.js`の`isSolidBand`）の矩形。
 *   ただし`slab`の矩形は、その上に立つ`cut`壁の**向こう側の面**まで延ばす（`solidRectsOf`。
 *   `sectionEmit.js`の`slabEdgeCutWallJunction`が小口の縦線を立てるxと同一の規則＝
 *   `slabJunctionOf`。向こう側に探査済みの空気がある場合だけ。ユーザー裁定2026-09-13「6」C）。対象は
 *   `isStringer`のpolylineのみ——踏面（CUT）・桁枠・端面・梯子は対象外（踏面を対象にすると
 *   最終段の蹴込がslab内で消えD2-2が回帰する。実測済み）。判定は矩形の**厳密内部**
 *   （`solidRectsOf`がGAP_EPSだけ内側へ縮めて返す）。`hidden`（そこに壁は実在するが描かない
 *   区間。§5.10で階段の占有形状が遮蔽物として参加する側に回った）・`wall`（見えがかり壁）は
 *   囲まない——`isSolidBand`の対象外。矩形は`columns`からだけ作る（新チャネルを増やさない。
 *   §5.9(b)）。QA是正（2026-09-13第2ラウンド）: この一般判定は`solidRectsOf(columns)`＋
 *   `isStringer(p)`だけのプリミティブ単位・無状態な処理で、旧`isLower`のような「他の部材との
 *   ペア判定」を一切持たない——x終端クリップとの前後を入れ替えても出力は変わらない（実測:
 *   QAが順序を入れ替えて`npm test`2114/2114緑・13.stq一致を確認済み）。x終端クリップより
 *   前に置いているのは、旧`opts.slabBand`+`clipStairDetailInSlabBand`（トリム→クリップの
 *   順で組んでいた旧規約）との連続性のためであり、正しさの条件ではない。
 * @returns {object[]}
 */
export function stairPrimitivesForCut(contribution, cut, columns, opts = {}) {
  if (!contribution) return [];
  contribution = withCutLandings(contribution, cut);
  const outerBound = opts.outerBound;
  const prims = [];
  // 階段の走行軸の向き。**flightsが空でも踊り場から取れる**ようにする（ユーザー実機指摘2026-08
  // 「6」A）——seq3は「段の重ね描きなし」でflights:[]の寄与を受け取るため、旧実装の
  // `flights[0] ?? cut.line.isVertical`だと切断線自身の向きへフォールバックし、
  // isLengthwiseCut/crossingの判定が反転して踊り場の断面・桁枠がほとんど出なかった。
  // 踊り場のside辺（走行軸に平行な辺）の向きが階段の向きそのもの（landingFramePrimitivesと同じ導出）。
  // 桁枠を持たない踊り場（回り階段の回転部のスライス）は landing.isVertical を持つ（stairAxisIsVertical）。
  const stairIsVertical = stairAxisIsVertical(contribution, cut);
  const isSteel = contribution.structure === StructuralMaterialType.STEEL;
  // WP-A2: 踊り場桁枠の生成対象（STEEL・RC。ユーザー裁定2026-08-23）。ささら本体(isSteel)とは
  // 独立したゲート——RC階段はささらを持たないがコンクリート桁枠は持つ。
  const hasFrame = hasLandingFrame(contribution.structure);
  // QA実機フィードバック: 鉄骨ささら階段は平面同様、往路・復路間にLANE_GAPぶんの空きを
  // 梯子の横幅へ反映する（ladderAcrossRange参照）。trueAcrossLo/Hiは全flights/landingsの
  // 最小・最大＝部屋の実際の外縁。
  const acrossExtents = [...(contribution.flights ?? []), ...(contribution.landings ?? [])];
  const trueAcrossLo = acrossExtents.length ? Math.min(...acrossExtents.map(e => e.acrossLo)) : 0;
  const trueAcrossHi = acrossExtents.length ? Math.max(...acrossExtents.map(e => e.acrossHi)) : 0;
  const zigzagEntries = []; // {points, flight}（実機フィードバック第3弾B: stringerPrimitives
  // のz方向クリップにflightのbaseZ/steps/riserMmが要るため、点列だけでなくflightも持ち回る）
  for (const flight of contribution.flights ?? []) {
    const zig = flightZigzagPrimitives(flight, cut, columns, outerBound);
    if (zig.length > 0) {
      if (isSteel) {
        // ユーザー実機フィードバック2026-08-23（switchbackCuts.jsの切断線再定義で、切断線が
        // 往路/復路レーンの中を通るようになったことに伴う訂正）: 「段部はササラの横に付く
        // （横付け）なので側面視ではジグザグ本体を隠しささらの輪郭(DETAIL)だけ描く」という
        // 旧仕様（WP-E3〜E5b）は撤回する——切断線が実際に踏面の中を縦断する以上、踏面自体が
        // 文字通り切断されている（DWD立面図でも踏板は断面として描かれている）。ジグザグ本体を
        // CUT（太線）として描いたうえで、切断面の向こう側にある「このレーン自身」のささら
        // （手前側は切り取られるため描かない）をstringerPrimitives（DETAIL）で重ねて描く。
        const clipped = clipStringerToAnchors(zig[0].points, contribution.unit, flight);
        prims.push({ type: 'polyline', points: clipped, weight: weightForRole(ElevationLineRole.CUT) });
        zigzagEntries.push({ points: clipped, flight });
      } else {
        prims.push(...zig);
      }
    }
    const ladderAcross = isSteel ? ladderAcrossRange(flight, trueAcrossLo, trueAcrossHi, LANE_GAP) : flight;
    if (opts.includeLadder !== false) {
      prims.push(...flightLadderPrimitives(flight, cut, columns, ladderAcross, opts.treadSection !== false));
    }
    // ささら正面視（レーンを横切る切断のみ該当。§6「鉄骨階段のみ」）: 12mm厚×せいSTEEL_STRINGER_
    // DEPTH_MMの断面矩形をCUT（太線）で描く。ユーザー指示「断面は太線」対応。
    if (isSteel) {
      prims.push(...flightStringerFrontPrimitives(
        flight, cut, columns, ladderAcross, STEEL_STRINGER_DEPTH_MM, STEEL_STRINGER_THICKNESS_MM,
        contribution.unit?.baseboardHeightMm ?? 0));
      // 実機フィードバック第3弾E: 踊り場より下（flight.baseZ<cut.baseFloorZ）まで達するレーンは
      // ささらの端面（縦の細破線）も追加する。
      prims.push(...stringerEndCapPrimitives(flight, cut, ladderAcross, outerBound));
      // 内側のささらの見えがかり（同上の縦線1本。端面規則の対象外レーン＝復路を補う）。
      prims.push(...innerStringerSilhouette(flight, cut, ladderAcross, trueAcrossLo, trueAcrossHi));
    }
  }
  // WP-2026-08-23実機フィードバック「「1」Bでは、往路と復路の間に壁はないので、復路直進部の
  // ささらが見える」対応: contribution.secondaryFlights（switchbackCuts.jsがseq2にのみ設定。
  // 往路レーン中央から見て視線前方にある復路レーン）は、そのレーン自身がcut.lineの縦断対象
  // ではない（isLengthwiseCutで検出されない）ため通常のflights処理では一切現れないが、
  // 途中に見えがかり壁（cutAlong/wall。往復間の壁）が無ければ、そのレーンの近い側の
  // ささらだけが見えがかり細線として視界に入る。STEEL限定（ささら自体がSTEEL限定のため）。
  if (isSteel) {
    // 手前（この切断が縦断するレーン）のささらの上端線＝遮蔽の外形。secondaryはこれより奥にある。
    const nearTopSeg = (() => {
      for (const flight of contribution.flights ?? []) {
        if (!isLengthwiseCut(flight.isVertical, flight.acrossLo, flight.acrossHi, flight.runLo, flight.runHi, cut)) continue;
        const band = stringerBandGeometry(
          computeFlightProfile(flight, cut, columns, outerBound).noses, STEEL_STRINGER_DEPTH_MM, {
            baseboardMm: contribution.unit?.baseboardHeightMm ?? 0,
            ...landingMitreOpts(flight, contribution.landings, contribution.unit),
          });
        if (band) return band.top;
      }
      return null;
    })();
    for (const secondary of contribution.secondaryFlights ?? []) {
      if (isBlockedByWall(columns, cut, secondary)) continue;
      const prof = computeFlightProfile(secondary, cut, columns, outerBound);
      const points = clipStringerToAnchors(prof.points, contribution.unit, secondary);
      for (const prim of stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM, flightZBounds(secondary),
        { noses: prof.noses, baseboardMm: contribution.unit?.baseboardHeightMm ?? 0,
          ...landingMitreOpts(secondary, contribution.landings, contribution.unit) })) {
        for (const seg of clipPolylineAboveOccluder(prim.points, nearTopSeg)) {
          prims.push({ ...prim, points: seg });
        }
      }
    }
  }
  for (const landing of contribution.landings ?? []) {
    prims.push(...landingCutPrimitives(landing, contribution.flights, stairIsVertical, cut, columns));
    // WP-A2: 踊り場の桁枠（front/back/side桁。STEEL・RCが対象。ユーザー裁定2026-08-23）。
    if (hasFrame) {
      const mitreX = isSteel ? landingSideMitreX(contribution, landing, cut, columns) : null;
      prims.push(...landingFramePrimitives(landing, cut, columns, contribution.unit, mitreX,
        laneGapLocalX(contribution, cut, trueAcrossLo, trueAcrossHi, isSteel)));
    }
  }
  // 段付きの踊り場（回り階段）の蹴上。踊り場が1枚（折返し）なら0本。
  prims.push(...landingStepRisers(contribution.landings, stairIsVertical, cut));
  // ささら側面視（鉄骨のみ。§6「鉄骨階段のみ」）: 各レーンのジグザグ点列ごとに桁成ぶん下げた
  // 輪郭（DETAIL＝切断面の向こう側にあるこのレーン自身のささら）を追加する。ユーザー指示
  // 「見えかがりは細線」対応（stringerPrimitives参照。2026-08-23実機修正でジグザグ自体が
  // CUTとして見えるようになったため、これは踏面のCUTに重ねて描く追加の輪郭になる）。
  if (isSteel && opts.includeStringerSightline !== false) {
    for (const { points, flight } of zigzagEntries) {
      prims.push(...stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM, flightZBounds(flight),
        { noses: computeFlightProfile(flight, cut, columns, outerBound).noses,
          baseboardMm: contribution.unit?.baseboardHeightMm ?? 0,
          bottomOnly: opts.stringerSightlineLowerOnly === true,
          ...landingMitreOpts(flight, contribution.landings, contribution.unit) }));
    }
  }
  // 階段自身の幾何の終端クリップ（展開図一般化Phase 6b-2「一体設計」。
  // .claude/elevation-redesign.md§5.12）。順序＝ミトレ（landingMitreOpts等）→辺落とし
  // （clipPolylineAboveOccluder等）→zクリップ（flightZBounds/clipStringerToAnchors）→
  // **「断面内部は描かない」の一般判定（設計(d)）**→x終端クリップ（ここ、裁定(c)
  // 「トリム先、全端クリップ」）。
  //
  // 一般ルール（ユーザー裁定2026-09-13。P3で特例を削除し確定）: 「実体（`slab`∪`cut`∪
  // `cutAlong`。`sectionTypes.js`の`isSolidBand`/`solidRectsOf`）で囲まれた矩形の
  // **厳密内部**にあるささらの見えがかり（`isStringer`）は描かない」——踏面（CUT）・桁枠・
  // 端面・梯子は対象外（踏面を対象にすると最終段の蹴込がslab内で消えD2-2が回帰する。実測済み）。
  // `slab`の矩形は、その上に立つ`cut`壁の向こう側の面まで延ばす（`slabEdgeCutWallJunction`と
  // 同じ規則＝`slabJunctionOf`。向こう側に探査済みの空気がある場合だけ。ユーザー裁定
  // 2026-09-13「6」C）。`hidden`（そこに壁は実在するが描かない区間）・`wall`（見えがかり壁）は
  // 囲まない。矩形は`columns`からだけ作る（新チャネルを増やさない。§5.9(b)）。
  // 旧`clipStairDetailInSlabBand`+`opts.slabBand`（下階天井〜上階床の固定z帯を外部から
  // 指定してカットする特例。階段下に部屋が無い場合に指定した一般ルールの特例に過ぎなかった）
  // はこの一般ルールへ置き換え、P3で削除済み。
  //
  // QA是正（2026-09-13第2ラウンド）: この一般判定は`solidRectsOf(columns)`＋`isStringer(p)`
  // だけを見るプリミティブ単位・無状態の処理で、他のpolylineとのペア判定（旧`isLower`）を
  // 持たない——x終端クリップとの前後を入れ替えても出力は変わらない（実測確認済み。順序は
  // 出力に影響しない）。ここに置くのは旧規約（トリム→クリップ）との連続性のためであり、
  // 正しさの条件ではない。
  const solidRects = rectsToFaceLocal(solidRectsOf(columns));
  const slabClipped = solidRects.length
    ? prims.flatMap(p => (isStringer(p) ? subtractRectsFromPrimitives([p], solidRects) : [p]))
    : prims;
  // QA是正（2026-09-12その1）: 「cutDrawRangeを超える幾何を生成している箇所が無いため素通り」
  // という旧コメントは事実誤り——`stringerEndCapPrimitives`はそのままでは壁centerline基準の
  // x（cutDrawRangeの外）を直組みしていたため、落ちる（その後QA是正その2で出口ではなく生成時に
  // `stairDrawRange`へクランプする側へ直した）。`innerStringerSilhouette`等（列を経由せず直接
  // local xを組む見えがかり線）は**意図的に**クランプせず、ここで初めてクリップ/分割される
  // （実機「6」D2で裁定済み）。outerBound未指定（「13」のstairOver等）でも、面の外へ出る幾何
  // （壁のない端の体裁延長や、flight自身の寸法が面の実境界を僅かに超える構成等）があれば
  // ここで切られる——「出力不変」は「出力が変わる幾何が現に無かった」という実測結果であって、
  // このクリップが無条件に素通りすることを保証するものではない。
  return clipPrimitivesToXRange(slabClipped, stairDrawRange(cut, outerBound));
}

/**
 * 階段下の部屋の天井との取り合い（ユーザー明示指示2026-09「「13」D/B: 扉近くがCH貼りのばし、
 * 鉄骨階段と取り合う先は鉄骨階段現わし」「天井を止める基準: CHの線が階段断面とぶつかるところ」）。
 *
 * 天井が張られている範囲では、その上の階段は天井に隠れて見えない——絶対z=`ceilAbsZ`（図のy=-z）
 * より**上**にある階段プリミティブを落とし、またぐ線分は天井の高さちょうどで切る。切った位置
 * （crossXs）が呼び出し側の「天井断面線をどこで止めるか」の単一情報源になる（作図側で別に
 * 交点を計算すると、描かれた階段断面と天井線が食い違う）。
 * @param {object[]} prims - stairPrimitivesForCutの出力（面ローカル座標）
 * @param {number} ceilAbsZ - その面の天井の絶対z(mm)
 * **crossXsに数えるのはCUT（階段の断面＝踏面・蹴上の輪郭）だけ**——ユーザー明示指示
 * 「天井を止める基準: CHの線が階段断面とぶつかるところ」。見えがかりのささら（DETAIL）は
 * 断面ではないので、天井を止める位置は決めない（クリップ自体は同じように受ける）。
 * @returns {{prims:object[], crossXs:number[]}} crossXsは階段断面が天井と交わったローカルx。
 */
export function clipStairUnderCeiling(prims, ceilAbsZ) {
  const yc = -ceilAbsZ;
  const under = y => y >= yc - GAP_EPS; // 図のyは下向き負＝yが大きいほど低い＝天井より下
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const crossXs = [];
  const addCross = (weight, x) => { if (weight === cutWeight) crossXs.push(x); };
  const out = [];
  const xAt = (x1, y1, x2, y2) => x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1);
  for (const p of prims) {
    if (p.type === 'line') {
      const u1 = under(p.y1), u2 = under(p.y2);
      if (u1 && u2) { out.push(p); continue; }
      if (!u1 && !u2) continue;
      const xm = xAt(p.x1, p.y1, p.x2, p.y2);
      addCross(p.weight, xm);
      out.push(u1 ? { ...p, x2: xm, y2: yc } : { ...p, x1: xm, y1: yc });
    } else if (p.type === 'polyline' && Array.isArray(p.points)) {
      let run = [];
      const flush = () => { if (run.length > 1) out.push({ ...p, points: run }); run = []; };
      for (let i = 0; i < p.points.length; i++) {
        const [x, y] = p.points[i];
        if (under(y)) run.push([x, y]);
        const next = p.points[i + 1];
        if (!next) break;
        const [nx, ny] = next;
        if (under(y) === under(ny)) continue;
        const xm = xAt(x, y, nx, ny);
        addCross(p.weight, xm);
        if (under(y)) { run.push([xm, yc]); flush(); } else { run = [[xm, yc]]; }
      }
      flush();
    } else {
      out.push(p);
    }
  }
  return { prims: out, crossXs };
}
