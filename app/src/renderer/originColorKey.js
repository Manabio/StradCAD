/**
 * 図形（CL・梁芯・柱）の「由来」から canvasStyle.js の色キーへ変換する純モジュール。
 *
 * import ゼロに近い規約（extractedModuleImportInvariant）: ../core/ 配下・structural/ の純モジュール
 * （columnOrigins.js など）・viewport.js（mobxと@coreのみに依存。前例 openings/openingPlanSymbol.js）
 * だけに依存する。store.js/snap.js/.jsx/react-konva は静的 import しない——node:test から本ファイルを
 * 単体 import 可能に保つため（QA指摘Minor-5・2026-09-27: viewport.js は mobx（npmパッケージ）を
 * import するが store.js/snap.js/.jsxのような重い依存やDOM/ブラウザAPIへは繋がらないため対象外）。
 *
 * ステップ1は CenterLine 用の centerLineOriginColorKey、ステップ3（本ファイル追記分）は柱用の
 * columnOriginColorKey/columnOriginMarkKey（柱の×表も同じ由来色を使う）。
 */
import { centerLineKind, BeamAxisOrigin } from '../core/centerLine.js';
import { StructuralMaterialType } from '../core/constants.js';
import { ColumnOrigin, parseColumnOrigins } from '../structural/columnOrigins.js';
import { LodLevel } from '../viewport.js';

/**
 * CenterLine の由来色キー（canvasStyle.js の ORIGIN_HUES のキー）を返す。
 * centerLineKind(cl) の4種別を由来キーへ写像する:
 *   'struct' → 'grid'（通り芯由来）
 *   'center' → 'center'（中心線由来）
 *   'aux'    → 'aux'（補助・手動）
 *   'beam'   → cl.beamAxisOrigin（ステップ2で新設した由来フィールド）で分岐する:
 *              wall/floorBeam（壁・床梁割付けからの自動生成）→ 'generated'
 *              center（中心線由来。S造向け・未実装。色キーのみ予約）→ 'center'
 *              user（AddCLDialogから追加）→ 'aux'
 *              null（既存データ・不明）→ 'none'
 * @param {import('../core/centerLine.js').CenterLine} cl
 * @returns {'grid'|'center'|'aux'|'generated'|'none'}
 */
export function centerLineOriginColorKey(cl) {
  const kind = centerLineKind(cl);
  if (kind === 'struct') return 'grid';
  if (kind === 'beam') {
    switch (cl.beamAxisOrigin) {
      case BeamAxisOrigin.WALL:
      case BeamAxisOrigin.FLOOR_BEAM: return 'generated';
      case BeamAxisOrigin.CENTER:     return 'center';
      case BeamAxisOrigin.USER:       return 'aux';
      default:                        return 'none';
    }
  }
  return kind; // 'center' | 'aux'
}

/**
 * 在来木造の柱の由来色キーを返す（複数の由来が重なれば優先順位の小さい方が勝つ。
 * .claude 由来: リード裁定2026-09-26「柱の由来別色分け ステップ3」）。
 * 優先順位:
 *   1. 手動柱（dimensionStatus !== 'auto'） → 'none'（黒）
 *   2. 建具の袖柱（woodJambRef 非null） → 'aux'（濃いグレー）
 *   3. 通り芯同士の交点（woodAxisOffset が null、かつ verticalCL/horizontalCL の両方が
 *      centerLineKind==='struct'。**描画時に導出**——由来集合には入れない。昇格/降格で種別が
 *      変わっても再計算なしで追従させるため） → 'grid'（濃い赤）
 *   4. 由来集合に ABOVE（上階柱直下・上階梁横断） → 'above'（濃いオレンジ）
 *   5. 由来集合に SUPPORT_SPAN（支持長分割） → 'supportSpan'（濃い緑）
 *   6. 由来集合に WALL（壁交点）または FREE_END（自由端） → 'center'（濃い水色。3は先に
 *      抜けているため、ここに残る柱のアンカーは必ず梁芯か中心線を含む）
 *   7. 由来不明（既存データ・集合が空） → 'none'（黒）
 * @param {import('../core/structuralEntities.js').WoodColumn} column
 * @returns {'none'|'aux'|'grid'|'above'|'supportSpan'|'center'}
 */
export function columnOriginColorKey(column) {
  if (column.dimensionStatus !== 'auto') return 'none';
  if (column.woodJambRef) return 'aux';
  if (column.woodAxisOffset == null
    && centerLineKind(column.verticalCL) === 'struct'
    && centerLineKind(column.horizontalCL) === 'struct') return 'grid';
  const origins = parseColumnOrigins(column.woodColumnOrigins);
  if (origins.has(ColumnOrigin.ABOVE)) return 'above';
  if (origins.has(ColumnOrigin.SUPPORT_SPAN)) return 'supportSpan';
  if (origins.has(ColumnOrigin.WALL) || origins.has(ColumnOrigin.FREE_END)) return 'center';
  return 'none';
}

/**
 * 柱の×表（由来色）を描くべきときだけ columnOriginColorKey(column) を返し、それ以外は null
 * （×を描かない）。呼び出し側（renderer/StructuralLayer.jsx ColumnsLayer）は viewport.lodLevel を
 * そのまま渡す——viewport.js の LodLevel 定数を import して比較する（QA指摘Minor-5・2026-09-27:
 * viewport.js は mobx・@core のみに依存するため本モジュールの import 制約に反しない。前例
 * openings/openingPlanSymbol.js）。
 * @param {object} column
 * @param {{planColumnOriginMark?: string}} drawing - structureRules.js drawing（'cross'のときだけ描く）
 * @param {string} lodLevel - viewport.lodLevel（LodLevel.DETAILのときだけ描く）
 * @param {boolean} enabled - 平面モードかどうか（renderer/planFigureVisibility.js shouldShowColumnOriginMarks）
 * @returns {'none'|'aux'|'grid'|'above'|'supportSpan'|'center'|null}
 */
export function columnOriginMarkKey(column, drawing, lodLevel, enabled) {
  if (!enabled || lodLevel !== LodLevel.DETAIL) return null;
  if (drawing?.planColumnOriginMark !== 'cross') return null;
  if (column.materialType !== StructuralMaterialType.WOOD || column.role === 'foundation') return null;
  return columnOriginColorKey(column);
}
