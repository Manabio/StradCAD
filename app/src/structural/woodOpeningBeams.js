// 在来木造の吹抜け（床開口）の辺の小梁（role:'secondary'、記号B）を、梁を直接生成して架ける。
// 構造不問の共通仕様（計画器 openingEdgePlan.js planOpeningEdgeBeams）の在来木造側の消費者:
// 「梁のない辺」だけに、支え間のスパンが短い辺から順に架け、手動配置の梁があればそちらを優先する。
// S造系は梁芯 extent 方式（openingBeamAxes.js 規則O）だが、在来木造は壁線の通し梁（role:'primary'）が
// 実梁として先に立つため、実梁を host に判定し、梁を直接生成する（床梁 autoFillWoodFloorBeams と同じ方式）。
// 設計意図は .claude/structural-model.md 参照。
import { CenterLineType, spanKey, beamExclusionKey } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { planOpeningEdgeBeams } from './openingEdgePlan.js';
import { edgeTarget, defaultBeamWidthMm } from './openingBeamAxes.js';
import {
  findBeamAnchorCL, wallBeamAxisExcludeKey, ensureAutoBeamAxisCL, bracketAutoBeamAxisExtent,
} from './wallBeamAxes.js';
import { axisSpanOccupied } from './woodAutoFill.js';

/**
 * 計画器へ渡す支え線（host）を、グラフの実梁から集める（在来木造）:
 *   - role 'primary'（壁線の通し梁・頭つなぎ・受梁など。auto／手動とも）
 *   - 手動配置（dimensionStatus!=='auto'）の role 'secondary'／'floor'。ただし軸CLの由来が FLOOR_BEAM の
 *     secondary は除く——この関数自身が作った小梁をユーザーが固定（locked）しただけで辺が「梁あり」になり、
 *     架け方が組み替わるのを防ぐ（S造系の規則Oが OPENING 由来を除くのと同型）。
 *   - 自動（dimensionStatus==='auto'）の secondary は数えない（自分の前回出力を支えにすると振動する）。
 * @returns {{hosts: Array, clById: Map<string, object>}} clById＝host 梁の軸CL（clId → CL）
 */
function woodOpeningHosts(graph, rules) {
  const hosts = [];
  const clById = new Map();
  for (const b of graph.beams) {
    if (b.materialType !== rules.baseMaterial) continue;
    const manual = b.dimensionStatus !== 'auto';
    const isHost = b.role === 'primary'
      || (manual && b.role === 'floor')
      || (manual && b.role === 'secondary' && b.axisCL.beamAxisOrigin !== BeamAxisOrigin.FLOOR_BEAM);
    if (!isHost) continue;
    const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
    hosts.push({
      isVertical: b.isVertical, coord: b.axisCL.effectiveValue, lo: Math.min(a, c), hi: Math.max(a, c),
      kind: 'beam', clId: b.axisCL.id,
    });
    clById.set(b.axisCL.id, b.axisCL);
  }
  return { hosts, clById };
}

