import { StructuralMaterialType, columnSlotKey, spanKey } from '../core.js';
import { DEFAULT_SECTION_BY_MATERIAL, DEFAULT_COLUMN_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { findSectionEntry } from './sectionCatalog.js';
import { isFoundationPlane } from './drawingDesignation.js';
import { computeTributaryColumnWidth, computeColumnBaseSize, computeFoundationBeamSize, computeRoofBeamSize } from './memberSizing.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

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

// 柱芯（ColumnAxis）の対象=柱・梁でラーメン躯体を構成する構造形式のみ。
// 木造・RC造(壁式)は対象外（既存の通り芯をそのまま柱芯として使う＝偏芯量は常に0）。
const RAME_STRUCTURE_TYPES = new Set(['S造', 'SRC造', 'RC造(ラーメン)']);

/** 実効主構造の文字列表記がラーメン系（柱・梁躯体）かどうかを判定する。 */
export function isRigidFrameStructure(mainStructure) {
  return RAME_STRUCTURE_TYPES.has(mainStructure);
}

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
  const newColumns  = (!isRoof && ownSpecified) ? autoFillColumns(graph, project, wallGate) : [];
  const newFootings = (foundation && ownSpecified) ? autoFillFootings(graph, wallGate) : [];
  const newBeams     = (!isRoof && ownSpecified) ? autoFillBeams(graph, project, foundation ? 'foundation' : 'primary', wallGate) : [];
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

/** その階の実効主構造から既定柱幅(mm)を導出する。ラーメン系の柱芯インセット量(width/2)の基準。 */
function defaultColumnWidth(mainStructure) {
  const materialType = defaultMaterialType(mainStructure);
  return findSectionEntry(DEFAULT_COLUMN_SECTION_BY_MATERIAL[materialType])?.width ?? 200;
}

/** 柱芯（columnAxisOffsets＝通り芯から柱芯までの偏芯量）を自動生成する。構造モード突入時、
 *  autoFillStructuralGrid と同タイミングで呼ぶ。柱芯・偏芯量はともに階固有（per-floor）だが、外周柱の
 *  「外面」（偏芯量0方向＝通り芯側の面）は同位置にある最下階の柱の外面に揃える——上階ほど柱が細っても
 *  建物外周面が階で食い違わないようにする（仕様）。各階は自階の既定柱幅で外面を最下階の外面基準面に
 *  合わせるため、幅が違えば偏芯量も変わる（＝階依存を保ったまま外面が揃う）。最下階のオフセットは
 *  lowestGraph（呼び出し元が resolveLowestGraph で解決して渡す。非アクティブ階は peek 可）から読む。
 *  ラーメン系（S造/SRC造/RC造(ラーメン)）でなければ既存の柱芯オフセットをすべて0に戻す（対象外＝通り芯と一致）。
 *  未登録のCLにのみ補完する（差分のみ補完。ユーザー上書きは保持）。 */
export function autoFillColumnAxisOffsets(graph, project, lowestGraph = graph) {
  const effective = graph.structureOverride ?? project.structuralInfo.mainStructure;
  if (!isRigidFrameStructure(effective)) {
    graph.columnAxisOffsets.clear();
    return;
  }
  const halfThis   = defaultColumnWidth(effective) / 2;
  const lowestEff  = lowestGraph.structureOverride ?? project.structuralInfo.mainStructure;
  const halfLowest = defaultColumnWidth(lowestEff) / 2;
  const isLowest   = lowestGraph.plane?.id === graph.plane?.id;
  for (const axisCLs of [graph.gridXs, graph.gridYs]) {
    const last = axisCLs.length - 1;
    axisCLs.forEach((cl, i) => {
      if (graph.columnAxisOffsets.has(cl.id)) return; // 既存値（ユーザー上書き含む）は保持
      // s = 外側方向の符号。最小側の外周CL=+1（内側＝+方向へインセット）、最大側CL=-1、内部CL=0（偏心なし）。
      const s = i === 0 ? 1 : i === last ? -1 : 0;
      if (s === 0) { graph.setColumnAxisOffset(cl.id, 0); return; }
      // 最下階の柱の外面位置（通り芯相対）。最下階の偏芯量は基底ルール「外面を通り芯に合わせる」
      // （offset=s*halfLowest → 外面=通り芯）。最下階が手動で動いていればその実値に追従する。
      const offLowest = isLowest ? s * halfLowest : (lowestGraph.columnAxisOffsets.get(cl.id) ?? s * halfLowest);
      const outerFace = offLowest - s * halfLowest; // 通り芯相対の外面基準面
      // 自階の柱幅で、その外面基準面に外面を合わせる偏芯量。
      graph.setColumnAxisOffset(cl.id, outerFace + s * halfThis);
    });
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
