import { StructuralMaterialType, CenterLineType, columnSlotKey, spanKey, findHostBeam, openingHostRefCLs, IndependentFooting, RoomFeature } from '../core.js';
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { beamAxisCenterLines as policyBeamAxisCenterLines } from '../core/centerLineKindPolicy.js';
import { DEFAULT_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { findSectionEntry } from './sectionCatalog.js';
import { isFoundationPlane } from './drawingDesignation.js';
import { computeTributaryColumnWidth, computeColumnBaseSize, computeFoundationBeamSize, computeRoofBeamSize } from './memberSizing.js';
import { peekVia } from './structuralPeek.js';
import { isRigidFrameStructure, structureHasMemberKind, memberKindOf, MEMBER_KIND } from './structuralClassification.js';
import { rulesFor, defaultMaterialFor, UNSPECIFIED_STRUCTURE, effectiveStructure } from './structureRules.js';
import { autoFillWoodColumns, autoFillWoodWallBeams, autoFillWoodFloorBeams, autoFillWoodSillBeams } from './woodAutoFill.js';
import { buildExteriorSide, footprintCellKeys } from './wallGate.js';
import { autoFillWallBeamAxes } from './wallBeamAxes.js';
import { autoFillOpeningBeamAxes, reconcileOpeningBeamAxes, retargetOpeningBeamAxisShortExtents } from './openingBeamAxes.js';
import { landingEdgeCLs, landingZ } from '../finish/stair/stairLanding.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { roomBounds } from '../finish/gridCells.js';

// 構造モード突入時に呼ばれる、構造体トポロジー（構造グリッド）から未定義の柱・梁・基礎を検出して
// デフォルト材料・断面で自動生成する純関数群。finish/edgeClassify.js の選定・差分同期パターンを流用する。
// 対象は labeled 柱芯（discipline:struct）の交点・隣接辺のみ（耐力壁・スラブは対象外）。
//
// 【データ帰属】柱は「その柱が物理的に立つ自階」のgraphに、自階の実効主構造で生成・格納する
// （基礎伏図=最下階も自階の柱を生成する）。「基礎伏図に柱を書かない」「2階伏図には1階の柱を書く」
// 等の伏図慣習は描画層（StructuralLayer.jsx が1つ下の階graphの柱を読む）で実現し、生成とは分離する。
// 平面モードは自階graphの柱をそのまま描く。
//
// 基礎伏図（isFoundationPlane）固有なのは「床下の構造材」だけ:
//   交点 → 独立フーチング（柱脚）を追加生成、辺 → 基礎梁（role:'foundation', symbol FG）
//   （通常階/屋根の辺は大梁 role:'primary', symbol G）。柱自体はどの実体平面でも自階分を生成する。
// 屋根専用平面（isRoofPlane）は「柱の立つ階」ではないため柱は生成しない（横架材=軒桁のみ）。

// 主構造未指定を表す値（structureRules.MAIN_STRUCTURE_OPTIONS[0]）。
// 未指定の間は部材を自動生成・材変換しない（木造フォールバックで実データが湧くのを防ぐ）。
// 実体は structureRules.js（主構造ごとのルールセット）。既存の import 経路を保つため再exportする。
export { UNSPECIFIED_STRUCTURE };

/** 主構造の文字列表記から既定の StructuralMaterialType を導出する（structureRules.js の baseMaterial。
 *  '未定' 等の未知はフォールバック既定=WOOD。生成・変換は呼び出し側でガード済み）。 */
export function defaultMaterialType(mainStructure) {
  return defaultMaterialFor(mainStructure);
}

/** その階の実効主構造（階の上書き優先・なければ建物全体値）。実体は structureRules.js（既存の import 経路の互換で再export）。 */
export { effectiveStructure };

/** その階の主構造が確定しているか（'未定'でない）。未確定の間は柱・梁・基礎を自動生成しない。 */
export function isStructureSpecified(graph, project) {
  return effectiveStructure(graph, project) !== UNSPECIFIED_STRUCTURE;
}

/** その階の実効主構造（階の上書き優先・なければ建物全体値）から既定材料を導出する。 */
export function resolveDefaultMaterialType(graph, project) {
  return defaultMaterialType(effectiveStructure(graph, project));
}

/** 基礎伏図で「ベース（独立フーチング）」を自動生成するか（木造べた基礎時はベースなし）。
 *  木造のなし／土間コンは基礎梁＋ベースの合成のためベースを生成する。非木造は常に生成する。
 *  判定は主構造ルール（structureRules.js の foundation.hasBase）。 */
export function foundationGeneratesBase(structure, foundationType) {
  return rulesFor(structure).foundation.hasBase(foundationType);
}

/** 基礎伏図で「べた基礎（マットスラブ role:'mat_foundation'）」を自動生成するか（木造べた基礎時のみ）。
 *  非木造の基礎スラブは手動配置（自動生成しない）。判定は主構造ルール（foundation.hasMatSlab）。 */
export function foundationGeneratesMatSlab(structure, foundationType) {
  return rulesFor(structure).foundation.hasMatSlab(foundationType);
}

// 柱芯（ColumnAxis）の対象＝柱・梁でラーメン躯体を構成する構造形式のみ（S造/SRC造/RC造(ラーメン)）。
// 木造・RC造(壁式)は対象外（既存の通り芯をそのまま柱芯として使う＝偏芯量は常に0）。
// 判定データは構造分類の単一の真実（structuralClassification.js）へ移設した。既存の import 経路
// （MemberListTab 等が structuralAutoFill から取る）を保つため、ここで再exportする。
export { isRigidFrameStructure };

/** labeled柱芯のX×Y全交点を列挙する（柱の配置候補）。 */
export function computeGridIntersections(graph) {
  const xs = graph.gridXs, ys = graph.gridYs;
  const result = [];
  for (const verticalCL of xs) {
    for (const horizontalCL of ys) {
      result.push({ verticalCL, horizontalCL, key: columnSlotKey(verticalCL, horizontalCL) });
    }
  }
  return result;
}

/** 隣接するグリッドCL間の辺を列挙する（梁の配置候補。X方向・Y方向の両方）。 */
export function computeGridSpans(graph) {
  const xs = graph.gridXs, ys = graph.gridYs;
  const spans = [];
  for (const hCL of ys) {
    for (let i = 0; i < xs.length - 1; i++) {
      spans.push({ axisCL: hCL, isVertical: false, clStart: xs[i], clEnd: xs[i + 1], key: spanKey(hCL, xs[i], xs[i + 1]) });
    }
  }
  for (const vCL of xs) {
    for (let i = 0; i < ys.length - 1; i++) {
      spans.push({ axisCL: vCL, isVertical: true, clStart: ys[i], clEnd: ys[i + 1], key: spanKey(vCL, ys[i], ys[i + 1]) });
    }
  }
  return spans;
}

/** 柱が存在しない交点を検出し、自階の実効主構造・既定断面で自動生成する（除外集合のスロットはスキップ）。
 *  柱は物理的に立つ自階のgraphに格納するため、材料も自階基準（resolveDefaultMaterialType）で導出する。
 *  基礎伏図でも呼ぶ（最下階の柱も自階分として生成する）。屋根専用平面では呼ばない。 */
export function autoFillColumns(graph, project, wallGate = null) {
  if (!isStructureSpecified(graph, project)) return { created: [], removed: [], originsUpdated: [] }; // 主構造未確定の間は生成しない
  const rules = rulesFor(effectiveStructure(graph, project));
  const materialType = rules.baseMaterial;
  const intersections = computeGridIntersections(graph);
  const validKeys = new Set(intersections.map(i => i.key));
  const existing = new Set(graph.columns.map(c => columnSlotKey(c.verticalCL, c.horizontalCL)));
  const created = [];
  for (const { verticalCL, horizontalCL, key } of intersections) {
    if (existing.has(key) || graph.excludedColumnSlots.has(key)) continue;
    // 建物フットプリント外の交点には柱を作らない（外壁線で有無を取捨。wallGate.js 参照）。
    if (wallGate && !wallGate.intersectionInBuilding(verticalCL, horizontalCL)) continue;
    created.push(graph.addColumn(materialType, rules.defaultSections.column, verticalCL, horizontalCL, {}));
  }
  // 撤去段（一般則。ユーザー裁定・案A・2026-09-25）: 通り芯グリッド交点方式（gridIntersections。
  // 在来木造の壁交点方式=autoFillWoodColumnsは別に撤去ループを持つ）の柱は、生成が「候補キーに無ければ
  // 作る」ADD-ONLYのため、通り芯が消えて候補キー集合が変わっても古いキーに紐づくauto柱は自然には
  // 消えない（`removeDependentsOfCenterLine`のJSDoc参照。実測: gridAddStructuralSyncProbe.mjsのA4）。
  // locked／手動固定（dimensionStatus!=='auto'）は保護。excludedColumnSlotsには触れない——手動削除の
  // 記録ではなく、通り芯の消滅に追従する自然な後始末のため。
  const removed = [];
  for (const column of graph.columns) {
    // 杭（role:'foundation'）は自動生成の対象外（本関数は作らない）なので撤去対象からも外す
    // （woodAutoFill.js:729の撤去ループと同じ保護。手動配置された杭を誤って巻き込まない）。
    if (column.role === 'foundation' || column.dimensionStatus !== 'auto') continue;
    if (validKeys.has(columnSlotKey(column.verticalCL, column.horizontalCL))) continue;
    graph.columnMap.delete(column.id);
    removed.push(column.id);
  }
  return { created, removed, originsUpdated: [] };
}

/** 柱の自動生成を主構造ルールの選択子（columnPlacement）で振り分ける単一の入口。
 *  通り芯交点（既定）＝autoFillColumns、壁交点＋上階柱直下＋上階の柱生成点源の壁交点（在来木造）＝
 *  autoFillWoodColumns（撤去も伴う）。aboveColumns・wallSegments・aboveBeamSegments・belowColumns は
 *  在来木造（columnPlacement:'wallIntersections'）のときだけ autoFillWoodColumns（ステップ3b・3h-2・
 *  3iのbelow優先候補）へ渡す——非在来では無視される。belowColumnsは同名のautoFillBeamsForStructure
 *  引数（3c-2b）と同じ値をそのまま渡せる。
 *  構造モード突入時の再計算（autoFillStructuralGrid）と、下階グラフへの反映（structuralOrchestration.js）が共有する。
 *  wallSourceCache: 1回の再計算内で壁区間（wallBeamAxes.js wallBeamSourcesFromGraph）をmemoする
 *  キャッシュ（wallBeamAxes.js createWallSourceCache。ステップC）。省略時は従来どおり自前で全走査する。
 *  originsUpdated（QA裁定Major-1・2026-09-27）: 在来木造（wallIntersections）のときだけ非空になりうる
 *  ——既存柱の由来集合（structural/columnOrigins.js）だけが変わった柱id（autoFillWoodColumns参照）。
 *  非在来は常に[]。
 *  @returns {{created: object[], removed: string[], originsUpdated: string[]}} */
export function autoFillColumnsForStructure(graph, project, wallGate = null, aboveColumns = [], wallSegments = [], aboveBeamSegments = [], belowColumns = [], wallSourceCache = undefined) {
  if (!isStructureSpecified(graph, project)) return { created: [], removed: [], originsUpdated: [] };
  const rules = rulesFor(effectiveStructure(graph, project));
  if (rules.columnPlacement === 'wallIntersections') return autoFillWoodColumns(graph, project, wallGate, aboveColumns, wallSegments, aboveBeamSegments, belowColumns, wallSourceCache);
  return autoFillColumns(graph, project, wallGate);
}

/** 柱が存在しない交点を検出し、独立フーチングをデフォルト材料・断面で自動生成する（除外集合のスロットはスキップ）。
 *  基礎伏図専用（柱の代わりに生成する）。手動の「＋追加」UI（MemberListTab.jsx）と同じ kind:'independent' を使う。
 *  独立フーチングは主構造（S造/木造等）に関わらず常にRC造（地中の基礎はRC造という建築の慣習に合わせたもの）。 */
export function autoFillFootings(graph, wallGate = null) {
  const materialType = StructuralMaterialType.RC;
  const intersections = computeGridIntersections(graph);
  const validKeys = new Set(intersections.map(i => i.key));
  const existing = new Set(graph.footings.map(f => columnSlotKey(f.verticalCL, f.horizontalCL)));
  const created = [];
  for (const { verticalCL, horizontalCL, key } of intersections) {
    if (existing.has(key) || graph.excludedFootingSlots.has(key)) continue;
    // 建物フットプリント外の交点には独立フーチングを作らない（柱と同じゲート。wallGate.js 参照）。
    if (wallGate && !wallGate.intersectionInBuilding(verticalCL, horizontalCL)) continue;
    created.push(graph.addFooting('independent', DEFAULT_SECTION_BY_MATERIAL[materialType], verticalCL, horizontalCL, { materialType }));
  }
  // 撤去段（一般則。ユーザー裁定・案A・2026-09-25）: autoFillColumnsと同じADD-ONLYの穴を塞ぐ。
  // 対象は本関数が作る独立フーチング（IndependentFooting）のみ——柱脚（ColumnBase）は本関数が
  // 生成しない別種の実体のため触らない。locked／手動固定（dimensionStatus!=='auto'）は保護。
  // excludedFootingSlotsには触れない。
  const removed = [];
  for (const footing of graph.footings) {
    if (!(footing instanceof IndependentFooting)) continue;
    if (footing.dimensionStatus !== 'auto') continue;
    if (validKeys.has(columnSlotKey(footing.verticalCL, footing.horizontalCL))) continue;
    graph.footingMap.delete(footing.id);
    removed.push(footing.id);
  }
  return { created, removed };
}

// べた基礎マットスラブの既定厚(mm)は主構造ルール（structureRules.js foundation.sectionDefaults.matThickness＝
// 断面図の既定と同じ値）から引く。レベル（GL+50・天端制約）は次フェーズ。

/** 基礎伏図（基準階）に「べた基礎」のマットスラブ（StructuralSlab role:'mat_foundation'）を自動生成・撤去する。
 *  - 木造べた基礎（foundationGeneratesMatSlab）かつ建物フットプリントがある → 自動マットスラブが無ければ1枚生成する。
 *    cells は屋内/吹抜けの footprint セル（footprintCellKeys）。基礎部材は常にRC造（独立フーチング・基礎梁と同じ）。
 *  - それ以外（基礎種別がべた基礎でない等） → 自動生成分（dimensionStatus==='auto'）のマットスラブを撤去する。
 *  非破壊規律：手動固定/検査済み（dimensionStatus!=='auto'）のマットスラブは保持する。
 *  〔割り切り〕単一の自動マットスラブを「存在すれば生成しない」方式で管理する。ユーザーが削除しても再突入で
 *  復活する（柱・梁の excludedXxxSlots に相当する除外記録は持たない＝レベル/除外は次フェーズ）。
 *  更新（created/removed）したスラブidの配列を返す。 */
export function autoFillMatFoundation(graph, project) {
  if (!isFoundationPlane(graph.plane, project)) return { created: [], removed: [] }; // マットスラブは基礎伏図(最下階)のみ
  const structure = effectiveStructure(graph, project);
  const foundationType = project.structuralInfo.foundationType;
  const existing = graph.slabs.filter(s => s.role === 'mat_foundation');
  if (foundationGeneratesMatSlab(structure, foundationType)) {
    if (existing.length > 0) return { created: [], removed: [] }; // 既にある＝生成しない（手動・自動問わず1枚に保つ）
    const cells = footprintCellKeys(graph);
    if (cells.size === 0) return { created: [], removed: [] }; // フットプリント未定義なら生成しない
    const slab = graph.addSlab(
      StructuralMaterialType.RC,
      DEFAULT_SECTION_BY_MATERIAL[StructuralMaterialType.RC],
      cells,
      { role: 'mat_foundation', levelRef: 'top', thickness: rulesFor(structure).foundation.sectionDefaults.matThickness },
    );
    return { created: [slab.id], removed: [] };
  }
  // べた基礎でない → 自動生成分のマットスラブを撤去（手動固定/検査済みは保持）。
  const removed = [];
  for (const slab of existing) {
    if (slab.dimensionStatus !== 'auto') continue;
    graph.removeSlab(slab.id);
    removed.push(slab.id);
  }
  return { created: [], removed };
}

/** 梁が存在しないグリッド辺を検出し、デフォルト材料・断面で自動生成する（除外集合のスロットはスキップ）。
 *  role: 基礎伏図では 'foundation'（symbol FG）、それ以外（通常階・R階伏図）では 'primary'（symbol G）。
 *  基礎梁（role:'foundation'）は主構造に関わらず常にRC造（独立フーチングと同じ理由）。 */
export function autoFillBeams(graph, project, role = 'primary', wallGate = null) {
  // 基礎梁は主構造に関わらずRC（材種既定断面）。床梁は自階の主構造ルールの既定断面。
  const rules = rulesFor(effectiveStructure(graph, project));
  const materialType = role === 'foundation' ? StructuralMaterialType.RC : rules.baseMaterial;
  const section = role === 'foundation' ? DEFAULT_BEAM_SECTION_BY_MATERIAL[materialType] : rules.defaultSections.beam;
  const spans = computeGridSpans(graph);
  const validKeys = new Set(spans.map(s => s.key));
  const existing = new Set(graph.beams.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));
  const created = [];
  for (const { axisCL, isVertical, clStart, clEnd, key } of spans) {
    if (existing.has(key) || graph.excludedBeamSlots.has(key)) continue;
    // 建物フットプリント外の辺（どの対象階の屋内にも接しない辺）には梁を作らない（外壁線で有無を取捨。wallGate.js 参照）。
    if (wallGate && !wallGate.spanInBuilding(axisCL, isVertical, clStart, clEnd)) continue;
    created.push(graph.addBeam(materialType, section, axisCL, isVertical, clStart, clEnd, { role }));
  }
  // 撤去段（一般則。ユーザー裁定・案A・2026-09-25）: autoFillColumnsと同じADD-ONLYの穴を塞ぐ。
  // 対象は呼び出し時のroleと一致するauto梁だけ（beamMapは'primary'/'foundation'/'eaves'/'secondary'等
  // 複数roleを共有するため、他roleの梁を誤って巻き込まないようroleで絞る）。locked／手動固定
  // （dimensionStatus!=='auto'）は保護。excludedBeamSlotsには触れない。
  const removed = [];
  for (const beam of graph.beams) {
    if (beam.role !== role || beam.dimensionStatus !== 'auto') continue;
    if (validKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }
  return { created, removed };
}

/** 梁(role:'primary')の自動生成を主構造ルールの選択子（beamPlacement）で振り分ける単一の入口。
 *  通り芯グリッド辺（既定）＝autoFillBeams、壁線上の通し梁（在来木造）＝autoFillWoodWallBeams
 *  （撤去も伴う）。role==='primary'（かつ在来木造）のときだけ壁線方式へ切り替える——基礎梁
 *  （role:'foundation'）・屋根の軒桁（role:'eaves'、autoFillRoofBeams）・踊り場受け梁は別経路の
 *  ままここを通らない。wallSegments は wallGate と同じ既存パターン（呼び出し側が await して渡す）。
 *  belowColumns は在来木造の壁線通し梁が下階柱の位置で分割する（ステップ3c-2b）ために使う——
 *  1つ下の実体階の柱集合（structuralRecompute.js の belowGraph?.columns 等）で、非在来では無視される。
 *  構造モード突入時の再計算（autoFillStructuralGrid）が共有する。
 *  selfGate は autoFillWoodWallBeams の同名引数（wallGate.js buildSelfFootprintGate）をそのまま
 *  素通しする——省略時（undefined）はそちら側が graph 自身で自前計算するため、実体階の呼び出しは
 *  従来と同値（小屋伏図にも梁・柱ルールを適用する計画のステップ3。呼び出し側の切替はステップ5以降）。
 *  freeEndGraph は autoFillWoodWallBeams の同名引数（R-2・2026-09-19是正）をそのまま素通しする——
 *  省略時（undefined）はそちら側が既定値（graph自身）を使うため実体階は従来と同値。
 *  wallSourceCache は autoFillWoodWallBeams の同名引数（ステップC）をそのまま素通しする——
 *  省略時（undefined）はそちら側が毎回全走査するため従来と同値。
 *  @returns {{created: object[], removed: string[]}} */
export function autoFillBeamsForStructure(graph, project, role, wallGate = null, wallSegments = [], belowColumns = [], selfGate = undefined, freeEndGraph = undefined, wallSourceCache = undefined) {
  if (role === 'primary' && rulesFor(effectiveStructure(graph, project)).beamPlacement === 'wallRuns') {
    return autoFillWoodWallBeams(graph, project, wallSegments, wallGate, belowColumns, selfGate, freeEndGraph ?? graph, wallSourceCache);
  }
  return autoFillBeams(graph, project, role, wallGate);
}

// 梁芯CL（direct discipline:'fuse'、labeled:false）の追加座標許容誤差(mm)。
const SPAN_EPS = 0.5;

/** 階固有の梁芯CL（centerLineKind==='beam'）を列挙する。core/centerLineKindPolicy.js
 *  beamAxisCenterLinesへ委譲する再export——既存のexport名はstructural/MemberListTab.jsxが直接importしている。 */
export function beamAxisCenterLines(graph) {
  return policyBeamAxisCenterLines(graph);
}

/** 梁芯CL cl の「hostとなる直交大梁(role:'primary')を持つ通り芯」配列（value昇順、extentでフィルタ済み）を
 *  返す。隣接要素の連続ペアが小梁の生成対象区間になる（「梁と梁の内側」＝host有り通り芯の連続ペア。
 *  隣接通り芯ペアではない——途中に大梁を持たない通り芯（L字の他翼由来・wallGateで梁が省かれた軸など）が
 *  1本挟まるだけで小梁が全く生成されなくなるのを避けるため）。座標基準はeffectiveValue（pendingDelta込み）
 *  に統一する。host判定はfindHostBeam（core/structuralEntities.js）に集約——描画側（spanForHostBeams）
 *  と同一実装・同一tolerance。autoFillSecondaryBeams（自動補完）と structural/beamAxisMove.js の
 *  resolveSecondaryBeamsForAxis（梁芯移動確定時の局所再解決）が共有する単一実装——host判定・区間規則を
 *  二系統に分岐させないための切り出し。
 *  直交集合（cross）は通り芯（従来）に加え、openingHostRefCLs(cl)（開口由来の梁芯が extent で明示
 *  参照している梁芯CLオブジェクト。core/structuralEntities.jsがCLの内部フィールド_extentLoCL/_extentHiCLを
 *  読む唯一の場所——ここでは読まない）を合わせたもの——短辺の梁芯が通し辺の梁芯を参照する場合、その
 *  通し梁芯上のhost判定は allowSecondaryHost:true（小梁も host として認める）にする。通り芯には従来どおり
 *  primaryのみ（allowSecondaryHost:false）。開口由来でない梁芯は参照集合が空のため cross・host判定
 *  とも従来と完全同一（ステップ5・.claude/structural-model.md 参照）。
 *  参照集合が空（開口由来でない梁芯を含む大多数）のときは gridCross をそのまま使う（並べ替えない）——
 *  gridXs/gridYs は既に value 昇順で確定済みで、これを effectiveValue で再ソートすると、ドラッグ中
 *  （pendingDelta で value と effectiveValue の大小が入れ替わる瞬間）に従来と順序が変わってしまう
 *  （再発防止。findHostPrimaryBeam時代の挙動を1ビットも変えない）。参照集合が非空のときだけ、その
 *  梁芯CLを混ぜて value で再ソートする——直後の inRange フィルタ・extentLo/Hi 判定がどちらも
 *  value 基準（cl.extentLo ?? -Infinity 等）のため、cross の並びもそれに揃える。 */
export function secondaryBeamSpansFor(graph, cl) {
  if (cl.centerLineType === CenterLineType.RADIAL) return []; // 放射CLはジオメトリ未対応（getCenterLineSegment同様）
  const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
  const gridCross = isVertical ? graph.gridYs : graph.gridXs; // value昇順の直交通り芯
  const beamCross = openingHostRefCLs(cl).filter(r => r.centerLineType === (isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL));
  const beamCrossSet = new Set(beamCross);
  const cross = beamCross.length === 0 ? gridCross : [...gridCross, ...beamCross].sort((a, b) => a.value - b.value);
  const lo = cl.extentLo ?? -Infinity, hi = cl.extentHi ?? Infinity;
  const inRange = cross.filter(p => p.value >= lo - SPAN_EPS && p.value <= hi + SPAN_EPS);
  return inRange.filter(p =>
    findHostBeam(graph.beams, p.id, !isVertical, cl.effectiveValue, { allowSecondaryHost: beamCrossSet.has(p) }));
}

/** beamAxisCenterLines(graph) の走査順を「参照集合(openingHostRefCLs)が空（通し辺・壁由来・その他。
 *  従来と同じhost判定）→ 参照集合が非空（短辺・参照先の梁芯をhostに含めうる）」の2群に安定ソート
 *  （同順位内は元の順を保つ）する——開口由来かどうかでは分けない（openingHostRefCLsは開口由来でない
 *  梁芯には常に空を返すため、空/非空の2群だけで「参照する側は参照される側より後」を保証できる）。
 *  短辺の小梁が生成条件を満たすには、参照先の梁芯（通し辺の開口由来梁芯、または壁由来梁芯等）が
 *  先に小梁を持っている必要があるため（ステップ5-4。autoFillSecondaryBeams専用、収束ループには乗せない）。 */
function orderForSecondaryBeamFill(cls) {
  const rank = (cl) => openingHostRefCLs(cl).length === 0 ? 0 : 1;
  return cls.map((cl, i) => ({ cl, i })).sort((a, b) => (rank(a.cl) - rank(b.cl)) || (a.i - b.i)).map(x => x.cl);
}

/** 梁芯CL（discipline:'fuse'）ごとに、この梁芯を跨ぐ直交大梁(role:'primary')を持つ通り芯の
 *  連続ペア（＝梁と梁の内側）へ小梁（role:'secondary', symbol B）を自動生成する（除外集合のスロットはスキップ）。
 *  基礎伏図・屋上伏図はhostとなる大梁がrole:'primary'でない（'foundation'/'eaves'）ため自動的に0本になる
 *  （分岐不要）。構造モード突入時の再計算（autoFillStructuralGrid）と、梁芯CL追加時の両方から呼ぶ。
 *  走査順は orderForSecondaryBeamFill（開口由来の短辺は、参照する通し辺の小梁が先に生成されるよう後回し）。 */
export function autoFillSecondaryBeams(graph, project) {
  if (!isStructureSpecified(graph, project)) return [];
  const structure = effectiveStructure(graph, project);
  if (!structureHasMemberKind(MEMBER_KIND.BEAM, structure)) return [];
  const rules = rulesFor(structure);
  const materialType = rules.baseMaterial;
  const section = rules.defaultSections.beam;
  const existing = new Set(graph.beams.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));
  const created = [];
  for (const cl of orderForSecondaryBeamFill(beamAxisCenterLines(graph))) {
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const hosts = secondaryBeamSpansFor(graph, cl);
    for (let i = 0; i < hosts.length - 1; i++) {
      const a = hosts[i], b = hosts[i + 1];
      const key = spanKey(cl, a, b);
      if (existing.has(key) || graph.excludedBeamSlots.has(key)) continue;
      created.push(graph.addBeam(materialType, section, cl, isVertical, a, b, { role: 'secondary', beamType: '小梁' }));
      existing.add(key);
    }
  }
  return created;
}

