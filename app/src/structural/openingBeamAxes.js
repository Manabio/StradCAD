// 床開口（吹抜け・昇降路・階段吹抜け・階段の破れ先）を囲むセル境界CLから梁芯CL（discipline:'fuse'）
// を自動生成する（規則O。S造・RC造・SRC造。木造は在来の階段開口処理＝stairOpeningRuns が別に担う
// ため対象外＝structureRules.js openingBeamAxes:null）。壁由来の梁芯（wallBeamAxes.js）と同じ
// ライフサイクル関数（graph.addCenterLine・discipline:FUSE・beamAxisOrigin）へ薄く乗せる。
// 設計意図は .claude/structural-model.md 参照。
import { CenterLine, CenterLineType, Discipline } from '../core.js';
import { resolveCLById } from '../core/clRefResolve.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { BeamAxisOrigin, fillBeamAxisOriginIfUnknown } from '../core/centerLine.js';
import { beamAxisCenterLines } from '../core/centerLineKindPolicy.js';
import { findSectionEntry } from './sectionCatalog.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import {
  findBeamAnchorCL, wallBeamAxisExcludeKey, wallBackingCenterCoord, wallBeamSourcesFor,
  isProtectedWallBeamAxis,
} from './wallBeamAxes.js';
import { planOpeningEdgeBeams } from './openingEdgePlan.js';
import { floorOpeningEdges } from '../finish/stair/slabOpening.js';
import { roomBounds } from '../finish/gridCells.js';

// 矩形判定・辺の一致判定の許容誤差(mm)。floorOpeningEdges/wallBeamAxes.js と同じ規約
// （CL_OVERLAP_TOL_MM。丸め・端数対策の余裕）。
const RECT_EPS_MM = CL_OVERLAP_TOL_MM;

/**
 * stair（graphに設置された階段）と同じ世界座標フットプリントの階段が belowGraph にあるか
 * （「下階に同じ階段（到達元）がある」）。続きの階段はユーザーが上階で指定するもの（自動コピーは
 * しない。設置階の直上1階にはSTAIR_VOIDだけが置かれ、同footprintの階段が指定されるとペア部屋へ
 * 転用される）で、下階の階段とは別idのため、id一致ではなくフットプリント（roomBounds＝世界座標の
 * 外接矩形）の一致で判定する。形状（種別・向き）が下階と違ってもフットプリントが同じなら到達元。
 * @param {object} stair
 * @param {object} graph stairが属するgraph（自階）
 * @param {object} belowGraph 1つ下の実体階のgraph
 * @returns {boolean}
 */
function hasMatchingStairBelow(stair, graph, belowGraph) {
  const rect = roomBounds(stair.cells, graph);
  if (!Number.isFinite(rect.x1)) return false;
  return belowGraph.stairs.some(s => {
    const r2 = roomBounds(s.cells, belowGraph);
    return Number.isFinite(r2.x1)
      && Math.abs(rect.x1 - r2.x1) < RECT_EPS_MM && Math.abs(rect.x2 - r2.x2) < RECT_EPS_MM
      && Math.abs(rect.y1 - r2.y1) < RECT_EPS_MM && Math.abs(rect.y2 - r2.y2) < RECT_EPS_MM;
  });
}

/**
 * floorOpeningEdges の stairFilter オプションを組み立てる（QAレビュー是正・2026-09-28）:
 * 「破れ先＝切断高より上に続く上り部分」（.claude/stair-model.md:38前半）は設置階自身の床の
 * 開口ではない——設置階の床に穴は無い。「自階スラブの開口越しに見下ろす下階階段」（同行後半）に
 * なるのは**下階に到達元の階段があるとき**だけ（ユーザーが上階で指定した続きの階段）。belowGraphが無い
 * （最下階・屋根専用平面）ときは常にfalse——破れ先は開口源にしない。
 * @param {object} graph
 * @param {object|null} belowGraph
 * @returns {(stair:object)=>boolean}
 */
export function stairFilterFor(graph, belowGraph) {
  return (stair) => belowGraph != null && hasMatchingStairBelow(stair, graph, belowGraph);
}

/**
 * 辺集合を componentId（floorOpeningEdges が付与する、開口セルの4近傍連結成分）でグルーピングする
 * （Q3是正・Minor-3是正・2026-09-28QAレビュー）: 「矩形のみ」（Q3）は**開口1つずつ**の意味であり、
 * 複数の独立した開口（例: STAIR_VOID1部屋＋VOID1部屋の計8辺）を1つの外接矩形として合成すると、
 * 互いに独立な矩形開口まで巻き添えで非矩形スキップになる。旧実装は辺の端点共有で連結成分を
 * 決めていたが、角だけで接する2開口（4近傍では非連結）を誤って同じ成分にまとめる不良があった
 * （Minor-3）ため、セル自体の4近傍で決めた componentId をそのまま使う（二重の連結判定を持たない）。
 * @param {ReturnType<typeof floorOpeningEdges>} edges
 * @returns {Array<Array>} 連結成分ごとの辺配列
 */
function groupByConnectivity(edges) {
  const groups = new Map();
  for (const e of edges) {
    if (!groups.has(e.componentId)) groups.set(e.componentId, []);
    groups.get(e.componentId).push(e);
  }
  return [...groups.values()];
}

