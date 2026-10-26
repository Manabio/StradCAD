// ================================================================
// S造スラブを支える子梁（小梁）の梁芯の割付け（ユーザー指示2026-10-26「スパン間を2500mm以下等間隔に
// 割り付ける」）。大梁（と開口辺の小梁）で4辺囲まれたベイ（framingCells.js beamGridCells）の短辺が
// 最大ピッチを超えるとき、長辺方向に等分して梁芯CL（beamAxisOrigin:FLOOR_BEAM）を生成する。子梁そのものは
// 既存の小梁生成（structuralAutoFill.js autoFillSecondaryBeams）が梁芯から作る。
// 在来木造の床梁（woodAutoFill.js autoFillWoodFloorBeams）と等分の式を framingCells.js divideBayEqually で共有する。
//
// react/konva/store/.jsx を静的に引かない（node:test から単体 import 可能）。
// 個別の位置変更・ベイ単位の除外は後続ステップ（S2）。ここは既定の割付けだけ。
// ================================================================
import { CenterLineType, Discipline } from '../core.js';
import { BeamRole, CL_OVERLAP_TOL_MM, SlabBayFillSkip, SlabSecondaryBeamPlacement } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { beamAxisCenterLines } from '../core/centerLineKindPolicy.js';
import { findHostBeam } from '../core/structuralEntities.js';
import { beamGridCells, divideBayEqually } from './framingCells.js';
import { wallBeamAxisExcludeKey } from './wallBeamAxes.js';
import { rulesFor, effectiveStructure } from './structureRules.js';

/**
 * 境界線 lines（大梁・開口辺の小梁）で囲まれた各ベイの割付けを純粋に計画する（graph を受けない）。
 * 開口との重なり・短辺の判定だけを行い、端の受け梁（NO_HOST）・既存梁芯（OCCUPIED）の判定は graph が要るため
 * autoFillSlabSecondaryBeamAxes 側。開口判定を短辺判定より先に行う（開口自身のベイは OPENING と報告する）。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} lines
 * @param {Array<{x1:number, x2:number, y1:number, y2:number}>} openingRects 床開口の矩形
 * @param {number} maxPitchMm
 * @returns {Array<{cell:object, isVertical:boolean, coords:number[], shortLo:number, shortHi:number}|{cell:object, skip:string}>}
 */
export function planSlabSecondaryBeamAxes(lines, openingRects, maxPitchMm) {
  return beamGridCells(lines).map((cell) => {
    // セル内部と面積で重なる開口（辺で接するだけは重ならない）。
    const overlapsOpening = openingRects.some(r =>
      Math.min(cell.x2, r.x2) - Math.max(cell.x1, r.x1) > CL_OVERLAP_TOL_MM &&
      Math.min(cell.y2, r.y2) - Math.max(cell.y1, r.y1) > CL_OVERLAP_TOL_MM);
    if (overlapsOpening) return { cell, skip: SlabBayFillSkip.OPENING };
    const division = divideBayEqually(cell, maxPitchMm);
    if (!division) return { cell, skip: SlabBayFillSkip.SHORT_SPAN };
    const { isVertical, coords, shortLo, shortHi } = division;
    return { cell, isVertical, coords, shortLo, shortHi };
  });
}

// ベイ内部に、境界を作っていない梁芯（全由来）が1本でもあるか。長辺方向は両端 tol を除いた開区間、
// 梁芯の走る方向は extent（null は無限）との重なり > tol。梁芯の向きは問わない（直交する梁芯も子梁と交差する）。
function bayHasBeamAxis(graph, cell, boundaryAxisIds) {
  return beamAxisCenterLines(graph).some((cl) => {
    if (boundaryAxisIds.has(cl.id)) return false;
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    if (!isVertical && cl.centerLineType !== CenterLineType.HORIZONTAL) return false;
    const [across1, across2, along1, along2] = isVertical
      ? [cell.x1, cell.x2, cell.y1, cell.y2] : [cell.y1, cell.y2, cell.x1, cell.x2];
    const v = cl.effectiveValue;
    if (!(v > across1 + CL_OVERLAP_TOL_MM && v < across2 - CL_OVERLAP_TOL_MM)) return false;
    const lo = cl.extentLo ?? -Infinity, hi = cl.extentHi ?? Infinity;
    return Math.min(hi, along2) - Math.max(lo, along1) > CL_OVERLAP_TOL_MM;
  });
}

