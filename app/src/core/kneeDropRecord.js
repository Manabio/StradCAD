// ================================================================
// 腰壁・垂れ壁の記録（graph.kneeDropWalls の値）の正規形。import は constants と core/detailRefs.js だけの葉。
// 形: { knee: {topHeight}|null, drop: {bottomHeight}|null, detailRefs?: {kneeTop?, dropBottom?}, frontSide?: 'roomPos' }
//   - detailRefs（部分詳細図の割当て。S8b-1）は KNEE_DROP_DETAIL_SLOTS だけ。腰壁が無ければ kneeTop、垂れ壁が無ければ dropBottom を落とす。
//     空なら detailRefs キー自体を持たない（FBS は無ければ書かない）。
//   - frontSide（表の側）は既定値（KNEE_DROP_FRONT_SIDE_DEFAULT）と違うときだけキーを持つ。
// ================================================================

import {
  DetailSlot, KNEE_DROP_DETAIL_SLOTS, KneeDropFrontSide, KNEE_DROP_FRONT_SIDE_DEFAULT,
} from './constants.js';
import { normalizeDetailRefs } from './detailRefs.js';

/** 記録の表の側（無い・未知の値は既定）。 */
export function kneeDropFrontSideOf(rec) {
  return rec?.frontSide === KneeDropFrontSide.ROOM_NEG || rec?.frontSide === KneeDropFrontSide.ROOM_POS
    ? rec.frontSide : KNEE_DROP_FRONT_SIDE_DEFAULT;
}

/**
 * 記録を正規形にした新しいオブジェクト（元は変えない）。knee・drop は渡されたまま。
 * @param {{knee?:object|null, drop?:object|null, detailRefs?:object|null, frontSide?:string}} rec
 */
export function normalizeKneeDropRecord(rec) {
  const out = { ...rec };
  const refs = normalizeDetailRefs(rec?.detailRefs) ?? {};
  const kept = {};
  for (const slot of KNEE_DROP_DETAIL_SLOTS) {
    const owned = slot === DetailSlot.KNEE_TOP ? rec?.knee != null : rec?.drop != null;
    if (owned && refs[slot] !== undefined) kept[slot] = refs[slot];
  }
  const normalized = normalizeDetailRefs(kept);
  if (normalized) out.detailRefs = normalized; else delete out.detailRefs;
  if (kneeDropFrontSideOf(rec) === KNEE_DROP_FRONT_SIDE_DEFAULT) delete out.frontSide;
  else out.frontSide = kneeDropFrontSideOf(rec);
  return out;
}