/**
 * edge（floorOpeningEdges の1辺）の軸CL上にある下地オーナー壁の「外側の面」の絶対座標を返す
 * （無ければnull）。「下地オーナー壁か」の判定は wallBeamAxes.js の wallBackingCenters/
 * selfWallSegments と同じ述語（wall.backingRange!=null）をそのまま読む——二重の定義を持たない。
 * axisCL id・isVertical一致かつ辺の区間[lo,hi]と重なる壁が対象。
 *
 * 【Major-1是正・QAレビュー】辺座標(edge.coord)±半幅で逃げ量を出す旧実装は「下地帯が軸CL中心に
 * ある」前提が偏芯壁（backingOffset≠0）で崩れ、梁が下地に食い込む／隙間が開く不良があった
 * （QA実測±45）。下地帯の外側の面（wallBackingCenterCoord(wall) + outwardSign×半幅。絶対座標）を
 * 基準にすることで偏芯を吸収する。辺の区間に重なる下地オーナー壁が複数あれば、外側へ最も
 * 出ている面（outwardSign方向に最大）を採る（指示書§5失敗系「両側に下地オーナー壁」）。
 * @param {object} graph
 * @param {{isVertical:boolean, axisCL:string, lo:number, hi:number, outwardSign:1|-1}} edge
 * @returns {number|null}
 */
function backingOuterFaceOnEdge(graph, edge) {
  let best = null;
  for (const wall of graph.walls) {
    if (wall.isVertical !== edge.isVertical) continue;
    if (wall.axisCL.id !== edge.axisCL) continue;
    if (wall.backingRange == null) continue; // isBackingOwnerWall(wall)と同じ判定（wallBeamAxes.js）
    const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
    const overlap = Math.min(hi, edge.hi) - Math.max(lo, edge.lo);
    // 辺の角に同一軸の壁の端が壁の下地帯幅ぶん（＋許容誤差）入り込むだけ（隣室との間仕切が角で終わる）の
    // 壁は辺の壁ではない——数えると目標座標が壁厚ぶん外へずれる。入り込みがそれ以下なら除外する。
    const bandWidth = wall.backingRange.hi - wall.backingRange.lo;
    if (overlap <= bandWidth + CL_OVERLAP_TOL_MM) continue;
    const halfWidth = bandWidth / 2;
    const face = wallBackingCenterCoord(wall) + edge.outwardSign * halfWidth; // 下地帯の外側の面（絶対座標）
    if (best == null || edge.outwardSign * face > edge.outwardSign * best) best = face; // 外側へ最も出ている面
  }
  return best;
}

/**
 * 主構造ルールの既定梁断面（rules.defaultSections.beam）の幅(mm)。カタログに解決できなければnull
 * （beamWidthUnresolved診断。structural/beamAxisMove.js:104と同じ既定断面の引き方——sectionDefIdを
 * findSectionEntryで解決する）。
 * @param {ReturnType<typeof rulesFor>} rules
 * @returns {number|null}
 */
export function defaultBeamWidthMm(rules) {
  return findSectionEntry(rules.defaultSections.beam)?.width ?? null;
}

/**
 * edge に生成する梁芯の座標とその他フラグを返す（Major-1是正）。下地オーナー壁があれば
 * coord = 下地帯の外側の面（backingOuterFaceOnEdge。絶対座標・偏芯を吸収） +
 *   outwardSign×(梁幅/2 + rules.openingBeamClearanceMm)
 * （メモ「壁下地材を逃げた所」＝下地帯の外面に梁の面が合う。Q1裁定clearance=既定0）。
 * 壁が無ければ coord = edge.coord（offset無し）。
 * @param {object} graph
 * @param {object} edge floorOpeningEdgesの1辺
 * @param {ReturnType<typeof rulesFor>} rules
 * @returns {{coord:number, beamWidthUnresolved:boolean}}
 */
export function edgeTarget(graph, edge, rules) {
  const outerFace = backingOuterFaceOnEdge(graph, edge);
  if (outerFace == null) return { coord: edge.coord, beamWidthUnresolved: false };
  const beamWidth = defaultBeamWidthMm(rules);
  const clearance = rules.openingBeamClearanceMm ?? 0;
  const offset = (beamWidth ?? 0) / 2 + clearance;
  return { coord: outerFace + edge.outwardSign * offset, beamWidthUnresolved: beamWidth == null };
}

/**
 * edges（floorOpeningEdgesの結果。矩形のみ対象・Q3）が単一矩形の4辺と一致するかを判定し、
 * 一致すれば向き別に整理して返す。一致しなければnull（非矩形・複数開口の合成等は
 * ステップ4bで扱う——現状は空配列＋診断へフォールバック）。
 * @param {ReturnType<typeof floorOpeningEdges>} edges
 * @returns {{v1:object, v2:object, h1:object, h2:object}|null}
 */
export function rectangularSidesOf(edges) {
  const verts = edges.filter(e => e.isVertical);
  const horzs = edges.filter(e => !e.isVertical);
  if (verts.length !== 2 || horzs.length !== 2) return null;
  const [v1, v2] = [...verts].sort((a, b) => a.coord - b.coord);
  const [h1, h2] = [...horzs].sort((a, b) => a.coord - b.coord);
  if (!(v2.coord - v1.coord > RECT_EPS_MM) || !(h2.coord - h1.coord > RECT_EPS_MM)) return null;
  const closeTo = (a, b) => Math.abs(a - b) < RECT_EPS_MM;
  // 各辺が外接矩形の辺（4本）に過不足なく一致すること。
  if (!closeTo(v1.lo, h1.coord) || !closeTo(v1.hi, h2.coord)) return null;
  if (!closeTo(v2.lo, h1.coord) || !closeTo(v2.hi, h2.coord)) return null;
  if (!closeTo(h1.lo, v1.coord) || !closeTo(h1.hi, v2.coord)) return null;
  if (!closeTo(h2.lo, v1.coord) || !closeTo(h2.hi, v2.coord)) return null;
  return { v1, v2, h1, h2 };
}