/** 屋上伏図（isRoofPlane）専用：梁が存在しないグリッド辺を検出し、軒桁を含む横架材（role:'eaves',
 *  symbol EG）をデフォルト材料・断面で自動生成する（除外集合のスロットはスキップ）。
 *  autoFillBeams の role='primary' 相当を屋根専用平面向けに複製したもの——spanKey がroleを見ないため、
 *  同じグリッド辺に'primary'と'eaves'を両方生成すると先勝ちで重複防止が誤作動する。そのため
 *  autoFillStructuralGrid 側で isRoofPlane の場合は autoFillBeams(..., 'primary') を呼ばず、
 *  この関数だけを呼ぶこと。belowMainStructure: autoFillColumns と同じ「1つ下の階」（＝最上の実体平面）。 */
export function autoFillRoofBeams(graph, project, belowMainStructure, wallGate = null) {
  const rules = rulesFor(belowMainStructure);
  const materialType = rules.baseMaterial;
  const spans = computeGridSpans(graph);
  const validKeys = new Set(spans.map(s => s.key));
  const existing = new Set(graph.beams.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));
  const created = [];
  for (const { axisCL, isVertical, clStart, clEnd, key } of spans) {
    if (existing.has(key) || graph.excludedBeamSlots.has(key)) continue;
    // 軒桁も直下階のフットプリント（外壁線）でゲートする（wallGate は直下の最上階基準。wallGate.js 参照）。
    if (wallGate && !wallGate.spanInBuilding(axisCL, isVertical, clStart, clEnd)) continue;
    created.push(graph.addBeam(materialType, rules.defaultSections.beam, axisCL, isVertical, clStart, clEnd, { role: 'eaves' }));
  }
  // 撤去段（一般則。ユーザー裁定・案A・2026-09-25。autoFillColumns/autoFillBeams/autoFillFootingsと
  // 同じADD-ONLYの穴——role:'eaves'の軒桁も通り芯グリッド辺方式のため同型の症状が出る。
  // gridConvertStructuralSyncProbe.mjsのC5（13.stqの屋根平面）で発見）。
  const removed = [];
  for (const beam of graph.beams) {
    if (beam.role !== 'eaves' || beam.dimensionStatus !== 'auto') continue;
    if (validKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    graph.beamMap.delete(beam.id);
    removed.push(beam.id);
  }
  return { created, removed };
}

