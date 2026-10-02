/**
 * 在来木造の小屋梁（role:'roofBeam'、beamType:'小屋梁'、記号KB）の自動生成（ステップC2b・C2d-2・C2e-1b。主屋根と
 * 矩形の下屋の切妻・片流れ・寄棟。下屋は実体階の graph へ、主屋根は屋根専用平面の graph へ載せる——位置・区切り・
 * 成は同じ規則で、下屋専用の分岐は持たない）。寄棟は、桁行の線を支える梁間方向の小屋梁（第1段。棟木の両端に必ず置く）と、
 * 妻側の線を支える桁行方向の短い小屋梁＝飛び梁（第2段。beamType:'飛び梁'、role・記号は小屋梁と同じ）の2段。
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
 *    寄棟の飛び梁の host は、大梁と「この呼び出しで計画し実在する第1段の小屋梁」だけ（graph 上にあるだけの小屋梁は
 *    候補にしない）。
 *  - I-C3: regions===undefined なら小屋梁に一切触れない。
 *  - 他の階へは書かない（regions は呼び出し側が導いたもの＝主屋根は最上階の graph から、下屋は自階の graph から。
 *    この関数は渡された graph だけを読み書きする）。
 *  - 毎回再生成の自動部材: 撤去は beamMap.delete を直接使う（graph.removeBeam は使わない＝excludedBeamSlots を汚さない）。
 *    対象は role:'roofBeam' で dimensionStatus==='auto' のみ（locked/calculated は保持）。
 *  - 除外集合は beamExclusionKey('roofBeam', …)（名前空間つき）。ユーザーが削除した小屋梁は再生成しない。
 * graph・core だけを import する（store.js・snap.js・.jsx を静的に引かない）。
 */
import { CenterLineType, spanKey, beamExclusionKey, findHostBeam } from '../core.js';
import { CL_OVERLAP_TOL_MM, RoofShape } from '../core/constants.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SUPPORT_SPAN_COLUMN_KINDS, supportSpanColumnCandidates } from '../core/centerLineKindPolicy.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { roofFramingLines, koyaBeamPositions, roofRidgeIsVertical } from './roofFramingGeometry.js';
import { ensureAutoBeamAxisCL, bracketAutoBeamAxisExtent } from './wallBeamAxes.js';
import { axisSpanOccupied } from './woodAutoFill.js';

const ROOF_BEAM_ROLE = 'roofBeam';
const ROOF_BEAM_TYPE = '小屋梁';
const TOBIBARI_BEAM_TYPE = '飛び梁'; // 寄棟の妻側の母屋を受ける、桁行方向の短い小屋梁（role は小屋梁と同じ。記号 KB も共有）

const spanLo = b => Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue);
const spanHi = b => Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue);
const byValueThenId = (a, b) => a.effectiveValue - b.effectiveValue || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * region の棟木・母屋の線を導く。不正な rect（欠落・NaN。roofFramingLines は有限でない座標を RangeError で
 * 拒む）は region 無しと同じに扱い null を返す。
 * @returns {{ridges: object[], purlins: object[]}|null}
 */
function regionLines(region, F, tol) {
  const r = region.rect;
  if (!r || ![r.x1, r.y1, r.x2, r.y2].every(Number.isFinite)) return null;
  return roofFramingLines({
    rect: region.rect, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, highSide: region.highSide,
    purlinPitchMm: F.purlinPitchMm, purlinStartOffsetsMm: F.purlinStartOffsetsMm, tolMm: tol,
  });
}

/**
 * 線（全て同じ向き）を支える小屋梁の位置（線に沿った座標の昇順）を決める（graph は読むだけ）。
 * 支え＝線と直交する大梁（role:'primary'）＋extraSupports。既存の小屋梁は数えない（I-C2）。
 * 優先順位（通り芯＞中心線）は SUPPORT_SPAN_COLUMN_KINDS の並び。位置は線に沿った座標＝線が縦なら y（HORIZONTAL の CL）。
 * @param {Array<{at:number, lo:number, hi:number}>} [extraSupports] koyaBeamPositions の supports と同じ形
 */
function koyaPositionsForLines(graph, rules, lines, primaries, extraSupports = []) {
  const tol = CL_OVERLAP_TOL_MM;
  const F = rules.framing;
  const lineVertical = lines[0].isVertical;
  const supports = primaries
    .filter(b => b.isVertical !== lineVertical)
    .map(b => ({ at: b.axisValue, lo: spanLo(b), hi: spanHi(b) }))
    .concat(extraSupports);
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
  return koyaBeamPositions({
    lines, supports, tiers, gridOriginOf, maxPitchMm: F.strutMaxPitchMm, gridModuleMm: F.gridModuleMm, tolMm: tol,
  });
}

