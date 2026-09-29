// 部屋名ダイアログ（RoomNameInput.jsx）・内部タブのカード（FinishTable.jsx RoomCard）の
// 選択肢の唯一の供給源。STAIR_VOID／UNDEFINED は自動管理でユーザーは選べない。
import { RoomKind, RoomFeature, isShaftFeature } from '@core';

export const ROOM_KIND_OPTIONS = Object.freeze([
  { value: RoomKind.INTERIOR, label: '屋内' },
  { value: RoomKind.EXTERIOR, label: '屋外' },
]);

export const ROOM_FEATURE_OPTIONS = Object.freeze([
  { value: null,                    label: 'なし' },
  { value: RoomFeature.STAIR,       label: '階段' },
  { value: RoomFeature.VOID,        label: '吹抜け' },
  { value: RoomFeature.EV,          label: 'EV' },
  { value: RoomFeature.DW,          label: 'DW' },
  { value: RoomFeature.FREIGHT_EV,  label: '貨物用EV' },
  { value: RoomFeature.VEHICLE_EV,  label: '車両用EV' },
]);

// <select> の value は文字列。null は '' で表す（往復ヘルパー）。
export const featureToSelectValue = f => f ?? '';
export const selectValueToFeature = v => (v === '' ? null : v);

// 内部タブのカード（既存部屋の属性セレクタ）用。昇降路（isShaftFeature。EV/DW/貨物用EV/
// 車両用EV）は共通仕様「昇降路」で一括指定するため出さない（Q5）——カードには「なし/階段/吹抜け」のみ。
export const CARD_FEATURE_OPTIONS = Object.freeze(
  ROOM_FEATURE_OPTIONS.filter(opt => !isShaftFeature(opt.value))
);
