// ================================================================
// 固定梁（dimensionStatus!=='auto'）と幾何的に重なる auto 梁の判定・撤去（純関数）。
//
// 指示書 dev直下 260929_手動追加材サイレント撤去回避.md §2.5・§4 Q1/Q2・§5 ステップ2 の実装。
// 固定梁と同軸で区間が重なる auto 梁は「生成しない」＋「既に在る auto 梁は撤去する」（手動追加の
// その場でも撤去する）。除外集合（excludedBeamSlots）は触らない——撤去は spanKey の候補外れと
// 同じ「自然な後始末」であり、ユーザーの明示削除の記録ではないため（autoFillBeams の既存撤去ループと
// 同じ規律）。
//
// 対象は同 role のみ（材種は見ない）。固定 primary が auto foundation/eaves/sill/secondary を
// 止めることは無い（autoFillBeams の撤去ループが role で絞る、土台と基礎梁は同区間に並ぶのが正しい
// ——structural-model.md 参照）。
//
// 在来木造（beamPlacement:'wallRuns'／roofBeamPlacement:'wallRuns'）は対象外（別裁定待ち）。
// 在来木造の生成は非分割run単位で固定梁との幾何重なりを見ずauto梁を作り直すため、その場で撤去すると
// 次の再計算で復活して往復する。在来木造には既に同じ目的の幾何ガードがある
// （woodAutoFill.js lockedFullBeamOverlap。対象roleが異なるため統合しない）。
//
// 呼び出し元: structuralAutoFill.js（autoFillBeams・autoFillRoofBeams・autoFillBeamsForStructure隣の
// fixedBeamGuardHonored）・manualMemberAdd.js（addManualBeam）。
//
// 純モジュール: react/.jsx/store.js/snap.js を静的 import しない。core/constants.js のみ依存する
// （structuralAutoFill.js に直接置かないのは、将来 woodAutoFill.js から使っても循環 import にならない
// ようにするため）。
// ================================================================
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';

/** 梁（またはcomputeGridSpansの候補span）の軸上の区間を返す。
 *  coordは軸座標（axisCL.effectiveValue）——beam.axisValue（偏芯・柱芯オフセット込み）は使わない
 *  （S造外周の固定梁を取りこぼすため。core/structuralEntities.js参照）。 */
export function beamAxisSpan(beam) {
  const lo = Math.min(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
  const hi = Math.max(beam.clStart.effectiveValue, beam.clEnd.effectiveValue);
  return { isVertical: beam.isVertical, coord: beam.axisCL.effectiveValue, lo, hi };
}

/** 2つの軸区間が幾何的に重なるか（開区間。端点で接するだけは重ならない）。
 *  向きが異なる、または軸座標がtol以上離れていれば重ならない。 */
export function spansOverlapOnAxis(a, b, tol = CL_OVERLAP_TOL_MM) {
  return a.isVertical === b.isVertical
    && Math.abs(a.coord - b.coord) < tol
    && a.lo < b.hi - tol && a.hi > b.lo + tol;
}

/** beams のうち role 一致・非 auto（固定）な梁の軸区間を列挙する。 */
export function fixedBeamSpans(beams, role) {
  return beams.filter(b => b.role === role && b.dimensionStatus !== 'auto').map(beamAxisSpan);
}

/** span が spans のどれかと重なるか。 */
export function overlapsAnySpan(span, spans, tol = CL_OVERLAP_TOL_MM) {
  return spans.some(s => spansOverlapOnAxis(span, s, tol));
}

/** graph 内の role 一致・auto な梁のうち、spans のどれかと軸上で重なるものを撤去し、撤去した梁idの
 *  配列を返す。撤去は woodAutoFill.js の各撤去ループ／structuralAutoFill.js の踊り場受け梁の撤去
 *  （autoFillStairLandingBeams、L558付近の removedStale 撤去ループ）と同じ規律（梁ホストの貫通
 *  スリーブを連鎖削除→graph.beamMap.delete。graph.removeBeam は使わない＝excludedBeamSlots に
 *  記録しない）——autoFillBeams/autoFillRoofBeams 自身の既存撤去ループ（spanKey不一致による撤去）は
 *  スリーブを消さないため、それとは異なる規律であることに注意。 */
export function removeAutoBeamsOverlapping(graph, role, spans, tol = CL_OVERLAP_TOL_MM) {
  if (spans.length === 0) return [];
  const removed = [];
  for (const beam of graph.beams) {
    if (beam.role !== role || beam.dimensionStatus !== 'auto') continue;
    if (!overlapsAnySpan(beamAxisSpan(beam), spans, tol)) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }
  return removed;
}
