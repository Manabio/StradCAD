import './LongPressIndicator.css';

/**
 * 長押し中に表示する拡大リング (HTML overlay)
 *
 * @param {{ x: number, y: number } | null} pos  スクリーン座標 (null = 非表示)
 */
export function LongPressIndicator({ pos }) {
  if (!pos) return null;
  return (
    <div
      className="longpress-ring"
      style={{ left: pos.x, top: pos.y }}
    />
  );
}