/**
 * 床開口の辺を連結成分ごとに分け、矩形の成分だけを4辺の配列で返す（S造系の規則Oと、在来木造の
 * 吹抜け小梁（S3）が共有する入口）。矩形でない成分・複数開口の合成はスキップ（診断は
 * openingBeamSourcesDiagnostics）。
 * @param {object} graph
 * @param {{riserOf?: (stair:object)=>number|null, belowGraph?: object|null}} [opts]
 * @returns {Array<Array<ReturnType<typeof floorOpeningEdges>[number]>>} 矩形成分ごとの4辺
 */
export function openingEdgeComponents(graph, { riserOf = () => null, belowGraph = null } = {}) {
  const edges = floorOpeningEdges(graph, { riserOf, stairFilter: stairFilterFor(graph, belowGraph) });
  return groupByConnectivity(edges).filter(c => rectangularSidesOf(c));
}

/**
 * 計画器（planOpeningEdgeBeams）へ渡す支え線（host）を集める（S/RC/SRC/未定。設計 D1）:
 *   (a) 通り芯（beamPlacement!=='wallRuns' のとき全長。通り芯上に大梁が立つ前提の代理）
 *   (b) RC下地壁由来の梁芯源（rcWallAxisSources。clIdは壁由来梁芯が既にあればそのid）
 *   (c) 手動配置の梁（dimensionStatus!=='auto' の primary／secondary。clIdは梁の軸CL）。
 *       ただし軸CLの beamAxisOrigin が OPENING の梁は除く——規則O自身が作った小梁をユーザーが
 *       部材リストで固定（locked）しただけで辺が covered になり、架け方が組み替わる／中心線移動で
 *       旧梁芯が残って平行2本になるため。踊り場受け梁 LG（role 'landing'）も含めない（踊り場レベルの梁で
 *       床レベルの開口縁梁とは別。リード裁定）。
 *   (d) 由来 USER の梁芯（ユーザーが置いた梁芯。clId＝そのCL）
 * @param {object} graph
 * @param {ReturnType<typeof rulesFor>} rules
 * @param {Array} rcWallAxisSources
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number, kind:string, clId?:string}>}
 */
function openingHostsFor(graph, rules, rcWallAxisSources) {
  const hosts = [];
  if (rules.beamPlacement !== 'wallRuns') {
    for (const cl of graph.gridXs) hosts.push({ isVertical: true, coord: cl.value, lo: -Infinity, hi: Infinity, kind: 'grid', clId: cl.id });
    for (const cl of graph.gridYs) hosts.push({ isVertical: false, coord: cl.value, lo: -Infinity, hi: Infinity, kind: 'grid', clId: cl.id });
  }
  for (const s of rcWallAxisSources) {
    const type = s.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const cl = findBeamAnchorCL(graph, type, s.coord);
    hosts.push({ isVertical: s.isVertical, coord: s.coord, lo: s.lo, hi: s.hi, kind: 'wall', ...(cl ? { clId: cl.id } : {}) });
  }
  for (const beam of graph.beams) {
    if (beam.dimensionStatus === 'auto' || (beam.role !== 'primary' && beam.role !== 'secondary')) continue;
    if (beam.axisCL.beamAxisOrigin === BeamAxisOrigin.OPENING) continue; // 規則O自身の梁芯に乗る梁は手動配置ではない
    const a = beam.clStart.effectiveValue, b = beam.clEnd.effectiveValue;
    hosts.push({
      isVertical: beam.isVertical, coord: beam.axisCL.effectiveValue, lo: Math.min(a, b), hi: Math.max(a, b),
      kind: 'beam', clId: beam.axisCL.id,
    });
  }
  for (const cl of beamAxisCenterLines(graph)) {
    if (cl.beamAxisOrigin !== BeamAxisOrigin.USER) continue;
    if (cl.centerLineType !== CenterLineType.VERTICAL && cl.centerLineType !== CenterLineType.HORIZONTAL) continue;
    hosts.push({
      isVertical: cl.centerLineType === CenterLineType.VERTICAL, coord: cl.effectiveValue,
      lo: cl.extentLo ?? -Infinity, hi: cl.extentHi ?? Infinity, kind: 'user', clId: cl.id,
    });
  }
  return hosts;
}

/**
 * 単一の矩形成分（4辺）を計画器へ通し、配置・被覆・除外・支え不足に分けた結果を返す。
 * openingBeamSourcesFor／Diagnostics が連結成分ごとに呼ぶ（二重実装しない）。
 * @param {object} graph
 * @param {ReturnType<typeof rulesFor>} rules
 * @param {Array} edges4 openingEdgeComponents の1成分
 * @param {ReturnType<typeof openingHostsFor>} hosts
 * @returns {ReturnType<typeof planOpeningEdgeBeams>}
 */
function planForRect(graph, rules, edges4, hosts) {
  const edges = edges4.map(edge => {
    const t = edgeTarget(graph, edge, rules);
    return { ...edge, target: t.coord, beamWidthUnresolved: t.beamWidthUnresolved };
  });
  const coverTol = Math.max(CL_OVERLAP_TOL_MM, (defaultBeamWidthMm(rules) ?? 0) / 2);
  return planOpeningEdgeBeams(edges, hosts, {
    coverTol,
    canPlace: edge => !graph.excludedWallBeamAxes.has(wallBeamAxisExcludeKey(edge.isVertical, edge.target)),
  });
}