/**
 * 位置 p（小屋梁の軸の座標）を跨ぐ host の axisCL を、軸の座標の昇順で返す。host の向きは hostIsVertical、
 * 候補の梁は hostBeams（host 判定は描画・梁成の伝播と同じ findHostBeam。座標が同じ host は先頭の1つ）。
 * hostCLs は host の軸CLの候補（呼び出し側が範囲で絞って昇順に並べたもの）。
 */
function hostCLsAt(hostBeams, hostIsVertical, hostCLs, p) {
  const tol = CL_OVERLAP_TOL_MM;
  const hosts = [];
  for (const cl of hostCLs) {
    if (!findHostBeam(hostBeams, cl.id, hostIsVertical, p, { allowRoofBeamHost: true })) continue;
    if (hosts.length > 0 && Math.abs(hosts[hosts.length - 1].effectiveValue - cl.effectiveValue) <= tol) continue;
    hosts.push(cl);
  }
  return hosts;
}

/** 隣り合う host の間を1区間（1本）にする（端に host が無い区間は、host の対が無いので生成されない）。 */
function segmentsBetweenHosts(graph, rules, p, hosts, koyaIsVertical) {
  const tol = CL_OVERLAP_TOL_MM;
  const segments = [];
  for (let i = 0; i + 1 < hosts.length; i++) {
    const lo = hosts[i].effectiveValue;
    const hi = hosts[i + 1].effectiveValue;
    if (hi - lo <= tol) continue;
    // 同じ軸の大梁・床梁が重なる区間には作らない（二重梁の防止。床梁の生成と同じ判定）。
    if (axisSpanOccupied(graph, rules.baseMaterial, koyaIsVertical, p, lo, hi, tol)) continue;
    segments.push({ coord: p, lo, hi, clStart: hosts[i], clEnd: hosts[i + 1], isVertical: koyaIsVertical });
  }
  return segments;
}

/** hostBeams から、軸の座標が [alongLo, alongHi]（許容差込み）にある axisCL を重複なく昇順で返す。 */
function hostAxisCLsIn(hostBeams, alongLo, alongHi) {
  const tol = CL_OVERLAP_TOL_MM;
  return [...new Map(hostBeams.map(b => [b.axisCL.id, b.axisCL])).values()]
    .filter(cl => cl.effectiveValue >= alongLo - tol && cl.effectiveValue <= alongHi + tol)
    .sort(byValueThenId);
}

/**
 * 1つの region（矩形の切妻・片流れ）の小屋梁の区間を計画する（graph は読むだけ）。
 * @returns {Array<{coord:number, lo:number, hi:number, clStart:object, clEnd:object, isVertical:boolean}>}
 *   小屋梁の軸は coord 一定。isVertical は梁の向き（母屋・棟木と直交＝線の向きの逆）
 */
function planRegionSegments(graph, rules, region, primaries) {
  const tol = CL_OVERLAP_TOL_MM;
  const rl = regionLines(region, rules.framing, tol);
  if (!rl) return [];
  const lines = [...rl.ridges, ...rl.purlins];
  if (lines.length === 0) return [];
  const lineVertical = lines[0].isVertical;
  if (lines.some(l => l.isVertical !== lineVertical)) return []; // 向きが混在する線は koyaBeamPositions の対象外

  const positions = koyaPositionsForLines(graph, rules, lines, primaries);
  // 小屋梁が突き当たる host＝線と平行な大梁（小屋梁は線と直交するので、小屋梁の端が載る梁は線と同じ向き）。
  const [crossLo, crossHi] = lineVertical ? [region.rect.x1, region.rect.x2] : [region.rect.y1, region.rect.y2];
  const parallel = primaries.filter(b => b.isVertical === lineVertical);
  const hostCLs = hostAxisCLsIn(parallel, crossLo, crossHi);
  const koyaIsVertical = !lineVertical;
  return positions.flatMap(p =>
    segmentsBetweenHosts(graph, rules, p, hostCLsAt(parallel, lineVertical, hostCLs, p), koyaIsVertical));
}

