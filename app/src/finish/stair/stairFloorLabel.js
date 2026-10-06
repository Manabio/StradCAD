/**
 * 仕上げモード階段タブの階の表記（純モジュール。react/konva/store を import しない）。
 *
 * 階段の連鎖のグループ名は「◯->△階」（出発階->到達階）。階段は設置階のグラフに属し、その階から
 * 1つ上の採用フロアへ上がる。入力は project.planes（採用フロア。elevation 昇順）。
 */
import { addSkipZero, makeFloorLevelPrefix, makeFloorName } from '../../floorNumber.js';

// 階の短い表記。{ text, isInt }。isInt=false（中間階）は末尾の「階」を付けない。
// side='from'（出発側）: 複数階ぶんの平面は最上の階番号。'to'（到着側）: startFloor。
function shortFloor(plane, side) {
  if (!Number.isInteger(plane.stories)) {
    return { text: makeFloorName(plane.startFloor, plane.stories), isInt: false };
  }
  const n = side === 'from' && plane.stories > 1
    ? addSkipZero(plane.startFloor, plane.stories - 1)
    : plane.startFloor;
  return { text: makeFloorLevelPrefix(n), isInt: true };
}

function joinLabel(fromPlane, toPlane) {
  const from = shortFloor(fromPlane, 'from');
  const to = shortFloor(toPlane, 'to');
  return `${from.text}->${to.text}${to.isInt ? '階' : ''}`;
}

/**
 * 階1つの表記（「2階」「B1階」「1ML」。中間階は末尾の「階」なし）。階段の行の階表記に使う。
 * 階段は設置階（出発側）の表記に揃えるため、複数階ぶんの平面は最上の階番号（'from' の規則）。
 * plane が無ければ空文字。
 */
export function stairFloorName(plane) {
  if (!plane) return '';
  const f = shortFloor(plane, 'from');
  return `${f.text}${f.isInt ? '階' : ''}`;
}

/**
 * 連鎖の到達階。連鎖の最後の階段の階（toPlaneId）の直上の採用フロアを返す。
 * planes に無い id・最上階（直上が無い）は undefined。planes は elevation 昇順。
 */
export function chainArrivalPlane(planes, toPlaneId) {
  const list = planes ?? [];
  const i = list.findIndex(p => p.id === toPlaneId);
  return i < 0 ? undefined : list[i + 1];
}

/**
 * 階段の連鎖のグループ名。「◯->△階」（出発階->到達階）。
 * 出発階＝連鎖の先頭の階段の階（fromPlane）、到達階＝最後の階段の階の直上の採用フロア（upperPlane。
 * chainArrivalPlane で求める）。
 *   1F,2F,3F の連鎖 → 「階段N（1->4階）」／単独の1階の階段 → 「階段N（1->2階）」。
 * 最後の階段の上に採用階が無い（最上階の階段）ときだけ到達階を空にする → 「階段N（3階->）」。
 * index は 0 始まり（表示は +1）。fromPlane が無い（階の表記が出せない。検討案の平面など）ときは括弧を付けない。
 */
export function stairChainTitle(index, fromPlane, upperPlane) {
  if (!fromPlane) return `階段${index + 1}`;
  const from = shortFloor(fromPlane, 'from');
  const span = upperPlane
    ? joinLabel(fromPlane, upperPlane)
    : `${from.text}${from.isInt ? '階' : ''}->`;
  return `階段${index + 1}（${span}）`;
}
