// 床開口（吹抜け・昇降路・階段吹抜け・階段の破れ先）を囲むセル境界CLから梁芯CL（discipline:'fuse'）
// を自動生成する（規則O。S造・RC造・SRC造。木造は在来の階段開口処理＝stairOpeningRuns が別に担う
// ため対象外＝structureRules.js openingBeamAxes:null）。壁由来の梁芯（wallBeamAxes.js）と同じ
// ライフサイクル関数（graph.addCenterLine・discipline:FUSE・beamAxisOrigin）へ薄く乗せる。
// 設計意図は .claude/structural-model.md 参照。
import { CenterLineType, Discipline } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { BeamAxisOrigin, fillBeamAxisOriginIfUnknown } from '../core/centerLine.js';
import { findSectionEntry } from './sectionCatalog.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { findBeamAnchorCL, wallBeamAxisExcludeKey, bracketExtent, wallBackingCenterCoord, wallBeamSourcesFor } from './wallBeamAxes.js';
import { floorOpeningEdges } from '../finish/stair/slabOpening.js';
import { roomBounds } from '../finish/gridCells.js';

// 矩形判定・辺の一致判定の許容誤差(mm)。floorOpeningEdges/wallBeamAxes.js と同じ規約
// （CL_OVERLAP_TOL_MM。丸め・端数対策の余裕）。
const RECT_EPS_MM = CL_OVERLAP_TOL_MM;

/**
 * stair（graphに設置された階段）と同じ世界座標フットプリントの階段が belowGraph にあるか
 * （「下階に同じ階段（到達元）がある」）。上階自動設置（finish/stair/stairFloorSync.js
 * syncUpperFloors）のコピーは`addStair`で新規idを発番する（同一idではない）ため、id一致ではなく
 * フットプリント（roomBounds＝世界座標の外接矩形）の一致で判定する——コピーは同じ踏面ジオメトリを
 * 平行移動なしで複製するため、上下階で完全一致する。
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
 * なるのは**下階に到達元の階段があるとき**だけ（上階自動設置のコピー）。belowGraphが無い
 * （最下階・屋根専用平面）ときは常にfalse——破れ先は開口源にしない。
 * @param {object} graph
 * @param {object|null} belowGraph
 * @returns {(stair:object)=>boolean}
 */
