import { StructuralMaterialType, columnSlotKey, spanKey } from '../core.js';
import { DEFAULT_SECTION_BY_MATERIAL, DEFAULT_COLUMN_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { findSectionEntry } from './sectionCatalog.js';
import { isFoundationPlane } from './drawingDesignation.js';
import { computeTributaryColumnWidth, computeColumnBaseSize, computeFoundationBeamSize, computeRoofBeamSize } from './memberSizing.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { isRigidFrameStructure, structureHasMemberKind, memberKindOf, MEMBER_KIND } from './structuralClassification.js';
import { buildExteriorSide, footprintCellKeys } from './wallGate.js';

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

// 主構造未指定を表す値（StructuralInfoDialog.MAIN_STRUCTURE_OPTIONS[0] と一致させる）。
// 未指定の間は部材を自動生成・材変換しない（木造フォールバックで実データが湧くのを防ぐ）。
export const UNSPECIFIED_STRUCTURE = '未定';

/** 主構造の文字列表記から既定の StructuralMaterialType を導出する。 */
export function defaultMaterialType(mainStructure) {
  if (mainStructure?.startsWith('木造')) return StructuralMaterialType.WOOD;
  if (mainStructure?.startsWith('S造') || mainStructure?.startsWith('SRC造')) return StructuralMaterialType.STEEL;
  if (mainStructure?.startsWith('RC造')) return StructuralMaterialType.RC;
  return StructuralMaterialType.WOOD; // '未定' 等のフォールバック既定（生成・変換は呼び出し側でガード済み）
}

/** その階の実効主構造（階の上書き優先・なければ建物全体値）。 */
export function effectiveStructure(graph, project) {
  return graph.structureOverride ?? project.structuralInfo.mainStructure;
}

/** その階の主構造が確定しているか（'未定'でない）。未確定の間は柱・梁・基礎を自動生成しない。 */
export function isStructureSpecified(graph, project) {
  return effectiveStructure(graph, project) !== UNSPECIFIED_STRUCTURE;
}

/** その階の実効主構造（階の上書き優先・なければ建物全体値）から既定材料を導出する。 */
export function resolveDefaultMaterialType(graph, project) {
  return defaultMaterialType(effectiveStructure(graph, project));
}

/** 木造系（在来・2"×4"）か。基礎種別（ベタ基礎時のベース有無・マットスラブ有無）の分岐に使う。 */
function isWoodStructure(structure) {
  return structure === '木造（在来）' || structure === '木造（2"×4"）';
}

/** 基礎伏図で「ベース（独立フーチング）」を自動生成するか（問題.md：木造べた基礎時はベースなし）。
 *  木造のなし／土間コンは基礎梁＋ベースの合成のためベースを生成する。非木造は従来どおり常に生成する。 */
export function foundationGeneratesBase(structure, foundationType) {
  if (isWoodStructure(structure)) return foundationType !== 'ベタ基礎';
  return true;
}

/** 基礎伏図で「べた基礎（マットスラブ role:'mat_foundation'）」を自動生成するか（問題.md：木造べた基礎時のみ）。
 *  非木造の基礎スラブは従来どおり手動配置（自動生成しない）。 */
export function foundationGeneratesMatSlab(structure, foundationType) {
  return isWoodStructure(structure) && foundationType === 'ベタ基礎';
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
  if (!isStructureSpecified(graph, project)) return []; // 主構造未確定の間は生成しない
  const materialType = resolveDefaultMaterialType(graph, project);
  const existing = new Set(graph.columns.map(c => columnSlotKey(c.verticalCL, c.horizontalCL)));
  const created = [];
  for (const { verticalCL, horizontalCL, key } of computeGridIntersections(graph)) {
    if (existing.has(key) || graph.excludedColumnSlots.has(key)) continue;
    // 建物フットプリント外の交点には柱を作らない（外壁線で有無を取捨。wallGate.js 参照）。
    if (wallGate && !wallGate.intersectionInBuilding(verticalCL, horizontalCL)) continue;
    created.push(graph.addColumn(materialType, DEFAULT_COLUMN_SECTION_BY_MATERIAL[materialType], verticalCL, horizontalCL, {}));
  }
  return created;
}

/** 柱が存在しない交点を検出し、独立フーチングをデフォルト材料・断面で自動生成する（除外集合のスロットはスキップ）。
 *  基礎伏図専用（柱の代わりに生成する）。手動の「＋追加」UI（MemberListTab.jsx）と同じ kind:'independent' を使う。
 *  独立フーチングは主構造（S造/木造等）に関わらず常にRC造（地中の基礎はRC造という建築の慣習に合わせたもの）。 */
export function autoFillFootings(graph, wallGate = null) {
  const materialType = StructuralMaterialType.RC;
  const existing = new Set(graph.footings.map(f => columnSlotKey(f.verticalCL, f.horizontalCL)));
  const created = [];
  for (const { verticalCL, horizontalCL, key } of computeGridIntersections(graph)) {
    if (existing.has(key) || graph.excludedFootingSlots.has(key)) continue;
    // 建物フットプリント外の交点には独立フーチングを作らない（柱と同じゲート。wallGate.js 参照）。
    if (wallGate && !wallGate.intersectionInBuilding(verticalCL, horizontalCL)) continue;
    created.push(graph.addFooting('independent', DEFAULT_SECTION_BY_MATERIAL[materialType], verticalCL, horizontalCL, { materialType }));
  }
  return created;
}

// べた基礎マットスラブの既定厚(mm)（問題.md：べた基礎 厚150）。レベル（GL+50・天端制約）は次フェーズ。
const MAT_FOUNDATION_THICKNESS = 150;

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
      { role: 'mat_foundation', levelRef: 'top', thickness: MAT_FOUNDATION_THICKNESS },
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
  const materialType = role === 'foundation' ? StructuralMaterialType.RC : resolveDefaultMaterialType(graph, project);
  const existing = new Set(graph.beams.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));
  const created = [];
  for (const { axisCL, isVertical, clStart, clEnd, key } of computeGridSpans(graph)) {
    if (existing.has(key) || graph.excludedBeamSlots.has(key)) continue;
    // 建物フットプリント外の辺（どの対象階の屋内にも接しない辺）には梁を作らない（外壁線で有無を取捨。wallGate.js 参照）。
    if (wallGate && !wallGate.spanInBuilding(axisCL, isVertical, clStart, clEnd)) continue;
    created.push(graph.addBeam(materialType, DEFAULT_BEAM_SECTION_BY_MATERIAL[materialType], axisCL, isVertical, clStart, clEnd, { role }));
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
  const materialType = defaultMaterialType(belowMainStructure);
  const existing = new Set(graph.beams.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));
  const created = [];
  for (const { axisCL, isVertical, clStart, clEnd, key } of computeGridSpans(graph)) {
    if (existing.has(key) || graph.excludedBeamSlots.has(key)) continue;
    // 軒桁も直下階のフットプリント（外壁線）でゲートする（wallGate は直下の最上階基準。wallGate.js 参照）。
    if (wallGate && !wallGate.spanInBuilding(axisCL, isVertical, clStart, clEnd)) continue;
    created.push(graph.addBeam(materialType, DEFAULT_BEAM_SECTION_BY_MATERIAL[materialType], axisCL, isVertical, clStart, clEnd, { role: 'eaves' }));
  }
  return created;
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