/** 軒桁を含む横架材(role:'eaves')の梁幅b・梁成Dを、自グラフ（屋上伏図）の最長スパンから再算定する。
 *  対象はdimensionStatus==='auto'の軒桁のみ（autoFillFoundationBeamSizesと同じ方式）。
 *  構造モード突入時、autoFillStructuralGrid と同タイミングで呼ぶ。更新した梁idの配列を返す。 */
export function autoFillRoofBeamSizes(graph) {
  const updated = [];
  const roofBeams = graph.beams.filter(b => b.role === 'eaves' && b.dimensionStatus === 'auto');
  if (roofBeams.length === 0) return updated;
  const { width, depth } = computeRoofBeamSize(graph);
  for (const beam of roofBeams) {
    if (beam.beamWidth === width && beam.beamDepth === depth) continue;
    beam.setField('beamWidth', width);
    beam.setField('beamDepth', depth);
    updated.push(beam.id);
  }
  return updated;
}

// 踊り場受け梁（role:'landing', symbol 'LG'）の生成対象材料（鉄骨・RC階段限定。ユーザー裁定
// 2026-08-23 §9-D。木造は階段自体が構造体のため下地鉄骨が不要で対象外）。
const LANDING_BEAM_STRUCTURES = new Set([StructuralMaterialType.STEEL, StructuralMaterialType.RC]);

