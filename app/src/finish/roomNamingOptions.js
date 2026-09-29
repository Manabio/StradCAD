// 部屋名ダイアログ（RoomNameInput.jsx）・内部タブのカード（FinishTable.jsx RoomCard）の
// 選択肢の唯一の供給源。STAIR_VOID／UNDEFINED は自動管理でユーザーは選べない。
import { RoomKind, RoomFeature, isShaftFeature } from '@core';

export const ROOM_KIND_OPTIONS = Object.freeze([
  { value: RoomKind.INTERIOR, label: '屋内' },
  { value: RoomKind.EXTERIOR, label: '屋外' },
]);

export const ROOM_FEATURE_OPTIONS = Object.freeze([
  { value: null,               label: 'なし' },
  { value: RoomFeature.STAIR,  label: '階段' },
  { value: RoomFeature.VOID,   label: '吹抜け' },
  { value: RoomFeature.ELEVATOR_EQUIPMENT, label: '昇降機' },
]);

// <select> の value は文字列。null は '' で表す（往復ヘルパー）。
export const featureToSelectValue = f => f ?? '';
export const selectValueToFeature = v => (v === '' ? null : v);

// 内部タブのカード（既存部屋の属性セレクタ）用。昇降路（isShaftFeature。昇降機）は共通仕様
// 「昇降路」で一括指定するため出さない（Q5）——カードには「なし/階段/吹抜け」のみ。
export const CARD_FEATURE_OPTIONS = Object.freeze(
  ROOM_FEATURE_OPTIONS.filter(opt => !isShaftFeature(opt.value))
);

// 部屋名ダイアログ（RoomNameInput.jsx）の選択肢の唯一の供給源。通常は ROOM_FEATURE_OPTIONS
// そのままだが、部分指定（referenceRoomIds 非空。親部屋の中に描いた一部だけの部屋）は
// 昇降機を選べない——昇降路は未指定セルからしか作れない仕様（S5・2026-09-29）。
// referenceRoomIds が undefined/null（想定外の入力）でも例外にせず通常の全選択肢を返す。
export function featureOptionsForDialog(room) {
  const isPartial = (room?.referenceRoomIds?.size ?? 0) > 0;
  return isPartial ? CARD_FEATURE_OPTIONS : ROOM_FEATURE_OPTIONS;
}
