/**
 * 階段タイプの日本語表記（純モジュール）。仕上げ表の階段タブ（StairTab.jsx）と天伏の専用パネル
 * （ceiling/ceilingPanelRows.js）の共用。
 */
import { StairType } from '@core';

export const STAIR_TYPE_LABEL = {
  [StairType.STRAIGHT]:         '直進',
  [StairType.STRAIGHT_LANDING]: '踊り場付直進',
  [StairType.SWITCHBACK]:       '屈折',
  [StairType.WINDING]:          '回り',
  [StairType.L_TURN]:           '矩折',
  [StairType.FLARED]:           '曲がり',
  [StairType.OPEN_WELL]:        '中空き',
};