/** 構造モード突入時に呼ぶ統合エントリポイント。柱・梁・基礎（フーチング）が対象（耐力壁・スラブは対象外）。
 *  柱はどの実体平面でも自階分を生成する（基礎伏図=最下階も自階の柱を生成する）。屋根専用平面（isRoofPlane）
 *  では柱を生成しない（柱の立つ階ではないため）。基礎伏図（isFoundationPlane）では床下に独立フーチングを
 *  追加生成し、梁は基礎梁（role:'foundation'）とする。屋根専用平面では梁を autoFillRoofBeams（role:'eaves'）で
 *  生成する（'primary'は生成しない）。belowMainStructure: 屋根横架材が属する「1つ下の階（=最上の実体平面）」の
 *  実効主構造（呼び出し元が drawingDesignation.js の structuralPlaneBelow で求めて渡す）。
 *  wallGate: 建物フットプリント（部屋領域＝外壁線位置）の鉛直連続性で柱・梁・基礎・軒桁の有無を取捨するゲート
 *  （wallGate.js / buildStructuralWallGate。屋根は直下の最上階基準。null＝ゲートなしで全グリッド生成）。 */
export function autoFillStructuralGrid(graph, project, belowMainStructure, wallGate = null) {
  const foundation = isFoundationPlane(graph.plane, project);
  const isRoof = graph.plane.isRoofPlane;
  // 自階帰属の柱・梁・基礎は自階の主構造が確定するまで生成しない（autoFillColumns は自前でも同ガード）。
  // 屋根の軒桁(eaves)は下階の主構造に従うため、判定軸は belowMainStructure 側で別に行う。
  const ownSpecified = isStructureSpecified(graph, project);
  // 構造種別による部材の取捨（問題.md 表A＝structuralClassification）。柱・梁（地上）は構造でゲートし、
  // 基礎梁・ベース（基礎）は常に○のため実質ゲートされない。地階＝RC固定の地中梁図も常に○。
  const structure = effectiveStructure(graph, project);
  const foundationType = project.structuralInfo.foundationType;
  const newColumns  = (!isRoof && ownSpecified && structureHasMemberKind(MEMBER_KIND.COLUMN, structure)) ? autoFillColumns(graph, project, wallGate) : [];
  // ベース（独立フーチング）は分類（表A）に加え、基礎種別でもゲートする（木造べた基礎時はベースなし。問題.md）。
  const newFootings = (foundation && ownSpecified && structureHasMemberKind(MEMBER_KIND.INDEPENDENT_FOOTING, structure)
    && foundationGeneratesBase(structure, foundationType)) ? autoFillFootings(graph, wallGate) : [];
  const beamKind = foundation ? MEMBER_KIND.FOUNDATION_BEAM : MEMBER_KIND.BEAM;
  const newBeams     = (!isRoof && ownSpecified && structureHasMemberKind(beamKind, structure)) ? autoFillBeams(graph, project, foundation ? 'foundation' : 'primary', wallGate) : [];
  const newRoofBeams = (isRoof && belowMainStructure !== UNSPECIFIED_STRUCTURE) ? autoFillRoofBeams(graph, project, belowMainStructure, wallGate) : [];
  return { newColumns, newFootings, newBeams: [...newBeams, ...newRoofBeams] };
}