/** 計画の配置結果（placed）を、梁芯生成源（プレーンオブジェクト）へ写す。 */
function sourceOfPlaced({ edge, target, order, loRef, hiRef, through }) {
  return {
    isVertical: edge.isVertical, coord: target, lo: edge.lo, hi: edge.hi,
    outwardSign: edge.outwardSign, through,
    source: edge.source, sources: edge.sources, beamWidthUnresolved: edge.beamWidthUnresolved,
    axisCLId: edge.axisCL, // 辺が乗る軸CLのid（ステップ6: 再計算照合・中心線移動追従が
    // 「同じ辺」を前後で対応づけるのに使う。梁芯生成には使わない）。
    order, spanRefs: { lo: loRef, hi: hiRef },
  };
}

/** 矩形成分すべてを計画し、(rules, hosts) の組と成分ごとの計画結果を返す。 */
function planAllComponents(graph, project, rules, opts) {
  const components = openingEdgeComponents(graph, opts);
  if (components.length === 0) return { components, plans: [] };
  // I-9是正: RC下地の下地オーナー壁由来の梁芯生成源（自階のみ。wallBeamAxes.js
  // autoFillWallBeamAxesが先に同じ位置へ梁芯を生成済み）。RC造以外は空配列。
  const rcWallAxisSources = rules.wallBeamAxes === 'rcBacking' ? wallBeamSourcesFor(graph, project, null) : [];
  const hosts = openingHostsFor(graph, rules, rcWallAxisSources);
  return { components, plans: components.map(c => planForRect(graph, rules, c, hosts)) };
}

/**
 * graph（自階）の床開口から、規則Oの梁芯生成源（プレーン配列）を求める（同期・純関数）。
 * 主構造ルール（structureRules.js openingBeamAxes）が'slabOpenings'でなければ空配列
 * （木造・鉄骨/RC以外は対象外）。floorOpeningEdgesが返す辺は連結成分（groupByConnectivity）
 * ごとに独立して矩形判定する——「矩形のみ」（Q3）は開口1つずつの意味であり、複数の独立した
 * 開口が同一階にあっても、矩形の成分だけ処理し非矩形の成分はスキップする（診断は
 * openingBeamSourcesDiagnostics 参照）。
 * 各矩形成分の4辺は計画器（openingEdgePlan.js planOpeningEdgeBeams）に通す: 既に梁のある辺
 * （通り芯・RC下地壁・手動梁・由来USERの梁芯が重なる）・除外集合にある辺・支えが片側に無い辺は
 * 源にしない。残りは支え間のスパンが短い辺から順に（order昇順）源になり、後の辺は先に置いた辺を
 * 支え（spanRefs）にする。through＝両端の支えがどちらも開口の梁でない（=通し）。
 * 破れ先（source:'stairBeyond'）は`belowGraph`（1つ下の実体階）に「同じ階段（到達元）」が
 * あるときだけ源になる——設置階自身の破れ先は開口ではない（stairFilterFor参照）。
 * @param {object} graph
 * @param {object} project
 * @param {{riserOf?: (stair:object)=>number|null, belowGraph?: object|null,
 *   rules?: ReturnType<typeof rulesFor>}} [opts] -
 *   belowGraph省略時（既定null）は破れ先を一切源にしない（最下階・屋根専用平面と同じ扱い。
 *   呼び出し側=structuralRecompute.jsは既にpeek済みのbelowGraphをそのまま渡す）。
 *   rules省略時（既定undefined）は`rulesFor(effectiveStructure(graph, project))`を使う——
 *   テスト用のDI引数（Minor-6。defaultSections.beamが未知の断面キーのrulesを注入し
 *   beamWidthUnresolvedの経路を実データのrulesFor改変なしで検証できるようにする）。
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number, outwardSign:1|-1,
 *   through:boolean, source:string, sources:string[], beamWidthUnresolved:boolean, axisCLId:string,
 *   order:number,
 *   spanRefs:{lo:{kind:string, coord:number, clId?:string}, hi:{kind:string, coord:number, clId?:string}}}>}
 */
export function openingBeamSourcesFor(graph, project, { riserOf = () => null, belowGraph = null, rules: rulesOverride = undefined } = {}) {
  const rules = rulesOverride ?? rulesFor(effectiveStructure(graph, project));
  if (rules.openingBeamAxes !== 'slabOpenings') return [];
  // 非矩形の成分はスキップ（診断はopeningBeamSourcesDiagnostics）。
  const { plans } = planAllComponents(graph, project, rules, { riserOf, belowGraph });
  return plans.flatMap(plan => plan.placed.map(sourceOfPlaced));
}

/**
 * openingBeamSourcesFor が源を返さない／一部だけ返した理由を診断する（probe・テスト用の補助。
 * 生成本体には使わない）。
 * @param {object} graph
 * @param {object} project
 * @param {{riserOf?: (stair:object)=>number|null, belowGraph?: object|null,
 *   rules?: ReturnType<typeof rulesFor>}} [opts] - rulesはopeningBeamSourcesForと同じDI引数（Minor-6）。
 * @returns {{skipped: 'notApplicable'|'noOpenings'|'nonRectangular'|null, edgeCount?:number,
 *   componentCount?:number, rectangularCount?:number, nonRectangularCount?:number,
 *   beamWidthUnresolvedCount?:number, coveredCount?:number, excludedCount?:number, unsupportedCount?:number,
 *   edges?: Array<{isVertical:boolean, coord:number, target:number,
 *     status:'placed'|'covered'|'excluded'|'unsupported', span?:number, order?:number, loRef?:object, hiRef?:object}>}}
 */
