// 在来木造の柱カード「柱寸：」欄（適用範囲2択：全体／この部材。ユーザー裁定2026-09-17）の書き込み先を
// 決める純関数。MemberListTab.jsx の ColumnWidthScopeSelect が唯一の呼び出し元（二重実装を避ける）。
import { WOOD_SQUARE_WIDTHS } from './sectionCatalog.js';

// 呼び出し側は柱カード専用state（columnScope。'all'|'entity'のみ）から渡す——分割UIの`scope`
// （'all'|'floor'|'entity'）とは別物（QA指摘・回帰: 混在させるとcommitScopedEditの分割経路へ
// 迷い込む。structural-model.md「柱の全体／この部材ボタン」節参照）。
//
// scope='all'    → 全体（共通柱の柱寸＝各階柱寸法欄。graph.setWoodColumnWidthMm）を書く。
// scope='entity' → タップした柱（focusedMember）の個別指定（woodColumnWidthMm）を書く。
//                  focusedMember が無い（一覧から開いた等）場合は書き込み先が無い（target: null）。
//                  選んだ幅が階の値と同じなら null（共通へ戻す）を書く——「個別指定＝階の値と同値」を
//                  存在しない状態にする既存の排他規則（.claude/structural-model.md 参照）をここでも保証する。
// scope が上記以外（未知の値）のときも書き込み先が無い（target: null）——'all'を明示的に判定する
// （QA指摘: 既定でfloorへ倒すと、想定外のscope値でも柱寸が書き換わってしまう）。
//
// @param {{scope: 'all'|'entity', focusedMember: object|null, floorWidth: number|null, width: number}} args
// @returns {{target: 'floor'|'member'|null, value: number|null}}
export function resolveColumnWidthEdit({ scope, focusedMember, floorWidth, width }) {
  if (scope === 'entity') {
    if (!focusedMember) return { target: null, value: null };
    return { target: 'member', value: width === floorWidth ? null : width };
  }
  if (scope === 'all') {
    return { target: 'floor', value: width };
  }
  return { target: null, value: null };
}

// 全体（各階柱寸法欄）をwidthへ変更した直後に呼ぶ副作用ヘルパー（QA指摘2026-09-17: 「個別＝階の値」
// 禁止状態の復活を防ぐ）——graph内の柱のうちwoodColumnWidthMmが新しい階の値と偶然同値になったものを
// null（共通）へ正規化する。呼び出し元はColumnWidthScopeSelectのfloor分岐とWoodColumnWidthSelectの
// handleChangeの2箇所（graph.setWoodColumnWidthMm(width)の直後）——個別指定の排他規則
// （resolveColumnWidthEditの`width === floorWidth ? null : width`と同じ規則）を、全体側の変更でも
// 同じ意味で保つための対になる処理。
// @param {object} graph - columnMap（Map<string, {woodColumnWidthMm, setField}>）を持つPlanGraph相当
// @param {number} width - 新しい階の値
export function normalizeColumnOverridesToFloor(graph, width) {
  for (const column of graph.columnMap.values()) {
    if (column.woodColumnWidthMm === width) column.setField('woodColumnWidthMm', null);
  }
}

// ---- 柱寸アップ（ユーザー裁定2026-09-17・B-1）: 個別指定で選べる柱寸は既定で階の値以下に限定し、
// 「柱寸アップ」チェック時だけ階の値より大きい寸法も選べる。MemberListTab.jsx ColumnWidthScopeSelect
// が唯一の呼び出し元（二重実装を避ける）。----

/** 個別指定の柱寸セレクトに出す選択肢（カタログ幅の降順・昇順に依らずWOOD_SQUARE_WIDTHSの並び順）。
 *  allowUpsize=false は floorWidth 以下だけに絞る（floorWidth 自身は常に含む）。floorWidth が
 *  null・カタログ外（無効値）なら絞り込みできないため全件を返す。
 * @param {number|null} floorWidth - 階の柱寸（structureRules.js woodColumnWidthMm）
 * @param {boolean} allowUpsize - 「柱寸アップ」チェックの状態
 * @returns {number[]} */
export function allowedColumnWidths(floorWidth, allowUpsize) {
  if (allowUpsize || floorWidth == null || !WOOD_SQUARE_WIDTHS.includes(floorWidth)) return [...WOOD_SQUARE_WIDTHS];
  return WOOD_SQUARE_WIDTHS.filter(w => w <= floorWidth);
}

/** 柱寸widthが階の値floorWidthより大きい（＝柱寸アップ状態でしか選べない値）か。
 *  floorWidth・widthのどちらかが非数ならfalse（判定不能＝アップ扱いにしない）。
 * @param {number|null} width
 * @param {number|null} floorWidth
 * @returns {boolean} */
export function isUpsizedWidth(width, floorWidth) {
  return Number.isFinite(width) && Number.isFinite(floorWidth) && width > floorWidth;
}
