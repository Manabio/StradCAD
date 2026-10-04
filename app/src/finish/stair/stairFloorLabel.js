/**
 * 仕上げモード階段タブの「◯->△階」表記（純モジュール。react/konva/store を import しない）。
 *
 * 階段は設置階のグラフに属し、その階から1つ上の採用フロアへ上がる。
 * 入力は project.planes（採用フロア。elevation 昇順）とアクティブ平面 id。
 */
import { addSkipZero, makeFloorLevelPrefix, makeFloorName } from '../../floorNumber.js';

const NO_UPPER = '（上階なし）';

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
  if (!toPlane) return `${from.text}${from.isInt ? '階' : ''}->${NO_UPPER}`;
  const to = shortFloor(toPlane, 'to');
  return `${from.text}->${to.text}${to.isInt ? '階' : ''}`;
}

/**
 * 自階の階段・直下階の階段に付ける階の表記を返す。
 * 返り値: { self, lower }。表記を出せないものは null。
 *   self : アクティブ階→その1つ上の採用フロア（無ければ「->（上階なし）」）
 *   lower: 直下階→アクティブ階（直下階が無ければ null）
 * アクティブ階が planes に無い（検討案の平面など）・planes が空なら両方 null。
 */
export function stairFloorLabels(planes, activePlaneId) {
  const list = planes ?? [];
  const idx = list.findIndex(p => p.id === activePlaneId);
  if (idx < 0) return { self: null, lower: null };
  const active = list[idx];
  return {
    self: joinLabel(active, list[idx + 1] ?? null),
    lower: idx > 0 ? joinLabel(list[idx - 1], active) : null,
  };
}