// 踊り場桁枠のせい(mm)。elevation/section/sectionStair.jsのSTEEL_LANDING_FRAME_DEPTH_MMと同値
// （ユーザー裁定2026-08-23 §9-A＝ささらと同じ300）。ここへ複製するのは finish/stair/ →
// elevation/section/ へのimportを避けるため（finish/stair/stairLanding.jsのファイル冒頭コメント
// 「finish/stair/ 配下は elevation/ に依存しない」参照。structural/もelevation/を直接引かない）。
const LANDING_FRAME_DEPTH_MM = 300;
// 踊り場桁枠の下端から梁天端までの追加下がり(mm。ユーザー裁定2026-08-23 §9-C）。
const LANDING_BEAM_DROP_MM = 10;

// landingEdgeCLs（stairLanding.js）が返すCL id文字列から実CLオブジェクトを解決する。踊り場外周の
// 境界壁は階固有CL・通り芯CLのどちらもあり得るため、両方をマージ済みの graph.centerLines
// （core/planGraph.js）から引く（見つからなければnull。手動で通り芯を削除した直後などの防御）。
function resolveCLById(graph, id) {
  return graph.centerLines.find(cl => String(cl.id) === String(id)) ?? null;
}

// 踊り場矩形（roomBounds）の世界座標一致判定の許容誤差(mm)。openingBeamAxes.js hasMatchingStairBelow
// と同じ規約（CL_OVERLAP_TOL_MM）。
const LANDING_RECT_EPS_MM = CL_OVERLAP_TOL_MM;

function rectsMatch(r1, r2) {
  return Number.isFinite(r1.x1) && Number.isFinite(r2.x1)
    && Math.abs(r1.x1 - r2.x1) < LANDING_RECT_EPS_MM && Math.abs(r1.x2 - r2.x2) < LANDING_RECT_EPS_MM
    && Math.abs(r1.y1 - r2.y1) < LANDING_RECT_EPS_MM && Math.abs(r1.y2 - r2.y2) < LANDING_RECT_EPS_MM;
}

/** belowStair（1つ下の実体階=設置階に立つ階段）の踊り場外周辺を、到達階（graph）側で解決する。
 *  (a) footprint（roomBounds）が一致する上階自動設置コピー（finish/stair/stairFloorSync.js
 *  syncUpperFloors。graph.stairsに新idで複製される）があれば、それで landingEdgeCLs。
 *  (b) 無ければ（最上階＝コピーの代わりにSTAIR_VOID Roomだけがある）、footprintが一致する
 *  STAIR_VOID Roomを探し、belowStairのtype/upDirection/flip/sections/totalStepsとroom.cellsを
 *  合成したshimでlandingEdgeCLs（resolveSwitchbackSpanLengths・makeFrameはtype/upDirection/flip/
 *  sections/totalSteps/cellsしか読まないため、Stairの実インスタンスでなくても同じ幾何が求まる）。
 *  どちらも無ければnull。 */
function resolveArrivalLandingEdges(belowStair, belowGraph, graph) {
  const belowRect = roomBounds(belowStair.cells, belowGraph);
  if (!Number.isFinite(belowRect.x1)) return null;
  const copy = graph.stairs.find(s => rectsMatch(roomBounds(s.cells, graph), belowRect));
  if (copy) return landingEdgeCLs(copy, graph);
  const room = graph.rooms.find(r => r.feature === RoomFeature.STAIR_VOID && rectsMatch(roomBounds(r.cells, graph), belowRect));
  if (!room) return null;
  const shim = {
    type: belowStair.type, upDirection: belowStair.upDirection, flip: belowStair.flip,
    sections: belowStair.sections, totalSteps: belowStair.totalSteps, cells: room.cells,
  };
  return landingEdgeCLs(shim, graph);
}

/** belowGraph・現況の階段配置から、今回有効なLGの源（spanKey・材質・levelOffset等）を列挙する。
 *  belowGraphが無い（最下階・屋根専用平面・下階peek対象外）、またはfloorHeightAboveが未解決なら
 *  空配列（＝有効な源が0件。呼び出し側の撤去段が既存の自動生成LGを全撤去する）。 */
function collectLandingSources(graph, project, belowGraph) {
  if (!belowGraph) return [];
  const floorHeight = floorHeightAbove(project, belowGraph.plane); // 設置階(belowGraph)〜到達階(graph)の階高
  if (floorHeight == null) return [];
  const sources = [];
  for (const belowStair of belowGraph.stairs) {
    if (!LANDING_BEAM_STRUCTURES.has(belowStair.structure)) continue;
    const z = landingZ(belowStair, belowGraph, floorHeight); // 設置階FL基準
    if (z == null) continue;
    const edges = resolveArrivalLandingEdges(belowStair, belowGraph, graph);
    if (!edges) continue;
    const backEdge = edges.find(e => e.kind === 'back');
    if (!backEdge) continue;
    const axisCL = resolveCLById(graph, backEdge.axisCL);
    const clStart = resolveCLById(graph, backEdge.clStart);
    const clEnd = resolveCLById(graph, backEdge.clEnd);
    if (!axisCL || !clStart || !clEnd) continue;
    const materialType = belowStair.structure;
    const levelOffset = z - floorHeight - LANDING_FRAME_DEPTH_MM - LANDING_BEAM_DROP_MM;
    sources.push({ key: spanKey(axisCL, clStart, clEnd), axisCL, clStart, clEnd, isVertical: backEdge.isVertical, materialType, levelOffset });
  }
  return sources;
}

/** 鉄骨・RC階段の踊り場を支える受け梁（role:'landing', symbol 'LG'）を、踊り場の**到達階**
 *  （踊り場の上の階の伏図）へ自動生成する（設置階には出さない。ユーザー裁定2026-09-28）。
 *  源は`belowGraph.stairs`（1つ下の実体階＝設置階のgraph）——`graph.stairs`（自階＝到達階）からは
 *  生成しない（設置階自身の伏図は常に0本のまま。基礎伏図＝最下階も同様に0本）。到達階での踊り場
 *  外周辺の解決はresolveArrivalLandingEdges参照（単一の情報源finish/stair/stairLanding.jsの
 *  landingEdgeCLsを、上階自動設置コピーまたはSTAIR_VOID Room由来のshimへ適用する）。
 *  生成対象は踊り場外周4辺のうち壁側1辺（kind:'back'）だけ（ユーザー裁定2026-08-23 §9-B。
 *  side/front辺には生成しない）。対象は stair.structure（階段自身の材質）がSTEEL・RCの階段のみ
 *  （§9-D）。
 *  levelOffset（到達階FL基準）: 設置階FL基準のlandingZ（§9-C=踊り場桁枠下端-10mm）から、設置階〜
 *  到達階の階高ぶんを差し引いて到達階FL基準へ換算する
 *  （levelOffset = landingZ − 設置階〜到達階の階高 − LANDING_FRAME_DEPTH_MM − LANDING_BEAM_DROP_MM）。
 *
 *  撤去・更新段（一般則。ユーザー裁定・案A・2026-09-25と同型。QA指摘F1・2026-09-29是正）:
 *  今回の源から求めた有効spanKey集合を作り、(a) 集合に無い既存の自動生成LG（role:'landing'・
 *  dimensionStatus:'auto'）は撤去する（貫通スリーブ先消し・excludedBeamSlotsには触れない）——
 *  下階の階段が消えた・移動した等で旧LGが取り残されるのを防ぐ（autoFillBeamsの撤去段と同じ
 *  ADD-ONLYの穴を塞ぐ）。この段はbelowGraphがnull（最下階・設置階自身）でも走らせる——belowGraphが
 *  無い＝有効集合が空なので、そのgraphに残る自動生成LGは無条件で撤去対象になる。
 *  (b) 有効集合にある自動生成LGが既に存在する場合はlevelOffsetを最新値へ更新する（旧仕様で保存
 *  された正値のlevelOffset等が冪等スキップで直らない問題の是正）。
 *  (c) 有効集合にあり既存梁が無いスロットは新規生成する。同spanKeyに自動生成のG（role:'primary'・
 *  dimensionStatus:'auto'）があれば撤去してLGへ置き換える（貫通スリーブも連鎖削除・除外集合は
 *  汚さない生のbeamMap.delete。ユーザー裁定2026-09-28: LG区間には床大梁Gを置かない——ただしこれは
 *  置換分岐そのものが保証する。生成順序（大梁より前）は1パス内の無駄な生成→即撤去を省くだけで、
 *  順序自体が排他性を保証するわけではない。QA指摘F5是正）。同spanKeyに手動固定・他roleの梁が
 *  あればLGを作らずスキップする（skippedConflictsとして件数を返す）。excludedBeamSlotsに記録された
 *  辺（ユーザーがこのLGを手動削除済み）はG撤去も行わずそのままスキップする。
 *  wallGateは適用しない——階段のRoom（STAIR）・階段吹抜け（STAIR_VOID）はフットプリントの権威を
 *  確立しない（structural-model.md「属性Roomはフットプリントの権威を確立しない」）ため、ゲートに
 *  掛けると常に「範囲外」判定になり生成されなくなってしまう。
 *  @returns {{created: object[], removedG: string[], removedStale: string[], updated: string[], skippedConflicts: number}} */
export function autoFillStairLandingBeams(graph, project, wallGate = null, belowGraph = null) {
  void wallGate; // 意図的に未使用（理由は上記コメント）。他のautoFill*と引数構成を揃えるためだけに受け取る。
  const sources = collectLandingSources(graph, project, belowGraph);
  const validKeys = new Set(sources.map(s => s.key));

  // (a) 撤去段: 有効集合に無い自動生成LGは撤去する（belowGraphがnullでも走る）。
  const removedStale = [];
  for (const beam of graph.beams) {
    if (beam.role !== 'landing' || beam.dimensionStatus !== 'auto') continue;
    if (validKeys.has(spanKey(beam.axisCL, beam.clStart, beam.clEnd))) continue;
    for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === beam.id) graph.sleeveMap.delete(s.id);
    graph.beamMap.delete(beam.id);
    removedStale.push(beam.id);
  }

  const created = [];
  const removedG = [];
  const updated = [];
  let skippedConflicts = 0;
  for (const src of sources) {
    if (graph.excludedBeamSlots.has(src.key)) continue; // 手動削除されたLGは復活させない（Gの置換も行わない）
    const conflict = graph.beams.find(b => spanKey(b.axisCL, b.clStart, b.clEnd) === src.key);
    if (conflict) {
      if (conflict.role === 'landing') {
        // (b) 既存の自動生成LG: levelOffsetを最新値へ更新する（手動固定は上書きしない）。
        if (conflict.dimensionStatus === 'auto' && conflict.levelOffset !== src.levelOffset) {
          conflict.setField('levelOffset', src.levelOffset);
          updated.push(conflict.id);
        }
        continue;
      }
      if (conflict.role === 'primary' && conflict.dimensionStatus === 'auto') {
        // (c) 自動生成のGを置換する。除外集合は汚さない生の削除（deleteClassificationOverflowと同じ
        // 「梁ホストの貫通スリーブも連鎖削除する」規約）。
        for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === conflict.id) graph.sleeveMap.delete(s.id);
        graph.beamMap.delete(conflict.id);
        removedG.push(conflict.id);
      } else {
        skippedConflicts++; // 手動固定・他role の梁は上書きしない
        continue;
      }
    }
    created.push(graph.addBeam(
      src.materialType, DEFAULT_BEAM_SECTION_BY_MATERIAL[src.materialType],
      src.axisCL, src.isVertical, src.clStart, src.clEnd,
      { role: 'landing', levelOffset: src.levelOffset },
    ));
  }
  return { created, removedG, removedStale, updated, skippedConflicts };
}