/**
 * 矩形の寄棟の第1段: 桁行の線（棟木＋環の長辺）を支える、梁間方向の小屋梁の区間を計画する（graph は読むだけ）。
 * 位置は切妻・片流れと同じ規則（koyaPositionsForLines）に、棟木の両端（正方形は中心）の位置（seed）を必ず加える
 * ——棟木の端は隅木の上端で、その下に横架材が無いと隅木が支えられない。その位置で棟木の座標を跨ぐ直交の大梁が
 * 既にあれば seed は置かない（大梁が支える）。host は線と平行な大梁だけ。
 * 桁行の向きは roofRidgeIsVertical（正方形は横＝rectHipLines の棟木の向きと一致。region.ridgeIsVertical は使わない）。
 */
function planHipKetaSegments(graph, rules, region, primaries) {
  const tol = CL_OVERLAP_TOL_MM;
  const rl = regionLines(region, rules.framing, tol);
  if (!rl) return [];
  const { x1, y1, x2, y2 } = region.rect;
  const ketaVertical = roofRidgeIsVertical(region.rect, tol);
  const lines = [...rl.ridges, ...rl.purlins].filter(l => l.isVertical === ketaVertical);
  if (lines.length === 0) return [];

  // 棟木の両端（隅木の上端）。短手 s の半分だけ桁行の端から入った位置。正方形は2点が一致して1点になる。
  const [alongLo, alongHi, crossLo, crossHi] = ketaVertical ? [y1, y2, x1, x2] : [x1, x2, y1, y2];
  const s = crossHi - crossLo;
  const ridgeCoord = (crossLo + crossHi) / 2;
  const seeds = [alongLo + s / 2, alongHi - s / 2]
    .filter((v, i, a) => i === 0 || Math.abs(v - a[0]) > tol)
    .filter(v => !primaries.some(b => b.isVertical !== ketaVertical && Math.abs(b.axisValue - v) <= tol &&
      spanLo(b) - tol <= ridgeCoord && ridgeCoord <= spanHi(b) + tol));
  const extra = seeds.map(at => ({ at, lo: crossLo, hi: crossHi }));
  const positions = [...koyaPositionsForLines(graph, rules, lines, primaries, extra), ...seeds]
    .sort((a, b) => a - b)
    .filter((v, i, a) => i === 0 || v - a[i - 1] > tol);

  const parallel = primaries.filter(b => b.isVertical === ketaVertical);
  const hostCLs = hostAxisCLsIn(parallel, crossLo, crossHi);
  return positions.flatMap(p =>
    segmentsBetweenHosts(graph, rules, p, hostCLsAt(parallel, ketaVertical, hostCLs, p), !ketaVertical));
}

/**
 * 矩形の寄棟の第2段: 妻側の線（環の短辺）を支える、桁行方向の小屋梁（飛び梁）の区間を計画する（graph は読むだけ）。
 * 妻側の線を桁行方向の中心で左右（lo 側・hi 側）に分け、片側ずつ位置を決める（両側をまとめると、片側の違反を解く
 * 位置が反対側に不要な飛び梁を生む）。区間は host の間で、host は妻側の線と平行な大梁と koyaBeams（同じ呼び出しで
 * 計画し実在する第1段の小屋梁だけ。graph 上にあるだけの既存の小屋梁は渡さない＝I-C2）。終点 T は、その側の最も内側の
 * 妻側の線の位置以内（軒側）にある最初の host（妻の軒桁から最初の梁間方向の部材まで）。T より内側の host は使わない。
 * T が無ければ候補の全部を使う。途中の host でも区切る（小屋梁どうしを交差させない）。
 */
