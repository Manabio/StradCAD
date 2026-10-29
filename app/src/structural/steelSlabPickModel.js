// ================================================================
// 構造リスト「スラブ」見出しの S造スラブ指定UI（トグル・選択数・ボタン）の出し分けを決める純モジュール
// （react/konva/store 非依存。node:test から単体 import 可能）。判断はここだけに置き、
// structural/MemberListTab.jsx は結果を描くだけにする。
// ================================================================

/**
 * @param {{active: boolean, selectedCount: number, canAssign: boolean}} args
 *   active＝ベイ選択中（StructuralModeState.bayPick が非 null）／selectedCount＝選択中のベイ数／
 *   canAssign＝canAssignSteelSlab（S造の通常階）
 * @returns {{showToggle: boolean, showActions: boolean, label: string, canCommit: boolean, canRelease: boolean}}
 *   showToggle＝「スラブ指定」開始ボタン（S造の通常階で、選択中でないとき）／showActions＝選択中のボタン群
 *   （[スラブにする][指定を外す][取消]）／canCommit・canRelease＝それぞれ 1 ベイ以上選んでいるとき。
 */
export function slabPickHeader({ active, selectedCount, canAssign }) {
  const hasSelection = active && selectedCount > 0;
  return {
    showToggle: canAssign && !active,
    showActions: active,
    label: active ? `${selectedCount} ベイ選択中` : 'スラブ指定',
    canCommit: hasSelection && canAssign,
    canRelease: hasSelection,
  };
}
