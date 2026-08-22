/**
 * 2.5D断面エンジン: stairContribution / stairPrimitivesForCut（第3層。WP-E3→WP-E5bで統合）。
 * 設計意図はarchitect承認済みの実装指示書§4末尾参照。elevationStairSequence.js（switchbackCuts.js
 * 経由でcut.stairCutとして渡された値を消費）から呼ばれる。
 *
 * 既存部品を転用する（§5.7）: stairRunProfile・stringerPrimitives（elevationStairSection.js。
 * 挙動不変のまま呼ぶ）・resolveSwitchbackParams（区間長・段数の単一情報源）・makeFrame
 * （finish/stair/stairGeometry.js。flip/upDirection吸収済み）。梯子（正面視の水平線）は
 * treadLadderLinesを使わずemitLine経由で組み立てる（§5.6最終フィルタ・baseFloorZ以下の
 * 明示的な破線指定を両立させるため。WP-E5b）。今回のスコープはSWITCHBACKのみ
 * （resolveSwitchbackParams自体がSWITCHBACK以外null）。
 *
 * h(t)は関数で持たず区分線形のFlight[]で表す（設計書§4のコメントどおり。既存部品の前提形）。
 * WP-E5b修正: stairContributionの復路(inbound)flightは、makeFrameのt軸が「往路+踊り場」ぶんの
 * 長さしか確保していないため（SWITCHBACKは復路が並走する別レーンで戻るため）、往路と同じ
 * 世界run区間（runLo/runHi）を逆向き(travelSign反転)に歩くモデルへ修正した（旧実装は
 * t=tRun→1の区間=踊り場の奥行きぶんを復路のrun区間に誤用しており、復路の実長(len2)と
 * 一致しない縮尺で描かれていた）。runLengthMmは実測flight.lengthMm（len1/len2）を単一情報源にする。
 * ASSUMED（設計書に明記が無いため以下の解釈を採用。§9のとおり階段fixture経由の単体テストで
 * 直接検証する）:
 *   - 「レーン縦断」（cut.lineが往路・復路レーンの伸びる方向と同じ向きで、かつそのレーン幅の
 *     内側を通る）→ 段鼻のジグザグ（SILHOUETTE polyline。stairRunProfile）。
 *   - 「横切る」（cut.lineがレーンと直交し、cut.axisValueがそのレーンのrun範囲内）→
 *     正面視の梯子（DETAIL。steps=そのレーンの全段数。位置に応じた部分段数ではなく全段——
 *     seq1「往路=正面梯子(下)／復路=正面梯子(上)」と同じ、レーン全体を正面から見る構図）。
 *   - 踊り場も同じレーン縦断条件（往路・復路と同じrun範囲・全幅）でCUT水平線1本。
 *   - ささら（STEEL限定）は生成したジグザグ点列（zigzag polylineのpoints）ごとに
 *     stringerPrimitives を適用する。
 *   - WP-E5b: どの切断（seqNo）がどちらのレーン(flight)を描くかは、cut.line/viewSign/dirSignの
 *     幾何だけからは（seq2/2.5とseq4/4.5/5が同一のレーン境界線を共有するため）一意に決まらない
 *     ——switchbackCuts.js側がcut.stairCutへ渡すcontributionをflights=[outbound]/[inbound]の
 *     いずれかへ事前に絞り込むことで解決する（本ファイル側のisLengthwiseCut/flightLadder等の
 *     判定ロジックは変更していない）。
 */