export function openingBeamSourcesDiagnostics(graph, project, { riserOf = () => null, belowGraph = null, rules: rulesOverride = undefined } = {}) {
  const rules = rulesOverride ?? rulesFor(effectiveStructure(graph, project));
  if (rules.openingBeamAxes !== 'slabOpenings') return { skipped: 'notApplicable' };
  const edges = floorOpeningEdges(graph, { riserOf, stairFilter: stairFilterFor(graph, belowGraph) });
  if (edges.length === 0) return { skipped: 'noOpenings' };
  const components = groupByConnectivity(edges);
  const { plans } = planAllComponents(graph, project, rules, { riserOf, belowGraph });
  const rectangularCount = plans.length;
  const nonRectangularCount = components.length - rectangularCount;
  // Minor-6: 実際に生成される源（placed）まで組み立て、梁幅が解決できなかった件数を数える。
  const beamWidthUnresolvedCount = plans
    .flatMap(p => p.placed).filter(p => p.edge.beamWidthUnresolved).length;
  // 辺ごとの判定表（probeの説明用。status＝placed／covered／excluded／unsupported）。
  const table = [];
  for (const p of plans) {
    const base = e => ({ isVertical: e.isVertical, coord: e.coord, target: e.target });
    for (const x of p.placed) table.push({ ...base(x.edge), status: 'placed', span: x.span, order: x.order, loRef: x.loRef, hiRef: x.hiRef });
    for (const x of p.covered) table.push({ ...base(x.edge), status: 'covered' });
    for (const x of p.excluded) table.push({ ...base(x.edge), status: 'excluded' });
    for (const x of p.unsupported) table.push({ ...base(x.edge), status: 'unsupported' });
  }
  const count = key => plans.reduce((n, p) => n + p[key].length, 0);
  return {
    skipped: rectangularCount === 0 ? 'nonRectangular' : null,
    edgeCount: edges.length, componentCount: components.length,
    rectangularCount, nonRectangularCount, beamWidthUnresolvedCount,
    coveredCount: count('covered'), excludedCount: count('excluded'), unsupportedCount: count('unsupported'),
    edges: table,
  };
}

/**
 * 開口源（openingBeamSourcesForの1件）が要求するextent（範囲の根拠）を求める（M-1是正・QA指摘。
 * autoFillOpeningBeamAxes（新規生成）とreconcileOpeningBeamAxes（既存梁芯の役割照合・張り直し）が
 * 同じ計算を共有する——二重実装しない）。
 * 両端とも同じ手順: spanRefs.X.clId のCL（graph に今もあれば）→ 無ければ spanRefs.X.coord にある
 * 梁芯・通り芯（findBeamAnchorCL）→ それも無ければ静的値 spanRefs.X.coord。
 * @param {object} graph
 * @param {object} src openingBeamSourcesForの1件
 * @returns {{loRef: {clId:string, offset:number}|null, hiRef: {clId:string, offset:number}|null,
 *   lo: number|null, hi: number|null}}
 */
function extentTargetFor(graph, src) {
  const orthoType = src.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const resolve = (ref) => {
    const byId = ref.clId != null ? resolveCLById(graph.shapeMap, graph._structGraph, ref.clId, CenterLine) : null;
    return byId ?? findBeamAnchorCL(graph, orthoType, ref.coord);
  };
  const loCL = resolve(src.spanRefs.lo);
  const hiCL = resolve(src.spanRefs.hi);
  return {
    loRef: loCL ? { clId: loCL.id, offset: 0 } : null, lo: loCL ? null : src.spanRefs.lo.coord,
    hiRef: hiCL ? { clId: hiCL.id, offset: 0 } : null, hi: hiCL ? null : src.spanRefs.hi.coord,
  };
}

/**
 * openingBeamSourcesFor の結果から梁芯CLを生成する（同期・純生成。autoFillWallBeamAxes と同型）。
 * autoFillStructuralGrid の autoFillWallBeamAxes 直後で呼ぶ。
 *   - 梁のある辺（通り芯・RC下地壁・手動梁）は源に含まれない（openingBeamSourcesFor＝計画器が除く）。
 *   - 源のorder昇順（先に置く辺が先。後の辺のextent参照先が先に生成されている必要があるため）。
 *   - 除外集合（graph.excludedWallBeamAxes）にあれば生成しない（wallBeamAxisExcludeKeyを共用）。
 *   - 重複ガード: findBeamAnchorCL（通り芯・梁芯の第1候補）が返せば再利用し、由来未設定なら書き戻す。
 *   - extentは両端ともextentTargetFor（spanRefsのclId→座標のCL→静的値）。
 * @param {object} graph
 * @param {ReturnType<typeof openingBeamSourcesFor>} openingSources
 * @returns {import('../core.js').CenterLine[]} 新規作成した梁芯CLの配列
 */
