/**
 * 在来木造の小屋梁（role:'roofBeam'、beamType:'小屋梁'、記号KB）の自動生成（ステップC2b・C2d-2。主屋根と
 * 矩形の下屋の切妻・片流れ。下屋は実体階の graph へ、主屋根は屋根専用平面の graph へ載せる——位置・区切り・
 * 成は同じ規則で、下屋専用の分岐は持たない）。
 * 設計意図は .claude/structural-model.md「小屋梁」の節。
 *
 * 小屋梁は母屋・棟木と直交する横架材で、各母屋・棟木の上で束の間隔（線の両端＝屋根範囲の辺を含む）が
 * strutMaxPitchMm（1820）以下になる最少本数を、通り芯＞中心線＞910グリッドの優先で選ぶ（支持長1820ルール 3i と
 * 同じ優先。順位は core/centerLineKindPolicy.js の SUPPORT_SPAN_COLUMN_KINDS から導き、ここに複製しない）。
 * 位置の決定は roofFramingGeometry.js koyaBeamPositions（純関数）、ここは graph の読み書き。
 *
 * 1本の小屋梁は、直交方向に屋根範囲の端から端（軒から軒）まで延び、途中で平行な大梁（role:'primary'）と
 * 交わるたびに区切る（区切った1区間＝1本）。両端の CL は、載る大梁の axisCL そのもの——座標が同じ別の CL へ
 * 引き直さない（findHostPrimaryBeam が CL id の一致で host を探すため）。屋根範囲の端に大梁が無い区間は生成しない。
 * 束は実体を持たない（描画時に導く。framingDrawing.js roofFramingHostMembers）。
 *
 * 【不変条件】
 *  - I-C2（自分の出力を入力に数えない）: 位置を決める「支え」は role:'primary' の梁だけで、既存の roofBeam を含めない。
 *    既存の auto の小屋梁は spanKey が同じなら同じ実体を使い回す（id を変えない）。2回目の呼び出しは変化 0 件。
 *  - I-C3: regions===undefined なら小屋梁に一切触れない。
 *  - 他の階へは書かない（regions は呼び出し側が導いたもの＝主屋根は最上階の graph から、下屋は自階の graph から。
 *    この関数は渡された graph だけを読み書きする）。
 *  - 毎回再生成の自動部材: 撤去は beamMap.delete を直接使う（graph.removeBeam は使わない＝excludedBeamSlots を汚さない）。
 *    対象は role:'roofBeam' で dimensionStatus==='auto' のみ（locked/calculated は保持）。
 *  - 除外集合は beamExclusionKey('roofBeam', …)（名前空間つき）。ユーザーが削除した小屋梁は再生成しない。
 * graph・core だけを import する（store.js・snap.js・.jsx を静的に引かない）。
 */
import { CenterLineType, spanKey, beamExclusionKey, findHostPrimaryBeam } from '../core.js';
import { CL_OVERLAP_TOL_MM, RoofShape } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SUPPORT_SPAN_COLUMN_KINDS, supportSpanColumnCandidates } from '../core/centerLineKindPolicy.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { roofFramingLines, koyaBeamPositions } from './roofFramingGeometry.js';
import { ensureAutoBeamAxisCL, bracketAutoBeamAxisExtent } from './wallBeamAxes.js';
import { axisSpanOccupied } from './woodAutoFill.js';

const ROOF_BEAM_ROLE = 'roofBeam';
const ROOF_BEAM_TYPE = '小屋梁';

const spanLo = b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
const spanHi = b => Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);

/**
 * 1つの region（矩形の切妻・片流れ）の小屋梁の区間を計画する（graph は読むだけ）。
 * @returns {Array<{coord:number, lo:number, hi:number, clStart:object, clEnd:object, isVertical:boolean}>}
 *   小屋梁の軸は coord 一定。isVertical は梁の向き（母屋・棟木と直交＝線の向きの逆）
 */
