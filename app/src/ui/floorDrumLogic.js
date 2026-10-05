// FloorDrum（階を選ぶドラムロール）の判断を切り出した純モジュール。
// FloorDrum.jsx は node:test から import できないため、表示基準・次インデックス・切替要求の
// 可否と後始末はここを唯一の供給源にする（react・store.js・snap.js・.jsx を引かない）。
//
// 保留中の選択（pending）: 階を選んだ瞬間に pending を立て、表示は選んだ階へ直接移す。
// 切替処理（onSwitch）が決着したら pending を外す。成功時は activeFloorId が先に新しい階へ
// 変わっているので表示は動かず、失敗・無視のときだけ実際の階へ戻る。

export const ITEM_H = 34; // 1階あたりの高さ(px)

/** インデックスを [0, length-1] へ収める。 */
export function clampIndex(i, length) {
  return Math.max(0, Math.min(length - 1, i));
}

/**
 * 表示の基準にする階 id。pending が floors に在ればそれ、無ければ activeFloorId。
 * floors は [{ id, name }]（構造モードの id は slotType:planeId のスロットキー文字列）。
 */
export function resolveDisplayId(floors, activeFloorId, pendingId) {
  if (pendingId != null && floors.some(f => f.id === pendingId)) return pendingId;
  return activeFloorId;
}

/**
 * ドラッグ量から次のインデックスを決める。下方向ドラッグ(正) → 上の階（インデックス小）が中心へ。
 */
export function nextIndexFromDrag(baseIndex, drag, length) {
  const steps = Math.round(drag / ITEM_H);
  return clampIndex(baseIndex - steps, length);
}

/** ホイール下回し(deltaY > 0) → 1階下へ（インデックス大）。 */
export function nextIndexFromWheel(baseIndex, deltaY, length) {
  return clampIndex(baseIndex + (deltaY > 0 ? 1 : -1), length);
}

/**
 * 新しい切替を要求してよいか。pending 中は不可（連打無視。2つ目の要求は関門に無視されて
 * 即決着し、1つ目の pending まで外してしまうため）。対象が表示基準と同じなら不可。
 */
export function canRequestSwitch(pendingId, displayId, targetId) {
  if (pendingId != null) return false;
  if (targetId == null) return false;
  return targetId !== displayId;
}

/**
 * 切替の要求と後始末。pending を立てる → onSwitch(id) を呼ぶ → 決着（resolve・reject・
 * undefined＝関門に無視・同期 throw のどれでも）で pending を外す。返す Promise は常に resolve する。
 * 失敗の表示は onSwitch 側（App.jsx guardUi）の責務。ここでは握るだけでなく console.error に残す。
 */
export async function requestFloorSwitch(id, onSwitch, setPending) {
  setPending(id);
  try {
    await onSwitch(id);
  } catch (err) {
    console.error('FloorDrum: 階切替の要求が失敗した', err);
  } finally {
    setPending(null);
  }
}
