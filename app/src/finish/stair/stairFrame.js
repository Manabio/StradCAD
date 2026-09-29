// 設置エリア矩形 b から走行軸方向 t∈[0,1] / 幅方向 s∈[0,1] → ワールド点 の写像（makeFrame）。
// stairGeometry.js（描画）と stairClassify.js（区間実測 uTurnSpans）が共有するため、循環importを
// 避けて独立ファイルに置く。既存の import 経路（stairGeometry.js からの export）は維持する。
export function makeFrame(stair, b) {
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const runLength = (vertical ? (b.y2 - b.y1) : (b.x2 - b.x1)) || 1;
  const coordAt = (t) => {
    switch (stair.upDirection) {
      case 'down':  return b.y1 + t * (b.y2 - b.y1);
      case 'right': return b.x1 + t * (b.x2 - b.x1);
      case 'left':  return b.x2 - t * (b.x2 - b.x1);
      case 'up':
      default:      return b.y2 - t * (b.y2 - b.y1);
    }
  };
  const acrossLo = vertical ? b.x1 : b.y1;
  const acrossHi = vertical ? b.x2 : b.y2;
  const acrossAt = (s) => {
    const ss = stair.flip ? 1 - s : s;
    return acrossLo + ss * (acrossHi - acrossLo);
  };
  const pt = (t, s) => vertical
    ? { x: acrossAt(s), y: coordAt(t) }
    : { x: coordAt(t), y: acrossAt(s) };
  // coordAt/acrossAt の逆写像（world座標点 → t/s）。破れ線先セル判定（cellsBeyondBreak）や
  // 区間実測（uTurnSpans）で、実セル境界がタイプ共通の走行軸(t)・幅方向(s)のどこに位置するかを求める。
  const tOf = (p) => {
    const coord = vertical ? p.y : p.x;
    switch (stair.upDirection) {
      case 'down':  return (coord - b.y1) / runLength;
      case 'right': return (coord - b.x1) / runLength;
      case 'left':  return (b.x2 - coord) / runLength;
      case 'up':
      default:      return (b.y2 - coord) / runLength;
    }
  };
  const sOf = (p) => {
    const coord = vertical ? p.x : p.y;
    const raw = (coord - acrossLo) / ((acrossHi - acrossLo) || 1);
    return stair.flip ? 1 - raw : raw;
  };
  return { vertical, runLength, pt, tOf, sOf };
}