/**
 * 在来木造の吹抜けの辺に小梁（role:'secondary'、beamType:'小梁'）を自動生成し、候補に無い自動生成の
 * 小梁（dimensionStatus==='auto'）を撤去する。
 *  - openingComponents: openingBeamAxes.js openingEdgeComponents の結果（矩形成分ごとの4辺）。
 *    undefined は何もしない（roofRegions と同じ規約＝この階を扱わない呼び出し）。[] なら auto の小梁を撤去する。
 *  - 何もしない（生成も撤去もしない）: framing を持たない主構造・屋根専用平面・壁区間が無い階
 *    （autoFillWoodWallBeams と同じ「壁ゼロの階は既存部材を保全」）。
 *  - 辺の判定と順序は計画器に委ねる: 実梁が覆う辺は生成しない（covered）。残りは支え間スパンの短い辺から
 *    1本ずつ架け、後の辺は先に架けた小梁を支えにする（その梁芯CLを clStart/clEnd にする）。
 *  - 除外（ユーザーの削除の尊重）: 梁芯の座標が excludedWallBeamAxes にある辺は計画から外す。小梁の
 *    スロット（spanKey）が excludedBeamSlots にある辺も計画から外して計画し直す（その小梁を支えにする
 *    辺も別の支えへ付け替わる）。スロットはCLが揃って初めて分かるため、計画→判定→やり直しを収束まで繰り返す。
 *  - 梁芯CLは ensureAutoBeamAxisCL（由来 FLOOR_BEAM。OPENING だと reconcileOpeningBeamAxes が孤児として撤去する）。
 *    extent の張り直し（bracketAutoBeamAxisExtent）は梁を新規作成する直前にだけ行う（冪等性）。
 *  - 撤去は graph.beamMap.delete（removeBeam は使わない＝excludedBeamSlots を汚さない）。子スリーブは連鎖削除する。
 *    対象は主構造材種の role:'secondary' のうち dimensionStatus==='auto' のみ（locked は保持）。
 *    旧方式（梁芯CL上の小梁）の auto の小梁も、候補に無ければここで撤去される。
 *  - 二重防御（axisSpanOccupied）: 同一軸上に別の梁が生成スパンと重なっていれば生成しない。
 * @param {object} graph
 * @param {object} project
 * @param {Array<Array<object>>|undefined} openingComponents
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} wallSegments
 * @param {Array<{isVertical:boolean, axisValue:number, lo:number, hi:number}>} [partitionSpans] - 隔て梁
 *   （stairPartitionBeams.js stairPartitionBeamSpans の計画値）。折返し階段の隔て壁の真上の梁で、開口辺に乗る辺は
 *   「梁あり」として除く。計画値を使うのは、隔て梁の生成が本関数の後（同じ再計算の中）で実梁がまだ無いため。
 *   支え（直交辺の掛け先）にはしない——隔て梁の端は開口辺の梁に載る側（stairPartitionBeams.js 冒頭）。
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodOpeningBeams(graph, project, openingComponents, wallSegments, partitionSpans = []) {
  const none = { created: [], removed: [] };
  if (openingComponents === undefined) return none;
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing || graph.plane.isRoofPlane || !(wallSegments?.length)) return none;

  const { hosts, clById } = woodOpeningHosts(graph, rules);
  const coverTol = Math.max(CL_OVERLAP_TOL_MM, (defaultBeamWidthMm(rules) ?? 0) / 2);
  const typeOf = isVertical => (isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL);

  // 支え（ref）の梁芯CL。host 梁は clId、先に架ける小梁（kind:'opening'）は座標の梁芯・通り芯。
  const refCL = (ref, orthoType) => (ref.clId != null ? clById.get(ref.clId) : findBeamAnchorCL(graph, orthoType, ref.coord)) ?? null;

  // 成分ごとに計画する。スロットが除外済みの小梁を含む計画は、その辺を外して計画し直す。
  const plans = openingComponents.map(edges4 => {
    const edges = edges4
      .map(edge => ({ ...edge, target: edgeTarget(graph, edge, rules).coord }))
      .filter(edge => !partitionSpans.some(s => s.isVertical === edge.isVertical
        && Math.min(Math.abs(s.axisValue - edge.coord), Math.abs(s.axisValue - edge.target)) <= coverTol
        && Math.min(s.hi, edge.hi) - Math.max(s.lo, edge.lo) > CL_OVERLAP_TOL_MM));
    const unplaceable = new Set();
    const baseCanPlace = edge => {
      // 梁芯が手動削除された座標（ensureAutoBeamAxisCL が作らない）は辺ごと外す。既存の梁芯があればそれを使える。
      if (!graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(edge.isVertical, edge.target))) return true;
      return findBeamAnchorCL(graph, typeOf(edge.isVertical), edge.target) != null;
    };
    for (let i = 0; i <= edges.length; i++) {
      const plan = planOpeningEdgeBeams(edges, hosts, {
        coverTol, canPlace: edge => !unplaceable.has(edge) && baseCanPlace(edge),
      });
      const bad = plan.placed.filter(p => {
        const axisCL = findBeamAnchorCL(graph, typeOf(p.edge.isVertical), p.target);
        const orth = typeOf(!p.edge.isVertical);
        const lo = refCL(p.loRef, orth), hi = refCL(p.hiRef, orth);
        return axisCL != null && lo != null && hi != null
          && graph.excludedBeamSlots.has(beamExclusionKey('secondary', axisCL, lo, hi));
      });
      if (bad.length === 0) return plan;
      for (const p of bad) unplaceable.add(p.edge);
    }
    return { placed: [], covered: [], excluded: [], unsupported: [] }; // 到達不能（辺数を超えて収束しない）
  });

  // 梁芯CLと端のCL（支え）を確定し、候補（spanKey）を集める。成分間・成分内とも order 昇順。
  const candidates = [];
  const candidateKeys = new Set();
  for (const plan of plans) {
    for (const p of plan.placed) {
      const { isVertical } = p.edge;
      const loCoord = p.loRef.coord, hiCoord = p.hiRef.coord;
      // 候補段階は既存CLだけを解決する（梁芯CLの新設は生成確定の直前。床梁等で置けない辺にCLを残さない）。
      // CLが揃っていれば spanKey が分かり、撤去の候補キーにできる。揃っていなければ新設予定（既存の梁は無い）。
      const orth = typeOf(!isVertical);
      const axisCL = findBeamAnchorCL(graph, typeOf(isVertical), p.target);
      const clStart = refCL(p.loRef, orth), clEnd = refCL(p.hiRef, orth);
      if (axisCL && clStart && clEnd) {
        const key = spanKey(axisCL, clStart, clEnd);
        if (graph.excludedBeamSlots.has(key)) continue;
        candidateKeys.add(key);
      }
      candidates.push({ p, isVertical, target: p.target, loCoord, hiCoord });
    }
  }

  // 撤去: 候補に無い自動生成の小梁（旧方式のものを含む）。生成より先に行い、同一軸の占有判定を実態に合わせる。
  const removed = [];
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.materialType !== rules.baseMaterial || beam.role !== 'secondary') continue;
    if (beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }

  const existingKeys = new Set(
    graph.beams.filter(b => b.materialType === rules.baseMaterial && b.role === 'secondary')
      .map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));
  const created = [];
  for (const c of candidates) {
    const orth = typeOf(!c.isVertical);
    const existingAxis = findBeamAnchorCL(graph, typeOf(c.isVertical), c.target);
    const existingStart = refCL(c.p.loRef, orth), existingEnd = refCL(c.p.hiRef, orth);
    // 既存（手動固定含む。自分自身の再生成も含む）と重複させない
    if (existingAxis && existingStart && existingEnd && existingKeys.has(spanKey(existingAxis, existingStart, existingEnd))) continue;
    if (axisSpanOccupied(graph, rules.baseMaterial, c.isVertical, c.target, c.loCoord, c.hiCoord, CL_OVERLAP_TOL_MM)) continue;
    // ここで初めて梁芯CLを新設する（除外座標は null）。支えは先に架けた小梁のCLを含め、この時点で解決する。
    const axisCL = ensureAutoBeamAxisCL(graph, c.isVertical, c.target, c.loCoord, c.hiCoord, BeamAxisOrigin.FLOOR_BEAM);
    if (!axisCL) continue;
    const clStart = refCL(c.p.loRef, orth), clEnd = refCL(c.p.hiRef, orth);
    if (!clStart || !clEnd) continue; // 支えの梁芯が解決できない（先に架ける小梁が作れなかった）
    if (graph.excludedBeamSlots.has(beamExclusionKey('secondary', axisCL, clStart, clEnd))) continue;
    bracketAutoBeamAxisExtent(graph, axisCL, c.isVertical, c.loCoord, c.hiCoord);
    created.push(graph.addBeam(
      rules.baseMaterial, rules.defaultSections.beam, axisCL, c.isVertical, clStart, clEnd,
      { role: 'secondary', beamType: '小梁' },
    ));
    existingKeys.add(spanKey(axisCL, clStart, clEnd));
  }
  return { created, removed };
}
