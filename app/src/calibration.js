// クレジットカード等の規格サイズ（ISO/IEC 7810 ID-1。キャッシュカード等も共通）
export const CARD_WIDTH_MM  = 85.6;
export const CARD_HEIGHT_MM = 53.98;

export const CalibrationMethod = {
  RULER_MEASURE: 'RULER_MEASURE',
  CARD_MATCH:    'CARD_MATCH',
};

// 短辺が小さい（おおむね100mmの基準線が収まらない）、またはスマホ系UAの場合はカード当て方式を推奨
export function getRecommendedCalibrationMethod() {
  const minDimension = Math.min(window.screen.width, window.screen.height);
  const isMobileUA   = /Mobi|Android|iPhone/i.test(navigator.userAgent);
  return (minDimension < 500 || isMobileUA)
    ? CalibrationMethod.CARD_MATCH
    : CalibrationMethod.RULER_MEASURE;
}