/** 構造モード突入時に呼ぶ統合エントリポイント。柱・梁・基礎（フーチング）が対象（耐力壁・スラブは対象外）。
 *  柱はどの実体平面でも自階分を生成する（基礎伏図=最下階も自階の柱を生成する）。屋根専用平面（isRoofPlane）
 *  では柱を生成しない（柱の立つ階ではないため）。基礎伏図（isFoundationPlane）では床下に独立フーチングを
 *  追加生成し、梁は基礎梁（role:'foundation'）とする。屋根専用平面の梁はルールの選択子roofBeamPlacement
 *  （structureRules.js）で振り分ける——既定'gridEaves'は従来どおりautoFillRoofBeams（role:'eaves'）、
 *  在来木造'wallRuns'は自階（＝最上階）の壁線上の通し梁（role:'primary', beamType:'軒桁'。
 *  autoFillWoodWallBeams。小屋伏図にも梁・柱ルールを適用する計画のステップ5）。belowMainStructure:
 *  屋根横架材が属する「1つ下の階（=最上の実体平面）」の実効主構造（呼び出し元が drawingDesignation.js
 *  の structuralPlaneBelow で求めて渡す。非在来のautoFillRoofBeamsの材種決定に使う）。
 *  wallGate: 建物フットプリント（部屋領域＝外壁線位置）の鉛直連続性で柱・梁・基礎・軒桁の有無を取捨するゲート
 *  （wallGate.js / buildStructuralWallGate。屋根は直下の最上階基準。null＝ゲートなしで全グリッド生成）。
 *  wallSources: 壁由来の梁芯生成対象（structural/wallBeamAxes.js collectWallBeamSources の結果。
 *  下階peekを含む非同期収集のため呼び出し側が await して渡す＝wallGateと同じ既存パターン）。
 *  wallSegments: 壁線上の通し梁（在来木造・beamPlacement:'wallRuns'）が候補列挙に使う壁区間
 *  （wallBeamAxes.js wallRunSegments の結果。マージ不要のプレーン配列。他構造は未使用）。基礎伏図
 *  （isFoundationPlane。最下階には下階が無いため自階=1階の壁区間のみ）では同じ配列を土台
 *  （role:'sill'、woodAutoFill.js autoFillWoodSillBeams）の候補列挙にも渡す。
 *  在来木造（beamPlacement:'wallRuns'）は基礎梁（role:'foundation'）の生成・撤去が確定した直後に土台
 *  （role:'sill'。基礎伏図のみ）、続いて壁線上の通し梁の生成・撤去が確定した直後に床梁
 *  （role:'floor'、woodAutoFill.js autoFillWoodFloorBeams。ステップ3e-2）も生成・撤去する。
 *  aboveColumns: 1つ上の実体階の柱集合（在来木造の上階柱直下の柱＝ステップ3bが候補列挙に使う。
 *  wallBeamAxes.js peekAboveGraph の結果。呼び出し側が主構造ルール(columnPlacement)がwallIntersections
 *  のときだけ渡す想定——非在来では autoFillColumnsForStructure 側で無視される）。
 *  belowColumns: 1つ下の実体階の柱集合（在来木造の壁線通し梁の下階柱分割＝ステップ3c-2bと、3iの候補
 *  優先順struct＞center＞below＞910グリッドのbelow（ユーザー裁定2026-09-19「最下階まで可能な限り
 *  同位置に柱を追加」）の両方が使う。structuralRecompute.js の belowGraph?.columns 等。非在来では
 *  autoFillBeamsForStructure・autoFillColumnsForStructure 側で無視される）。
 *  aboveBeamSegments: 1つ上の実体階の柱生成の点源（role:'primary'または'floor'の梁の区間。在来木造の
 *  3h-2＝生成した梁が自階の壁と交わる位置に下階柱を立てる、が候補列挙に使う。wallBeamAxes.js
 *  columnSeedBeamSegments(aboveGraph, ...) の結果。aboveColumnsと同じ「wallIntersectionsのときだけ
 *  渡す」規律。非在来では無視される）。
 *  selfGate: 自階フットプリント単独ゲート（wallGate.js buildSelfFootprintGate）。autoFillWoodWallBeams/
 *  autoFillWoodSillBeamsへそのまま素通しする——省略時（undefined）はそちら側がgraph自身で自前計算する
 *  ため実体階は従来と同値（小屋伏図にも梁・柱ルールを適用する計画のステップ3。呼び出し側
 *  （structuralRecompute.js）が屋根専用平面のときだけ「1つ下の実体階（＝最上階）」のgraphから
 *  計算した値を渡せるようにするための引数。切替はステップ5以降）。
 *  freeEndGraph: 自由端（F-2・selfWallFreeEnds）の判定に使うgraph（R-2・2026-09-19是正）。
 *  autoFillWoodWallBeamsの同名引数へそのまま素通しする——省略時（undefined）はそちら側の既定値
 *  （graph自身）になるため実体階は従来と同値。呼び出し側（structuralRecompute.js）が屋根専用平面の
 *  ときだけ「1つ下の実体階（＝最上階）」のgraphを渡す。
 *  wallSourceCache: 1回の再計算内で壁区間をmemoするキャッシュ（wallBeamAxes.js createWallSourceCache。
 *  ステップC）。省略時（undefined）は従来どおり呼び出しのたびに壁区間を全走査する——本関数自身は
 *  wallSources/wallSegments（呼び出し側が既に導出済みの結果）を直接使うだけで消費しないが、内部で
 *  さらに壁区間を導出し直す autoFillColumnsForStructure（在来木造の壁交点柱）・autoFillWoodWallBeams
 *  （在来木造の壁線上の通し梁・屋根の軒桁）へそのまま素通しする。
 *  戻り値の originsUpdatedColumns（QA裁定Major-1・2026-09-27）: autoFillColumnsForStructure の
 *  originsUpdated をそのまま返す——既存柱の由来集合だけが変わった柱id（changed判定には現れない）。
 *  非在来・柱を生成しない階（屋根等）は常に[]。structuralRecompute.js が別枠の originsChanged として使う。
 *  openingSources: 床開口（吹抜け・昇降路・階段吹抜け・階段の破れ先）由来の梁芯生成源（規則O。
 *  openingBeamAxes.js openingBeamSourcesFor の結果）。壁由来梁芯（autoFillWallBeamAxes）の直後に
 *  autoFillOpeningBeamAxes へそのまま渡す——省略時（既定[]）は従来どおり何も生成しない
 *  （openingBeamAxes:'slabOpenings'でない主構造は呼び出し側が[]を渡す）。
 *  belowGraph: 1つ下の実体階のgraph（踊り場受け梁＝autoFillStairLandingBeamsが「踊り場の設置階」の
 *  階段を読む唯一の入口。ユーザー裁定2026-09-28: LGは設置階でなく到達階の伏図に出す）。省略時
 *  （既定null）は新規LGを生成しない（最下階・屋根専用平面・下階peek対象外と同じ扱い）——ただし
 *  自動生成済みの既存LG（dimensionStatus:'auto'）が残っていれば撤去する（QA指摘F1是正。下階の階段が
 *  消えた等で有効な源が0件になった場合の後始末）。 */