export function autoFillOpeningBeamAxes(graph, openingSources) {
  const created = [];
  const ordered = [...openingSources].sort((a, b) => a.order - b.order); // 安定ソート
  for (const src of ordered) {
    const centerLineType = src.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const excludeKey = wallBeamAxisExcludeKey(src.isVertical, src.coord);
    if (graph.excludedWallBeamAxes.has(excludeKey)) continue;

    const anchor = findBeamAnchorCL(graph, centerLineType, src.coord);
    if (anchor) {
      fillBeamAxisOriginIfUnknown(anchor, BeamAxisOrigin.OPENING);
      continue;
    }

    const { loRef: extentLoRef, hiRef: extentHiRef, lo: extentLo, hi: extentHi } = extentTargetFor(graph, src);

    created.push(graph.addCenterLine(centerLineType, src.coord, {
      labeled: false,
      discipline: Discipline.FUSE,
      extentLoRef, extentHiRef, extentLo, extentHi,
      beamAxisOrigin: BeamAxisOrigin.OPENING,
    }));
  }
  return created;
}

/**
 * 開口由来の梁芯（beamAxisOrigin===OPENING）を、再計算のたびに現況の開口・壁と照合し、
 * 追従・回収できない孤児を撤去する（ステップ6。中心線の移動・削除、部屋属性の変更、壁の偏芯変化
 * いずれも専用処理を持たず、再計算時のこの照合だけで拾う——設計 §4）。
 * `autoFillStructuralGrid` 内で `autoFillOpeningBeamAxes` の直前に呼ぶこと（同じ座標へ生成し直す前に
 * 古い梁芯を退場させる／再ラベルする）。
 *
 * 手順（対象は自階の梁芯CLのうち `beamAxisOrigin===OPENING` のものだけ——`USER`（手動移動で
 * 由来を切り替え済み。transform/centerLineOps.js commitCLMoveOp参照）・`WALL`等は対象外）:
 *   1. 座標（effectiveValue）と向きが openingSources のどれとも CL_OVERLAP_TOL_MM 以内で一致しない
 *      梁芯を孤児候補、一致する梁芯を一致候補とする。
 *   2.（M-1是正・QA指摘）一致候補について、一致した源から求まる期待extent（spanRefsの支え。
 *      extentTargetFor）と現状のextentLoRef/HiRefを比較し、
 *      違えば**同idのまま**graph.setCenterLineExtentRefで張り直す（座標が一致しても、開口の形状が
 *      変わって「どの通り芯／どの通し辺を参照すべきか」という役割が変わることがあるため——
 *      座標一致だけでは検出できない）。張り直した梁芯に乗るrole:'secondary'かつ
 *      dimensionStatus==='auto'の小梁は撤去する（直後のautoFillSecondaryBeamsが新しいextentで
 *      作り直す。非autoは残す＝ロック済みの手動材を巻き込まない）。この張り直しは孤児の保護判定
 *      （手順4）より先に行う——短辺が旧通し辺への参照を持ったままだと、旧通し辺が「まだ参照されて
 *      いる」ため孤児回収できない（座標一致が崩れて孤児になった通し辺を、張り直し前の短辺の参照が
 *      いつまでも保護してしまう）。
 *   3. 孤児候補のうち、座標が wallSources のどれかと一致するものは撤去せず、由来を WALL へ
 *      書き替える（開口が消えても壁が根拠を持つ——以後は壁由来のライフサイクルへ移る）。
 *   4. 残りの孤児候補は isProtectedWallBeamAxis で保護判定するが、`ignoreRefsFrom`（孤児候補id全体の
 *      集合）を渡し、同じ矩形の中で短辺が通し辺を extentLoRef/HiRef で参照しているだけの関係は
 *      保護理由にしない（そうしないと通し辺が常に保護され、開口が消えても残ってしまう。n-7是正:
 *      refId参照はignoreRefsFromでも無視しない——isProtectedWallBeamAxis側の規約）。
 *      保護されない孤児は `graph.removeCenterLine`（依存の小梁・柱は teardown で道連れに消え、
 *      直後の autoFillOpeningBeamAxes・autoFillSecondaryBeams が同じ関数呼び出しの中で作り直す）。
 * @param {object} graph
 * @param {ReturnType<typeof openingBeamSourcesFor>} openingSources 現況の開口由来生成源
 * @param {Array<{isVertical:boolean, coord:number}>} wallSources 現況の壁由来生成源
 *   （wallBeamAxes.js wallBeamSourcesFor の戻り値。主構造がwallBeamAxes生成源を持たない階は[]）
 * @returns {{removed: import('../core.js').CenterLine[], relabeled: import('../core.js').CenterLine[],
 *   retargeted: import('../core.js').CenterLine[]}} removed=撤去（重複なし）・relabeled=由来を
 *   WALLへ書き替えた梁芯・retargeted=extentを同idのまま張り直した梁芯（m-5・changed判定に使う）。
 */
/**
 * graph の梁芯CL（beamAxisOrigin===OPENING）のうち、座標（effectiveValue）と向きが openingSources の
 * いずれかと CL_OVERLAP_TOL_MM 以内で一致するものを{cl, src}の配列で返す（一致候補。孤児は含まない）。
 * reconcileOpeningBeamAxes（1段目）とretargetOpeningBeamAxisExtentsAfterCreate（2段目）が
 * 共有する走査（二重実装しない）。
 * @param {object} graph
 * @param {ReturnType<typeof openingBeamSourcesFor>} openingSources
 * @returns {Array<{cl: import('../core.js').CenterLine, src: object}>}
 */
