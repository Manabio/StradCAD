/**
 * 在来木造の折返し・回り階段（U 字系）の隔て梁（role:'partitionBeam'、beamType:'隔て梁'、記号PG、断面 90×90）の自動生成
 * （隔て壁 S5。ユーザー裁定2026-10-07「2→3階以降も同位置に階段がある場合は、各階床梁から90角梁を出して、
 * 上下に回転部柱がとりつくようにして。『踊り場下から支える』はなし」。位置は確認済み＝隔て壁の真上）。
 * 設計意図は .claude/structural-model.md「隔て梁」の節。
 *
 * 階Nの隔て壁の両端に柱があり（S3'）、その上の階N+1にも同じ位置に折返し・回り階段があるとき、N+1 の床レベルに
 * 隔て壁の区間 [lo,hi]（レーン間中心線上）へ90角の梁を1本架ける。上り口側の端は N+1 の開口辺の床梁に、
 * 踊り場側の端は N の回転部柱に載り、N+1 の回転部柱はこの梁に立つ。続く階が無い最上層は階段が自階だけなので
 * 下階の隔て壁の端が無く、梁は作らない。
 *
 * 入力は「下階の隔て壁の端の座標（belowPartitionEnds）」と自階の階段（stairPartitionLines）だけ——他階の実体は
 * 座標だけ持ち込む（1パスで収束）。自階の部材は読まない（自分の出力を入力にしない）。
 * 端・軸のCLは柱と同じ解決（woodAutoFill.js resolveWoodColumnAnchorCL。通り芯／梁芯→意匠中心線）で、CL は作らない
 * （解決できなければ黙って生成しない）。role を新設するのは、primary/floor/secondary だと 3c の撤去・3d の梁成・
 * 3h-2/3i の点源に入ってしまうため。
 *
 * 毎回再生成の自動部材: 撤去は beamMap.delete を直接使う（graph.removeBeam は使わない＝excludedBeamSlots を汚さない）。
 * 対象は role:'partitionBeam' で dimensionStatus==='auto' のみ（locked は保持）。除外集合は
 * beamExclusionKey('partitionBeam', …)（名前空間つき）——同 spanKey の大梁・床梁と除外を共有しない。
 * graph・core だけを import する（store.js・snap.js・.jsx を静的に引かない）。
 */
import { CenterLineType, spanKey, beamExclusionKey } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { stairPartitionLines } from '../finish/stair/stairPartition.js';
import { resolveWoodColumnAnchorCL, PARTITION_BEAM_SECTION } from './woodAutoFill.js';

export const PARTITION_BEAM_ROLE = 'partitionBeam';
export const PARTITION_BEAM_TYPE = '隔て梁';

/** 下階の隔て壁の端 ends のうち、軸 axisValue（向き isVertical）上の along にあるものがあるか。 */
function hasBelowEnd(ends, isVertical, axisValue, along) {
  return ends.some(e => e.isVertical === isVertical
    && Math.abs(e.coord - axisValue) < CL_OVERLAP_TOL_MM
    && Math.abs(e.along - along) < CL_OVERLAP_TOL_MM);
}

/**
 * 隔て梁の区間を計画する（graph は読むだけ。純関数）。自階の階段の隔て壁の線（stairPartitionLines）のうち、
 * 下階の隔て壁の両端（lo/hi）が同じ軸上にあるものの [lo,hi]。上下で線の長さが違う・下階の片端が 2a の差し引きで
 * 切れている場合は生成しない（既知の限界。.claude/structural-model.md）。在来木造以外は空。
 * @param {object} graph 自階
 * @param {object} project
 * @param {Array<{isVertical:boolean, coord:number, along:number}>} belowPartitionEnds 下階の stairPartitionEnds の結果
 * @returns {Array<{isVertical:boolean, axisValue:number, lo:number, hi:number}>}
 */
export function stairPartitionBeamSpans(graph, project, belowPartitionEnds) {
  if (!rulesFor(effectiveStructure(graph, project)).framing) return [];
  if (!belowPartitionEnds || belowPartitionEnds.length === 0) return [];
  return stairPartitionLines(graph).filter(l =>
    hasBelowEnd(belowPartitionEnds, l.isVertical, l.axisValue, l.lo)
    && hasBelowEnd(belowPartitionEnds, l.isVertical, l.axisValue, l.hi));
}

/**
 * 隔て梁を自動生成・撤去する。
 *  - 候補（stairPartitionBeamSpans）の軸・端を自階の CL へ解決できたものだけ生成（CL は作らない）。
 *  - 候補に無くなった auto の隔て梁（階段の消滅・下階の隔て壁の消滅・非在来化）は撤去する。locked は保持。
 *  - 除外集合にある区間・同 spanKey に別役割の梁がある区間は作らない。既存は使い回す（id を変えない）。
 * @param {object} graph
 * @param {object} project
 * @param {Array<{isVertical:boolean, coord:number, along:number}>} belowPartitionEnds 下階が無ければ []
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillStairPartitionBeams(graph, project, belowPartitionEnds) {
  const rules = rulesFor(effectiveStructure(graph, project));
  const existingByKey = new Map();
  const anyByKey = new Set();
  for (const b of graph.beams) {
    const key = spanKey(b.axisCL, b.clStart, b.clEnd);
    anyByKey.add(key);
    if (b.role === PARTITION_BEAM_ROLE) existingByKey.set(key, b);
  }

  const candidateKeys = new Set();
  const created = [];
  if (rules.framing) {
    for (const s of stairPartitionBeamSpans(graph, project, belowPartitionEnds)) {
      const axisType = s.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
      const crossType = s.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
      const axisCL = resolveWoodColumnAnchorCL(graph, axisType, s.axisValue);
      const startCL = resolveWoodColumnAnchorCL(graph, crossType, s.lo);
      const endCL = resolveWoodColumnAnchorCL(graph, crossType, s.hi);
      if (!axisCL || !startCL || !endCL) continue;
      if (graph.excludedBeamSlots.has(beamExclusionKey(PARTITION_BEAM_ROLE, axisCL, startCL, endCL))) continue; // 削除済み
      const key = spanKey(axisCL, startCL, endCL);
      candidateKeys.add(key);
      if (existingByKey.has(key)) continue; // 冪等（id を変えない）
      if (anyByKey.has(key)) continue; // 別 role の梁が同じスロットを占めていれば重複させない
      const beam = graph.addBeam(
        rules.baseMaterial, PARTITION_BEAM_SECTION, axisCL, s.isVertical, startCL, endCL,
        { role: PARTITION_BEAM_ROLE, beamType: PARTITION_BEAM_TYPE },
      );
      created.push(beam);
      existingByKey.set(key, beam);
      anyByKey.add(key);
    }
  }

  const removed = [];
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.role !== PARTITION_BEAM_ROLE || beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const sl of [...graph.sleeveMap.values()]) if (sl.hostBeamId === beam.id) graph.sleeveMap.delete(sl.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }
  return { created, removed };
}