export function autoFillStructuralGrid(graph, project, belowMainStructure, wallGate = null, wallSources = [], wallSegments = [], aboveColumns = [], belowColumns = [], aboveBeamSegments = [], selfGate = undefined, freeEndGraph = undefined, wallSourceCache = undefined, openingSources = [], belowGraph = null) {
  const foundation = isFoundationPlane(graph.plane, project);
  const isRoof = graph.plane.isRoofPlane;
  // 自階帰属の柱・梁・基礎は自階の主構造が確定するまで生成しない（autoFillColumns は自前でも同ガード）。
  // 屋根の軒桁(eaves)は下階の主構造に従うため、判定軸は belowMainStructure 側で別に行う。
  const ownSpecified = isStructureSpecified(graph, project);
  // 構造種別による部材の取捨（structuralClassification.js 表A）。柱・梁（地上）は構造でゲートし、
  // 基礎梁・ベース（基礎）は常に○のため実質ゲートされない。地階＝RC固定の地中梁図も常に○。
  const structure = effectiveStructure(graph, project);
  const foundationType = project.structuralInfo.foundationType;
  // 壁由来の梁芯CL自動生成は柱より前に行う（在来木造の壁交点柱が梁芯CLをアンカーに使うため。
  // 通り芯グリッドの部材とは独立の生成源なので、他の主構造でも順序は結果に影響しない）。
  const newWallBeamAxes = autoFillWallBeamAxes(graph, wallSources);
  // 開口由来梁芯の再計算照合（ステップ6・規則O）: 中心線の移動・削除、部屋属性の変更、壁の偏芯変化
  // いずれも専用処理を持たず、ここでの現況照合だけが孤児（開口が動いた・消えた）を追従・回収する。
  // 壁由来梁芯の生成（直前）・開口由来梁芯の生成（直後）に挟む——WALLへ再ラベルした孤児を
  // autoFillWallBeamAxesの重複ガードではなくautoFillOpeningBeamAxesの重複ガード対象に含めるため。
  const { removed: removedOpeningBeamAxes, relabeled: relabeledOpeningBeamAxes, retargeted: retargetedOpeningBeamAxes } =
    reconcileOpeningBeamAxes(graph, openingSources, wallSources);
  // 床開口（吹抜け・昇降路・階段吹抜け・階段の破れ先）由来の梁芯CL自動生成（規則O）。
  // 壁由来梁芯の直後・柱より前——重複ガード（findBeamAnchorCL）が壁由来梁芯も対象に含むため。
  const newOpeningBeamAxes = autoFillOpeningBeamAxes(graph, openingSources);
  // M-1'是正・QA指摘: 短辺のextent張り直し2段目（autoFillOpeningBeamAxesの直後）。開口の形状変化で
  // 新たに必要になった通し辺は上のautoFillOpeningBeamAxesで今しがた生成されたばかりのため、
  // reconcileOpeningBeamAxes内（生成前）の1段目では短辺の期待extentが解決できず静的値に
  // フォールバックしていた——ここでもう一度、短辺だけ対象に張り直すことで同じ再計算1回の中で
  // 収束させる（呼ばないと次の再計算までchanged=trueが続く。1パス打ち切りの構造同期で問題化）。
  const retargetedOpeningBeamAxesShort = retargetOpeningBeamAxisShortExtents(graph, openingSources);
  // 柱は主構造ルールの配置源（通り芯交点／壁交点）で振り分ける。壁交点方式は候補に無い自動柱の撤去も返す。
  const columnsResult = (!isRoof && ownSpecified && structureHasMemberKind(MEMBER_KIND.COLUMN, structure))
    ? autoFillColumnsForStructure(graph, project, wallGate, aboveColumns, wallSegments, aboveBeamSegments, belowColumns, wallSourceCache) : { created: [], removed: [], originsUpdated: [] };
  const newColumns = columnsResult.created;
  const removedColumns = columnsResult.removed;
  const originsUpdatedColumns = columnsResult.originsUpdated;
  // ベース（独立フーチング）は分類（表A）に加え、基礎種別でもゲートする（木造べた基礎時はベースなし）。
  const footingsResult = (foundation && ownSpecified && structureHasMemberKind(MEMBER_KIND.INDEPENDENT_FOOTING, structure)
    && foundationGeneratesBase(structure, foundationType)) ? autoFillFootings(graph, wallGate) : { created: [], removed: [] };
  const newFootings = footingsResult.created;
  const removedFootings = footingsResult.removed;
  // 踊り場受け梁（role:'landing'）。到達階（踊り場の上の階）へ自動生成する（ユーザー裁定2026-09-28:
  // 設置階ではなく到達階）。同spanKeyの自動生成G（role:'primary'）との排他性はautoFillStairLandingBeams
  // 内の置換分岐（同spanKeyのauto G撤去）が保証する——ここで大梁(G)生成より前に呼ぶのは、1パス内で
  // 「Gを生成してからLGへ置換で即撤去」という無駄を省くためだけ（QA指摘F5是正: 順序自体が排他性を
  // 保証するわけではない）。屋根専用平面は対象外（屋根には階段が到達しない）。
  const landingResult = !isRoof
    ? autoFillStairLandingBeams(graph, project, wallGate, belowGraph)
    : { created: [], removedG: [], removedStale: [], updated: [], skippedConflicts: 0 };
  const newLandingBeams = landingResult.created;
  const removedLandingG = landingResult.removedG;
  const removedStaleLandingBeams = landingResult.removedStale;
  const updatedLandingBeams = landingResult.updated;
  const beamKind = foundation ? MEMBER_KIND.FOUNDATION_BEAM : MEMBER_KIND.BEAM;
  const beamsResult = (!isRoof && ownSpecified && structureHasMemberKind(beamKind, structure))
    ? autoFillBeamsForStructure(graph, project, foundation ? 'foundation' : 'primary', wallGate, wallSegments, belowColumns, selfGate, freeEndGraph, wallSourceCache)
    : { created: [], removed: [] };
  const newBeams = beamsResult.created;
  const removedBeams = beamsResult.removed;
  // 在来木造の土台（role:'sill'、記号SL。基礎伏図＝最下階専用。「1階の壁下ならびに、基礎上には
  // 必ずある」）。基礎梁（role:'foundation'）の生成・撤去が確定した直後、床梁の前に呼ぶ——候補源(b)が
  // 確定済みの基礎梁スパンを読むため。呼び出し条件は`foundation`のみ（`beamPlacement`条件は付けない。
  // QA裁定Major-2・2026-09-18）——非在来へ切り替わった直後も本関数自身が自動生成分のrole:'sillを
  // 撤去する（内部で`!rules.framing`分岐を持つ。woodAutoFill.js参照）ため、ここで呼び出し自体を
  // 止めてしまうと非在来では撤去が走らず土台が取り残される。
  const sillBeamsResult = foundation
    ? autoFillWoodSillBeams(graph, project, wallSegments, undefined, selfGate) : { created: [], removed: [] };
  // 在来木造の床梁（role:'floor'、ステップ3e-2）。壁線上の通し梁（大梁）の生成・撤去が確定した
  // 直後に呼ぶ——床梁のセル抽出・端部アンカーは確定済みの大梁（role:'primary'）を前提にするため。
  // 屋根専用平面は対象外（小屋伏図に梁・柱ルールを適用する計画（.claude/structural-model.md）でも
  // 3e（床梁）は明示的に対象外——屋根に自階の床は無いため。現状は屋根にrole:'primary'の梁が無く
  // 自然に0本だが、将来（ステップ5）屋根の梁をrole:'primary'へ切り替えた際に床梁が生えるのを防ぐ
  // 明示ガード）。
  const floorBeamsResult = !isRoof && rulesFor(structure).beamPlacement === 'wallRuns'
    ? autoFillWoodFloorBeams(graph, project) : { created: [], removed: [] };
  // 小屋伏図にも梁・柱ルールを適用する計画（ステップ5）: 屋根専用平面の梁は主構造ルールの選択子
  // roofBeamPlacement（structureRules.js。ステップ2）で振り分ける——在来木造（'wallRuns'）は
  // 通り芯グリッドの軒桁（role:'eaves'）の代わりに、自階（＝最上階。wallSegments・selfGateは
  // ステップ3・4でどちらも「屋根の1つ下＝最上階」を指すよう配線済み）の壁線上の通し梁
  // （role:'primary', beamType:'軒桁'）をautoFillWoodWallBeamsで生成する（既存のauto軒桁は
  // その内部の撤去ループが「屋根平面のときだけ」道を空ける。woodAutoFill.js参照）。非在来
  // （既定'gridEaves'）は従来どおりautoFillRoofBeamsのまま完全不変。判定は roof の実効主構造
  // （wallSegments・wallSources 等ステップ3・4と同じ`structure`変数）で行う——belowMainStructure
  // （autoFillRoofBeamsの材種決定に使う「1つ下の階」の値）とは別軸。
  const roofBeamsResult = (isRoof && belowMainStructure !== UNSPECIFIED_STRUCTURE)
    ? (rulesFor(structure).roofBeamPlacement === 'wallRuns'
        ? autoFillWoodWallBeams(graph, project, wallSegments, wallGate, belowColumns, selfGate, freeEndGraph ?? graph, wallSourceCache)
        : autoFillRoofBeams(graph, project, belowMainStructure, wallGate))
    : { created: [], removed: [] };
  const newRoofBeams = roofBeamsResult.created;
  const removedRoofBeams = roofBeamsResult.removed;
  // 梁芯CL（discipline:'fuse'）ごとの小梁自動生成。wallGate は直接引かない
  // （直交大梁に挟まれている＝大梁のフットプリント判定を継承するため。上のnewBeams生成後に呼ぶ）。
  // 出自を問わず全梁芯が対象のため、壁由来の梁芯（newWallBeamAxes）もそのまま拾う。beamPlacement:'wallRuns'
  // （在来木造）は通り芯グリッドの大梁を持たないため小梁のhostが無く、呼んでも0本になる以外に害はないが、
  // 二重の判定軸を持たないよう明示的にスキップする（ステップ3c-2）。
  const newSecondaryBeams = rulesFor(structure).beamPlacement === 'wallRuns' ? [] : autoFillSecondaryBeams(graph, project);
  return {
    newColumns, removedColumns, newFootings, removedFootings, originsUpdatedColumns,
    // m-5是正・QA指摘: 開口由来梁芯の再ラベル（→WALL）・extent張り直し（reconcileOpeningBeamAxes）は
    // 「新規/撤去した梁」ではないため newBeams/removedBeams には混ぜず、別枠で返す
    // （structuralRecompute.js の changed 判定はこの配列の長さも見る）。
    changedOpeningBeamAxes: [...relabeledOpeningBeamAxes, ...retargetedOpeningBeamAxes, ...retargetedOpeningBeamAxesShort],
    newBeams: [...newBeams, ...newRoofBeams, ...newWallBeamAxes, ...newOpeningBeamAxes, ...newLandingBeams, ...newSecondaryBeams, ...sillBeamsResult.created, ...floorBeamsResult.created],
    removedBeams: [...removedBeams, ...removedRoofBeams, ...sillBeamsResult.removed, ...floorBeamsResult.removed, ...removedOpeningBeamAxes, ...removedLandingG, ...removedStaleLandingBeams],
    // 踊り場受け梁の既存auto LGへのlevelOffset再計算更新（QA指摘F1是正）。新規/撤去した梁ではないため
    // newBeams/removedBeamsには混ぜず、changedOpeningBeamAxesと同じ別枠にする
    // （structuralRecompute.jsのchanged判定はこの配列の長さも見る）。
    updatedLandingBeams,
    skippedConflicts: landingResult.skippedConflicts,
  };
}

/** 主要構造（実効値）と異なる材種の既存柱・梁を、新しい材種のサブクラスへ変換する。
 *  耐力壁・スラブはRC専用クラスしか存在せず木造/S造では生成されないため対象外（core.js 参照）。
 *  基礎梁（role:'foundation'）と基礎・柱脚（footingMap全件）は主構造に関わらず常にRC造に固定する
 *  （autoFillFootings/autoFillBeamsと同じ理由。手動「＋追加」分やフロア切替時の取りこぼしもここで揃える）。
 *  土台（role:'sill'）は変換対象外——在来木造専用の概念で、非在来へ切替えると自動生成分は
 *  autoFillWoodSillBeams自身が撤去する（woodAutoFill.js参照）。手動固定（locked）で残った土台まで
 *  ここで新主構造の材種へ変換すると、木造専用の断面（柱同寸の正角）が非木造の材種の断面へ書き換わり
 *  実体が壊れる（QA裁定Major-2・2026-09-18。基礎梁の'foundation'特例の隣に置く）。
 *  柱は自階の柱を自階graphに持つため自階の実効主構造（resolveDefaultMaterialType）を対象材質にする。
 *  軒桁を含む横架材(role:'eaves')は屋根の1つ下の階（belowMainStructure）の実効主構造を対象材質にする
 *  （autoFillRoofBeamsが同じbelowMainStructureで生成するため）。それ以外の梁（通常階の床梁）も自階基準でよい。 */