function planRegionSegments(graph, rules, region, primaries) {
  const tol = CL_OVERLAP_TOL_MM;
  const F = rules.framing;
  // 寄棟（環状の母屋）は後続（C2e）。形状で止める（母屋が無く棟木だけの小さな寄棟は線の向きが混在しないため、
  // 下の向きの混在チェックだけでは止まらない）。
  if (region.shape === RoofShape.HIP) return [];
  // 不正な rect（欠落・NaN。roofFramingLines は有限でない座標を RangeError で拒む）は region 無しと同じに扱う。
  const r = region.rect;
  if (!r || ![r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) return [];
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
  const lines = [...ridges, ...purlins];
  if (lines.length === 0) return [];
  const lineVertical = lines[0].isVertical;
  if (lines.some(l => l.isVertical !== lineVertical)) return []; // 向きが混在する線は koyaBeamPositions の対象外

  // 支え＝線と直交する大梁（role:'primary'）だけ。既存の小屋梁は数えない（I-C2）。
  const supports = primaries
    .filter(b => b.isVertical !== lineVertical)
    .map(b => ({ at: b.axisValue, lo: spanLo(b), hi: spanHi(b) }));
  // 優先順位（通り芯＞中心線）は SUPPORT_SPAN_COLUMN_KINDS の並び。位置は線に沿った座標＝線が縦なら y（HORIZONTAL の CL）。
  const alongType = lineVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const candidates = supportSpanColumnCandidates(graph, { centerLineType: alongType });
  const tiers = SUPPORT_SPAN_COLUMN_KINDS.map(kind => candidates.filter(c => c.kind === kind).map(c => c.cl.effectiveValue));
  // 910グリッドの原点は通り芯（kind 'struct'）。位置 a 以下で最大、無ければ a 以上で最小（3i の R-1 と同じ）。
  const structAlongs = candidates.filter(c => c.kind === 'struct').map(c => c.cl.effectiveValue);
  const gridOriginOf = (a) => {
    const below = structAlongs.filter(v => v <= a + tol);
    if (below.length > 0) return Math.max(...below);
    const above = structAlongs.filter(v => v >= a - tol);
    return above.length > 0 ? Math.min(...above) : undefined;
  };
  const positions = koyaBeamPositions({
    lines, supports, tiers, gridOriginOf, maxPitchMm: F.strutMaxPitchMm, gridModuleMm: F.gridModuleMm, tolMm: tol,
  });

  // 小屋梁が突き当たる host＝線と平行な大梁（小屋梁は線と直交するので、小屋梁の端が載る梁は線と同じ向き）。
  const [crossLo, crossHi] = lineVertical ? [region.rect.x1, region.rect.x2] : [region.rect.y1, region.rect.y2];
  const parallel = primaries.filter(b => b.isVertical === lineVertical);
  const hostCLs = [...new Map(parallel.map(b => [b.axisCL.id, b.axisCL])).values()]
    .filter(cl => cl.effectiveValue >= crossLo - tol && cl.effectiveValue <= crossHi + tol)
    .sort((a, b) => a.effectiveValue - b.effectiveValue || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const koyaIsVertical = !lineVertical;
  const segments = [];
  for (const p of positions) {
    // p を跨ぐ host（host 判定は描画・梁成の伝播と同じ findHostPrimaryBeam）。座標が同じ host は先頭の1つ。
    const hosts = [];
    for (const cl of hostCLs) {
      if (!findHostPrimaryBeam(parallel, cl.id, lineVertical, p)) continue;
      if (hosts.length > 0 && Math.abs(hosts[hosts.length - 1].effectiveValue - cl.effectiveValue) <= tol) continue;
      hosts.push(cl);
    }
    // 隣り合う host の間が1本（端に host が無い区間は、host の対が無いので生成されない）。
    for (let i = 0; i + 1 < hosts.length; i++) {
      const lo = hosts[i].effectiveValue;
      const hi = hosts[i + 1].effectiveValue;
      if (hi - lo <= tol) continue;
      // 同じ軸の大梁・床梁が重なる区間には作らない（二重梁の防止。床梁の生成と同じ判定）。
      if (axisSpanOccupied(graph, rules.baseMaterial, koyaIsVertical, p, lo, hi, tol)) continue;
      segments.push({ coord: p, lo, hi, clStart: hosts[i], clEnd: hosts[i + 1], isVertical: koyaIsVertical });
    }
  }
  return segments;
}

/**
 * 小屋梁（role:'roofBeam'）を自動生成・撤去する。
 *  - regions===undefined: 何もしない（I-C3。小屋組を扱わない呼び出し）。
 *  - 在来木造でない（rules.framing が無い）／regions が空: auto の小屋梁を全て撤去する。
 *  - region の形状が寄棟（C2e で扱う）: その region の小屋梁は作らない（既存の auto は撤去される）。
 *  - 候補に無くなった auto の小屋梁（屋根の入力や主構造の変更で不要になったもの）は撤去する。locked は保持。
 *  - 梁芯CLは位置に通り芯・既存の梁芯があればそれを、無ければ梁芯CL（由来 roofBeam）を作る（床梁と共有の
 *    wallBeamAxes.js ensureAutoBeamAxisCL）。除外座標（excludedWallBeamAxes）の位置には作らない。
 *    不要になった小屋梁由来の梁芯CLは撤去しない（孤児の梁芯を撤去しない既存の裁定。床梁・壁由来と同じ）。
 * @param {object} graph 小屋梁を載せる平面の graph（主屋根＝屋根専用平面、下屋＝その屋根セルのある実体階）
 * @param {object} project
 * @param {Array<{key:string, rect:object, shape:string, ridgeIsVertical:boolean, highSide:string|null}>|undefined} regions
 *   roofFramingRegions.js の region（主屋根・下屋）。undefined なら何もしない
 * @returns {{created: object[], removed: string[]}}
 */
export function autoFillWoodRoofFraming(graph, project, regions) {
  if (regions === undefined) return { created: [], removed: [] };
  const rules = rulesFor(effectiveStructure(graph, project));

  const primaries = rules.framing
    ? graph.beams.filter(b => b.materialType === rules.baseMaterial && b.role === 'primary')
    : [];
  const existingByKey = new Map();
  for (const b of graph.beams) {
    if (b.role !== ROOF_BEAM_ROLE) continue;
    existingByKey.set(spanKey(b.axisCL, b.clStart, b.clEnd), b);
  }
  const anyByKey = new Set(graph.beams.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));

  const candidateKeys = new Set();
  const created = [];
  if (rules.framing) {
    for (const region of regions) {
      const segments = planRegionSegments(graph, rules, region, primaries);
      // 位置（coord）ごとに梁芯CLを1回だけ確保する。
      const byCoord = new Map();
      for (const s of segments) {
        if (!byCoord.has(s.coord)) byCoord.set(s.coord, []);
        byCoord.get(s.coord).push(s);
      }
      for (const [coord, segs] of byCoord) {
        const isVertical = segs[0].isVertical;
        const axisCL = ensureAutoBeamAxisCL(
          graph, isVertical, coord, Math.min(...segs.map(s => s.lo)), Math.max(...segs.map(s => s.hi)), BeamAxisOrigin.ROOF_BEAM);
        if (!axisCL) continue; // 除外座標（手動削除の尊重）
        for (const s of segs) {
          if (graph.excludedBeamSlots.has(beamExclusionKey(ROOF_BEAM_ROLE, axisCL, s.clStart, s.clEnd))) continue; // 削除済み
          const key = spanKey(axisCL, s.clStart, s.clEnd);
          candidateKeys.add(key);
          if (existingByKey.has(key)) continue; // 既存（自分自身の再生成を含む）は使い回す＝id を変えない
          if (anyByKey.has(key)) continue; // 別 role の梁が同じスロットを占めていれば重複させない
          // 梁芯CLの extent を小屋梁の区間を含むよう再ブラケットする（床梁と同じ。新規作成の直前だけ）。
          bracketAutoBeamAxisExtent(graph, axisCL, isVertical, s.lo, s.hi);
          created.push(graph.addBeam(
            rules.baseMaterial, rules.defaultSections.beam, axisCL, isVertical, s.clStart, s.clEnd,
            { role: ROOF_BEAM_ROLE, beamType: ROOF_BEAM_TYPE },
          ));
          existingByKey.set(key, created[created.length - 1]);
          anyByKey.add(key);
        }
      }
    }
  }

  const removed = [];
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.role !== ROOF_BEAM_ROLE || beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }
  return { created, removed };
}
