/**
 * 在来木造の折返し階段（SWITCHBACK）の隔て壁（平面）の生成（隔て壁 S2）。
 *
 * 隔て壁は往路・復路レーンの間（レーン間中心線 s=0.5）に立つ。形は「下地オーナー壁＋仕上げ薄壁」
 * （.claude/stair-model.md・finish/wallGeneration.js の所有権解決と同じ2枚方式）:
 *   - オーナー壁: axisOffset=+57.5・finishSide=+1・backingOffset=0・backingDepth=90（90角の下地を軸中心に）
 *   - 薄壁:       axisOffset=−57.5・finishSide=−1・backingDepth=0（反対面の仕上げ12.5のみ）
 * 総厚 115 = 90 + 12.5×2（stairPartition.js の PARTITION_* が唯一の供給源）。仕上げ厚は固定
 * （dimsOf/roomWallDims・柱寸法シフト bandShift は使わない）。
 *
 * 軸CL・端CLは既存のものを探すだけで作らない（レーン間中心線・分割線CLは階段下分割で既に在る前提。
 * 無い・区間を覆っていない場合は黙ってその区間を生成しない）。軸CLは同座標の分割線CL
 * （isFinishCellDivider。梁芯・補助線は不可）、端CLは直交する分割線CL。
 *
 * どの Room の generatedWallIds にも入れない（2a のクリップ・CL偏芯・所有権解決・外壁オーナー化の
 * 対象外）。識別は座標照合（stairPartition.js isStairPartitionWall）。
 *
 * 既知の限界: 手動壁との重なりは見ない（同位置に手動壁があれば二重になる）。
 * 構造（梁芯・柱）・腰壁からの除外は S5 までの暫定（structural/wallBeamAxes.js・finish/kneeDropWall.js）。
 *
 * 純モジュール: store.js / snap.js / *.jsx を静的 import しない。
 */
import { CenterLineType, RoomKind } from '@core';
import { sameCoordCounterparts, isFinishCellDivider, coversAlongAxis } from '../../core/centerLineKindPolicy.js';
import { isTraditionalWoodStructure } from '../../structural/structureRules.js';
import {
  stairPartitionGeometry, PARTITION_BACKING_MM, PARTITION_FINISH_MM,
} from './stairPartition.js';

const TOL_MM = 0.5;
const MIN_SEGMENT_MM = 1;
const OWNER_OFFSET_MM = PARTITION_BACKING_MM / 2 + PARTITION_FINISH_MM; // 57.5

// 同座標の分割線CLのうち、coverCoords すべてを軸方向に覆うものの先頭（無ければ null）。
function findDividerCL(graph, centerLineType, value, coverCoords) {
  const cands = sameCoordCounterparts(graph, { centerLineType, value }).filter(isFinishCellDivider);
  return cands.find(cl => coverCoords.every(c => coversAlongAxis(cl, c, TOL_MM))) ?? null;
}

// [lo,hi] から claimed（同じ向き・同じ軸の2a区間）を差し引いた残りの区間（長さ>1mm）
function subtractClaimed(lo, hi, claimed) {
  let segs = [[lo, hi]];
  for (const c of claimed) {
    const next = [];
    for (const [a, b] of segs) {
      if (c.hi <= a || c.lo >= b) { next.push([a, b]); continue; }
      if (c.lo > a) next.push([a, c.lo]);
      if (c.hi < b) next.push([c.hi, b]);
    }
    segs = next;
  }
  return segs.filter(([a, b]) => b - a > MIN_SEGMENT_MM);
}

/**
 * 隔て壁を生成して返す（オーナー壁→薄壁の順に区間ごと）。
 * @param {object} graph
 * @param {{ structure:string|null, underEdges?:Array<{isVertical:boolean,value:number,lo:number,hi:number}> }} opts
 *   structure … 実効主構造（在来木造以外は生成しない）。
 *   underEdges … 2a が受け持った辺。同じ軸上の区間は差し引く（2a が両レーンの壁を持つ区間は重ねない）。
 *     値は computeClaimedEdges の axisCL.value（生の value）。軸CLの探索（sameCoordCounterparts）も value で
 *     比べるので両者は揃う。限界: 子CL（refOffset あり）で value≠effectiveValue のとき、軸CLが見つからず
 *     黙って生成しない（computeClaimedEdges の他の消費者も生の value で比べるため、そちらは変えない）。
 * @returns {import('@core').Wall[]}
 */
export function generateStairPartitionWalls(graph, { structure = null, underEdges = [] } = {}) {
  if (!isTraditionalWoodStructure(structure)) return [];
  const walls = [];
  for (const stair of graph.stairs) {
    // 屋外階段は壁なし（wallRegeneration の屋外部屋と同じ扱い。stairPartition.js stairPartitionLines と同条件）
    const g = stairPartitionGeometry(stair, graph);
    if (!g) continue;
    if (graph.roomMap.get(stair.roomId)?.kind === RoomKind.EXTERIOR) continue;
    const [axisType, endType] = g.isVertical
      ? [CenterLineType.VERTICAL, CenterLineType.HORIZONTAL]
      : [CenterLineType.HORIZONTAL, CenterLineType.VERTICAL];

    const claimed = underEdges.filter(e => e.isVertical === g.isVertical && Math.abs(e.value - g.axisValue) < TOL_MM);
    for (const [lo, hi] of subtractClaimed(g.lo, g.hi, claimed)) {
      const axisCL = findDividerCL(graph, axisType, g.axisValue, [lo, hi]);
      const startCL = findDividerCL(graph, endType, lo, [g.axisValue]);
      const endCL = findDividerCL(graph, endType, hi, [g.axisValue]);
      if (!axisCL || !startCL || !endCL) continue;
      const common = { isRoomWall: true, wallFinish: PARTITION_FINISH_MM, backingOffset: 0 };
      // オーナー壁を先に（展開図 findMidWall が先に見つけた壁を使う）
      walls.push(graph.addWall(axisCL, OWNER_OFFSET_MM, g.isVertical, startCL, 0, endCL, 0,
        { ...common, backingDepth: PARTITION_BACKING_MM, finishSide: 1 }));
      walls.push(graph.addWall(axisCL, -OWNER_OFFSET_MM, g.isVertical, startCL, 0, endCL, 0,
        { ...common, backingDepth: 0, finishSide: -1 }));
    }
  }
  return walls;
}