export function convertMembersToEffectiveMaterial(graph, project, belowMainStructure) {
  // 対象材質・変換後の既定断面は主構造ルール（自階＝ownRules・屋根の1つ下＝belowRules）から引く。
  const belowRules = rulesFor(belowMainStructure);
  const ownRules = rulesFor(effectiveStructure(graph, project));
  const belowMaterialType = belowRules.baseMaterial;
  const belowSpecified = belowMainStructure !== UNSPECIFIED_STRUCTURE;
  const ownSpecified = isStructureSpecified(graph, project);
  const ownMaterialType = ownRules.baseMaterial;
  const convertedColumns = [];
  const convertedBeams = [];
  const convertedFootings = [];
  for (const column of [...graph.columnMap.values()]) {
    // 自階主構造が未確定なら変換しない（既存の柱を木造フォールバックへ書き換えてしまうのを防ぐ）。
    if (ownSpecified && column.materialType !== ownMaterialType) {
      graph.convertColumnMaterial(column, ownMaterialType, ownRules.defaultSections.column);
      convertedColumns.push(column.id);
    }
  }
  for (const beam of [...graph.beamMap.values()]) {
    if (beam.role === 'sill') continue; // 土台は変換対象外（上記コメント参照。QA裁定Major-2）
    // 基礎梁=主構造非依存の常時RC。軒桁=下階主構造、それ以外(床梁)=自階主構造。出所が未確定なら変換しない。
    if (beam.role !== 'foundation' && !(beam.role === 'eaves' ? belowSpecified : ownSpecified)) continue;
    const targetMaterial = beam.role === 'foundation' ? StructuralMaterialType.RC
      : beam.role === 'eaves' ? belowMaterialType
      : ownMaterialType;
    const targetSection = beam.role === 'foundation' ? DEFAULT_BEAM_SECTION_BY_MATERIAL[StructuralMaterialType.RC]
      : beam.role === 'eaves' ? belowRules.defaultSections.beam
      : ownRules.defaultSections.beam;
    if (beam.materialType !== targetMaterial) {
      graph.convertBeamMaterial(beam, targetMaterial, targetSection);
      convertedBeams.push(beam.id);
    }
  }
  for (const footing of [...graph.footingMap.values()]) {
    if (footing.materialType !== StructuralMaterialType.RC) {
      footing.setField('materialType', StructuralMaterialType.RC);
      footing.setField('sectionDefId', DEFAULT_SECTION_BY_MATERIAL[StructuralMaterialType.RC]);
      convertedFootings.push(footing.id);
    }
  }
  return { convertedColumns, convertedBeams, convertedFootings };
}

// 構造由来の削除対象とする map（柱・基礎・梁・スラブ・耐力壁。貫通スリーブは梁の連鎖で消す）。
const CLASSIFICATION_MAPS = ['columnMap', 'footingMap', 'beamMap', 'slabMap', 'wallMap'];

/** 主構造変更で「×」化した部材（その構造が持たない部材種別）のうち、自動生成分（dimensionStatus==='auto'）を削除する。
 *  「構造変更の場合、×は削除、○は生成」の削除側。生成側は autoFillStructuralGrid の構造ゲートが担う。
 *  手動固定/検査済み（dimensionStatus!=='auto'）は手動部材として保持する（フットプリント削除と同じ規律）——
 *  残った手動部材は構造リスト側で同じ分類ゲートにより非表示になる。除外集合には記録しない
 *  （構造を戻せば autoFill で再生成されるべきため。フットプリント削除と同様に可逆）。
 *  構造リスト・採番より前、共有の純再計算（recomputeStructuralForGraph）内で呼ぶ。削除した部材idの配列を返す。 */
export function deleteClassificationOverflow(graph, project) {
  if (graph.plane?.isRoofPlane) return []; // 屋根伏図（R階伏図/小屋伏図）は Phase A の対象外（軒桁等を巻き込まない）
  const structure = effectiveStructure(graph, project);
  const removed = [];
  for (const mapName of CLASSIFICATION_MAPS) {
    for (const entity of [...graph[mapName].values()]) {
      if (entity.dimensionStatus !== 'auto') continue; // 手動固定/検査済みは保持
      const kind = memberKindOf(mapName, entity);
      if (!kind || structureHasMemberKind(kind, structure)) continue; // 表外(null)＝保持／○＝残す
      if (mapName === 'beamMap') {
        // 梁ホストの貫通スリーブも連鎖削除する（removeBeam と同じ。ただし除外集合には記録しない）。
        for (const s of [...graph.sleeveMap.values()]) if (s.hostBeamId === entity.id) graph.sleeveMap.delete(s.id);
      }
      graph[mapName].delete(entity.id);
      removed.push(entity.id);
    }
  }
  return removed;
}

/** その階の実効主構造から既定柱幅(mm)を導出する。ラーメン系の柱芯インセット量(width/2)の基準。 */
function defaultColumnWidth(mainStructure) {
  return findSectionEntry(rulesFor(mainStructure).defaultSections.column)?.width ?? 200;
}

/** あるCL（通り芯）が外周かどうかの符号を、軸線に沿って**全交差位置を走査**して求める単一ヘルパ。
 *  直交グリッドの隣接スパン中点ごとに外周モデル（exterior）へ外側方向を問い合わせ、最初に得た非0符号を返す。
 *  代表1点（その軸の最初の柱の座標）だけを見ると、L字段差の中通り（例:Y2）で代表が内部側スパンに当たり
 *  s=0 に落ちる——軸の一部だけが外周の場合を取りこぼす不具合の解消（X2はたまたま代表が外周側で助かっていた）。
 *  スパン中点で引くので軸線上（交点）の worldToCell 端境界曖昧性も避けられる。両側で符号が割れる稀な軸は
 *  先勝ち（割り切り。凹形状でも各軸は単一外周符号という前提）。外周が無い内部軸は0。 */
export function axisExteriorSign(exterior, graph, cl, isVertical) {
  const cross = isVertical ? graph.gridYs : graph.gridXs; // 直交グリッド（value 昇順）
  for (let i = 0; i < cross.length - 1; i++) {
    const atCross = (cross[i].value + cross[i + 1].value) / 2;
    const s = exterior.outsideSign(cl.value, isVertical, atCross);
    if (s !== 0) return s;
  }
  return 0;
}

/** 柱芯（columnAxisOffsets＝通り芯から柱芯までの偏芯量）を、建物由来の出幅から決定的に再構築する。
 *  構造モード突入時・出幅編集時に autoFillStructuralGrid と同タイミングで呼ぶ。
 *  柱芯・偏芯量は per-floor だが、**柱の外面**（偏芯量0方向＝通り芯側の面）は「出幅 projection」
 *  （通り芯から柱外面までの距離。1構造×1通り芯＝getColumnFaceProjection(effective, cl)）で決める——
 *  同一構造の階は同じ出幅キーを共有するため外面が階で食い違わない（混構造は構造ごと、X/Y通り芯ごとに別値）。
 *  各階は自階の既定柱幅で外面を出幅基準面に合わせるので、幅が違えば偏芯量も変わる
 *  （＝階依存を保ったまま外面が揃う）。導出（外周CLのみ。内部CLは0）：
 *      柱外面 = 通り芯 + s×出幅（通り芯の内側に出幅だけ控える）、偏芯量 offset = 外面 + s×halfThis = s×(halfThis + 出幅)
 *  柱芯は常に通り芯の内側（屋内側）に保たれ、通り芯・出幅寸法は柱芯の外側（屋外側）に位置する（出幅をいくら
 *  大きくしても柱芯が通り芯を越えない）。出幅=0 で offset=s×halfThis（外面＝通り芯＝従来既定）。これで
 *  「最下階オフセットを peek して引き継ぐ」処理（旧 offLowest/外面引き継ぎ）が不要になる。
 *  外側符号 s だけは最下階フットプリント(exterior)を権威に求める（lowestGraph を peek。R階伏図など
 *  自階に部屋が無い階で外周モデルが部材CL外接矩形へ縮退し、L字外周の中通りを内部と誤判定するのを回避。
 *  axisExteriorSign で軸線を全交差走査）。ユーザー上書きは出幅へ一本化したため、各CLは毎回上書きする。
 *  ラーメン系（S造/SRC造/RC造(ラーメン)）でなければ柱芯オフセットをすべて0に戻す（対象外＝通り芯と一致）。
 *  @param {ReturnType<import('./wallGate.js').createFootprintCache>} [footprintCache] - 1回の再計算内で
 *   フットプリント索引（wallGate.js footprintProbe）をmemoするキャッシュ（ステップA）。isLowestがfalseの
 *   ときだけ内部でbuildExteriorSide(lowestGraph)を呼ぶため、その1点にだけ渡す——exterior自体は既に
 *   呼び出し側が確定済みの値（省略時はbuildExteriorSide(graph)がデフォルト引数として評価されるため
 *   footprintCacheより先に確定してしまい、この引数の恩恵を受けない。省略時は毎回組み直す従来どおり）。 */
export function autoFillColumnAxisOffsets(graph, project, lowestGraph = graph, exterior = buildExteriorSide(graph), footprintCache = undefined) {
  const effective = graph.structureOverride ?? project.structuralInfo.mainStructure;
  if (!isRigidFrameStructure(effective)) {
    graph.columnAxisOffsets.clear();
    return;
  }
  const halfThis   = defaultColumnWidth(effective) / 2;
  const isLowest   = lowestGraph.plane?.id === graph.plane?.id;
  const ex         = isLowest ? exterior : buildExteriorSide(lowestGraph, footprintCache); // 符号権威＝最下階フットプリント
  for (const [axisCLs, isVertical] of [[graph.gridXs, true], [graph.gridYs, false]]) {
    for (const cl of axisCLs) {
      const s = axisExteriorSign(ex, lowestGraph, cl, isVertical);
      // 1構造×1通り芯の値を引く（混構造は構造ごと、X/Y通り芯ごとに別値）。外周軸は正の出幅、
      // 内部軸は符号付きの柱芯移動指示（描画エリアの柱芯ラベルで入力）を表す。
      const projection = project.structuralInfo.getColumnFaceProjection(effective, cl);
      const mag = halfThis + Math.abs(projection); // 柱半幅＋出幅相当（柱芯の移動量）
      // 外周芯(s≠0): 向きはフットプリント。出幅で外面を、自階の柱幅で柱芯を決める（柱芯は常に通り芯の内側）。
      // 内部芯(s=0): 外側方向が無いので入力値の符号を向きにする（X:+右/−左、Y:+上(−y)/−下(+y)＝y軸下向き正）。
      // 入力0は偏芯0。
      const offset = s !== 0
        ? s * mag
        : (projection === 0 ? 0 : (isVertical ? Math.sign(projection) : -Math.sign(projection)) * mag);
      graph.setColumnAxisOffset(cl.id, offset);
    }
  }
}