function stairFilterFor(graph, belowGraph) {
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
    if (overlap <= 0) continue;
    const halfWidth = (wall.backingRange.hi - wall.backingRange.lo) / 2;
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
function defaultBeamWidthMm(rules) {
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
function edgeTarget(graph, edge, rules) {
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
 * @returns {{v1:object, v2:object, h1:object, h2:object, throughIsVertical:boolean}|null}
 */
function rectangularSidesOf(edges) {
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
  const width = v2.coord - v1.coord, height = h2.coord - h1.coord;
  // 通し方向（Q2）: 外接矩形の長辺方向を通し。beamJunction.jsの出隅規則と同じ言葉
  // 「長い方が勝ち、同長はX」——同長(width===height)はfalse（水平辺=isVertical:falseが通し）。
  const throughIsVertical = height > width;
  return { v1, v2, h1, h2, throughIsVertical };
}

/**
 * edge の軸方向・座標・区間が rcWallAxisSources（RC下地の下地オーナー壁由来の梁芯生成源。
 * wallBeamAxes.js wallBeamSourcesFor の結果）のいずれかと一致するか（I-9是正）。
 * RC造の開口辺にRC下地壁があると、壁由来梁芯（壁芯）と開口梁芯（外面+クリアランス）が平行に
 * 2本立ってしまう——RC壁は自身が梁の役目を持つ（structureRules.js wallBeamAxes:'rcBacking'で
 * 壁芯に梁芯が立つ）ため、その辺は生成対象から外し、壁芯の梁芯（autoFillWallBeamAxesが先に
 * 生成済み）を参照する。判定は同じ軸方向・辺の区間[lo,hi]と重なり・壁芯座標が辺座標の許容差内
 * （RECT_EPS_MM）——壁芯とCLがほぼ一致する通常配置だけを対象にする。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} rcWallAxisSources
 * @param {{isVertical:boolean, coord:number, lo:number, hi:number}} edge
 * @returns {boolean}
 */
function isRcBackedEdge(rcWallAxisSources, edge) {
  return rcWallAxisSources.some(s => s.isVertical === edge.isVertical
    && Math.min(s.hi, edge.hi) - Math.max(s.lo, edge.lo) > 0
    && Math.abs(s.coord - edge.coord) < RECT_EPS_MM);
}

/**
 * 単一の矩形成分（rectangularSidesOfの戻り値）から梁芯生成源（プレーン配列）を組み立てる。
 * openingBeamSourcesForが連結成分ごとに呼ぶ（二重実装しない）。
 * @param {object} graph
 * @param {ReturnType<typeof rulesFor>} rules
 * @param {{v1:object, v2:object, h1:object, h2:object, throughIsVertical:boolean}} rect
 * @param {Array} rcWallAxisSources I-9是正: RC下地の下地オーナー壁由来の梁芯生成源（無ければ[]）
 * @returns {Array} openingBeamSourcesForと同じ形の配列
 */
function sourcesForRect(graph, rules, rect, rcWallAxisSources = []) {
  const { v1, v2, h1, h2, throughIsVertical } = rect;
  const throughEdges = throughIsVertical ? [v1, v2] : [h1, h2];
  const shortEdges = throughIsVertical ? [h1, h2] : [v1, v2];

  // skip=true（onGrid・I-9のRC下地壁一致）の辺はcoord=edge.coordのまま生成しない
  // （autoFillOpeningBeamAxes参照）。findBeamAnchorCLの許容差内に既存の梁芯（通り芯・壁芯）が
  // あるため、後段の重複ガードが自然にそれを再利用する。
  const targetOf = (edge) => (edge.onGrid || isRcBackedEdge(rcWallAxisSources, edge))
    ? { coord: edge.coord, beamWidthUnresolved: false, rcBacked: !edge.onGrid && isRcBackedEdge(rcWallAxisSources, edge) }
    : { ...edgeTarget(graph, edge, rules), rcBacked: false };

  const throughTargets = throughEdges.map(edge => ({ edge, ...targetOf(edge) }));

  const sources = [];
  for (const { edge, coord, beamWidthUnresolved, rcBacked } of throughTargets) {
    sources.push({
      isVertical: edge.isVertical, coord, lo: edge.lo, hi: edge.hi,
      outwardSign: edge.outwardSign, through: true, onGrid: edge.onGrid, rcBacked,
      source: edge.source, sources: edge.sources, beamWidthUnresolved,
    });
  }
  // 短辺のspanRefs: throughTargetsはcoord昇順（v1/v2・h1/h2のソート順）のまま——
  // 短辺自身のlo/hiも同じ昇順（辺は外接矩形の対辺いっぱいに一致済み）なので対応は位置そのまま。
  const [loThrough, hiThrough] = throughTargets;
  for (const edge of shortEdges) {
    const target = targetOf(edge);
    sources.push({
      isVertical: edge.isVertical, coord: target.coord, lo: edge.lo, hi: edge.hi,
      outwardSign: edge.outwardSign, through: false, onGrid: edge.onGrid, rcBacked: target.rcBacked,
      source: edge.source, sources: edge.sources, beamWidthUnresolved: target.beamWidthUnresolved,
      spanRefs: {
        lo: { kind: loThrough.edge.onGrid ? 'grid' : 'opening', coord: loThrough.coord },
        hi: { kind: hiThrough.edge.onGrid ? 'grid' : 'opening', coord: hiThrough.coord },
      },
    });
  }
  return sources;
}

/**
 * graph（自階）の床開口から、規則Oの梁芯生成源（プレーン配列）を求める（同期・純関数）。
 * 主構造ルール（structureRules.js openingBeamAxes）が'slabOpenings'でなければ空配列
 * （木造・鉄骨/RC以外は対象外）。floorOpeningEdgesが返す辺は連結成分（groupByConnectivity）
 * ごとに独立して矩形判定する——「矩形のみ」（Q3）は開口1つずつの意味であり、複数の独立した
 * 開口が同一階にあっても、矩形の成分だけ処理し非矩形の成分はスキップする（診断は
 * openingBeamSourcesDiagnostics 参照）。
 * onGridの辺（isGridCenterLine(axis)）は生成対象に含めない（不変条件6・通り芯上の辺は大梁の
 * 領分）——ただし短辺のextent参照のためその位置を`through:true`のソース自身に持たせる。
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
 *   through:boolean, onGrid:boolean, rcBacked:boolean, source:string, sources:string[],
 *   beamWidthUnresolved:boolean,
 *   spanRefs?: {lo:{kind:'grid'|'opening', coord:number}, hi:{kind:'grid'|'opening', coord:number}}}>}
 */
export function openingBeamSourcesFor(graph, project, { riserOf = () => null, belowGraph = null, rules: rulesOverride = undefined } = {}) {
  const rules = rulesOverride ?? rulesFor(effectiveStructure(graph, project));
  if (rules.openingBeamAxes !== 'slabOpenings') return [];
  const edges = floorOpeningEdges(graph, { riserOf, stairFilter: stairFilterFor(graph, belowGraph) });
  if (edges.length === 0) return [];
  // I-9是正: RC下地の下地オーナー壁由来の梁芯生成源（自階のみ。wallBeamAxes.js
  // autoFillWallBeamAxesが先に同じ位置へ梁芯を生成済み——重複させない）。RC造以外は空配列。
  const rcWallAxisSources = rules.wallBeamAxes === 'rcBacking' ? wallBeamSourcesFor(graph, project, null) : [];

  const sources = [];
  for (const component of groupByConnectivity(edges)) {
    const rect = rectangularSidesOf(component);
    if (!rect) continue; // 非矩形の成分はスキップ（診断はopeningBeamSourcesDiagnostics）
    sources.push(...sourcesForRect(graph, rules, rect, rcWallAxisSources));
  }
  return sources;
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
 *   beamWidthUnresolvedCount?:number}}
 */
export function openingBeamSourcesDiagnostics(graph, project, { riserOf = () => null, belowGraph = null, rules: rulesOverride = undefined } = {}) {
  const rules = rulesOverride ?? rulesFor(effectiveStructure(graph, project));
  if (rules.openingBeamAxes !== 'slabOpenings') return { skipped: 'notApplicable' };
  const edges = floorOpeningEdges(graph, { riserOf, stairFilter: stairFilterFor(graph, belowGraph) });
  if (edges.length === 0) return { skipped: 'noOpenings' };
  const rcWallAxisSources = rules.wallBeamAxes === 'rcBacking' ? wallBeamSourcesFor(graph, project, null) : [];
  const components = groupByConnectivity(edges);
  const rectangularComponents = components.filter(c => rectangularSidesOf(c));
  const nonRectangularCount = components.length - rectangularComponents.length;
  // Minor-6: 実際に生成される源（sourcesForRect）まで組み立て、梁幅が解決できなかった件数を数える。
  const beamWidthUnresolvedCount = rectangularComponents
    .flatMap(c => sourcesForRect(graph, rules, rectangularSidesOf(c), rcWallAxisSources))
    .filter(s => s.beamWidthUnresolved).length;
  return {
    skipped: rectangularComponents.length === 0 ? 'nonRectangular' : null,
    edgeCount: edges.length, componentCount: components.length,
    rectangularCount: rectangularComponents.length, nonRectangularCount, beamWidthUnresolvedCount,
  };
}

/**
 * openingBeamSourcesFor の結果から梁芯CLを生成する（同期・純生成。autoFillWallBeamAxes と同型）。
 * autoFillStructuralGrid の autoFillWallBeamAxes 直後で呼ぶ。
 *   - onGrid・rcBackedのソースは生成しない（不変条件6＝通り芯・I-9＝RC下地壁の壁芯梁芯。
 *     いずれも既に対象位置に梁芯／通り芯がある）。
 *   - 通し辺を先に、短辺を後に処理する（短辺のextent参照先＝通し辺の梁芯が先に生成されている必要があるため）。
 *   - 除外集合（graph.excludedWallBeamAxes）にあれば生成しない（wallBeamAxisExcludeKeyを共用）。
 *   - 重複ガード: findBeamAnchorCL（通り芯・梁芯の第1候補）が返せば再利用し、由来未設定なら書き戻す。
 *   - 通し辺のextentは壁由来と同じbracketExtent（直交通り芯で挟む）。
 *   - 短辺のextentはspanRefsのcoordから、通し方向のCL（findBeamAnchorCL）を解決して参照する
 *     （見つからなければ静的extentへフォールバック）。
 * @param {object} graph
 * @param {ReturnType<typeof openingBeamSourcesFor>} openingSources
 * @returns {import('../core.js').CenterLine[]} 新規作成した梁芯CLの配列
 */
export function autoFillOpeningBeamAxes(graph, openingSources) {
  const created = [];
  const ordered = [...openingSources.filter(s => s.through), ...openingSources.filter(s => !s.through)];
  for (const src of ordered) {
    if (src.onGrid || src.rcBacked) continue; // 通り芯上の辺（不変条件6）・RC下地壁の辺（I-9）は生成しない

    const centerLineType = src.isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const excludeKey = wallBeamAxisExcludeKey(src.isVertical, src.coord);
    if (graph.excludedWallBeamAxes.has(excludeKey)) continue;

    const anchor = findBeamAnchorCL(graph, centerLineType, src.coord);
    if (anchor) {
      fillBeamAxisOriginIfUnknown(anchor, BeamAxisOrigin.OPENING);
      continue;
    }

    let extentLoRef, extentHiRef, extentLo, extentHi;
    if (src.through) {
      const gridCLs = src.isVertical ? graph.gridYs : graph.gridXs; // 直交通り芯（value昇順）
      const { loCL, hiCL } = bracketExtent(gridCLs, src.lo, src.hi);
      extentLoRef = loCL ? { clId: loCL.id, offset: 0 } : null;
      extentHiRef = hiCL ? { clId: hiCL.id, offset: 0 } : null;
      extentLo = loCL ? null : src.lo;
      extentHi = hiCL ? null : src.hi;
    } else {
      const orthoType = src.isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
      const loCL = findBeamAnchorCL(graph, orthoType, src.spanRefs.lo.coord);
      const hiCL = findBeamAnchorCL(graph, orthoType, src.spanRefs.hi.coord);
      extentLoRef = loCL ? { clId: loCL.id, offset: 0 } : null;
      extentHiRef = hiCL ? { clId: hiCL.id, offset: 0 } : null;
      extentLo = loCL ? null : src.spanRefs.lo.coord;
      extentHi = hiCL ? null : src.spanRefs.hi.coord;
    }

    created.push(graph.addCenterLine(centerLineType, src.coord, {
      labeled: false,
      discipline: Discipline.FUSE,
      extentLoRef, extentHiRef, extentLo, extentHi,
      beamAxisOrigin: BeamAxisOrigin.OPENING,
    }));
  }
  return created;
}