function planHipTobibariSegments(graph, rules, region, primaries, koyaBeams) {
  const tol = CL_OVERLAP_TOL_MM;
  const rl = regionLines(region, rules.framing, tol);
  if (!rl) return [];
  const { x1, y1, x2, y2 } = region.rect;
  const ketaVertical = roofRidgeIsVertical(region.rect, tol);
  const gableLines = rl.purlins.filter(l => l.isVertical !== ketaVertical);
  if (gableLines.length === 0) return [];
  const [alongLo, alongHi] = ketaVertical ? [y1, y2] : [x1, x2];
  const center = (alongLo + alongHi) / 2;
  // 飛び梁（桁行方向）の host＝妻側の線と平行な梁（大梁と第1段の小屋梁）。向きは妻側の線と同じ。
  const hostIsVertical = !ketaVertical;
  const hostBeams = [...primaries.filter(b => b.isVertical === hostIsVertical), ...koyaBeams.filter(b => b.isVertical === hostIsVertical)];

  const segments = [];
  for (const side of ['lo', 'hi']) {
    const lines = gableLines.filter(l => (side === 'lo' ? l.coord < center - tol : l.coord > center + tol));
    if (lines.length === 0) continue; // 妻側の線が無い側は飛び梁なし
    const innermost = side === 'lo' ? Math.max(...lines.map(l => l.coord)) : Math.min(...lines.map(l => l.coord));
    const hostCLs = side === 'lo' ? hostAxisCLsIn(hostBeams, alongLo, center) : hostAxisCLsIn(hostBeams, center, alongHi);
    for (const p of koyaPositionsForLines(graph, rules, lines, primaries)) {
      const hosts = hostCLsAt(hostBeams, hostIsVertical, hostCLs, p);
      // 終点 T（軒から内側へ数えて最初に最も内側の線へ届く host）より内側の host を落とす。
      let trimmed = hosts;
      if (side === 'lo') {
        const t = hosts.findIndex(h => h.effectiveValue >= innermost - tol);
        if (t >= 0) trimmed = hosts.slice(0, t + 1);
      } else {
        let t = -1;
        for (let i = hosts.length - 1; i >= 0; i--) if (hosts[i].effectiveValue <= innermost + tol) { t = i; break; }
        if (t >= 0) trimmed = hosts.slice(t);
      }
      segments.push(...segmentsBetweenHosts(graph, rules, p, trimmed, ketaVertical));
    }
  }
  return segments;
}

/**
 * 小屋梁（role:'roofBeam'）を自動生成・撤去する。
 *  - regions===undefined: 何もしない（I-C3。小屋組を扱わない呼び出し）。
 *  - 在来木造でない（rules.framing が無い）／regions が空: auto の小屋梁を全て撤去する。
 *  - region の形状が寄棟（矩形）: 第1段の小屋梁→第2段の飛び梁（beamType '飛び梁'）の順に作る。使い回す既存の auto は
 *    beamType が違えば作り直す（removed と created の両方に入る）。
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
  const removed = [];
  // 毎回再生成の自動部材の撤去（beamMap.delete を直接使う。除外集合を汚さない）。梁に載った袖も一緒に消す。
  const dropBeam = (beam) => {
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  };

  // 計画した区間を梁にする（既存は使い回す）。戻り値＝その区間に実在する小屋梁（第2段の host 候補）。
  const emitSegments = (segments, beamType) => {
    const present = [];
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
        let beam = existingByKey.get(key);
        // 既存（自分自身の再生成を含む）は使い回す＝id を変えない。ただし auto で種別（小屋梁／飛び梁）が違えば
        // 作り直す（その場で書き換えると変化として検出されない）。locked は触らない。
        if (beam && beam.dimensionStatus === 'auto' && beam.beamType !== beamType) {
          dropBeam(beam);
          existingByKey.delete(key);
          anyByKey.delete(key);
          beam = undefined;
        }
        if (!beam) {
          if (anyByKey.has(key)) continue; // 別 role の梁が同じスロットを占めていれば重複させない
          // 梁芯CLの extent を小屋梁の区間を含むよう再ブラケットする（床梁と同じ。新規作成の直前だけ）。
          bracketAutoBeamAxisExtent(graph, axisCL, isVertical, s.lo, s.hi);
          beam = graph.addBeam(
            rules.baseMaterial, rules.defaultSections.beam, axisCL, isVertical, s.clStart, s.clEnd,
            { role: ROOF_BEAM_ROLE, beamType },
          );
          created.push(beam);
          existingByKey.set(key, beam);
          anyByKey.add(key);
        }
        present.push(beam);
      }
    }
    return present;
  };

  if (rules.framing) {
    for (const region of regions) {
      if (region.shape === RoofShape.HIP) {
        // 寄棟は2段: 梁間方向の小屋梁（第1段）→ それを host に含めた飛び梁（第2段）。
        const koya = emitSegments(planHipKetaSegments(graph, rules, region, primaries), ROOF_BEAM_TYPE);
        emitSegments(planHipTobibariSegments(graph, rules, region, primaries, koya), TOBIBARI_BEAM_TYPE);
      } else {
        emitSegments(planRegionSegments(graph, rules, region, primaries), ROOF_BEAM_TYPE);
      }
    }
  }

  for (const beam of [...graph.beamMap.values()]) {
    if (beam.role !== ROOF_BEAM_ROLE || beam.dimensionStatus !== 'auto') continue;
    if (candidateKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    dropBeam(beam);
  }
  return { created, removed };
}