/**
 * S造のスラブ小梁の梁芯を、ベイごとに等ピッチで生成する（structureRules.js slabSecondaryBeams が null の主構造・
 * 基礎伏図・屋根専用平面では呼び出し側が呼ばない／ここで空を返す）。
 *  - 境界: role primary・landing の大梁、および由来 OPENING の梁芯に乗る小梁（開口辺）。座標は梁芯の
 *    effectiveValue（外周の大梁は偏芯しうる）。USER・FLOOR_BEAM 由来の梁芯に乗る小梁は境界にしない
 *    （自分の子梁が次のパスで区画を割らないため）。
 *  - 端: 短辺の両端に通り芯があり、各座標でその通り芯上の大梁（primary）が子梁を受けること。無ければ NO_HOST
 *    （端が踊り場受け梁・開口小梁のベイは作らない）。
 *  - OCCUPIED: ベイ内に境界でない梁芯が既にあれば丸ごと作らない（冪等・手動の梁芯の尊重・削除した梁芯の非復活）。
 *  - 座標ごと: 同方向の通り芯と一致する座標・除外集合（excludedWallBeamAxes）にある座標は作らない。座標は丸めない。
 * 梁芯の extent は端の通り芯への参照（autoFillSecondaryBeams が host を引く範囲になる）。refId は持たせない。
 * @param {object} graph
 * @param {object} project
 * @param {Array<{x1:number, x2:number, y1:number, y2:number}>} [openingRects] 床開口のセル矩形の集合
 *   （openingBeamAxes.js openingCellRects。矩形フィルタの前の情報＝L字などの非矩形の開口も含む）。省略は開口なし
 * @returns {{created: object[], skipped: Array<{cell:object, reason:string}>}}
 */
export function autoFillSlabSecondaryBeamAxes(graph, project, openingRects = undefined) {
  const result = { created: [], skipped: [] };
  const spec = rulesFor(effectiveStructure(graph, project)).slabSecondaryBeams;
  if (!spec || spec.kind !== SlabSecondaryBeamPlacement.EQUAL_PITCH) return result;

  const boundaryBeams = graph.beams.filter(b =>
    b.role === BeamRole.PRIMARY || b.role === BeamRole.LANDING ||
    (b.role === BeamRole.SECONDARY && b.axisCL.beamAxisOrigin === BeamAxisOrigin.OPENING));
  const lines = boundaryBeams.map((b) => {
    const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
    return { isVertical: b.isVertical, coord: b.axisCL.effectiveValue, lo: Math.min(a, c), hi: Math.max(a, c) };
  });
  const boundaryAxisIds = new Set(boundaryBeams.map(b => b.axisCL.id));

  for (const plan of planSlabSecondaryBeamAxes(lines, openingRects ?? [], spec.maxPitchMm)) {
    const { cell } = plan;
    if (plan.skip) { result.skipped.push({ cell, reason: plan.skip }); continue; }
    const { isVertical, coords, shortLo, shortHi } = plan;

    // 端の通り芯（子梁の走る方向の両端）と、そこに子梁を受ける大梁があること。
    const crossGrids = isVertical ? graph.gridYs : graph.gridXs;
    const endGrid = v => crossGrids.find(g => Math.abs(g.effectiveValue - v) <= CL_OVERLAP_TOL_MM);
    const loGrid = endGrid(shortLo), hiGrid = endGrid(shortHi);
    const hosted = g => !!g && coords.every(c => findHostBeam(graph.beams, g.id, !isVertical, c));
    if (!hosted(loGrid) || !hosted(hiGrid)) { result.skipped.push({ cell, reason: SlabBayFillSkip.NO_HOST }); continue; }

    if (bayHasBeamAxis(graph, cell, boundaryAxisIds)) { result.skipped.push({ cell, reason: SlabBayFillSkip.OCCUPIED }); continue; }

    const axisType = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const sameDirGrids = isVertical ? graph.gridXs : graph.gridYs;
    for (const coord of coords) {
      if (sameDirGrids.some(g => Math.abs(g.effectiveValue - coord) <= CL_OVERLAP_TOL_MM)) continue; // 通り芯が梁芯を兼ねる
      if (graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(isVertical, coord))) continue; // 手動削除の尊重
      result.created.push(graph.addCenterLine(axisType, coord, {
        labeled: false,
        discipline: Discipline.FUSE,
        extentLoRef: { clId: loGrid.id, offset: 0 },
        extentHiRef: { clId: hiGrid.id, offset: 0 },
        extentLo: null,
        extentHi: null,
        beamAxisOrigin: BeamAxisOrigin.FLOOR_BEAM,
      }));
    }
  }
  return result;
}