/** 建物の最下階（elevation昇順の先頭採用フロア）のgraphを返す。非アクティブならpeekで読み取り専用に覗く。
 *  柱芯の外面合わせ（autoFillColumnAxisOffsets）が最下階の柱を基準にするために使う。
 *  @param {object} project
 *  @param {object} activeGraph
 *  @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [ctx] -
 *    解決コンテキスト（省略時は floorSwapManager.peek 直呼び。反映処理（structuralOrchestration.js
 *    の境界処理）からは解決コンテキストが渡る）。 */
export async function resolveLowestGraph(project, activeGraph, ctx = undefined) {
  const planes = project.planes; // elevation 昇順、屋根・検討を除く採用フロア
  const lowest = planes[0];
  if (!lowest || lowest.id === activeGraph.plane.id) return activeGraph;
  return peekVia(ctx, lowest, project.structGraph);
}

/** 柱の負担床面積から柱幅(tributaryWidth)を再算定する。dimensionStatus==='auto'の柱のみ対象
 *  （'locked'/'calculated'はユーザー固定値として保持し上書きしない）。
 *  structuralPlane: 柱が実際に属する階（drawingDesignation.jsのstructuralPlaneBelowで求めた階。
 *  呼び出し元が解決して渡す）。構造モード突入時、autoFillStructuralGrid と同タイミングで呼ぶ。
 *  更新した柱idの配列を返す。 */
export function autoFillColumnSizes(graph, project, structuralPlane) {
  const updated = [];
  for (const column of graph.columns) {
    if (column.dimensionStatus !== 'auto') continue;
    const width = computeTributaryColumnWidth(graph, project, column.verticalCL, column.horizontalCL, structuralPlane);
    if (column.tributaryWidth === width) continue;
    column.setField('tributaryWidth', width);
    updated.push(column.id);
  }
  return updated;
}

/** 柱脚(ColumnBase)の平面サイズ・埋込み深さを、自分の位置の負担床面積から再算定する。
 *  対象は'pedestalDepth' in entity（=ColumnBase。IndependentFootingは対象外）かつ
 *  dimensionStatus==='auto'のもののみ。直上階の柱を参照せず、自分の verticalCL/horizontalCL と
 *  graph.plane（支持階数）だけから独立に算定する（非アクティブフロアのスワップアウト設計と衝突しないため）。
 *  柱脚は基礎伏図（rank0）自身に立つため、構造階＝自階（graph.plane、1つ下の階は存在しない）。
 *  更新した柱脚idの配列を返す。 */
export function autoFillColumnBaseSizes(graph, project) {
  const updated = [];
  for (const footing of graph.footings) {
    if (!('pedestalDepth' in footing) || footing.dimensionStatus !== 'auto') continue;
    const columnWidth = computeTributaryColumnWidth(graph, project, footing.verticalCL, footing.horizontalCL, graph.plane);
    const { widthX, widthY, pedestalDepth } = computeColumnBaseSize(columnWidth);
    if (footing.widthX === widthX && footing.widthY === widthY && footing.pedestalDepth === pedestalDepth) continue;
    footing.setField('widthX', widthX);
    footing.setField('widthY', widthY);
    footing.setField('pedestalDepth', pedestalDepth);
    updated.push(footing.id);
  }
  return updated;
}

/** 基礎梁(role:'foundation')の梁幅b・梁成Dを、建物全体の最長スパン・最大柱幅から再算定する。
 *  対象はdimensionStatus==='auto'の基礎梁のみ（'locked'/'calculated'はユーザー固定値として保持し上書きしない）。
 *  構造モード突入時、autoFillStructuralGrid と同タイミングで呼ぶ。更新した梁idの配列を返す。 */
export function autoFillFoundationBeamSizes(graph, project) {
  const updated = [];
  const foundationBeams = graph.beams.filter(b => b.role === 'foundation' && b.dimensionStatus === 'auto');
  if (foundationBeams.length === 0) return updated;
  const effective = graph.structureOverride ?? project.structuralInfo.mainStructure;
  const { width, depth } = computeFoundationBeamSize(graph, project, effective);
  for (const beam of foundationBeams) {
    if (beam.beamWidth === width && beam.beamDepth === depth) continue;
    beam.setField('beamWidth', width);
    beam.setField('beamDepth', depth);
    updated.push(beam.id);
  }
  return updated;
}

/** 断面サイズが基準幅と異なる部材の「外側面で揃える」個別補正値を求める。
 *  baseOffset: 柱芯オフセット（基準断面幅を前提に算出された軸位置）
 *  sectionWidth: 実際の断面幅、referenceWidth: 基準断面幅、alignSide: 揃える面の方向(+1/-1) */
export function alignToOuterFace(baseOffset, sectionWidth, referenceWidth, alignSide) {
  return baseOffset + alignSide * (sectionWidth - referenceWidth) / 2;
}

// ----------------------------------------------------------------
// 梁の偏芯量（柱芯⇄材芯）— 柱外面と梁縁を一致させる自動算出
//
// 梁の材芯 = 通り芯 + 柱芯オフセット(columnAxisOffsets) + eccentricity。
// 外周梁では「柱の外面」と「梁の縁」を faceGap だけ離して揃える（faceGap=0 で面一）。
// 柱外面は autoFillColumnAxisOffsets が既定柱幅で定義した基準面に等しいため、柱芯オフセットは
// 梁・柱で共有されて相殺し、eccentricity は s・((梁幅 − 既定柱幅)/2 + faceGap) に集約される
// （導出: 梁縁 = 材芯 − s・梁半幅、柱外面 = 通り芯 + (柱芯オフセット − s・既定半幅)、梁縁 = 柱外面 + s・faceGap）。
//   s        : 外周側の符号。**梁の軸CLの柱芯オフセット(columnAxisOffsets)の符号**から取る——
//              autoFillColumnAxisOffsets が axisExteriorSign で軸全体を走査して確定した「軸単位」の
//              外周符号に必ず一致させるため。これにより L字内側コーナーを通る軸（例 X2/Y2）の
//              内部側セグメントも、同じ軸の外周セグメント・柱と同じ向きに偏芯し、梁面がコーナーで
//              段差せず一直線に揃う（局所スパンの内外だけ見ると内部側 s=0 でジョグが残る不具合の解消。
//              R階伏図など自階に部屋が無い階の矩形縮退も、オフセットが最下階権威で確定済みのため無関係）。
//   既定柱幅 : その階の実効主構造の既定柱断面幅（柱外面の基準＝columnAxisOffsets と整合）
//   faceGap  : 柱外面と梁縁のギャップ(mm)。ラベル毎に指定する値（梁に保持）。
// ラーメン系（S造/SRC造/RC造ラーメン）以外・内部軸(柱芯オフセット0＝s=0)は eccentricity=0。
// autoFillColumnAxisOffsets を先に呼んで columnAxisOffsets を確定させておくこと（recompute はその順序）。
// ----------------------------------------------------------------

/** 梁の伏図見付き幅(mm)＝梁幅b（描画 beamRenderWidth・小梁の端部クリアランス算定と同一基準。
 *  柱外面合わせの縁はこの幅で揃える）。実体は StructuralBeam.sectionWidth（core/structuralEntities.js）
 *  に集約し、ここは薄い委譲のみ（構造モードの梁エンティティは常にこのgetterを持つため呼び出し元は不変）。 */
function beamSectionWidth(beam) {
  return beam.sectionWidth;
}

/** 梁の偏芯算出に必要な幾何（外周符号 s と base=(梁半幅 − 既定柱半幅)）。
 *  s は梁の軸CLの柱芯オフセットの符号（＝柱と同一の軸単位外周符号）。ラーメン系でない／
 *  当該軸が外周でない（柱芯オフセット0＝s=0）なら null（＝偏芯0）。 */
function beamEccentricityGeom(graph, project, beam) {
  const effective = graph.structureOverride ?? project.structuralInfo.mainStructure;
  if (!isRigidFrameStructure(effective)) return null;
  const s = Math.sign(graph.columnAxisOffsets.get(beam.axisCL.id) ?? 0);
  if (s === 0) return null;
  return { s, base: (beamSectionWidth(beam) - defaultColumnWidth(effective)) / 2 };
}

/** 梁の faceGap から偏芯量（柱芯⇄材芯）を算出する。対象外（非ラーメン・内部軸）は0。
 *  faceGap 未指定時は梁自身の値を使う（UIからの単発呼び出し用）。 */
export function autoBeamEccentricity(graph, project, beam, faceGap = beam.faceGap ?? 0) {
  const geom = beamEccentricityGeom(graph, project, beam);
  return geom ? geom.s * (geom.base + faceGap) : 0;
}

/** 図上で指定された偏芯量（符号付き）から、保存すべき faceGap を逆算する（autoBeamEccentricity の逆変換）。
 *  対象外（非ラーメン・内部軸）は既存 faceGap を保持。 */
export function faceGapForEccentricity(graph, project, beam, eccSigned) {
  const geom = beamEccentricityGeom(graph, project, beam);
  return geom ? geom.s * eccSigned - geom.base : (beam.faceGap ?? 0);
}

/** 全梁（大梁・小梁・軒桁）の偏芯量を faceGap から再算出して整合する。構造モード突入時、
 *  autoFillColumnAxisOffsets の**後**に呼ぶ（符号源の columnAxisOffsets を確定させておく）。
 *  柱寸法・梁寸法（既定柱幅・梁断面幅）が変わっても faceGap を保ったまま柱外面合わせを保つ。
 *  更新した梁idの配列を返す。 */
export function autoFillBeamEccentricity(graph, project) {
  const updated = [];
  for (const beam of graph.beams) {
    // 大梁・小梁・軒桁（屋根外周の横架材）が対象。軒桁も建物外周に乗るため柱外面合わせを行う。基礎梁は対象外。
    if (beam.role !== 'primary' && beam.role !== 'secondary' && beam.role !== 'eaves') continue;
    const target = autoBeamEccentricity(graph, project, beam, beam.faceGap ?? 0);
    if (beam.eccentricity === target) continue;
    beam.setField('eccentricity', target);
    updated.push(beam.id);
  }
  return updated;
}
