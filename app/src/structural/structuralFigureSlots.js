// 構造モードの「図面スロット列」——スライダー（FloorDrum）のナビゲーション単位。
//
// 構造モードのスライダーは平面と 1:1 ではなく、構造種別に依存して可変個の図面スロットを持つ
// （問題.md「平面と構造の移動スライダーのラベル対応」）。その「単一の真実」をここに集約し、
// スライダー描画・図面呼称・ナビゲーションをスロットから解決する。
//
// スロット = { key, plane, planeId, slotType, figureType }
//   key      : ナビゲーション・ドラムの行ID。`slotType:planeId`（1平面に複数スロットが乗る
//              ＝木造の「基礎伏図＋1階伏図」・S造の「R階伏図＋小屋伏図」を区別する）。
//   plane    : 対応する実体/屋根平面（switchFloor 先・呼称の階番号源）。
//   slotType : SLOT_TYPE。出現可否（SLOT_PRESENCE）と呼称の決定に使う。
//   figureType : 部材の出し分け軸（FIGURE_TYPE。地中梁図/屋根の細分）。
//
// 【スコープ】合成図面（地中梁図・1階伏図追加・小屋伏図）は専用の部材データを持たない（次フェーズ）。
// そのため専用平面は作らず、最も近い実体/屋根平面に対応づける（key で区別）。専用平面の実体化は
// 部材データ再編フェーズで行う（空の専用平面は再利用と区別がつかず、coreデータモデル改変の risk だけが残るため）。

import { makeFloorName } from '../floorNumber.js';
import { FIGURE_TYPE, SLOT_TYPE, slotPresent } from './structuralClassification.js';

// スロット種別 → 部材出し分けの図面種別。
const FIGURE_TYPE_BY_SLOT = {
  [SLOT_TYPE.UNDERGROUND_BEAM]: FIGURE_TYPE.UNDERGROUND_BEAM,
  [SLOT_TYPE.UNDERGROUND_BODY]: FIGURE_TYPE.ABOVEGROUND, // 地階躯体＝RC。柱・梁・壁・スラブを持つ
  [SLOT_TYPE.FOUNDATION]:       FIGURE_TYPE.FOUNDATION,
  [SLOT_TYPE.GROUND_FLOOR]:     FIGURE_TYPE.ABOVEGROUND,
  [SLOT_TYPE.FLOOR]:            FIGURE_TYPE.ABOVEGROUND,
  [SLOT_TYPE.ROOF_SLAB]:        'roof',
  [SLOT_TYPE.ROOF_FRAME]:       'roof',
};

function makeSlot(slotType, plane) {
  return { key: `${slotType}:${plane.id}`, plane, planeId: plane.id, slotType, figureType: FIGURE_TYPE_BY_SLOT[slotType] };
}

/** 構造モードのスライダーに並ぶ図面スロット列（下＝最下階 → 上＝屋根）を返す。
 *  出現可否は建物全体の主構造で SLOT_PRESENCE（問題.md 表B）によりゲートする。 */
export function buildStructuralFigureSlots(project) {
  const structure = project.structuralInfo?.mainStructure;
  const has = slotType => slotPresent(slotType, structure);
  const planes = project.planes; // elevation 昇順・採用実体平面
  const basements = planes.filter(p => p.startFloor < 0);  // 地階（昇順）
  const grounds   = planes.filter(p => p.startFloor >= 1); // 地上階（昇順）
  const slots = [];

  if (basements.length > 0) {
    // 地階あり：foundation は地階側（地中梁図／躯体図）。基礎伏図スロットは出さない。
    // 地階が2以上のとき、最下階躯体図の下に「地中梁図」。
    if (basements.length >= 2 && has(SLOT_TYPE.UNDERGROUND_BEAM)) slots.push(makeSlot(SLOT_TYPE.UNDERGROUND_BEAM, basements[0]));
    for (const b of basements) if (has(SLOT_TYPE.UNDERGROUND_BODY)) slots.push(makeSlot(SLOT_TYPE.UNDERGROUND_BODY, b));
    for (const g of grounds)   if (has(SLOT_TYPE.FLOOR))           slots.push(makeSlot(SLOT_TYPE.FLOOR, g));
  } else {
    // 地階なし：最下（1階）＝基礎伏図。木造はさらに「1階伏図」を追加。2階以降は n階伏図。
    const first = grounds[0];
    if (first) {
      if (has(SLOT_TYPE.FOUNDATION))   slots.push(makeSlot(SLOT_TYPE.FOUNDATION, first));
      if (has(SLOT_TYPE.GROUND_FLOOR)) slots.push(makeSlot(SLOT_TYPE.GROUND_FLOOR, first));
    }
    for (let i = 1; i < grounds.length; i++) if (has(SLOT_TYPE.FLOOR)) slots.push(makeSlot(SLOT_TYPE.FLOOR, grounds[i]));
  }

  // 屋根（最上）：R階伏図（非木造）と 屋根+/小屋伏図（S造・木造）。両方出る構造（S造）は2スロット。
  const roof = project.roofPlane;
  if (roof) {
    if (has(SLOT_TYPE.ROOF_SLAB))  slots.push(makeSlot(SLOT_TYPE.ROOF_SLAB, roof));
    if (has(SLOT_TYPE.ROOF_FRAME)) slots.push(makeSlot(SLOT_TYPE.ROOF_FRAME, roof));
  }

  return slots;
}

/** スロットの図面呼称（スライダーに出すラベル）。slotType と階番号から決まる。
 *  屋根+（ROOF_FRAME）だけは選択時に「小屋伏図」へ変わる（問題.md：「屋根+」が選択されると「小屋伏図」）。 */
export function designationForSlot(slot, isActive = false) {
  const sf = slot.plane.startFloor;
  switch (slot.slotType) {
    case SLOT_TYPE.UNDERGROUND_BEAM: return '地中梁図';
    case SLOT_TYPE.UNDERGROUND_BODY: return `B${Math.abs(sf)}躯体図`;
    case SLOT_TYPE.FOUNDATION:       return '基礎伏図';
    case SLOT_TYPE.GROUND_FLOOR:     return `${makeFloorName(sf, 1)}伏図`; // 木造1階の床伏（土台/大引は次フェーズ）
    case SLOT_TYPE.FLOOR:            return `${makeFloorName(sf, 1)}伏図`;
    case SLOT_TYPE.ROOF_SLAB:        return 'R階伏図';
    case SLOT_TYPE.ROOF_FRAME:       return isActive ? '小屋伏図' : '屋根+';
    default:                         return slot.plane.name ?? '';
  }
}

/** 指定平面に対応する最初のスロットの key（その平面へ移動したときの既定スロット）。無ければ null。 */
export function firstSlotKeyForPlane(slots, planeId) {
  return slots.find(s => s.planeId === planeId)?.key ?? null;
}
