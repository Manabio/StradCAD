/**
 * 折返し階段（SWITCHBACK）の踊り場矩形・外周辺CLの単一情報源（WP-A1。architect承認済み実装
 * 指示書§6 A1）。従来 elevation/section/sectionStair.js の stairContribution 内に直接書かれていた
 * 「踊り場の世界矩形」導出式をここへ移設し、structural側（WP-B2・踊り場受け梁の自動生成）とも
 * 共有する。純モジュール（node:testから単体import可能。store.js/snap.js/*.jsx/react-konva/
 * appViewport.jsを静的importしない）——finish/stair/ 配下は elevation/ に依存しない
 * （elevation/ が finish/stair/ を消費する側。逆方向のimportは循環・層違反になるため避ける）。
 *
 * landingRect(stair, graph): 踊り場の世界矩形{x1,y1,x2,y2}。sectionStair.js の stairContribution
 * が返す Landing の runLo/runHi・acrossLo/acrossHi と同じ式（makeFrame(stair,bounds)のt/s軸を
 * 使い、走行方向(run)の踊り場開始位置=t=tRun〜終端=t=1、幅方向(across)は全幅=s=0〜s=1）。
 * landingEdgeCLs(stair, graph): 踊り場矩形の外周4辺を、stair.cells のセルキー
 * （`leftId:topId:rightId:bottomId`。gridCells.js の cellBoundsFromKey と同じ規約）から直接
 * 引いたCL idで表す（新CLは作らない。elevationFloorProfile.js の runBoundaryCLIds と同じ規約）。
 * kind: 'front'（レーンに接する側=踊り場開始位置t=tRun側）/'back'（反対=t=1側）/'side'（走行軸に
 * 平行な残り2辺）。
 */
import { roomBounds, refreshCells, cellBoundsFromKey } from '../gridCells.js';
import { makeFrame } from './stairGeometry.js';
import { resolveSwitchbackSpanLengths } from './stairClassify.js';

// mm — cellBoundsFromKeyの実測値とlandingRectの計算値を突き合わせる際の許容差
// （stairClassify.jsのSTRAIGHT_ENTRY_MID_EPS等と同スケール）。
const EDGE_EPS_MM = 1;

// 踊り場の幾何一式（landingRect・landingEdgeCLsが共有する内部計算）。SWITCHBACK以外・
// floorHeight未確定ではなく「セル配置から矩形が求まらない」場合はnull。
function computeLandingFrame(stair, graph) {
  const spanInfo = resolveSwitchbackSpanLengths(stair, graph);
  if (!spanInfo) return null;
  const bounds = roomBounds(refreshCells(stair.cells, graph), graph);
  if (![bounds.x1, bounds.y1, bounds.x2, bounds.y2].every(Number.isFinite)) return null;

  const f = makeFrame(stair, bounds);
  const vertical = f.vertical;

  // 走行方向(run): 踊り場は t=tRun（往路の終端＝踊り場の開始）〜t=1（踊り場の奥＝終端）。
  const tRun = spanInfo.len1 / (spanInfo.len1 + spanInfo.landingLen);
  const pRun = f.pt(tRun, 0), p1 = f.pt(1, 0);
  const coordAtRun = vertical ? pRun.y : pRun.x;
  const coordAt1   = vertical ? p1.y   : p1.x;
  const runLo = Math.min(coordAtRun, coordAt1), runHi = Math.max(coordAtRun, coordAt1);

  // 幅方向(across): 踊り場は全幅（s=0〜s=1）。
  const acrossAt = s => { const p = f.pt(0, s); return vertical ? p.x : p.y; };
  const a0 = acrossAt(0), a1 = acrossAt(1);
  const acrossLo = Math.min(a0, a1), acrossHi = Math.max(a0, a1);

  const rect = vertical
    ? { x1: acrossLo, y1: runLo, x2: acrossHi, y2: runHi }
    : { x1: runLo, y1: acrossLo, x2: runHi, y2: acrossHi };

  // frontIsLo: t=tRun側（レーンに接する側=front）がrunLo（矩形の低座標側）に来ているか。
  return { vertical, rect, frontIsLo: coordAtRun <= coordAt1 };
}

/**
 * 踊り場の世界矩形（{x1,y1,x2,y2}。x1<=x2・y1<=y2）を返す。
 * SWITCHBACK以外・stair.cellsからセル配置が求まらない場合はnull。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @returns {{x1:number, y1:number, x2:number, y2:number}|null}
 */
export function landingRect(stair, graph) {
  return computeLandingFrame(stair, graph)?.rect ?? null;
}

