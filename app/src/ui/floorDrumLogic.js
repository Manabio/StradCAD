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
 * 押した位置の階のインデックス。offsetFromCenterPx＝ドラム（マスク）の中心からの縦のずれ(px。下が正)。
 * 中心スロットが displayIndex の階、下へ ITEM_H ごとに1階下（インデックス大）。端は収める。
 * 階設定表の長押しが「長押しした位置の階」を決めるのに使う。
 */
export function indexAtPointer(displayIndex, offsetFromCenterPx, length) {
  return clampIndex(displayIndex + Math.round(offsetFromCenterPx / ITEM_H), length);
}

/**
 * 長押し（階設定表を開く）を始めてよいか。左ボタン（マウス）または接触（タッチ・ペン）のみ・開く手段（hasHandler）が
 * 在る・切替の決着待ち（pendingId）でない・関門（uiBusy）が閉じている、のすべてを満たすとき。
 */
export function canStartFloorLongPress({ button, isPrimary = true, hasHandler, pendingId, busy }) {
  if (!hasHandler) return false;
  if (!isPrimary) return false; // 2本目以降の指（マルチタッチ）では始めない
  if (button !== 0) return false;
  if (pendingId != null) return false;
  return !busy;
}

/** 長押しの成立時（タイマー発火）に開いてよいか。押し始めから状況が変わっていたら開かない。 */
export function shouldFireFloorLongPress({ pendingId, busy }) {
  return pendingId == null && !busy;
}

/** ドラム／ピルのジェスチャ（ドラッグ・長押し）を始めてよいボタンか。右・中ボタンはドラッグも切替も起こさない。 */
export function isDrumGestureButton(button) {
  return button === 0;
}

/**
 * 右クリック（contextmenu）で階設定表を開いてよいか。直前の pointerdown がマウスのときだけ
 * （タッチ・ペンの長押しでも Android/Windows は contextmenu が来るが、それは長押し側が開くので二重にしない）。
 * 開く手段がある・決着待ちでない・関門が閉じている、も長押しと同じ。
 */
export function shouldOpenOnContextMenu({ pointerType, hasHandler, pendingId, busy }) {
  if (!hasHandler) return false;
  if (pointerType !== 'mouse') return false;
  return pendingId == null && !busy;
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