import { StairType, StructuralMaterialType } from '@core';
import { roomBounds, refreshCells } from '../../finish/gridCells.js';
import { makeFrame } from '../../finish/stair/stairGeometry.js';
import {
  resolveSwitchbackParams, stairRunProfile, stringerPrimitives, STEEL_STRINGER_DEPTH_MM,
} from '../elevationStairSection.js';
import { ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { localXOf } from './sectionTypes.js';
import { emitLine } from './sectionEmit.js';

/**
 * @typedef {{isVertical:boolean, runLo:number, runHi:number, travelSign:1|-1,
 *   acrossLo:number, acrossHi:number, baseZ:number, riserMm:number, steps:number,
 *   lengthMm:number}} Flight
 * @typedef {{runLo:number, runHi:number, acrossLo:number, acrossHi:number, z:number}} Landing
 */

/**
 * 階段（SWITCHBACKのみ）の3D寄与を、タイプ非依存の区分線形モデル（Flight[]・Landing[]）で返す。
 * SWITCHBACK以外・floorHeight未確定・stair.cellsから設置枠が求まらない場合はnull
 * （resolveSwitchbackParamsのnull契約をそのまま延長）。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {{flights:Flight[], landings:Landing[], structure:string|null}|null}
 */
export function stairContribution(stair, graph, floorHeight) {
  if (!stair || stair.type !== StairType.SWITCHBACK) return null;
  const params = resolveSwitchbackParams(stair, graph, floorHeight);
  if (!params) return null;
  const { n1, n2, riser, len1, landingLen, len2 } = params;

  const bounds = roomBounds(refreshCells(stair.cells, graph), graph);
  if (!bounds) return null;
  const f = makeFrame(stair, bounds);
  const vertical = f.vertical;
  const acrossLo = vertical ? bounds.x1 : bounds.y1;
  const acrossHi = vertical ? bounds.x2 : bounds.y2;
  const acrossMid = (acrossLo + acrossHi) / 2;

  const tRun = len1 / (len1 + landingLen);
  const p0 = f.pt(0, 0), pRun = f.pt(tRun, 0), p1 = f.pt(1, 0);
  const coordAt0   = vertical ? p0.y   : p0.x;
  const coordAtRun = vertical ? pRun.y : pRun.x;
  const coordAt1   = vertical ? p1.y   : p1.x;

  const outbound = {
    isVertical: vertical,
    runLo: Math.min(coordAt0, coordAtRun), runHi: Math.max(coordAt0, coordAtRun),
    travelSign: coordAtRun >= coordAt0 ? 1 : -1,
    acrossLo, acrossHi: acrossMid, baseZ: 0, riserMm: riser, steps: n1, lengthMm: len1,
  };
  const landingZ = n1 * riser;
  // WP-E5b修正: makeFrameのt軸は「往路(t:0→tRun)＋踊り場(t:tRun→1)」の1往復ぶんの長さしか
  // 確保していない（SWITCHBACKは復路が別レーンを並走して戻るため、room bboxの走行軸長は
  // len1+landingLenで足りる。t=tRun→1の区間[coordAtRun,coordAt1]は踊り場の奥行きそのもの）。
  // 復路（inbound）は往路と同じレーン区間（世界の走行軸範囲）を逆向きに歩く——
  // t=tRun→1の区間をそのまま復路のrunLo/runHiに使うと、復路の実長(len2)がlandingLen相当の
  // 区間に押し込まれ、往路と同じ位置（踊り場の実際の位置）にも重なってしまう。
  // runLo/runHiはoutboundと同じ世界レーン区間を再利用し、走行方向(travelSign)だけ反転する。
  const inbound = {
    isVertical: vertical,
    runLo: outbound.runLo, runHi: outbound.runHi,
    travelSign: -outbound.travelSign,
    acrossLo: acrossMid, acrossHi, baseZ: landingZ, riserMm: riser, steps: n2, lengthMm: len2,
  };
  const landing = {
    runLo: Math.min(coordAtRun, coordAt1), runHi: Math.max(coordAtRun, coordAt1),
    acrossLo, acrossHi, z: landingZ,
  };

  return { flights: [outbound, inbound], landings: [landing], structure: stair.structure ?? null };
}

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

// cut.lineが対象（レーン・踊り場）を「縦断」しているか（向きが一致・幅の内側・run範囲が重なる）。
function isLengthwiseCut(entityIsVertical, entityAcrossLo, entityAcrossHi, entityRunLo, entityRunHi, cut) {
  return cut.line.isVertical === entityIsVertical &&
    cut.line.axisValue >= entityAcrossLo - GAP_EPS && cut.line.axisValue <= entityAcrossHi + GAP_EPS &&
    rangesOverlap(cut.line.lo, cut.line.hi, entityRunLo, entityRunHi);
}

// columns のうち、世界run座標が[runLo,runHi]と重なるものだけのローカルx範囲（Math.min/max）。
// 該当なしはnull。
function columnsXRangeOverlapping(columns, runLo, runHi) {
  const relevant = columns.filter(c => rangesOverlap(c.worldLo, c.worldHi, runLo, runHi));
  if (relevant.length === 0) return null;
  const xs = relevant.flatMap(c => [c.x0, c.x1]);
  return { loX: Math.min(...xs), hiX: Math.max(...xs) };
}

// columns全体（この切断の描画される全ローカルx範囲=[0,face.run]相当）のMath.min/max。空なら
// クランプ無し（[-Infinity,Infinity]）。
function fullColumnsXRange(columns) {
  if (!columns || columns.length === 0) return { loX: -Infinity, hiX: Infinity };
  const xs = columns.flatMap(c => [c.x0, c.x1]);
  return { loX: Math.min(...xs), hiX: Math.max(...xs) };
}

// レーン縦断: 段鼻のジグザグ（SILHOUETTE）。runLengthMmは実測flight.lengthMm（無ければ
// runHi-runLoへフォールバック。§9 WP-E5b修正: coordAt由来のrunHi-runLoは往路・復路で
// 一致しない場合があるため、実測長を単一情報源にする）。
// 点列のxはcolumns全体の範囲へクランプする（WP-E5b発見: stairContributionのrunLo/runHi
// （roomBounds由来・生の室境界）とcut.line.lo/hi（wOut1.lo/hi・壁仕上げ面へスナップ済み）は
// 半壁厚ぶんズレることがあり、面のローカル範囲[0,run]をわずかに超える点が出ることがあるため
// （回帰: 「浅い階段室」テスト参照）。
function flightZigzagPrimitives(flight, cut, columns) {
  if (!isLengthwiseCut(flight.isVertical, flight.acrossLo, flight.acrossHi, flight.runLo, flight.runHi, cut)) return [];
  const worldStart = flight.travelSign > 0 ? flight.runLo : flight.runHi;
  const localDir = flight.travelSign * cut.dirSign; // ローカルx方向の歩行方向
  const startX = localXOf(cut, worldStart);
  const runLengthMm = flight.lengthMm ?? (flight.runHi - flight.runLo);
  const { points } = stairRunProfile(flight.steps, flight.riserMm, runLengthMm, startX, -flight.baseZ, localDir);
  const { loX, hiX } = fullColumnsXRange(columns);
  const clamped = points.map(([x, y]) => [Math.min(hiX, Math.max(loX, x)), y]);
  return [{ type: 'polyline', points: clamped, weight: weightForRole(ElevationLineRole.SILHOUETTE) }];
}

// レーンを横切る: 正面視の梯子（DETAIL。全段=steps）。flight.baseZがcut.baseFloorZより低い
// （＝見返りの基準床より下の区間）なら破線にする（WP-E5b: seq1「踊り場より下の往路踏面は
// 破線」の一般化。emitLineの§5.6最終フィルタと役割は重なるが、往路全体を一律破線にする
// 既存仕様に合わせここでも明示指定する——両者が重複適用されても結果は変わらない）。
function flightLadderPrimitives(flight, cut, columns) {
  const crosses = cut.line.isVertical !== flight.isVertical &&
    cut.line.axisValue >= flight.runLo - GAP_EPS && cut.line.axisValue <= flight.runHi + GAP_EPS;
  if (!crosses) return [];
  // 横切るcutのcolumnsは（cut.lineに沿って）幅方向(across)のx区間である——flightのacrossLo/Hi
  // （走行方向ではなく）と重なる列だけに絞る（run方向で絞るflightZigzag/landingCutとは軸が違う）。
  const range = columnsXRangeOverlapping(columns, flight.acrossLo, flight.acrossHi);
  if (!range) return [];
  const { loX, hiX } = range;
  const dashed = flight.baseZ < (cut.baseFloorZ ?? 0) - GAP_EPS;
  const steps = Math.max(0, Math.round(flight.steps));
  const prims = [];
  for (let k = 1; k <= steps; k++) {
    const z = flight.baseZ + k * flight.riserMm;
    prims.push(emitLine(cut, loX, z, hiX, z, ElevationLineRole.DETAIL, dashed ? { dash: 'dashed' } : {}));
  }
  return prims;
}

// 踊り場のレーン縦断: 床のCUT水平線1本（columns中、踊り場のrun範囲と重なる列のx範囲のみ）。
function landingCutPrimitives(landing, stairIsVertical, cut, columns) {
  if (!isLengthwiseCut(stairIsVertical, landing.acrossLo, landing.acrossHi, landing.runLo, landing.runHi, cut)) return [];
  const range = columnsXRangeOverlapping(columns, landing.runLo, landing.runHi);
  if (!range) return [];
  return [emitLine(cut, range.loX, landing.z, range.hiX, landing.z, ElevationLineRole.CUT)];
}

/**
 * stairContribution の結果を、1つの切断（cut）・その列配列（columns。x範囲の決定にのみ使う——
 * 塞ぎ判定等は行わない）に対する断面プリミティブへ変換する。
 * @param {{flights:Flight[], landings:Landing[], structure:string|null}|null} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @returns {object[]}
 */
export function stairPrimitivesForCut(contribution, cut, columns) {
  if (!contribution) return [];
  const prims = [];
  const stairIsVertical = contribution.flights[0]?.isVertical ?? cut.line.isVertical;
  const zigzagPointsList = [];
  for (const flight of contribution.flights ?? []) {
    const zig = flightZigzagPrimitives(flight, cut, columns);
    if (zig.length > 0) { prims.push(...zig); zigzagPointsList.push(zig[0].points); }
    prims.push(...flightLadderPrimitives(flight, cut, columns));
  }
  for (const landing of contribution.landings ?? []) {
    prims.push(...landingCutPrimitives(landing, stairIsVertical, cut, columns));
  }
  // ささら（鉄骨のみ。§6「鉄骨階段のみ」）: 各レーンのジグザグ点列ごとに桁成ぶん下げた輪郭を追加する。
  if (contribution.structure === StructuralMaterialType.STEEL) {
    for (const points of zigzagPointsList) prims.push(...stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM));
  }
  return prims;
}