// stair.cells のうち rect（landingRectの結果）に含まれるセルだけから、矩形の外周4辺（x1/x2/y1/y2）
// それぞれに接するCL idを集める。同じ辺に複数セルが接していても同一CL idのはず（矩形境界のため）。
function landingCellBoundaryIds(stair, graph, rect) {
  let leftId = null, rightId = null, topId = null, bottomId = null;
  for (const key of refreshCells(stair.cells, graph)) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    const within = cb.x1 >= rect.x1 - EDGE_EPS_MM && cb.x2 <= rect.x2 + EDGE_EPS_MM &&
      cb.y1 >= rect.y1 - EDGE_EPS_MM && cb.y2 <= rect.y2 + EDGE_EPS_MM;
    if (!within) continue;
    const [l, t, r, b] = key.split(':');
    if (Math.abs(cb.x1 - rect.x1) < EDGE_EPS_MM) leftId = l;
    if (Math.abs(cb.x2 - rect.x2) < EDGE_EPS_MM) rightId = r;
    if (Math.abs(cb.y1 - rect.y1) < EDGE_EPS_MM) topId = t;
    if (Math.abs(cb.y2 - rect.y2) < EDGE_EPS_MM) bottomId = b;
  }
  if (!leftId || !rightId || !topId || !bottomId) return null;
  return { leftId, rightId, topId, bottomId };
}

/**
 * 踊り場矩形の外周4辺を、stair.cells のセルキーから直接引いたCL idで返す（新CLは作らない）。
 * SWITCHBACK以外・矩形の外周に対応するセルキーが見つからない場合はnull。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @returns {Array<{isVertical:boolean, axisCL:string, clStart:string, clEnd:string,
 *   kind:'front'|'back'|'side'}>|null}
 */
export function landingEdgeCLs(stair, graph) {
  const frame = computeLandingFrame(stair, graph);
  if (!frame) return null;
  const { vertical, rect, frontIsLo } = frame;
  const ids = landingCellBoundaryIds(stair, graph, rect);
  if (!ids) return null;
  const { leftId, rightId, topId, bottomId } = ids;

  // side辺（走行軸に平行。幅方向acrossLo/acrossHiの2辺）: verticalなら固定x(left/right)、
  // !verticalなら固定y(top/bottom)。clStart/clEndは辺自身の走行方向の範囲（run側のCL対）。
  const sideLo = {
    isVertical: vertical, axisCL: vertical ? leftId : topId,
    clStart: vertical ? topId : leftId, clEnd: vertical ? bottomId : rightId, kind: 'side',
  };
  const sideHi = {
    isVertical: vertical, axisCL: vertical ? rightId : bottomId,
    clStart: vertical ? topId : leftId, clEnd: vertical ? bottomId : rightId, kind: 'side',
  };
  // run辺（走行軸に直交。front=レーンに接する側／back=反対）: verticalなら固定y(top/bottom)、
  // !verticalなら固定x(left/right)。clStart/clEndは辺自身の幅方向の範囲（across側のCL対）。
  const runLoEdge = {
    isVertical: !vertical, axisCL: vertical ? topId : leftId,
    clStart: vertical ? leftId : topId, clEnd: vertical ? rightId : bottomId,
    kind: frontIsLo ? 'front' : 'back',
  };
  const runHiEdge = {
    isVertical: !vertical, axisCL: vertical ? bottomId : rightId,
    clStart: vertical ? leftId : topId, clEnd: vertical ? rightId : bottomId,
    kind: frontIsLo ? 'back' : 'front',
  };

  return [runLoEdge, runHiEdge, sideLo, sideHi];
}

/**
 * 踊り場の絶対z（設置階FL基準・mm）= n1（往路の段数）× riser（蹴上）。WP-B2（踊り場受け梁の
 * 既定天端レベル算出）向け。riser式は elevation/elevationStairSection.js の
 * resolveSwitchbackParams と同じ（stair.riser優先・無ければ階高/総段数）だが、finish/stair/
 * 配下は elevation/ に依存しない方針（ファイル冒頭コメント参照）のためここに複製する
 * （circular import回避が目的の意図的な重複。riser式を変更する場合は両方揃えること）。
 * SWITCHBACK以外・riserが求まらない（floorHeight未確定かつstair.riserも未指定）場合はnull。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)
 * @returns {number|null}
 */
export function landingZ(stair, graph, floorHeight) {
  const spanInfo = resolveSwitchbackSpanLengths(stair, graph);
  if (!spanInfo) return null;
  const riser = stair?.riser ?? (floorHeight != null ? floorHeight / spanInfo.totalSteps : null);
  if (riser == null) return null;
  return spanInfo.n1 * riser;
}