function matchedOpeningCandidates(graph, openingSources) {
  const candidates = beamAxisCenterLines(graph).filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING);
  const isVerticalOf = (cl) => cl.centerLineType === CenterLineType.VERTICAL;
  const out = [];
  for (const cl of candidates) {
    const src = openingSources.find(s =>
      s.isVertical === isVerticalOf(cl) && Math.abs(s.coord - cl.effectiveValue) < CL_OVERLAP_TOL_MM);
    if (src) out.push({ cl, src });
  }
  return out;
}

/**
 * matched（matchedOpeningCandidatesの結果）の各エントリについて、期待extent（extentTargetFor）と
 * 現状のextentLoRef/HiRefを比較し、違えば**同idのまま**graph.setCenterLineExtentRefで張り直す
 * （M-1是正）。張り直した梁芯に乗るrole:'secondary'かつdimensionStatus:'auto'の小梁は撤去する
 * （m-3(a)是正: 直後のautoFillSecondaryBeamsが新しいextentで作り直す。非autoは残す）。
 * 【m-3(c)是正・QA指摘】撤去するauto小梁に子スリーブ（graph.sleevesのhostBeamId一致）が乗っていれば
 * 先に消す——structural/beamAxisMove.js:95-96の前例（梁撤去の直前に子スリーブを消す）と同じ規律。
 * 【n-1是正・QA指摘】静的extentの読み出しはcore/centerLine.jsが公開するextentLo/extentHi getter
 * （refが無いときは内部フィールド`_extentLo/_extentHi`をそのまま返す）を使う——内部フィールドを
 * ここで直読みしない（refが設定されている枝では早期にmismatch=trueになるため、この関数が
 * getter経由で読むタイミングでは常にref無し＝getterが素の静的値を返すことが保証されている）。
 * @param {object} graph
 * @param {Array<{cl: import('../core.js').CenterLine, src: object}>} matched
 * @returns {import('../core.js').CenterLine[]} 張り直した梁芯CLの配列
 */
function retargetMatchedOpeningExtents(graph, matched) {
  const retargeted = [];
  const refEquals = (a, b) => (a?.clId ?? null) === (b?.clId ?? null);
  const staticEquals = (a, b) => (a == null && b == null)
    || (a != null && b != null && Math.abs(a - b) < CL_OVERLAP_TOL_MM);
  for (const { cl, src } of matched) {
    const expected = extentTargetFor(graph, src);
    const loMismatch = !refEquals(cl.extentLoRef, expected.loRef)
      || (expected.loRef == null && !staticEquals(cl.extentLo, expected.lo));
    const hiMismatch = !refEquals(cl.extentHiRef, expected.hiRef)
      || (expected.hiRef == null && !staticEquals(cl.extentHi, expected.hi));
    if (!loMismatch && !hiMismatch) continue;
    if (loMismatch) graph.setCenterLineExtentRef(cl, 'lo', expected.loRef, expected.lo);
    if (hiMismatch) graph.setCenterLineExtentRef(cl, 'hi', expected.hiRef, expected.hi);
    retargeted.push(cl);
    // 張り直した梁芯に乗るrole:'secondary'かつdimensionStatus:'auto'の小梁は撤去する
    // （直後のautoFillSecondaryBeamsが新しいextentで作り直す。非autoは残す）。
    for (const beam of [...graph.beams]) {
      if (beam.axisCL.id === cl.id && beam.role === 'secondary' && beam.dimensionStatus === 'auto') {
        // m-3(c)是正: 子スリーブ（梁ホスト）を先に消す（beamAxisMove.js:95-96と同じ規律）。
        for (const sleeve of [...graph.sleeves]) {
          if (sleeve.hostBeamId === beam.id) graph.sleeveMap.delete(sleeve.id);
        }
        graph.beamMap.delete(beam.id);
      }
    }
  }
  return retargeted;
}

/**
 * 全ての一致候補を対象に、matchedOpeningCandidates→retargetMatchedOpeningExtentsを
 * もう一度実行する（M-1'是正・QA指摘）。`autoFillStructuralGrid`内で`autoFillOpeningBeamAxes`の
 * **直後**に呼ぶこと——reconcileOpeningBeamAxes（autoFillOpeningBeamAxesの直前）の時点では、
 * 先に置く辺（支えになる開口梁芯）がまだ存在しないため、後の辺の期待extent
 * （spanRefsのclId／座標のfindBeamAnchorCL）が解決できず静的値へフォールバックする——
 * autoFillOpeningBeamAxesが新しい梁芯を生成した直後にもう一度この関数を呼ぶことで、
 * 同じ再計算1回の中で参照を新しい梁芯のidへ張り直せる（1パスで収束させる。
 * 呼ばないと次の再計算でchanged=trueになり続け、S造/RC造の構造同期は1パス打ち切り
 * （structuralOrchestration.js）のため利用者の操作なしに再計算が繰り返し必要になってしまう）。
 * 通し・短辺の区別はなくなった（支えが開口梁芯か通り芯かは源ごとの結果）ため全源が対象。
 * @param {object} graph
 * @param {ReturnType<typeof openingBeamSourcesFor>} openingSources 現況の開口由来生成源
 * @returns {import('../core.js').CenterLine[]} 張り直した梁芯CLの配列（m-5・changed判定に使う）
 */
export function retargetOpeningBeamAxisExtentsAfterCreate(graph, openingSources) {
  return retargetMatchedOpeningExtents(graph, matchedOpeningCandidates(graph, openingSources));
}

