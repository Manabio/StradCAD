/**
 * 機械器具タブの画面文言（純モジュール）。
 */
import { EvUsage } from '@core';

// EV用途セレクトの選択肢（既定は乗用＝EvUsage.PASSENGER）。
export const EV_USAGE_OPTIONS = [
  { value: EvUsage.PASSENGER,         label: '乗用' },
  { value: EvUsage.PASSENGER_FREIGHT, label: '人荷用' },
  { value: EvUsage.FREIGHT,           label: '荷物用' },
];

// 分類の表示ラベル（機械器具タブの「分類」列、表示専用）。
export const CATEGORY_LABEL = { ev: 'EV' };