/** 主要構造（実効値）と異なる材種の既存柱・梁を、新しい材種のサブクラスへ変換する。
 *  耐力壁・スラブはRC専用クラスしか存在せず木造/S造では生成されないため対象外（core.js 参照）。
 *  基礎梁（role:'foundation'）と基礎・柱脚（footingMap全件）は主構造に関わらず常にRC造に固定する
 *  （autoFillFootings/autoFillBeamsと同じ理由。手動「＋追加」分やフロア切替時の取りこぼしもここで揃える）。
 *  柱は自階の柱を自階graphに持つため自階の実効主構造（resolveDefaultMaterialType）を対象材質にする。
 *  軒桁を含む横架材(role:'eaves')は屋根の1つ下の階（belowMainStructure）の実効主構造を対象材質にする
 *  （autoFillRoofBeamsが同じbelowMainStructureで生成するため）。それ以外の梁（通常階の床梁）も自階基準でよい。 */
export function convertMembersToEffectiveMaterial(graph, project, belowMainStructure) {
  const belowMaterialType = defaultMaterialType(belowMainStructure);
  const belowSpecified = belowMainStructure !== UNSPECIFIED_STRUCTURE;
  const ownSpecified = isStructureSpecified(graph, project);
  const ownMaterialType = resolveDefaultMaterialType(graph, project);
  const convertedColumns = [];
  const convertedBeams = [];
  const convertedFootings = [];
  for (const column of [...graph.columnMap.values()]) {
    // 自階主構造が未確定なら変換しない（既存の柱を木造フォールバックへ書き換えてしまうのを防ぐ）。
    if (ownSpecified && column.materialType !== ownMaterialType) {
      graph.convertColumnMaterial(column, ownMaterialType, DEFAULT_COLUMN_SECTION_BY_MATERIAL[ownMaterialType]);
      convertedColumns.push(column.id);
    }
  }
  for (const beam of [...graph.beamMap.values()]) {
    // 基礎梁=主構造非依存の常時RC。軒桁=下階主構造、それ以外(床梁)=自階主構造。出所が未確定なら変換しない。
    if (beam.role !== 'foundation' && !(beam.role === 'eaves' ? belowSpecified : ownSpecified)) continue;
    const targetMaterial = beam.role === 'foundation' ? StructuralMaterialType.RC
      : beam.role === 'eaves' ? belowMaterialType
      : ownMaterialType;
    if (beam.materialType !== targetMaterial) {
      graph.convertBeamMaterial(beam, targetMaterial, DEFAULT_BEAM_SECTION_BY_MATERIAL[targetMaterial]);
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
 *  問題.md「構造変更の場合、×は削除、○は生成」の削除側。生成側は autoFillStructuralGrid の構造ゲートが担う。
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
  const materialType = defaultMaterialType(mainStructure);
  return findSectionEntry(DEFAULT_COLUMN_SECTION_BY_MATERIAL[materialType])?.width ?? 200;
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
 *  柱芯・偏芯量は per-floor だが、**柱の外面**（偏芯量0方向＝通り芯側の面）は「建物の出幅 projection」
 *  （通り芯から柱外面までの距離。建物に1値・全階共通）で決める——出幅が全階共通のため外面が階で
 *  食い違わない。各階は自階の既定柱幅で外面を出幅基準面に合わせるので、幅が違えば偏芯量も変わる
 *  （＝階依存を保ったまま外面が揃う）。導出（外周CLのみ。内部CLは0）：
 *      柱外面 = 通り芯 + s×出幅（通り芯の内側に出幅だけ控える）、偏芯量 offset = 外面 + s×halfThis = s×(halfThis + 出幅)
 *  柱芯は常に通り芯の内側（屋内側）に保たれ、通り芯・出幅寸法は柱芯の外側（屋外側）に位置する（出幅をいくら
 *  大きくしても柱芯が通り芯を越えない）。出幅=0 で offset=s×halfThis（外面＝通り芯＝従来既定）。これで
 *  「最下階オフセットを peek して引き継ぐ」処理（旧 offLowest/外面引き継ぎ）が不要になる。
 *  外側符号 s だけは最下階フットプリント(exterior)を権威に求める（lowestGraph を peek。R階伏図など
 *  自階に部屋が無い階で外周モデルが部材CL外接矩形へ縮退し、L字外周の中通りを内部と誤判定するのを回避。
 *  axisExteriorSign で軸線を全交差走査）。ユーザー上書きは出幅へ一本化したため、各CLは毎回上書きする。
 *  ラーメン系（S造/SRC造/RC造(ラーメン)）でなければ柱芯オフセットをすべて0に戻す（対象外＝通り芯と一致）。 */
export function autoFillColumnAxisOffsets(graph, project, lowestGraph = graph, exterior = buildExteriorSide(graph)) {
  const effective = graph.structureOverride ?? project.structuralInfo.mainStructure;
  if (!isRigidFrameStructure(effective)) {
    graph.columnAxisOffsets.clear();
    return;
  }
  const halfThis   = defaultColumnWidth(effective) / 2;
  const projection = project.structuralInfo.columnFaceProjection ?? 0;
  const isLowest   = lowestGraph.plane?.id === graph.plane?.id;
  const ex         = isLowest ? exterior : buildExteriorSide(lowestGraph); // 符号権威＝最下階フットプリント
  for (const [axisCLs, isVertical] of [[graph.gridXs, true], [graph.gridYs, false]]) {
    for (const cl of axisCLs) {
      const s = axisExteriorSign(ex, lowestGraph, cl, isVertical);
      // 内部芯(s=0)は偏芯0。外周芯は出幅で外面を、自階の柱幅で柱芯を決める（柱芯は常に通り芯の内側）。
      graph.setColumnAxisOffset(cl.id, s === 0 ? 0 : s * (halfThis + projection));
    }
  }
}

/** 建物の最下階（elevation昇順の先頭採用フロア）のgraphを返す。非アクティブならpeekで読み取り専用に覗く。
 *  柱芯の外面合わせ（autoFillColumnAxisOffsets）が最下階の柱を基準にするために使う。 */
export async function resolveLowestGraph(project, activeGraph) {
  const planes = project.planes; // elevation 昇順、屋根・検討を除く採用フロア
  const lowest = planes[0];
  if (!lowest || lowest.id === activeGraph.plane.id) return activeGraph;
  return floorSwapManager.peek(lowest, project.structGraph);
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

/** 梁の伏図見付き幅(mm)＝梁幅b（描画 beamRenderWidth と同一基準。柱外面合わせの縁はこの幅で揃える）。
 *  RCは beamWidth(算定値)、鋼材はカタログ断面の幅b（width）。軒桁等で算定 beamWidth/beamDepth が立っても
 *  鋼材はカタログ断面を優先する（算定値は屋根スパン由来でカタログ断面とは別物のため）。 */
function beamSectionWidth(beam) {
  if (beam.materialType === StructuralMaterialType.RC) return beam.beamWidth ?? 300;
  return findSectionEntry(beam.sectionDefId)?.width ?? 300;
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