export function reconcileOpeningBeamAxes(graph, openingSources, wallSources) {
  const isVerticalOf = (cl) => cl.centerLineType === CenterLineType.VERTICAL;
  const matches = (sources, cl) => sources.some(s =>
    s.isVertical === isVerticalOf(cl) && Math.abs(s.coord - cl.effectiveValue) < CL_OVERLAP_TOL_MM);

  const matched = matchedOpeningCandidates(graph, openingSources);
  const matchedIds = new Set(matched.map(({ cl }) => cl.id));
  const orphans = beamAxisCenterLines(graph)
    .filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING && !matchedIds.has(cl.id));

  // M-1是正（1段目）: 一致候補のextent（役割）を現況の源から張り直す（同id）。
  // 孤児の保護判定より先に行う（短辺が旧通し辺への参照を持ったままだと孤児回収できないため）。
  const retargeted = retargetMatchedOpeningExtents(graph, matched);

  // 壁ソースに一致する孤児は即座にWALLへ再ラベルして生き残る（以後、保護判定では「Cの外の生存者」
  // と同じ扱いにする——ignoreRefsFromから外す）。
  const relabeled = [];
  const undecided = [];
  for (const cl of orphans) {
    if (matches(wallSources, cl)) {
      cl.beamAxisOrigin = BeamAxisOrigin.WALL;
      relabeled.push(cl);
    } else {
      undecided.push(cl);
    }
  }

  // 固定点反復（マーク&スイープ）: 「Cに含まれる他の開口由来CLからの参照は保護理由にしない」だが、
  // その参照元自身が（保護済みユーザーデータ等で）生き残ると決まった時点からは、その参照は
  // 「生存者からの参照」として扱う——通し辺を短辺が参照し、短辺自身が非auto小梁等で保護されて
  // 残る場合、通し辺もその参照によって保護される（1回の判定では終わらないため反復する）。
  const ignoreRefsFrom = new Set([...undecided.map(cl => cl.id)]);
  const survivedIds = new Set();
  let stable = false;
  while (!stable) {
    stable = true;
    for (const cl of undecided) {
      if (survivedIds.has(cl.id)) continue;
      if (isProtectedWallBeamAxis(graph, cl, { ignoreRefsFrom })) {
        survivedIds.add(cl.id);
        ignoreRefsFrom.delete(cl.id); // 以後、生存者からの参照として数える
        stable = false;
      }
    }
  }

  const toRemove = undecided.filter(cl => !survivedIds.has(cl.id));
  for (const cl of toRemove) graph.removeCenterLine(cl.id);
  return { removed: toRemove, relabeled, retargeted };
}

/**
 * openingBeamSourcesFor の前後スナップショットから、辺の位置が動いた箇所を対応づける
 * （mapBackingCenterMoves と同型。ステップ6の3。commitCLMoveOp の中心線移動確定が、壁由来梁芯と
 * 同じ手順で開口由来梁芯を追従させるために使う）。
 * 対応づけは2段階（QA指摘m-4是正: 移動先が既存CLの座標へ厳密一致すると、floorOpeningEdgesが
 * その辺の`axisCL`を移動元CLから移動先CLへ動的に差し替える——移動元CLの`axisCLId`は物理的には
 * 同じ辺のままなのに、beforeとafterで別idになり1段階のaxisCLId一致だけでは対応が切れてしまう）:
 *   1段階目（厳格・M-3是正）: 同一`isVertical`・同一`axisCLId`（辺が乗る軸CLのid）・同一
 *     `outwardSign`（同じCLを軸にする対辺どうし、例えばL字の内外2辺を区別する）のうち、
 *     区間 [lo,hi] の重なり長が最大（かつ正）のものを1:1で対応づける（mapBackingCenterMoves と
 *     同じ「座標近さではなく重なり長」の規約——偶然近い別の辺と誤対応する事故を避ける）。
 *   2段階目（フォールバック・m-4是正）: 1段階目で対応が付かなかったbeforeエントリだけ、
 *     axisCLIdの一致を落とし`isVertical`・`outwardSign`・区間重なり最大で再度対応づける
 *     （既に使用済みのafterエントリは対象外）。
 * @param {ReturnType<typeof openingBeamSourcesFor>} before
 * @param {ReturnType<typeof openingBeamSourcesFor>} after
 * @returns {Array<{isVertical:boolean, from:number, to:number}>}
 */
export function mapOpeningSourceMoves(before, after) {
  const usedAfter = new Set();
  const bestMatch = (b, requireAxisMatch) => {
    let bestIdx = -1, bestOverlap = 0;
    for (let i = 0; i < after.length; i++) {
      if (usedAfter.has(i)) continue;
      const a = after[i];
      if (requireAxisMatch && a.axisCLId !== b.axisCLId) continue;
      if (a.isVertical !== b.isVertical || a.outwardSign !== b.outwardSign) continue;
      const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestIdx = i; }
    }
    return bestIdx;
  };

  const moves = [];
  const unmatched = [];
  for (const b of before) {
    const idx = bestMatch(b, true);
    if (idx === -1) { unmatched.push(b); continue; }
    usedAfter.add(idx);
    const a = after[idx];
    if (a.coord !== b.coord) moves.push({ isVertical: b.isVertical, from: b.coord, to: a.coord });
  }
  for (const b of unmatched) {
    const idx = bestMatch(b, false);
    if (idx === -1) continue; // 対応する新側が無い（開口が消えた等）— reconcileの撤去に任せる
    usedAfter.add(idx);
    const a = after[idx];
    if (a.coord !== b.coord) moves.push({ isVertical: b.isVertical, from: b.coord, to: a.coord });
  }
  return moves;
}
