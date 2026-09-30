// ================================================================
// 構造リストタブ「＋追加」の手動追加（純関数）。
//
// MemberListTab.jsx（.jsx はnode:testから単体importできない）から「柱・基礎/柱脚・梁を
// 追加し、初期値を自動算定してから dimensionStatus:'locked' にする」という一連の判断を
// ここへ抽出する（前例: openings/openingTagPlacement.js ⇄ renderer/OpeningTagLayer.jsx）。
//
// 手動追加した構造材は主構造を問わず locked にする（撤去段は dimensionStatus==='auto' の
// 材だけを候補外で消すため、locked にすれば再計算・CL操作で黙って消えない。指示書
// dev直下 260929_手動追加材サイレント撤去回避.md §3 裁定1・2）。
//
// 順序は「追加 → 初期値の自動算定 → locked」固定。autoFillColumnSizes/autoFillColumnBaseSizes は
// dimensionStatus==='auto' の材だけを対象にするため、先に locked にすると初期値が入らない
// （structuralAutoFill.js:915,933）。autoFillBeamEccentricity は dimensionStatus を見ないため
// 順序に依存しないが、追加直後に呼ぶ既存の挙動（faceGap=0からの初期偏芯算出）に合わせる。
// 梁成の自動算定（autoFillWoodBeamDepths、在来木造のみ）も同じ理由で「追加直後の1回だけ」locked化前に
// 呼ぶ（S造柱のautoFillColumnSizesと同じ扱い。指示書 案(ii) 2026-09-30）。dimensionStatus==='auto' の
// 材だけを対象にするため、先にlockedにすると成が既定断面(120x120)のまま固定されてしまう。以後の
// 再計算・beamType昇格（standard→受梁等）・階段LGのG置換の対象からは外れる——手動固定した材を
// 再計算が黙って書き換えないという既存方針（上のlocked化の理由）と同じ副作用であり受容する。
//
// 純モジュール: react/.jsx/store.js/snap.js を静的 import しない。
// ================================================================
import { StructuralMaterialType } from '../core.js';
import { rulesFor, woodColumnSectionId, effectiveStructure } from './structureRules.js';
import { DEFAULT_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { autoFillColumnSizes, autoFillColumnBaseSizes, autoFillBeamEccentricity, fixedBeamGuardHonored } from './structuralAutoFill.js';
import { autoFillWoodBeamDepths } from './woodAutoFill.js';
import { beamAxisSpan, removeAutoBeamsOverlapping } from './fixedBeamOverlap.js';

/** 柱を手動追加し、初期値算定後に locked にする。vCL・hCL は明示必須（欠落は例外）。
 *  @returns 追加した StructuralColumn */
export function addManualColumn(graph, project, { vCL, hCL }) {
  if (!vCL || !hCL) throw new Error('addManualColumn: vCL と hCL は必須です');
  const rules = rulesFor(effectiveStructure(graph, project));
  const materialType = rules.baseMaterial;
  // 在来木造は「各階柱寸法」欄の値（階の柱寸の正角）を新規柱にも使う。非在来・カタログ外は
  // 従来どおり rules.defaultSections.column（建物共通の固定値）。
  const columnSection = woodColumnSectionId(graph, project) ?? rules.defaultSections.column;
  const column = graph.addColumn(materialType, columnSection, vCL, hCL, {});
  // 柱が支える階数(N)も自階（graph.plane）基準で算定する（columnSizing:'fixed' の在来は算定しない＝再計算と同じ）。
  if (rules.columnSizing !== 'fixed') autoFillColumnSizes(graph, project, graph.plane);
  column.setDimensionStatus('locked');
  return column;
}

/** 独立基礎・柱脚を手動追加し、初期値算定後に locked にする。vCL・hCL は明示必須。
 *  基礎・柱脚は主構造に関わらず常にRC造（structuralAutoFill.js の autoFillFootings と同じ理由）。
 *  @returns 追加した IndependentFooting/ColumnBase */
export function addManualFooting(graph, project, { kind, vCL, hCL }) {
  if (!vCL || !hCL) throw new Error('addManualFooting: vCL と hCL は必須です');
  const footing = graph.addFooting(kind, DEFAULT_SECTION_BY_MATERIAL[StructuralMaterialType.RC], vCL, hCL, { materialType: StructuralMaterialType.RC });
  autoFillColumnBaseSizes(graph, project);
  footing.setDimensionStatus('locked');
  return footing;
}

/** 梁（大梁）を手動追加し、初期値算定後に locked にする。axisCL・clStart・clEnd は明示必須
 *  （clStart===clEnd も不可）。
 *  @returns 追加した StructuralBeam */
export function addManualBeam(graph, project, { axisCL, isVertical, clStart, clEnd }) {
  if (!axisCL || !clStart || !clEnd) throw new Error('addManualBeam: axisCL・clStart・clEnd は必須です');
  if (clStart.id === clEnd.id) throw new Error('addManualBeam: clStart と clEnd は異なるCLである必要があります');
  const rules = rulesFor(effectiveStructure(graph, project));
  const materialType = rules.baseMaterial;
  const beam = graph.addBeam(materialType, rules.defaultSections.beam, axisCL, isVertical, clStart, clEnd, {});
  autoFillBeamEccentricity(graph, project); // 外周梁なら柱外面合わせの偏芯量を初期算出（faceGap=0＝面一）
  // belowColumns=[]固定: 手動追加は同期処理で他階peekができないため、下階柱を支持点に含めず端点2点
  // だけで評価する（本番の再計算より成が大きめに出うるが、初期値としては安全側）。在来以外・材幅未解決
  // （resolvedBeamColumnWidthMm）のときはautoFillWoodBeamDepths自身が[]を返し何もしない
  // （framing無しの主構造・S造など。structureRules.js:470）。
  autoFillWoodBeamDepths(graph, project, []);
  beam.setDimensionStatus('locked');
  // 固定梁と重なるauto梁は、その場で撤去し追加と同じundoエントリに入れる（指示書§2.5・裁定Q2）。
  // 在来木造の壁線方式（role:'primary'）は対象外（fixedBeamGuardHonored参照。次の再計算で復活して
  // 往復するため）。
  if (fixedBeamGuardHonored(beam.role, rules)) {
    removeAutoBeamsOverlapping(graph, beam.role, [beamAxisSpan(beam)]);
  }
  return beam;
}
